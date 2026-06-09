import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { debug } from '@pga/logger';
import { getAiResponse } from './lib/ai.js';
import { withHandler, withProcessorHandler, type ProcessingContext } from './lib/handlers.js';
import { isInvoiceMarkedForSkip, isWorkdayValidationError, recordInvoiceValidationFailure } from './lib/invoice_validation_failures.js';
import { notifyEnrichmentResult, notifyResult } from './lib/slack.js';
import type { InvoiceData, PresignedAttachment, WorkdayInvoice } from './lib/types.js';
import type { AppliedFallback, ExtractedInvoiceLine, PurchaseOrderLine } from './lib/workday.js';
import { annotateSupplierInvoice, executeWorkdayQuery, getInboundEmailsForOCRInvoices, getPurchaseOrder, getSupplierInvoiceWithAttachments, getWorkQueueTagWIDs, parsePurchaseOrderLines, submitSupplierInvoiceUpdate } from './lib/workday.js';
import { invoiceEnrichmentPrompt, InvoiceEnrichmentSchema, type InvoiceEnrichmentResult } from './prompts/enrich_invoice_prompt.js';

const MODIFIED_TAG_REF_ID = process.env.WORKDAY_AGENT_MODIFIED_TAG_REF_ID || 'FINAGENT-invoice-modified';
const DEFAULT_SUPPLIER_WID = process.env.WORKDAY_DEFAULT_SUPPLIER_WID;
const INVOICE_MOD_ENABLED = process.env.INVOICE_MOD_ENABLED !== 'false'; // enabled by default
const WORKDAY_TASK_NOT_AUTHORIZED_MESSAGE = 'The task submitted is not authorized';

function errorText(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }

  if (error instanceof Error) {
    return `${error.name}: ${error.message}\n${error.stack ?? ''}`;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return '';
  }
}

