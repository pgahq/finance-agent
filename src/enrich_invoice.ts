import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { debug } from '@pga/logger';
import { getAiResponse } from './lib/ai.js';
import { withHandler, withProcessorHandler, type ProcessingContext } from './lib/handlers.js';
import { isInvoiceMarkedForSkip, isWorkdayValidationError, recordInvoiceValidationFailure } from './lib/invoice_validation_failures.js';
import { notifyResult } from './lib/slack.js';
import type { InvoiceData, PresignedAttachment, WorkdayInvoice } from './lib/types.js';
import { annotateSupplierInvoice, executeWorkdayQuery, getInboundEmailsForOCRInvoices, getSupplierInvoiceWithAttachments, getWorkQueueTagWIDs, submitSupplierInvoiceUpdate } from './lib/workday.js';
import { invoiceEnrichmentPrompt, InvoiceEnrichmentSchema, type InvoiceEnrichmentResult } from './prompts/enrich_invoice_prompt.js';

const MODIFIED_TAG_REF_ID = process.env.WORKDAY_AGENT_MODIFIED_TAG_REF_ID || 'FINAGENT-invoice-modified';
const DEFAULT_SUPPLIER_WID = process.env.WORKDAY_DEFAULT_SUPPLIER_WID;
const INVOICE_MOD_ENABLED = process.env.INVOICE_MOD_ENABLED !== 'false'; // enabled by default

async function buildQuery(context: Parameters<typeof getWorkQueueTagWIDs>[0]): Promise<string> {
  const wids = await getWorkQueueTagWIDs(context, [MODIFIED_TAG_REF_ID]);

  const widList = wids.map(wid => `'${wid}'`).join(', ');

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  return `
  SELECT
    workdayID,
    OCRSupplierInvoice,
    supplier,
    company1
  FROM supplierInvoices (dataSourceFilter = supplierInvoicesFilter)
  WHERE OCRSupplierInvoice is not empty
    AND workQueueTags not in (${widList})
    AND invoiceStatusAsText = 'Draft'
    AND isCanceled = false
    AND invoiceReceivedDate >= '${yesterdayStr}'
    AND invoiceIsPaid = false
    AND invoiceIsPartiallyPaid = false
  LIMIT 5
`;
}


// Query function - scheduled daily
export const handler = withHandler(async (context) => {
  const processorFunctionName = `${process.env.AWS_STACK_NAME}-EnrichInvoiceProcessor`;

  const [invoiceQuery, emailMap] = await Promise.all([
    buildQuery(context).then(query => executeWorkdayQuery(context.workdayConfig, query)),
    getInboundEmailsForOCRInvoices(context.workdayConfig),
  ]);

  const allData = invoiceQuery.data;
  if (!allData || !Array.isArray(allData) || allData.length === 0) {
    debug('No invoices found to process');
    return;
  }

  debug(`Found ${allData.length} invoices, ${emailMap.size} email mappings`);

  const lambda = new LambdaClient({ region: process.env.AWS_REGION });

  for (const invoice of allData) {
    const inv = invoice as any;
    const emailContext = emailMap.get(inv.workdayID) || undefined;
    debug(`Invoice ${inv.workdayID}: emailContext ${emailContext ? 'found' : 'not found'}`);
    if (emailContext) {
      debug(`Email context for ${inv.workdayID}:`, emailContext);
    }
    const enrichedInvoice = { ...inv, emailContext };

    await lambda.send(new InvokeCommand({
      FunctionName: processorFunctionName,
      InvocationType: 'Event',
      Payload: JSON.stringify({
        data: [enrichedInvoice],
        page: 1,
        totalPages: 1
      })
    }));
  }
});

