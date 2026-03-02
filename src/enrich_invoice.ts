import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { debug } from '@pga/logger';
import { getAiResponse } from './lib/ai.js';
import { withHandler, withProcessorHandler, type ProcessingContext } from './lib/handlers.js';
import { notifyResult } from './lib/slack.js';
import type { InvoiceData, PresignedAttachment, WorkdayInvoice } from './lib/types.js';
import { addNoSupplierTagToInvoice, executeWorkdayQuery, getInboundEmailsForOCRInvoices, getSupplierInvoiceWithAttachments, getWorkQueueTagWIDs, updateSupplierInvoiceSupplier, updateVerifySupplierInvoiceData } from './lib/workday.js';
import { invoiceEnrichmentPrompt, InvoiceEnrichmentSchema, type InvoiceEnrichmentResult } from './prompts/enrich_invoice_prompt.js';

const MODIFIED_TAG_REF_ID = process.env.WORKDAY_AGENT_MODIFIED_TAG_REF_ID || 'FINAGENT-invoice-modified';
const NO_SUPPLIER_TAG_REF_ID = process.env.WORKDAY_AGENT_NO_SUPPLIER_TAG_REF_ID || 'FINAGENT-no-supplier';
const INVOICE_MOD_ENABLED = process.env.INVOICE_MOD_ENABLED !== 'false'; // enabled by default

