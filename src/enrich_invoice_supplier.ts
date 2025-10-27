import { withBatchHandler, withRecordHandler, type ProcessingContext } from './lib/actions.js';
import { debug } from '@pga/logger';
import { getSupplierInvoiceWithAttachments } from './lib/workday.js';
import { getAiResponse } from './lib/ai.js';
import type { InvoiceData, PresignedAttachment } from './lib/types.js';
import { supplierIdentificationPrompt, SupplierIdentificationSchema, type SupplierIdentificationResult } from './prompts/identify_supplier.js';
import { notifyResult } from './lib/slack.js';

const QUERY = `
  SELECT 
    workdayID, 
    invoiceStatusAsText, 
    OCRSupplierInvoice, 
    supplier 
  FROM supplierInvoices (dataSourceFilter = supplierInvoicesFilter) 
  WHERE OCRSupplierInvoice is not empty 
    AND supplier is empty 
    AND isCanceled = false
`;


export const batchHandler = withBatchHandler(QUERY)(`finance-agent-EnrichInvoiceSupplierProcessor`);

export const dataProcessor = withRecordHandler<InvoiceData>(processAction);

async function processAction(context: ProcessingContext, invoiceData: InvoiceData): Promise<void> {
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
        invoiceNumber: detailedInvoice.invoiceNumber || 'Unknown',
        result: supplierResult
      };

      await notifyResult(
        'enrich_invoice_supplier',
        status,
        processingTime,
        details,
        status === 'error' ? supplierResult : undefined,
        `invoice: \`${detailedInvoice.invoiceNumber || 'Unknown'}\``
      );

      // Handle different scenarios based on the new schema
      switch (supplierResult.status) {
        case 'found':
          debug('Supplier found in Workday - updating invoice');
          // TODO: Update Workday with identified supplier
          // await updateInvoiceSupplier(config, detailedInvoice.id, supplierResult.resolvedSupplier);
          break;
          
        case 'not_found':
          debug('Supplier not found - registering new supplier');
          // TODO: Register new supplier with extracted information
          // await registerNewSupplier(config, supplierResult.extractedSupplierInformation);
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
      debug('Supplier already present - no enrichment needed');
    }
  } catch (error) {
    const processingTime = Date.now() - startTime;
    debug('Error in supplier enrichment process:', error);
    
    // Send error notification to Slack
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

async function identifySupplier(
  invoice: any,
  processedAttachments: PresignedAttachment[]
): Promise<SupplierIdentificationResult> {
  debug('Identifying supplier for invoice:', invoice.invoiceNumber);
  
  try {
    // Prepare invoice data for AI analysis
    const invoiceData = {
      companyName: invoice.company1?.descriptor || invoice.OCRSupplierInvoice?.descriptor,
      address: extractAddressFromInvoice(invoice),
      phone: extractPhoneFromInvoice(invoice),
      email: extractEmailFromInvoice(invoice),
      invoiceNumber: invoice.invoiceNumber,
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
      resolvedSupplier: undefined,
      extractedSupplierInformation: {
        supplierName: 'Unknown',
        address: undefined,
        phone: undefined,
        email: undefined,
        taxId: undefined,
        website: undefined,
        industry: undefined,
        contactPerson: undefined
      },
      potentialDuplicateSuppliers: undefined,
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
