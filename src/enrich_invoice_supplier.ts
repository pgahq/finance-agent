import { debug } from '@pga/logger';
import { getAiResponse } from './lib/ai.js';
import { withProcessorHandler, withQueryHandler } from './lib/handlers.js';
import { notifyResult } from './lib/slack.js';
import type { InvoiceData, PresignedAttachment } from './lib/types.js';
import { addNoSupplierTagToInvoice, getSupplierInvoiceWithAttachments, updateSupplierInvoiceSupplier, updateVerifySupplierInvoiceData } from './lib/workday.js';
import { supplierIdentificationPrompt, SupplierIdentificationSchema, type SupplierIdentificationResult } from './prompts/identify_supplier.js';
import { invoiceDataVerificationPrompt, InvoiceDataVerificationSchema, type InvoiceDataVerificationResult } from './prompts/verify_invoice_data.js';

const QUERY = `
  SELECT
    workdayID,
    invoiceStatusAsText,
    OCRSupplierInvoice,
    supplier
  FROM supplierInvoices (dataSourceFilter = supplierInvoicesFilter)
  WHERE OCRSupplierInvoice is not empty
    AND invoiceStatusAsText = 'Draft'
    AND workQueueTags not in ('FINAGENT-invoice-modified', 'FINAGENT-no-supplier')
    AND isCanceled = false
`;


