import { withBatchHandler, withRecordHandler, type ProcessingContext } from './lib/actions.js';
import { debug } from '@pga/logger';
import { getSupplierInvoiceWithAttachments } from './lib/workday.js';
import { getAiResponse } from './lib/ai.js';
import type { SupplierIdentificationResult, InvoiceData, PresignedAttachment } from './lib/types.js';
import { z } from 'zod';

// Zod schema for supplier identification result
const SupplierIdentificationSchema = z.object({
  supplierId: z.string().describe('The unique identifier of the supplier'),
  supplierName: z.string().describe('The name of the supplier'),
  confidence: z.number().min(0).max(1).describe('Confidence score between 0 and 1'),
  reasoning: z.string().describe('Explanation of the reasoning behind the identification')
});

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
  debug('Enriching invoice supplier with AI and Workday data');
  
  debug(`Processing invoice with workdayID: ${invoiceData.workdayID}`);

  // Get detailed invoice data with attachments using SOAP API
  const { invoice: detailedInvoice, presignedAttachments: processedAttachments } = await getSupplierInvoiceWithAttachments(
    context, 
    invoiceData.workdayID
  );
  
  debug('detailedInvoice from SOAP', detailedInvoice);
  debug(`Successfully processed ${processedAttachments.length} attachments`);

  // Check if supplier is missing (using the original invoice data from the batch query)
  if (!invoiceData.supplier || !invoiceData.supplier.descriptor) {
    debug('Missing supplier - identifying supplier');
    const supplierResult = await identifySupplier(detailedInvoice, processedAttachments);
    debug('Supplier result:', supplierResult);

    if (supplierResult.confidence > 0.8) {
      debug('High confidence supplier identification - updating invoice');
      // TODO: Update Workday with identified supplier
      // await updateInvoiceSupplier(config, detailedInvoice.id, supplierResult);
    } else {
      debug('Low confidence supplier identification - flagging for manual review');
      // TODO: Flag for manual review
      // await flagForManualReview(config, detailedInvoice.id, 'supplier', supplierResult);
    }
  } else {
    debug('Supplier already present - no enrichment needed');
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
      prompt: `You are an expert at matching invoices to suppliers. Your task is to identify the most likely supplier for the given invoice.

      You have access to a findSuppliers tool that can search our supplier database using semantic similarity. Use this tool to find relevant suppliers based on the invoice data, then analyze the results to identify the best match.

      The invoice may include attachment files (PDFs, images, etc.) with presigned URLs that you can access to analyze the document content. These attachments often contain crucial information like supplier details, company logos, or additional context.

      Consider the following when matching:
      - Company name similarity
      - Address information
      - Contact details (phone, email)
      - Business context and industry
      - Document content from attachments (if available)
      - Any other relevant details from the invoice

      Use the findSuppliers tool to search for suppliers, then provide your analysis and recommendation.`,
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
      supplierId: '',
      supplierName: 'None',
      confidence: 0,
      reasoning: `Error in supplier identification: ${error}`
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
