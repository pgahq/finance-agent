import { withBatchHandler, withRecordHandler } from './lib/actions.js';
import { debug } from '@pga/logger';
import { executeWorkdayQuery, getAttachmentContent, type WorkdayConfig } from './lib/workday.js';
import { callOpenAIWithSchema } from './lib/openai.js';
import { getJsonFromS3, type S3Config } from './lib/s3.js';
import type { SupplierIdentificationResult, InvoiceData, SupplierCacheData } from './lib/types.js';

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

async function processAction({ workdayConfig, s3Config, data: invoiceData }: { workdayConfig: WorkdayConfig; s3Config: S3Config; dbConnection: any; data: InvoiceData }): Promise<void> {
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
    const supplierResult = await identifySupplier(detailedInvoice, s3Config, attachmentData);
    
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
  s3Config: S3Config,
  attachmentData: any
): Promise<SupplierIdentificationResult> {
  debug('Identifying supplier for invoice:', invoice.invoiceNumber);
  
  try {
    // Get supplier cache from S3
    const cacheKey = 'cache/suppliers.json';
    const supplierCache = await getJsonFromS3(s3Config, cacheKey) as SupplierCacheData;
    
    if (!supplierCache || !supplierCache.suppliers) {
      throw new Error('Supplier cache not found');
    }
    
    const suppliers = supplierCache.suppliers;
    debug(`Loaded ${suppliers.length} suppliers from cache`);
    
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
    
    // Call OpenAI to identify the supplier
    const result = await callOpenAIWithSchema({
      prompt: `Identify the most likely supplier for this invoice based on the provided supplier data.`,
      schema: {
        type: 'object',
        properties: {
          supplierId: { type: 'string' },
          supplierName: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          reasoning: { type: 'string' }
        },
        required: ['supplierId', 'supplierName', 'confidence', 'reasoning']
      },
      messages: [
        { role: 'system', content: `You are an expert at matching invoices to suppliers. You will be given invoice data and a list of suppliers. Your job is to identify the most likely supplier for the invoice.` },
        { role: 'user', content: `Invoice data: ${JSON.stringify(invoiceData, null, 2)}\n\nAvailable suppliers: ${JSON.stringify(suppliers, null, 2)}` }
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