// Query function - scheduled daily
export const handler = withQueryHandler(QUERY)({
  processorFunctionName: `${process.env.AWS_STACK_NAME}-EnrichInvoiceSupplierProcessor`,
  pageSize: 1 // One invoice per invocation
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
  debug('Enriching invoice supplier with AI and Workday data');

  debug(`Processing invoice with workdayID: ${invoiceData.workdayID}`);

  try {
    // Get detailed invoice data with attachments using SOAP API
    const { invoice: detailedInvoice, presignedAttachments: processedAttachments } = await getSupplierInvoiceWithAttachments(
      context,
      invoiceData.workdayID
    );

    debug(`Successfully processed ${processedAttachments.length} attachments`);

    // Check if supplier is missing (using the original invoice data from the batch query)
    if (!invoiceData.supplier || !invoiceData.supplier.descriptor) {
      debug('Missing supplier - identifying supplier');
      const supplierResult = await identifySupplier(detailedInvoice, processedAttachments);
      debug('Supplier result:', supplierResult);

      const processingTime = Date.now() - startTime;

      // Send Slack notification
      const status = supplierResult.status === 'error' ? 'error' : 'success';
      const details = {
        workdayId: invoiceData.workdayID,
        invoiceNumber: detailedInvoice.Invoice_Number || 'Unknown',
        result: supplierResult
      };

      await notifyResult(
        'enrich_invoice_supplier',
        status,
        processingTime,
        details,
        status === 'error' ? supplierResult : undefined,
        `invoice: \`${detailedInvoice.Invoice_Number || 'Unknown'}\``
      );

      // Handle different scenarios based on the new schema
      switch (supplierResult.status) {
        case 'found':
          await handleFoundSupplier(context, invoiceData.workdayID, supplierResult);
          break;

        case 'not_found':
          debug('Supplier not found - adding no-supplier work queue tag');
          const notFoundNotes = `AI Agent Could not find automatically add a supplier. AI Agent Recommendation: ${supplierResult.recommendation.action}\n${supplierResult.recommendation.reason}`;
          const memo = supplierResult.extractedSupplierInformation?.memo || undefined;
          await addNoSupplierTagToInvoice(context, invoiceData.workdayID, notFoundNotes, memo);
          break;

        case 'ambiguous':
          debug('Ambiguous supplier identification - flagging for manual review');
          // TODO: Flag for manual review with potential duplicates
          // await flagForManualReview(config, detailedInvoice.id, 'supplier', supplierResult);
          break;

        case 'error':
          debug('Error in supplier identification - flagging for manual review');
          // TODO: Flag for manual review due to error
          // await flagForManualReview(config, detailedInvoice.id, 'supplier', supplierResult);
          break;
      }
    } else {
      debug('Supplier present - verifying invoice data');
      const verificationResult = await verifyInvoiceData(detailedInvoice, processedAttachments, invoiceData.supplier!);
      debug('Verification result:', verificationResult);

      const processingTime = Date.now() - startTime;

      // Send Slack notification
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
      'enrich_invoice_supplier',
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
  supplierResult: SupplierIdentificationResult
): Promise<void> {
  debug('Supplier found in Workday - updating invoice');
  const foundSupplierID = supplierResult.resolvedSupplier?.supplierId;

  if (foundSupplierID) {
    const notes = `AI Agent found matching supplier. AI Agent Recommendation: ${supplierResult.recommendation.action}\n${supplierResult.recommendation.reason}`;
    const memo = supplierResult.extractedSupplierInformation?.memo || undefined;

    await updateSupplierInvoiceSupplier(
      context,
      invoiceWorkdayID,
      foundSupplierID,
      notes,
      memo
    );
  } else {
    debug('No valid supplier Workday ID found - cannot update invoice');
  }
}


async function verifyInvoiceData(
  invoice: any,
  processedAttachments: PresignedAttachment[],
  existingSupplier: { descriptor: string; id: string }
): Promise<InvoiceDataVerificationResult> {
  debug('Verifying invoice data for invoice:', invoice.Invoice_Number);

  try {
    const invoiceData = {
      existingSupplier: {
        name: existingSupplier.descriptor,
        id: existingSupplier.id
      },
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
      }))
    };

    const result = await getAiResponse({
      prompt: invoiceDataVerificationPrompt,
      schema: InvoiceDataVerificationSchema,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Please verify if the existing supplier on this invoice is correct:\n\nExisting Supplier: ${existingSupplier.descriptor} (ID: ${existingSupplier.id})\n\nInvoice Data: ${JSON.stringify(invoiceData, null, 2)}\n\nExtract supplier information from the invoice attachments and compare it with the existing supplier. Use the findSuppliers tool if you think the supplier might be different.`
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
      verificationStatus: 'uncertain' as const,
      confidence: 0,
      extractedSupplierInformation: {},
      recommendedSupplier: null,
      verificationReason: `Error in verification: ${error}`
    };
  }
}

async function handleVerificationResult(
  context: any,
  invoiceWorkdayID: string,
  verificationResult: InvoiceDataVerificationResult
): Promise<void> {
  const memo = verificationResult.extractedSupplierInformation?.memo || undefined;

  switch (verificationResult.verificationStatus) {
    case 'matching':
      {
        debug('Supplier verified as matching - updating invoice with memo');
        const notes = `AI Agent verified supplier is correct. ${verificationResult.verificationReason}`;
        await updateVerifySupplierInvoiceData(context, invoiceWorkdayID, notes, memo);
        debug('No memo extracted - skipping update');
        break;
      }

    case 'different':
      debug('Supplier verification found different supplier - adding revision note');
      const recommendedSupplier = verificationResult.recommendedSupplier;
      const notes = recommendedSupplier
        ? `AI Agent recommends supplier revision. Recommended supplier: ${recommendedSupplier.supplierName} (${recommendedSupplier.supplierId}).
        Confidence: ${(recommendedSupplier.confidence * 100).toFixed(0)}%.
        Reason: ${recommendedSupplier.reason}\n\nVerification details: ${verificationResult.verificationReason}`
        : `AI Agent recommends supplier revision. ${verificationResult.verificationReason}`;
      await updateVerifySupplierInvoiceData(context, invoiceWorkdayID, notes, memo);
      break;

    case 'uncertain':
      {
        const notes = `AI Agent is uncertain that the supplier is correct. ${verificationResult.verificationReason}`;
        await updateVerifySupplierInvoiceData(context, invoiceWorkdayID, notes, memo);
        break;
      }
  }
}

async function identifySupplier(
  invoice: any,
  processedAttachments: PresignedAttachment[]
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
      }))
    };

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
              text: `Please identify the supplier for this invoice:\n\nInvoice Data: ${JSON.stringify(invoiceData, null, 2)}\n\nUse the findSuppliers tool to search for relevant suppliers and then provide your analysis. Reference the images from the invoice attachments to help you identify the supplier.`
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