// Processor function - invoked by query function
export const processor = withProcessorHandler(async (context, invoices, _event) => {
  // Process single invoice (invoices will be array with one item)
  for (const invoice of invoices) {
    await processInvoice(context, invoice as InvoiceData);
  }
});
async function processInvoice(context: ProcessingContext, invoiceData: InvoiceData): Promise<void> {
  const startTime = Date.now();

  if (await isInvoiceMarkedForSkip(context.invoiceValidationFailuresConfig, invoiceData.workdayID)) {
    debug(`Skipping invoice ${invoiceData.workdayID} because it is already marked in the validation skip registry`);
    return;
  }

  debug(`Processing invoice with workdayID: ${invoiceData.workdayID}`);

  try {
    // Get detailed invoice data with attachments using SOAP API
    const { invoice: detailedInvoice, presignedAttachments: processedAttachments } = await getSupplierInvoiceWithAttachments(
      context,
      invoiceData.workdayID
    );

    debug(`Successfully processed ${processedAttachments.length} attachments`);

    const canModifyInvoice = INVOICE_MOD_ENABLED;

    const existingSupplier = invoiceData.supplier?.descriptor
      ? { descriptor: invoiceData.supplier.descriptor, id: invoiceData.supplier.id }
      : undefined;

    const existingCompany = invoiceData.company1?.descriptor
      ? { descriptor: invoiceData.company1.descriptor, id: invoiceData.company1.id }
      : undefined;

    debug(existingSupplier ? 'Enriching invoice with existing supplier' : 'Enriching invoice - no supplier assigned');
    const result = await enrichInvoice(detailedInvoice, processedAttachments, existingSupplier, existingCompany, invoiceData.emailContext);
    debug('Enrichment result:', result);

    if (result.supplier.status === 'error') {
      throw new Error(`Invoice enrichment returned error status: ${result.supplier.reason}`);
    }

    const processingTime = Date.now() - startTime;
    const memo = result.supplier.extractedInformation?.memo || undefined;
    const extractedInvoiceDate = result.extractedInvoiceDate || undefined;

    const resolvedSupplierWID = result.supplier.resolvedSupplier?.workdayId
      ?? (result.supplier.status === 'matching' ? existingSupplier?.id : undefined);
    const targetSupplierWID = resolvedSupplierWID ?? DEFAULT_SUPPLIER_WID;
    const recommendedCompanyWID = result.companyVerification?.status === 'different'
      ? result.companyVerification.recommended?.workdayId ?? undefined
      : undefined;

    debug(`Supplier resolution: status=${result.supplier.status}, targetSupplierWID=${targetSupplierWID ?? 'none'}`);
    debug(`Company resolution: status=${result.companyVerification?.status}, companyWID=${recommendedCompanyWID ?? '(none - keeping existing)'}`);

    const extractedSuppliersInvoiceNumber = result.extractedSuppliersInvoiceNumber || undefined;
    const baseNotes = result.supplier.reason + formatCompanyNotes(result) + formatInvoiceDateNotes(result) + formatAmountNotes(result) + formatFallbackNotes(!resolvedSupplierWID);

    if (canModifyInvoice && targetSupplierWID) {
      debug(`Setting supplier to WID=${targetSupplierWID}`);
      await submitSupplierInvoiceUpdate(context, {
        invoiceWorkdayID: invoiceData.workdayID,
        supplierWID: targetSupplierWID,
        notes: baseNotes,
        memo,
        invoiceDate: extractedInvoiceDate,
        companyWID: recommendedCompanyWID,
        extractedAmountDue: result.extractedAmountDue ?? undefined,
        supplierInvoiceNumber: extractedSuppliersInvoiceNumber
      });
    } else {
      debug('Invoice modification disabled or no supplier available - recording notes only');
      const notes = baseNotes + formatInvoiceNumberNotes(result);
      await annotateSupplierInvoice(context, {
        invoiceWorkdayID: invoiceData.workdayID,
        notes,
        memo,
        invoiceDate: extractedInvoiceDate
      });
    }

    await notifyResult(
      'enrich_invoice',
      'success',
      processingTime,
      {
        workdayId: invoiceData.workdayID,
        invoiceNumber: detailedInvoice.Invoice_Number || 'Unknown',
        result: result.supplier,
        companyVerification: result.companyVerification
      },
      undefined,
      `invoice: \`${detailedInvoice.Invoice_Number || 'Unknown'}\``
    );
  } catch (error) {
    const processingTime = Date.now() - startTime;
    debug('Error in supplier enrichment process:', error);

    await notifyResult(
      'enrich_invoice',
      'error',
      processingTime,
      {
        workdayId: invoiceData.workdayID,
        processingTime: `${processingTime}ms`
      },
      error
    );

    if (isWorkdayValidationError(error)) {
      debug(`Validation failure detected for invoice ${invoiceData.workdayID} - recording in skip registry`);
      await recordInvoiceValidationFailure(context.invoiceValidationFailuresConfig, invoiceData.workdayID, error);
      return;
    }

    throw error;
  }
}

