import { withBatchHandler, withRecordHandler } from './lib/actions.js';
import { debug } from '@pga/logger';
import { executeWorkdayQuery, getAttachmentContent, type WorkdayConfig } from './lib/workday.js';
import { getAiResponse } from './lib/ai.js';
import type { SupplierIdentificationResult, InvoiceData } from './lib/types.js';
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

async function processAction({ workdayConfig, data: invoiceData }: { workdayConfig: WorkdayConfig; dbConnection: any; data: InvoiceData }): Promise<void> {
  debug('Enriching invoice supplier with AI and Workday data');
  
  debug(`Processing invoice with workdayID: ${invoiceData.workdayID}`);

  // Get detailed invoice data using Workday ID
  const detailedQuery = `
    SELECT 
      workdayID, 
      invoiceNumber, 
      invoiceStatus, 
      OCRStatus, 
      OCRSupplierInvoice, 
      company1, 
      supplier, 
      suppliersInvoiceNumber, 
      controlTotalAmount, 
      purchaseOrders, 
      allAttachmentsForBusinessDocument 
    FROM supplierInvoices (dataSourceFilter = supplierInvoicesFilter) 
    WHERE workdayID = "${invoiceData.workdayID}"
  `;

  const detailedResponse = await executeWorkdayQuery(workdayConfig, detailedQuery);
  
  if (!detailedResponse || typeof detailedResponse !== 'object' || !('data' in detailedResponse) || !Array.isArray((detailedResponse as any).data)) {
    throw new Error('Expected detailed query response format: {total: number, data: array}');
  }
  
  const detailedResults = (detailedResponse as any).data;
  const detailedInvoice = detailedResults[0] as any;

  debug('detailedInvoice', detailedInvoice);

  // Get attachment content via separate API call if attachments are available
  if (detailedInvoice.allAttachmentsForBusinessDocument) {
    await getAttachmentContent(workdayConfig, detailedInvoice.allAttachmentsForBusinessDocument);
  } else {
    debug('No attachments found for this invoice');
  }

  // Check if supplier is missing
  if (!detailedInvoice.supplier || detailedInvoice.supplier === '') {
    debug('Missing supplier - identifying supplier');
    const attachmentData = detailedInvoice.allAttachmentsForBusinessDocument || [];
    const supplierResult = await identifySupplier(detailedInvoice, attachmentData);
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
  attachmentData: any
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
      attachmentData: attachmentData
    };
    
    // Call AI to identify the supplier using RAG
    const result = await getAiResponse({
      prompt: `You are an expert at matching invoices to suppliers. Your task is to identify the most likely supplier for the given invoice.

      You have access to a findSuppliers tool that can search our supplier database using semantic similarity. Use this tool to find relevant suppliers based on the invoice data, then analyze the results to identify the best match.

      Consider the following when matching:
      - Company name similarity
      - Address information
      - Contact details (phone, email)
      - Business context and industry
      - Any other relevant details from the invoice

      Use the findSuppliers tool to search for suppliers, then provide your analysis and recommendation.`,
      schema: SupplierIdentificationSchema,
      messages: [
        { 
          role: 'user', 
          content: `Please identify the supplier for this invoice:\n\nInvoice Data: ${JSON.stringify(invoiceData, null, 2)}\n\nUse the findSuppliers tool to search for relevant suppliers and then provide your analysis.` 
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
