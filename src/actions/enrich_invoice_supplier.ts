import { EventBridgeHandler } from 'aws-lambda';
import loadEnv from '@pga/lambda-env';
import { debug } from '@pga/logger';
import { getWorkdayConfig, executeWorkdayQuery, getAttachmentContent, type WorkdayConfig } from '../lib/workday.js';
import { callOpenAIWithSchema } from '../lib/openai.js';
import type { WorkdayQueryResultDetail } from '../wqlToEvent.js';

export const handler: EventBridgeHandler<'WorkdayQueryResult', WorkdayQueryResultDetail, void> = async (event) => {
  process.env = await loadEnv();
  debug('Supplier enrichment event received:', JSON.stringify(event, null, 2));

  const { data, timestamp, requestId } = event.detail;
  
  debug(`Event timestamp: ${timestamp}`);
  debug(`Request ID: ${requestId}`);

  const workdayConfig = getWorkdayConfig(process.env);

  await processAction(workdayConfig, data);

  debug('Successfully processed supplier enrichment');
};

async function processAction(
  config: WorkdayConfig,
  invoiceData: unknown
): Promise<void> {
  debug('Enriching invoice supplier with AI and Workday data');
  debug('Invoice data:', JSON.stringify(invoiceData, null, 2));
  
  // Cast the invoice data to expected structure
  const invoice = invoiceData as {
    id: string;
    invoiceNumber: string;
    supplier: unknown;
  };

  debug(`Processing invoice ${invoice.invoiceNumber} (ID: ${invoice.id})`);

  // Get detailed invoice data using Workday ID
  const detailedQuery = `
    SELECT
      id,
      invoiceNumber,
      invoiceStatus as Status,
      company1,
      supplier,
      suppliersInvoiceNumber,
      invoiceDate,
      controlTotalAmount,
      purchaseOrders,
      allAttachmentsForBusinessDocument as Attachments,
      supplierInvoiceDocumentAutoSubmitted,
      passedSupplierInvoiceAutoSubmitRules,
      passedSupplierInvoiceValidations,
      OCRSupplierInvoice
    FROM supplierInvoices
    WHERE id = "${invoice.id}"
  `;

  const detailedResults = await executeWorkdayQuery(config, detailedQuery);
  const detailedInvoice = detailedResults[0] as any;

  // Get attachment content via separate API call
  const attachmentData = await getAttachmentContent(config, detailedInvoice.Attachments);

  // Check if supplier is missing
  if (!detailedInvoice.supplier || detailedInvoice.supplier === '') {
    debug('Missing supplier - identifying supplier');
    const supplierResult = await identifySupplier(config, detailedInvoice, attachmentData);
    
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

interface SupplierIdentificationResult {
  supplierId: string;
  supplierName: string;
  confidence: number;
  reasoning: string;
}

async function identifySupplier(
  config: WorkdayConfig,
  invoice: any,
  attachmentData: any[]
): Promise<SupplierIdentificationResult> {
  debug('Identifying supplier for invoice:', invoice.invoiceNumber);
  
  // Get all registered suppliers from Workday
  const suppliersQuery = `
    SELECT 
      id,
      name,
      legalName,
      taxId,
      status
    FROM supplier
    WHERE status = "Active"
    ORDER BY name
  `;
  
  const suppliers = await executeWorkdayQuery(config, suppliersQuery) as Array<{
    id: string;
    name: string;
    legalName: string;
    taxId: string;
    status: string;
  }>;
  
  // Prepare AI request for supplier identification
  const systemPrompt = `You are a supplier identification specialist. Given an invoice and a list of registered suppliers, identify which supplier this invoice belongs to. If no match is found, respond with "None" and provide your reasoning.`;
  
  const userMessage = `Please identify the supplier for this invoice:
Invoice Number: ${invoice.invoiceNumber}
Invoice Data: ${JSON.stringify(invoice, null, 2)}
Attachments: ${JSON.stringify(attachmentData)}

Available Suppliers:
${suppliers.map(s => `${s.name} (ID: ${s.id})`).join('\n')}`;

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