async function enrichInvoice(
  invoice: WorkdayInvoice,
  processedAttachments: PresignedAttachment[],
  existingSupplier?: { descriptor: string; id: string },
  existingCompany?: { descriptor: string; id: string },
  emailContext?: InvoiceData['emailContext']
): Promise<InvoiceEnrichmentResult> {
  debug('Enriching invoice:', invoice.Invoice_Number);

  try {
    const company = existingCompany
      ? { name: existingCompany.descriptor, id: existingCompany.id }
      : undefined;

    const invoiceData = {
      existingSupplier: existingSupplier
        ? { name: existingSupplier.descriptor, id: existingSupplier.id }
        : undefined,
      existingCompany: company,
      companyName: existingCompany?.descriptor || invoice.OCRSupplierInvoice?.descriptor,
      address: extractAddressFromInvoice(invoice),
      phone: extractPhoneFromInvoice(invoice),
      email: extractEmailFromInvoice(invoice),
      invoiceNumber: invoice.Invoice_Number,
      currentInvoiceDate: invoice.Invoice_Date,
      amount: invoice.controlTotalAmount,
      assignedCostCenters: extractCostCentersFromInvoice(invoice),
      attachments: processedAttachments.map(att => ({
        fileName: att.fileName,
        contentType: att.contentType,
        presignedUrl: att.presignedUrl
      })),
      emailContext
    };

    const emailContextText = emailContext
      ? `\n\nAdditional context from inbound email:\nFrom: ${emailContext.emailFrom || 'N/A'}\nSubject: ${emailContext.subject || 'N/A'}\nBody: ${emailContext.plainTextBody || 'N/A'}`
      : '';

    const existingSupplierText = existingSupplier
      ? `\nExisting Supplier: ${existingSupplier.descriptor} (ID: ${existingSupplier.id})`
      : '\nExisting Supplier: None (supplier has not been assigned yet)';

    const existingCompanyText = company
      ? `\nExisting Company: ${company.name} (ID: ${company.id})`
      : '';

    const taskDescription = existingSupplier
      ? 'Please verify the supplier and company on this invoice'
      : 'Please identify the supplier and verify the company on this invoice';

    const taskInstructions = existingSupplier
      ? 'Extract supplier and company information from the invoice attachments. Compare them with the existing supplier and company. Use the findSuppliers tool if you think the supplier might be different. Use the findCompanies tool if you think the company might be different. If email context is provided, check for a cost center reference and compare it against the assignedCostCenters using the findCostCenters tool if needed.'
      : 'Use the findSuppliers tool to search for relevant suppliers and then provide your analysis. Reference the images from the invoice attachments to help you identify the supplier. Also verify the company using the findCompanies tool if needed. If email context is provided, check for a cost center reference and compare it against the assignedCostCenters using the findCostCenters tool if needed.';

    const result = await getAiResponse({
      prompt: invoiceEnrichmentPrompt,
      schema: InvoiceEnrichmentSchema,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `${taskDescription}:${existingSupplierText}${existingCompanyText}\n\nInvoice Data: ${JSON.stringify(invoiceData, null, 2)}\n\n${taskInstructions}${emailContextText}`
            },
            ...processedAttachments
              .filter(att => att.contentType.startsWith('image/'))
              .map(att => ({
                type: 'image' as const,
                image: new URL(att.presignedUrl)
              }))
          ]
        }
      ]
    });

    return result as InvoiceEnrichmentResult;

  } catch (error) {
    debug('Error in invoice enrichment:', error);
    throw error;
  }
}