function isWorkdayTaskNotAuthorizedError(error: unknown): boolean {
  return errorText(error).includes(WORKDAY_TASK_NOT_AUTHORIZED_MESSAGE);
}

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
    const extractedAmountDue = result.extractedAmountDue ?? undefined;
    const extractedFreightAmount = result.extractedFreightAmount ?? undefined;
    const rawPurchaseOrderNumber = result.extractedPurchaseOrderNumber || undefined;
    const normalizedPurchaseOrderNumber = rawPurchaseOrderNumber
      ? `PO-${rawPurchaseOrderNumber.replace(/^[Pp][Oo]-?/, '')}`
      : undefined;
    const extractedPurchaseOrderNumber = /^PO-\w{6}$/.test(normalizedPurchaseOrderNumber ?? '')
      ? normalizedPurchaseOrderNumber
      : undefined;
    let poLines: Awaited<ReturnType<typeof parsePurchaseOrderLines>> | undefined;
    if (canModifyInvoice && extractedPurchaseOrderNumber) {
      debug(`Fetching PO data for extracted PO number: ${extractedPurchaseOrderNumber}`);
      const poResponse = await getPurchaseOrder(context, extractedPurchaseOrderNumber);
      debug(`PO response for ${extractedPurchaseOrderNumber}: ${JSON.stringify(poResponse)}`);
      poLines = parsePurchaseOrderLines(poResponse);
      debug(`Parsed ${poLines.length} line(s) from PO ${extractedPurchaseOrderNumber}`);
    }

    const candidateLines = canModifyInvoice && !extractedPurchaseOrderNumber
      ? (result.extractedInvoiceLines ?? [])
      : [];
    const extractedLines: ExtractedInvoiceLine[] | undefined =
      candidateLines.length > 0 && candidateLines.every(l => l.description && l.quantity != null && l.unitCost && l.totalPrice)
        ? candidateLines
        : undefined;

    if (extractedLines) {
      debug(`Using ${extractedLines.length} extracted invoice line(s) from document`);
    }

    const upfrontFallbacks = getUpfrontFallbacks(resolvedSupplierWID, detailedInvoice, poLines, extractedLines);
    const baseNotes = formatSupplierNotes(result) + formatCompanyNotes(result) + formatInvoiceDateNotes(result) + formatAmountNotes(result) + formatFreightAmountNotes(result) + formatInvoiceNumberNotes(result) + formatPurchaseOrderNotes(result) + formatInvoiceLinesNotes(result) + formatPaymentTermsNotes(result);
    const buildNotes = (submissionFallbacks: AppliedFallback[]) =>
      baseNotes + formatFallbackNotes(mergeFallbacks(upfrontFallbacks, submissionFallbacks));

    let fallbacks: Fallbacks;
    if (canModifyInvoice && targetSupplierWID) {
      debug(`Setting supplier to WID=${targetSupplierWID}`);

      const paymentTermsId = result.extractedPaymentTerms?.workdayId ?? undefined;

      const updateOutcome = await submitSupplierInvoiceUpdate(context, {
        invoiceWorkdayID: invoiceData.workdayID,
        supplierWID: targetSupplierWID,
        buildNotes,
        memo,
        invoiceDate: extractedInvoiceDate,
        companyWID: recommendedCompanyWID,
        extractedAmountDue,
        suppliersInvoiceNumber: extractedSuppliersInvoiceNumber,
        extractedFreightAmount,
        poLines,
        extractedLines,
        paymentTermsId
      });
      if (!updateOutcome.success) {
        debug(`Skipping enrichment notification — Workday update failed: ${updateOutcome.message ?? '(no message)'}`);
        return;
      }
      fallbacks = mergeFallbacks(upfrontFallbacks, updateOutcome.appliedFallbacks);
    } else {
      debug('Invoice modification disabled or no supplier available - recording notes only');
      fallbacks = mergeFallbacks(upfrontFallbacks, []);
      await annotateSupplierInvoice(context, {
        invoiceWorkdayID: invoiceData.workdayID,
        notes: buildNotes([]),
        memo
      });
    }

    await notifyEnrichmentResult({
      processingTime,
      invoiceNumber: detailedInvoice.Invoice_Number || 'Unknown',
      canModify: canModifyInvoice && !!targetSupplierWID,
      supplier: {
        status: result.supplier.status,
        resolvedName: result.supplier.resolvedSupplier?.supplierName,
        existingName: existingSupplier?.descriptor,
        isDefault: fallbacks.defaultSupplier,
      },
      company: result.companyVerification ? {
        status: result.companyVerification.status,
        existingName: existingCompany?.descriptor,
        recommendedName: result.companyVerification.recommended?.companyName,
      } : undefined,
      extracted: {
        invoiceDate: extractedInvoiceDate,
        amountDue: extractedAmountDue,
        suppliersInvoiceNumber: extractedSuppliersInvoiceNumber,
        freightAmount: extractedFreightAmount,
        purchaseOrderNumber: extractedPurchaseOrderNumber,
        paymentTerms: result.extractedPaymentTerms?.name,
      },
      poLineCount: poLines?.length,
      suggestedCostCenters: result.costCenterVerification?.suggestedCostCenters ?? undefined,
      fallbacks: {
        defaultSupplier: fallbacks.defaultSupplier,
        fallbackFund: fallbacks.fund ? process.env.FALLBACK_FUND_ID : undefined,
        fallbackCostCenter: fallbacks.costCenter ? process.env.FALLBACK_COST_CENTER_ID : undefined,
        fallbackPaymentTerms: fallbacks.paymentTerms || undefined,
      },
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    debug('Error in supplier enrichment process:', error);
    const shouldSkipRetry = isWorkdayTaskNotAuthorizedError(error);

    await notifyResult(
      'enrich_invoice',
      'error',
      processingTime,
      {
        workdayId: invoiceData.workdayID,
        processingTime: `${processingTime}ms`,
        ...(shouldSkipRetry && {
          note: 'Workday returned "The task submitted is not authorized"; not retrying this Lambda invocation.'
        })
      },
      error,
      shouldSkipRetry ? 'Workday task not authorized - no retry' : undefined
    );

    if (shouldSkipRetry) {
      return;
    }

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
      : 'Use the findSuppliers tool to search for relevant suppliers and then provide your analysis. Reference the invoice attachments to help you identify the supplier. Also verify the company using the findCompanies tool if needed. If email context is provided, check for a cost center reference and compare it against the assignedCostCenters using the findCostCenters tool if needed.';

    const attachmentContentParts: Array<
      { type: 'file'; data: Buffer; mediaType: string; filename: string }
      | { type: 'image'; image: URL }
    > = [];

    for (const att of processedAttachments) {
      if (att.contentType === 'application/pdf' && att.buffer) {
        attachmentContentParts.push({
          type: 'file',
          data: att.buffer,
          mediaType: att.contentType,
          filename: att.fileName
        });
        continue;
      }

      if (att.contentType.startsWith('image/')) {
        attachmentContentParts.push({
          type: 'image',
          image: new URL(att.presignedUrl)
        });
      }
    }

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
            ...attachmentContentParts
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

function formatSupplierNotes(result: InvoiceEnrichmentResult): string {
  return `Supplier: ${result.supplier.reason}`;
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

interface UpfrontFallbacks {
  defaultSupplier: boolean;
  fund: boolean;
  costCenter: boolean;
  spendCategory: boolean;
}

interface Fallbacks extends UpfrontFallbacks {
  paymentTerms: boolean;
}

function mergeFallbacks(upfront: UpfrontFallbacks, submissionFallbacks: AppliedFallback[]): Fallbacks {
  return {
    defaultSupplier: upfront.defaultSupplier || submissionFallbacks.some(f => f.field === 'supplier'),
    fund: upfront.fund,
    costCenter: upfront.costCenter,
    spendCategory: upfront.spendCategory,
    paymentTerms: submissionFallbacks.some(f => f.field === 'paymentTerms'),
  };
}

function lineHasWorktag(line: any, type: string): boolean {
  const worktags = ([] as any[]).concat(line.worktagsReference ?? line.Worktags_Reference ?? []);
  return worktags.some((t: any) =>
    ([] as any[]).concat(t.ID ?? []).some((id: any) => id.$attributes?.type === type)
  );
}

function getUpfrontFallbacks(
  resolvedSupplierWID: string | undefined,
  detailedInvoice: { [key: string]: unknown },
  poLines?: PurchaseOrderLine[],
  extractedLines?: ExtractedInvoiceLine[]
): UpfrontFallbacks {
  if (extractedLines?.length) {
    return {
      defaultSupplier: !resolvedSupplierWID && !!DEFAULT_SUPPLIER_WID,
      fund: !!process.env.FALLBACK_FUND_ID,
      costCenter: !!process.env.FALLBACK_COST_CENTER_ID,
      spendCategory: !!process.env.FALLBACK_SPEND_CATEGORY_ID,
    };
  }

  const usingPOLines = !!(poLines?.length);
  const effectiveLines: any[] = usingPOLines
    ? poLines!
    : ([] as any[]).concat((detailedInvoice as any).Invoice_Line_Replacement_Data ?? []);

  const fund = !!(process.env.FALLBACK_FUND_ID && effectiveLines.some(l => !lineHasWorktag(l, 'Fund_ID')));
  const costCenter = !!(process.env.FALLBACK_COST_CENTER_ID && effectiveLines.some(l => !lineHasWorktag(l, 'Cost_Center_Reference_ID')));
  // Spend category is only applied to raw invoice lines (not PO lines)
  const spendCategory = !usingPOLines && !!(process.env.FALLBACK_SPEND_CATEGORY_ID && effectiveLines.some(l => !l.Spend_Category_Reference && !l.Item_Reference));

  return {
    defaultSupplier: !resolvedSupplierWID && !!DEFAULT_SUPPLIER_WID,
    fund,
    costCenter,
    spendCategory,
  };
}

function formatFallbackNotes(fallbacks: Fallbacks): string {
  const parts: string[] = [];
  if (fallbacks.defaultSupplier && DEFAULT_SUPPLIER_WID) {
    parts.push(`Supplier: ${DEFAULT_SUPPLIER_WID} (no match found, default applied)`);
  }
  if (fallbacks.fund && process.env.FALLBACK_FUND_ID) {
    parts.push(`Fund: ${process.env.FALLBACK_FUND_ID} (applied to lines without an existing fund)`);
  }
  if (fallbacks.costCenter && process.env.FALLBACK_COST_CENTER_ID) {
    parts.push(`Cost Center: ${process.env.FALLBACK_COST_CENTER_ID} (applied to lines without an existing cost center)`);
  }
  if (fallbacks.spendCategory && process.env.FALLBACK_SPEND_CATEGORY_ID) {
    parts.push(`Spend Category: ${process.env.FALLBACK_SPEND_CATEGORY_ID} (applied to lines without an existing spend category)`);
  }
  if (fallbacks.paymentTerms && process.env.FALLBACK_PAYMENT_TERMS_ID) {
    parts.push(`Payment Terms: ${process.env.FALLBACK_PAYMENT_TERMS_ID} (applied after validation error)`);
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

function formatFreightAmountNotes(result: InvoiceEnrichmentResult): string {
  if (!result.extractedFreightAmount) return '';
  return `\n\nFreight Amount (from document): ${result.extractedFreightAmount}`;
}

function formatInvoiceNumberNotes(result: InvoiceEnrichmentResult): string {
  if (!result.extractedSuppliersInvoiceNumber) return '';
  return `\n\nSupplier Invoice Number (from document): ${result.extractedSuppliersInvoiceNumber}`;
}

function formatPurchaseOrderNotes(result: InvoiceEnrichmentResult): string {
  if (!result.extractedPurchaseOrderNumber) return '';
  return `\n\nPurchase Order Number (from document): ${result.extractedPurchaseOrderNumber}`;
}

function formatPaymentTermsNotes(result: InvoiceEnrichmentResult): string {
  if (!result.extractedPaymentTerms) return '';
  const { name, workdayId } = result.extractedPaymentTerms;
  const resolvedSuffix = workdayId ? ` (resolved: ${workdayId})` : ' (no Workday match found)';
  return `\n\nPayment Terms (from document): ${name}${resolvedSuffix}`;
}

function formatInvoiceLinesNotes(result: InvoiceEnrichmentResult): string {
  if (!result.extractedInvoiceLines?.length) return '';
  const lineTexts = result.extractedInvoiceLines.map((line, i) => {
    const parts = [line.description];
    if (line.quantity != null) parts.push(`Qty: ${line.quantity}`);
    if (line.unitCost) parts.push(`Unit Cost: ${line.unitCost}`);
    if (line.totalPrice) parts.push(`Total: ${line.totalPrice}`);
    return `${i + 1}. ${parts.join(' | ')}`;
  });
  return `\n\nInvoice Lines (from document):\n${lineTexts.join('\n')}`;
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
