import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { debug } from '@pga/logger';
import { getAiResponse } from './lib/ai.js';
import { withHandler, withProcessorHandler } from './lib/handlers.js';
import { notifyResult } from './lib/slack.js';
import type { InvoiceData, PresignedAttachment } from './lib/types.js';
import { addNoSupplierTagToInvoice, executeWorkdayQuery, getInboundEmailsForOCRInvoices, getSupplierInvoiceWithAttachments, getWorkQueueTagWIDs, updateSupplierInvoiceSupplier, updateVerifySupplierInvoiceData } from './lib/workday.js';
import { supplierIdentificationPrompt, SupplierIdentificationSchema, type SupplierIdentificationResult } from './prompts/identify_supplier.js';
import { invoiceDataVerificationPrompt, InvoiceDataVerificationSchema, type InvoiceDataVerificationResult } from './prompts/verify_invoice_data.js';

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
    AND invoiceStatusAsText = 'Draft'
    AND workQueueTags not in (${widList})
    AND isCanceled = false
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
async function processInvoice(context: any, invoiceData: InvoiceData): Promise<void> {
  const startTime = Date.now();
  debug(`Processing invoice with workdayID: ${invoiceData.workdayID}`);

  try {
    // Get detailed invoice data with attachments using SOAP API
    const { invoice: detailedInvoice, presignedAttachments: processedAttachments } = await getSupplierInvoiceWithAttachments(
      context,
      invoiceData.workdayID
    );

    debug(`Successfully processed ${processedAttachments.length} attachments`);

    let supplierResult: SupplierIdentificationResult | undefined;
    if (!invoiceData.supplier || !invoiceData.supplier.descriptor) {
      debug('Missing supplier - identifying supplier');
      supplierResult = await identifySupplier(detailedInvoice, processedAttachments, invoiceData.emailContext);
      debug('Supplier result:', supplierResult);
    }

    const existingSupplier = invoiceData.supplier

    debug('Verifying invoice data');
    const verificationResult = await verifyInvoiceData(detailedInvoice, processedAttachments, existingSupplier, invoiceData.emailContext);
    debug('Verification result:', verificationResult);

    const processingTime = Date.now() - startTime;

    if (supplierResult) {
      const companyNotes = formatCompanyVerificationNotes(verificationResult);
      const status = supplierResult.status === 'error' ? 'error' : 'success';
      const details = {
        workdayId: invoiceData.workdayID,
        invoiceNumber: detailedInvoice.Invoice_Number || 'Unknown',
        result: supplierResult,
        companyVerification: verificationResult
      };

      await notifyResult(
        'enrich_invoice',
        status,
        processingTime,
        details,
        status === 'error' ? supplierResult : undefined,
        `invoice: \`${detailedInvoice.Invoice_Number || 'Unknown'}\``
      );

      const emailSummary = supplierResult.emailSummary ? `\n\nEmail Summary: ${supplierResult.emailSummary}` : '';
      switch (supplierResult.status) {
        case 'found':
          await handleFoundSupplier(context, invoiceData.workdayID, supplierResult, companyNotes);
          break;

        case 'not_found':
          debug('Supplier not found - adding no-supplier work queue tag');
          const notFoundNotes = `AI Agent could not find a matching supplier to add. AI Agent Recommendation: ${supplierResult.recommendation.action}\n${supplierResult.recommendation.reason}${companyNotes}${emailSummary}`;
          const memo = supplierResult.extractedSupplierInformation?.memo || undefined;
          if (INVOICE_MOD_ENABLED) {
            await addNoSupplierTagToInvoice(context, invoiceData.workdayID, notFoundNotes, memo);
          } else {
            debug('Invoice modification disabled - recording recommendation as notes only');
            await updateVerifySupplierInvoiceData(context, invoiceData.workdayID, notFoundNotes, memo);
          }
          break;

        case 'ambiguous':
          debug('Ambiguous supplier identification - flagging for manual review');
          debug('Supplier not found - adding no-supplier work queue tag');
          const ambiguousNotes = `AI Agent could not confidently find a matching supplier to add. AI Agent Recommendation: ${supplierResult.recommendation.action}\n${supplierResult.recommendation.reason}${companyNotes}${emailSummary}`;
          const ambiguousMemo = supplierResult.extractedSupplierInformation?.memo || undefined;
          if (INVOICE_MOD_ENABLED) {
            await addNoSupplierTagToInvoice(context, invoiceData.workdayID, ambiguousNotes, ambiguousMemo);
          } else {
            debug('Invoice modification disabled - recording recommendation as notes only');
            await updateVerifySupplierInvoiceData(context, invoiceData.workdayID, ambiguousNotes, ambiguousMemo);
          }
          break;

        case 'error':
          debug('Error in supplier identification - flagging for manual review');
          const errorNotes = `AI Agent encountered an error while looking for a matching supplier. AI Agent Recommendation: ${supplierResult.recommendation.action}\n${supplierResult.recommendation.reason}${companyNotes}${emailSummary}`;
          const errorMemo = supplierResult.extractedSupplierInformation?.memo || undefined;
          if (INVOICE_MOD_ENABLED) {
            await addNoSupplierTagToInvoice(context, invoiceData.workdayID, errorNotes, errorMemo);
          } else {
            debug('Invoice modification disabled - recording recommendation as notes only');
            await updateVerifySupplierInvoiceData(context, invoiceData.workdayID, errorNotes, errorMemo);
          }
          break;
      }
    } else {
      const details = {
        workdayId: invoiceData.workdayID,
        invoiceNumber: detailedInvoice.Invoice_Number || 'Unknown',
        existingSupplier: invoiceData.supplier?.descriptor,
        result: verificationResult
      };

      await notifyResult(
        'verify_invoice_data',
        'success',
        processingTime,
        details,
        undefined,
        `invoice: \`${detailedInvoice.Invoice_Number || 'Unknown'}\``
      );

      await handleVerificationResult(context, invoiceData.workdayID, verificationResult);
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
  context: any,
  invoiceWorkdayID: string,
  supplierResult: SupplierIdentificationResult,
  companyNotes: string = ''
): Promise<void> {
  debug('Supplier found in Workday - updating invoice');
  const foundSupplierID = supplierResult.resolvedSupplier?.supplierId;

  if (foundSupplierID) {
    const emailSummarySection = supplierResult.emailSummary ? `\n\nEmail Summary: ${supplierResult.emailSummary}` : '';
    const notes = `AI Agent found matching supplier. AI Agent Recommendation: ${supplierResult.recommendation.action}\n${supplierResult.recommendation.reason}${companyNotes}${emailSummarySection}`;
    const memo = supplierResult.extractedSupplierInformation?.memo || undefined;

    if (INVOICE_MOD_ENABLED) {
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


async function verifyInvoiceData(
  invoice: any,
  processedAttachments: PresignedAttachment[],
  existingSupplier?: { descriptor: string; id: string },
  emailContext?: InvoiceData['emailContext']
): Promise<InvoiceDataVerificationResult> {
  debug('Verifying invoice data for invoice:', invoice.Invoice_Number);

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

    const result = await getAiResponse({
      prompt: invoiceDataVerificationPrompt,
      schema: InvoiceDataVerificationSchema,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Please verify the supplier and company on this invoice:${existingSupplierText}${existingCompanyText}\n\nInvoice Data: ${JSON.stringify(invoiceData, null, 2)}\n\nExtract supplier and company information from the invoice attachments. Compare them with the existing supplier and company. Use the findSuppliers tool if you think the supplier might be different. Use the findCompanies tool if you think the company might be different.${emailContextText}`
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

    return result as InvoiceDataVerificationResult;

  } catch (error) {
    debug('Error in invoice data verification:', error);
    return {
      supplierVerification: {
        status: 'uncertain' as const,
        confidence: 0,
        extractedInformation: {},
        recommended: null,
        reason: `Error in verification: ${error}`
      },
      companyVerification: {
        status: 'uncertain' as const,
        confidence: 0,
        extractedInformation: {},
        recommended: null,
        reason: `Error in verification: ${error}`
      }
    };
  }
}

function formatCompanyVerificationNotes(verificationResult: InvoiceDataVerificationResult): string {
  const cv = verificationResult.companyVerification;
  let companyNotes = `\n\nCompany Verification: ${cv.status} - ${cv.reason}`;

  if (cv.recommended) {
    companyNotes += `\nRecommended Company: ${cv.recommended.companyName} (${cv.recommended.companyId}). Confidence: ${(cv.recommended.confidence * 100).toFixed(0)}%. Reason: ${cv.recommended.reason}`;
  }

  return companyNotes;
}

async function handleVerificationResult(
  context: any,
  invoiceWorkdayID: string,
  verificationResult: InvoiceDataVerificationResult
): Promise<void> {
  const sv = verificationResult.supplierVerification;
  const memo = sv.extractedInformation?.memo || undefined;
  const emailSummarySection = verificationResult.emailSummary ? `\n\nEmail Summary: ${verificationResult.emailSummary}` : '';
  const companySection = formatCompanyVerificationNotes(verificationResult);

  switch (sv.status) {
    case 'matching':
      {
        debug('Supplier verified as matching - updating invoice with memo');
        const notes = `AI Agent verified supplier is correct. ${sv.reason}${companySection}${emailSummarySection}`;
        await updateVerifySupplierInvoiceData(context, invoiceWorkdayID, notes, memo);
        break;
      }

    case 'different':
      debug('Supplier verification found different supplier - adding revision note');
      const recommended = sv.recommended;
      const notes = recommended
        ? `AI Agent recommends supplier revision. Recommended supplier: ${recommended.supplierName} (${recommended.supplierId}).
        Confidence: ${(recommended.confidence * 100).toFixed(0)}%.
        Reason: ${recommended.reason}\n\nVerification details: ${sv.reason}${companySection}${emailSummarySection}`
        : `AI Agent recommends supplier revision. ${sv.reason}${companySection}${emailSummarySection}`;
      await updateVerifySupplierInvoiceData(context, invoiceWorkdayID, notes, memo);
      break;

    case 'uncertain':
      {
        const notes = `AI Agent is uncertain that the supplier is correct. ${sv.reason}${companySection}${emailSummarySection}`;
        await updateVerifySupplierInvoiceData(context, invoiceWorkdayID, notes, memo);
        break;
      }
  }
}

async function identifySupplier(
  invoice: any,
  processedAttachments: PresignedAttachment[],
  emailContext?: InvoiceData['emailContext']
): Promise<SupplierIdentificationResult> {
  debug('Identifying supplier for invoice:', invoice.Invoice_Number);

  try {
    // Prepare invoice data for AI analysis
    const invoiceData = {
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

    // Call AI to identify the supplier using RAG
    const result = await getAiResponse({
      prompt: supplierIdentificationPrompt,
      schema: SupplierIdentificationSchema,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Please identify the supplier for this invoice:\n\nInvoice Data: ${JSON.stringify(invoiceData, null, 2)}\n\nUse the findSuppliers tool to search for relevant suppliers and then provide your analysis. Reference the images from the invoice attachments to help you identify the supplier.${emailContextText}`
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

    return result as SupplierIdentificationResult;

  } catch (error) {
    debug('Error in supplier identification:', error);
    return {
      status: 'error' as const,
      resolvedSupplier: null,
      extractedSupplierInformation: {},
      potentialDuplicateSuppliers: null,
      recommendation: {
        action: 'manual_review' as const,
        reason: `Error in supplier identification: ${error}`
      }
    };
  }
}

// Helper functions to extract data from invoice
function extractAddressFromInvoice(invoice: any): string | undefined {
  // Try to extract address from various invoice fields
  if (invoice.allAddresses?.length > 0) {
    return invoice.allAddresses.map((addr: any) => addr.descriptor).join(', ');
  }
  return undefined;
}

function extractPhoneFromInvoice(invoice: any): string | undefined {
  // Try to extract phone from various invoice fields
  if (invoice.allPhoneNumbers?.length > 0) {
    return invoice.allPhoneNumbers.map((phone: any) => phone.descriptor).join(', ');
  }
  return undefined;
}

function extractEmailFromInvoice(invoice: any): string | undefined {
  // Try to extract email from various invoice fields
  if (invoice.allEmailAddresses?.length > 0) {
    return invoice.allEmailAddresses.map((email: any) => email.descriptor).join(', ');
  }
  return undefined;
}