async function buildQuery(context: Parameters<typeof getWorkQueueTagWIDs>[0]): Promise<string> {
  const wids = await getWorkQueueTagWIDs(context, [MODIFIED_TAG_REF_ID, NO_SUPPLIER_TAG_REF_ID]);

  const widList = wids.map(wid => `'${wid}'`).join(', ');

  return `
  SELECT
    workdayID,
    invoiceStatusAsText,
    OCRSupplierInvoice,
    supplier
  FROM supplierInvoices (dataSourceFilter = supplierInvoicesFilter)
  WHERE OCRSupplierInvoice is not empty
    AND workQueueTags not in (${widList})
    AND invoiceStatusAsText in ('Draft', 'In Progress')
    AND isCanceled = false
    AND invoiceDate >= '2026-03-01'
    AND invoiceIsPaid = false
    AND invoiceIsPartiallyPaid = false
  LIMIT 1
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
  debug(`Processing invoice with workdayID: ${invoiceData.workdayID}`);

  try {
    // Get detailed invoice data with attachments using SOAP API
    const { invoice: detailedInvoice, presignedAttachments: processedAttachments } = await getSupplierInvoiceWithAttachments(
      context,
      invoiceData.workdayID
    );

    debug(`Successfully processed ${processedAttachments.length} attachments`);

    // Only allow supplier/tag modifications on Draft invoices
    const isDraft = invoiceData.invoiceStatusAsText === 'Draft';
    const canModifyInvoice = INVOICE_MOD_ENABLED && isDraft;

    if (!isDraft) {
      debug(`Invoice ${invoiceData.workdayID} is in '${invoiceData.invoiceStatusAsText}' status - will only add notes`);
    }

    const existingSupplier = invoiceData.supplier?.descriptor
      ? { descriptor: invoiceData.supplier.descriptor, id: invoiceData.supplier.id }
      : undefined;

    debug(existingSupplier ? 'Enriching invoice with existing supplier' : 'Enriching invoice - no supplier assigned');
    const result = await enrichInvoice(detailedInvoice, processedAttachments, existingSupplier, invoiceData.emailContext);
    debug('Enrichment result:', result);

    const processingTime = Date.now() - startTime;
    const companyNotes = formatCompanyVerificationNotes(result);
    const emailSummary = result.emailSummary ? `\n\nEmail Summary: ${result.emailSummary}` : '';
    const memo = result.supplier.extractedInformation?.memo || undefined;

    switch (result.supplier.status) {
      case 'found': {
        const status = 'success';
        await notifyResult(
          'enrich_invoice',
          status,
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
        await handleFoundSupplier(context, invoiceData.workdayID, result, companyNotes, canModifyInvoice);
        break;
      }

      case 'not_found': {
        debug('Supplier not found - adding no-supplier work queue tag');
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
        const notFoundNotes = `AI Agent could not find a matching supplier to add. AI Agent Recommendation: ${result.supplier.recommendation.action}\n${result.supplier.recommendation.reason}${companyNotes}${emailSummary}`;
        if (canModifyInvoice) {
          await addNoSupplierTagToInvoice(context, invoiceData.workdayID, notFoundNotes, memo);
        } else {
          debug('Invoice modification disabled - recording recommendation as notes only');
          await updateVerifySupplierInvoiceData(context, invoiceData.workdayID, notFoundNotes, memo);
        }
        break;
      }

      case 'ambiguous': {
        debug('Ambiguous supplier identification - flagging for manual review');
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
        const ambiguousNotes = `AI Agent could not confidently find a matching supplier to add. AI Agent Recommendation: ${result.supplier.recommendation.action}\n${result.supplier.recommendation.reason}${companyNotes}${emailSummary}`;
        if (canModifyInvoice) {
          await addNoSupplierTagToInvoice(context, invoiceData.workdayID, ambiguousNotes, memo);
        } else {
          debug('Invoice modification disabled - recording recommendation as notes only');
          await updateVerifySupplierInvoiceData(context, invoiceData.workdayID, ambiguousNotes, memo);
        }
        break;
      }

      case 'error': {
        debug('Error in supplier identification - flagging for manual review');
        await notifyResult(
          'enrich_invoice',
          'error',
          processingTime,
          {
            workdayId: invoiceData.workdayID,
            invoiceNumber: detailedInvoice.Invoice_Number || 'Unknown',
            result: result.supplier,
            companyVerification: result.companyVerification
          },
          result.supplier,
          `invoice: \`${detailedInvoice.Invoice_Number || 'Unknown'}\``
        );
        const errorNotes = `AI Agent encountered an error while looking for a matching supplier. AI Agent Recommendation: ${result.supplier.recommendation.action}\n${result.supplier.recommendation.reason}${companyNotes}${emailSummary}`;
        if (canModifyInvoice) {
          await addNoSupplierTagToInvoice(context, invoiceData.workdayID, errorNotes, memo);
        } else {
          debug('Invoice modification disabled - recording recommendation as notes only');
          await updateVerifySupplierInvoiceData(context, invoiceData.workdayID, errorNotes, memo);
        }
        break;
      }

      case 'matching': {
        debug('Supplier verified as matching - updating invoice with memo');
        await notifyResult(
          'verify_invoice_data',
          'success',
          processingTime,
          {
            workdayId: invoiceData.workdayID,
            invoiceNumber: detailedInvoice.Invoice_Number || 'Unknown',
            existingSupplier: invoiceData.supplier?.descriptor,
            result
          },
          undefined,
          `invoice: \`${detailedInvoice.Invoice_Number || 'Unknown'}\``
        );
        const matchingNotes = `AI Agent verified supplier is correct. ${result.supplier.reason}${companyNotes}${emailSummary}`;
        await updateVerifySupplierInvoiceData(context, invoiceData.workdayID, matchingNotes, memo);
        break;
      }

      case 'different': {
        debug('Supplier verification found different supplier - adding revision note');
        await notifyResult(
          'verify_invoice_data',
          'success',
          processingTime,
          {
            workdayId: invoiceData.workdayID,
            invoiceNumber: detailedInvoice.Invoice_Number || 'Unknown',
            existingSupplier: invoiceData.supplier?.descriptor,
            result
          },
          undefined,
          `invoice: \`${detailedInvoice.Invoice_Number || 'Unknown'}\``
        );
        const recommended = result.supplier.resolvedSupplier;
        const differentNotes = recommended
          ? `AI Agent recommends supplier revision. Recommended supplier: ${recommended.supplierName} (${recommended.supplierId}).
        Confidence: ${(recommended.confidence * 100).toFixed(0)}%.
        Reason: ${recommended.reason}\n\nVerification details: ${result.supplier.reason}${companyNotes}${emailSummary}`
          : `AI Agent recommends supplier revision. ${result.supplier.reason}${companyNotes}${emailSummary}`;
        await updateVerifySupplierInvoiceData(context, invoiceData.workdayID, differentNotes, memo);
        break;
      }

      case 'uncertain': {
        await notifyResult(
          'verify_invoice_data',
          'success',
          processingTime,
          {
            workdayId: invoiceData.workdayID,
            invoiceNumber: detailedInvoice.Invoice_Number || 'Unknown',
            existingSupplier: invoiceData.supplier?.descriptor,
            result
          },
          undefined,
          `invoice: \`${detailedInvoice.Invoice_Number || 'Unknown'}\``
        );
        const uncertainNotes = `AI Agent is uncertain that the supplier is correct. ${result.supplier.reason}${companyNotes}${emailSummary}`;
        await updateVerifySupplierInvoiceData(context, invoiceData.workdayID, uncertainNotes, memo);
        break;
      }
    }
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

    throw error;
  }
}