function formatCompanyNotes(result: InvoiceEnrichmentResult): string {
  const cv = result.companyVerification;
  if (!cv || cv.status === 'matching') return '';
  let notes = `\n\nCompany: ${cv.reason}`;
  if (cv.status === 'different' && cv.recommended) {
    notes += ` Recommended: ${cv.recommended.companyName}`;
  }
  return notes;
}

function formatFallbackNotes(usedDefaultSupplier: boolean): string {
  const parts: string[] = [];
  if (usedDefaultSupplier && DEFAULT_SUPPLIER_WID) {
    parts.push(`Supplier: ${DEFAULT_SUPPLIER_WID} (no match found, default applied)`);
  }
  if (process.env.FALLBACK_FUND_ID) {
    parts.push(`Fund: ${process.env.FALLBACK_FUND_ID} (applied to lines without an existing fund)`);
  }
  if (process.env.FALLBACK_COST_CENTER_ID) {
    parts.push(`Cost Center: ${process.env.FALLBACK_COST_CENTER_ID} (applied to lines without an existing cost center)`);
  }
  if (process.env.FALLBACK_PAYMENT_TERMS_ID) {
    parts.push(`Payment Terms: ${process.env.FALLBACK_PAYMENT_TERMS_ID} (applied when not already set)`);
  }
  if (!parts.length) return '';
  return `\n\nFallback values applied: ${parts.join('; ')}`;
}

function getFirstDayOfCurrentMonth(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = `${now.getUTCMonth() + 1}`.padStart(2, '0');
  return `${year}-${month}-01`;
}

function formatAmountNotes(result: InvoiceEnrichmentResult): string {
  if (!result.extractedAmountDue) return '';
  return `\n\nInvoice Amount (from document): ${result.extractedAmountDue}`;
}

function formatInvoiceNumberNotes(result: InvoiceEnrichmentResult): string {
  if (!result.extractedSuppliersInvoiceNumber) return '';
  return `\n\nSupplier Invoice Number (from document): ${result.extractedSuppliersInvoiceNumber}`;
}

function formatInvoiceDateNotes(result: InvoiceEnrichmentResult): string {
  if (result.extractedInvoiceDate) {
    return `\n\nInvoice Date (from document): ${result.extractedInvoiceDate}`;
  }

  const fallbackInvoiceDate = getFirstDayOfCurrentMonth();
  return `\n\nInvoice Date: Date was not extracted from the document and defaulted to the beginning of the current month (${fallbackInvoiceDate}).`;
}

// Helper functions to extract data from invoice
function extractAddressFromInvoice(invoice: WorkdayInvoice): string | undefined {
  if (invoice.allAddresses && invoice.allAddresses.length > 0) {
    return invoice.allAddresses.map(addr => addr.descriptor).join(', ');
  }
  return undefined;
}

function extractPhoneFromInvoice(invoice: WorkdayInvoice): string | undefined {
  if (invoice.allPhoneNumbers && invoice.allPhoneNumbers.length > 0) {
    return invoice.allPhoneNumbers.map(phone => phone.descriptor).join(', ');
  }
  return undefined;
}

function extractEmailFromInvoice(invoice: WorkdayInvoice): string | undefined {
  if (invoice.allEmailAddresses && invoice.allEmailAddresses.length > 0) {
    return invoice.allEmailAddresses.map(email => email.descriptor).join(', ');
  }
  return undefined;
}

function extractCostCentersFromInvoice(invoice: WorkdayInvoice): string[] {
  const results: string[] = [];
  JSON.stringify(invoice, (_, value) => {
    if (value?.$attributes?.type === 'Cost_Center_Reference_ID') {
      results.push(value.$value);
    }
    return value;
  });
  return [...new Set(results)];
}
