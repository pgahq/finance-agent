import loadEnv from '@pga/lambda-env';
import { debug } from '@pga/logger';
import { getWorkdayConfig, executeWorkdayQuery, getAttachmentContent, type WorkdayConfig } from '../lib/workday.js';
import { getS3Config, getJsonFromS3, type S3Config } from '../lib/s3.js';
import { callOpenAIWithSchema } from '../lib/openai.js';
import type { WorkdayQueryResultDetail, SupplierIdentificationResult, SupplierCacheData } from '../lib/types.js';

export const handler = async (event: { detail: WorkdayQueryResultDetail }) => {
  process.env = await loadEnv();
  debug('Supplier enrichment event received:', JSON.stringify(event, null, 2));

  const { data, timestamp, requestId } = event.detail;
  
  debug(`Event timestamp: ${timestamp}`);
  debug(`Request ID: ${requestId}`);

  const workdayConfig = getWorkdayConfig(process.env);
  const s3Config = getS3Config(process.env as Record<string, string>);

  await processAction(workdayConfig, s3Config, data);

  debug('Successfully processed supplier enrichment');
};

async function processAction(
  config: WorkdayConfig,
  s3Config: S3Config,
  invoiceData: unknown
): Promise<void> {
  debug('Enriching invoice supplier with AI and Workday data');
  debug('Invoice data:', JSON.stringify(invoiceData, null, 2));
  
  // Cast the invoice data to expected structure
  const invoice = invoiceData as {
    workdayID: string;
    invoiceStatusAsText: string;
    OCRSupplierInvoice: {
      descriptor: string;
      id: string;
    };
  };

  debug(`Processing invoice with workdayID: ${invoice.workdayID}`);

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
    WHERE workdayID = "${invoice.workdayID}"
  `;

  const detailedResponse = await executeWorkdayQuery(config, detailedQuery);
  
  // Handle new format: object with data array
  if (!detailedResponse || typeof detailedResponse !== 'object' || !('data' in detailedResponse) || !Array.isArray((detailedResponse as any).data)) {
    throw new Error('Expected detailed query response format: {total: number, data: array}');
  }
  
  const detailedResults = (detailedResponse as any).data;
  const detailedInvoice = detailedResults[0] as any;

  // Get attachment content via separate API call if attachments are available
  let attachmentData: any[] = [];
  if (detailedInvoice.allAttachmentsForBusinessDocument) {
    attachmentData = await getAttachmentContent(config, detailedInvoice.allAttachmentsForBusinessDocument);
  } else {
    debug('No attachments found for this invoice');
  }

  // Check if supplier is missing
  if (!detailedInvoice.supplier || detailedInvoice.supplier === '') {
    debug('Missing supplier - identifying supplier');
    const supplierResult = await identifySupplier(s3Config, detailedInvoice, attachmentData);
    
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
  s3Config: S3Config,
  invoice: any,
  attachmentData: any[]
): Promise<SupplierIdentificationResult> {
  debug('Identifying supplier for invoice:', invoice.invoiceNumber);
  
  // Get cached suppliers directly from S3
  const cacheKey = 'cache/suppliers.json';
  const cacheData = await getJsonFromS3<SupplierCacheData>(s3Config, cacheKey);
  
  if (!cacheData) {
    throw new Error('Supplier cache not found. Please ensure cache_suppliers has run successfully.');
  }
  
  const suppliers = cacheData.suppliers;
  debug(`Loaded ${suppliers.length} suppliers from cache (cached at: ${cacheData.cachedAt})`);
  
  // Prepare AI request for supplier identification
  const systemPrompt = `You are a supplier identification specialist. Given an invoice and a list of registered suppliers, identify which supplier this invoice belongs to. If no match is found, respond with "None" and provide your reasoning.`;
  
  const userMessage = `Please identify the supplier for this invoice:
Invoice WorkdayID: ${invoice.workdayID}
Invoice Status: ${invoice.invoiceStatusAsText}
OCR Supplier Invoice: ${JSON.stringify(invoice.OCRSupplierInvoice, null, 2)}
Detailed Invoice Data: ${JSON.stringify(invoice, null, 2)}
Attachments: ${JSON.stringify(attachmentData)}

Available Suppliers:
${JSON.stringify(suppliers, null, 2)}`;

  const schema = {
    type: 'object',
    properties: {
      supplierId: { type: 'string', description: 'Workday supplier ID if found' },
      supplierName: { type: 'string', description: 'Supplier name if found' },
      confidence: { type: 'number', description: 'Confidence level 0-1' },
      reasoning: { type: 'string', description: 'Explanation of the identification' }
    },
    required: ['supplierId', 'supplierName', 'confidence', 'reasoning']
  };

  const result = await callOpenAIWithSchema({
    prompt: systemPrompt,
    schema,
    messages: [{ role: 'user', content: userMessage }]
  });

  debug('Supplier identification result:', JSON.stringify(result, null, 2));
  
  return result as SupplierIdentificationResult;
}