async function handleFoundSupplier(
  context: ProcessingContext,
  invoiceWorkdayID: string,
  result: InvoiceEnrichmentResult,
  companyNotes: string = '',
  canModifyInvoice: boolean = INVOICE_MOD_ENABLED
): Promise<void> {
  debug('Supplier found in Workday - updating invoice');
  const foundSupplierID = result.supplier.resolvedSupplier?.supplierId;

  if (foundSupplierID) {
    const emailSummarySection = result.emailSummary ? `\n\nEmail Summary: ${result.emailSummary}` : '';
    const notes = `AI Agent found matching supplier. AI Agent Recommendation: ${result.supplier.recommendation.action}\n${result.supplier.recommendation.reason}${companyNotes}${emailSummarySection}`;
    const memo = result.supplier.extractedInformation?.memo || undefined;

    if (canModifyInvoice) {
      await updateSupplierInvoiceSupplier(
        context,
        invoiceWorkdayID,
        foundSupplierID,
        notes,
        memo
      );
    } else {
      debug('Invoice modification disabled - recording supplier recommendation as notes only');
      await updateVerifySupplierInvoiceData(context, invoiceWorkdayID, notes, memo);
    }
  } else {
    debug('No valid supplier Workday ID found - cannot update invoice');
  }
}

async function enrichInvoice(
  invoice: WorkdayInvoice,
  processedAttachments: PresignedAttachment[],
  existingSupplier?: { descriptor: string; id: string },
  emailContext?: InvoiceData['emailContext']
): Promise<InvoiceEnrichmentResult> {
  debug('Enriching invoice:', invoice.Invoice_Number);

  try {
    const existingCompany = invoice.company1
      ? { name: invoice.company1.descriptor, id: invoice.company1.id }
      : undefined;

    const invoiceData = {
      existingSupplier: existingSupplier
        ? { name: existingSupplier.descriptor, id: existingSupplier.id }
        : undefined,
      existingCompany,
      companyName: invoice.company1?.descriptor || invoice.OCRSupplierInvoice?.descriptor,
      address: extractAddressFromInvoice(invoice),
      phone: extractPhoneFromInvoice(invoice),
      email: extractEmailFromInvoice(invoice),
      invoiceNumber: invoice.Invoice_Number,
      amount: invoice.controlTotalAmount,
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

    const existingCompanyText = existingCompany
      ? `\nExisting Company: ${existingCompany.name} (ID: ${existingCompany.id})`
      : '';

    const taskDescription = existingSupplier
      ? 'Please verify the supplier and company on this invoice'
      : 'Please identify the supplier and verify the company on this invoice';

    const taskInstructions = existingSupplier
      ? 'Extract supplier and company information from the invoice attachments. Compare them with the existing supplier and company. Use the findSuppliers tool if you think the supplier might be different. Use the findCompanies tool if you think the company might be different.'
      : 'Use the findSuppliers tool to search for relevant suppliers and then provide your analysis. Reference the images from the invoice attachments to help you identify the supplier. Also verify the company using the findCompanies tool if needed.';

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
    return {
      supplier: {
        status: existingSupplier ? 'uncertain' : 'error',
        confidence: 0,
        extractedInformation: {},
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: {
          action: 'manual_review',
          reason: `Error in invoice enrichment: ${error}`
        },
        reason: `Error in invoice enrichment: ${error}`
      },
      companyVerification: {
        status: 'uncertain',
        confidence: 0,
        extractedInformation: {},
        recommended: null,
        reason: `Error in invoice enrichment: ${error}`
      }
    };
  }
}

function formatCompanyVerificationNotes(result: InvoiceEnrichmentResult): string {
  const cv = result.companyVerification;
  let companyNotes = `\n\nCompany Verification: ${cv.status} - ${cv.reason}`;

  if (cv.recommended) {
    companyNotes += `\nRecommended Company: ${cv.recommended.companyName} (${cv.recommended.companyId}). Confidence: ${(cv.recommended.confidence * 100).toFixed(0)}%. Reason: ${cv.recommended.reason}`;
  }

  return companyNotes;
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
