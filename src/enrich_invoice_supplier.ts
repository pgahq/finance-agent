import { withBatchHandler, withRecordHandler } from './lib/actions.js';
import { debug } from '@pga/logger';
import { executeWorkdayQuery, getAttachmentContent, type WorkdayConfig } from './lib/workday.js';
import { getJsonFromS3, type S3Config } from './lib/s3.js';
import { callOpenAIWithSchema } from './lib/openai.js';
import type { SupplierIdentificationResult, SupplierCacheData, InvoiceData, BatchSupplierIdentificationResult } from './lib/types.js';

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

// Configuration for supplier identification batching
const SUPPLIER_BATCH_SIZE = 10000;
const HIGH_CONFIDENCE_THRESHOLD = 0.9;
const MAX_BATCHES_TO_PROCESS = 50;

export const batchHandler = withBatchHandler(QUERY)(`finance-agent-EnrichInvoiceSupplierProcessor`);

export const dataProcessor = withRecordHandler<InvoiceData>(processAction);

async function processAction({ workdayConfig, s3Config, data: invoiceData }: { workdayConfig: WorkdayConfig; s3Config: S3Config; data: InvoiceData }): Promise<void> {
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
  let attachmentData: any[] = [];
  if (detailedInvoice.allAttachmentsForBusinessDocument) {
    attachmentData = await getAttachmentContent(workdayConfig, detailedInvoice.allAttachmentsForBusinessDocument);
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
  
  debug(`Using batch configuration: batchSize=${SUPPLIER_BATCH_SIZE}, highConfidenceThreshold=${HIGH_CONFIDENCE_THRESHOLD}, maxBatches=${MAX_BATCHES_TO_PROCESS}`);
  
  // Split suppliers into batches
  const batches = [];
  for (let i = 0; i < suppliers.length; i += SUPPLIER_BATCH_SIZE) {
    batches.push(suppliers.slice(i, i + SUPPLIER_BATCH_SIZE));
  }
  
  debug(`Split ${suppliers.length} suppliers into ${batches.length} batches`);
  
  const allResults: BatchSupplierIdentificationResult[] = [];
  let bestResult: BatchSupplierIdentificationResult | null = null;
  
  // Process batches sequentially with early exit on high confidence
  for (let i = 0; i < Math.min(batches.length, MAX_BATCHES_TO_PROCESS); i++) {
    const batch = batches[i];
    debug(`Processing batch ${i + 1}/${Math.min(batches.length, MAX_BATCHES_TO_PROCESS)} with ${batch.length} suppliers`);
    
    try {
      const batchResult = await identifySupplierInBatch(invoice, attachmentData, batch, i, batches.length);
      allResults.push(batchResult);
      
      // Track the best result so far
      if (!bestResult || batchResult.confidence > bestResult.confidence) {
        bestResult = batchResult;
      }
      
      // Early exit if we found a high confidence match
      if (batchResult.confidence >= HIGH_CONFIDENCE_THRESHOLD) {
        debug(`High confidence match found in batch ${i + 1}, stopping early`);
        break;
      }
      
    } catch (error) {
      debug(`Error processing batch ${i + 1}:`, error);
      // Continue with next batch on error
    }
  }
  
  // Return the best result found
  if (bestResult && bestResult.confidence > 0) {
    debug(`Best supplier identification result: confidence=${bestResult.confidence}, supplier=${bestResult.supplierName}`);
    return {
      supplierId: bestResult.supplierId,
      supplierName: bestResult.supplierName,
      confidence: bestResult.confidence,
      reasoning: bestResult.reasoning
    };
  } else {
    debug('No supplier match found in any batch');
    return {
      supplierId: '',
      supplierName: 'None',
      confidence: 0,
      reasoning: 'No matching supplier found in any processed batch'
    };
  }
}

async function identifySupplierInBatch(
  invoice: any,
  attachmentData: any[],
  suppliers: any[],
  batchIndex: number,
  totalBatches: number
): Promise<BatchSupplierIdentificationResult> {
  const systemPrompt = `You are a supplier identification specialist. Given an invoice and a list of registered suppliers, identify which supplier this invoice belongs to. If no match is found, respond with "None" and provide your reasoning.`;
  
  const userMessage = `Please identify the supplier for this invoice:
Invoice WorkdayID: ${invoice.workdayID}
Invoice Status: ${invoice.invoiceStatusAsText}
OCR Supplier Invoice: ${JSON.stringify(invoice.OCRSupplierInvoice, null, 2)}
Detailed Invoice Data: ${JSON.stringify(invoice, null, 2)}
Attachments: ${JSON.stringify(attachmentData)}

Available Suppliers (Batch ${batchIndex + 1}/${totalBatches}):
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

  const batchResult = {
    ...result as SupplierIdentificationResult,
    batchIndex,
    totalBatches
  };
  
  debug(`Batch ${batchIndex + 1} completed with confidence: ${batchResult.confidence}`);
  
  return batchResult;
}
