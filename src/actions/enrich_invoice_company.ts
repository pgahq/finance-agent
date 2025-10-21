import loadEnv from '@pga/lambda-env';
import { debug } from '@pga/logger';
import { getWorkdayConfig, executeWorkdayQuery, getAttachmentContent, type WorkdayConfig } from '../lib/workday.js';
import { callOpenAIWithSchema } from '../lib/openai.js';
import type { WorkdayQueryResultDetail } from '../wqlToEvent.js';

export const handler = async (event: { detail: WorkdayQueryResultDetail }) => {
  process.env = await loadEnv();
  debug('Company enrichment event received:', JSON.stringify(event, null, 2));

  const { data, timestamp, requestId } = event.detail;
  
  debug(`Event timestamp: ${timestamp}`);
  debug(`Request ID: ${requestId}`);

  const workdayConfig = getWorkdayConfig(process.env);

  await processAction(workdayConfig, data);

  debug('Successfully processed company enrichment');
};

async function processAction(
  config: WorkdayConfig,
  invoiceData: unknown
): Promise<void> {
  debug('Enriching invoice company with AI and Workday data');
  debug('Invoice data:', JSON.stringify(invoiceData, null, 2));
  
  // Cast the invoice data to expected structure
  const invoice = invoiceData as {
    id: string;
    invoiceNumber: string;
    company1: unknown;
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

  // Check if company is missing
  if (!detailedInvoice.company1 || detailedInvoice.company1 === '') {
    debug('Missing company - identifying company');
    const companyResult = await identifyCompany(config, detailedInvoice, attachmentData);
    
    if (companyResult.confidence > 0.8) {
      debug('High confidence company identification - updating invoice');
      // TODO: Update Workday with identified company
      // await updateInvoiceCompany(config, detailedInvoice.id, companyResult);
    } else {
      debug('Low confidence company identification - flagging for manual review');
      // TODO: Flag for manual review
      // await flagForManualReview(config, detailedInvoice.id, 'company', companyResult);
    }
  } else {
    debug('Company already present - no enrichment needed');
  }
}

interface CompanyIdentificationResult {
  companyId: string;
  companyName: string;
  confidence: number;
  reasoning: string;
}

async function identifyCompany(
  config: WorkdayConfig,
  invoice: any,
  attachmentData: any[]
): Promise<CompanyIdentificationResult> {
  debug('Identifying company for invoice:', invoice.invoiceNumber);
  
  // Get all companies from Workday
  const companiesQuery = `
    SELECT 
      id,
      name,
      legalName,
      taxId,
      status
    FROM company
    WHERE status = "Active"
    ORDER BY name
  `;
  
  const companies = await executeWorkdayQuery(config, companiesQuery) as Array<{
    id: string;
    name: string;
    legalName: string;
    taxId: string;
    status: string;
  }>;
  
  // Prepare AI request for company identification
  const systemPrompt = `You are a company identification specialist. Given an invoice and a list of internal companies, identify which company this invoice belongs to. If no match is found, respond with "None" and provide your reasoning.`;
  
  const userMessage = `Please identify the company for this invoice:
Invoice Number: ${invoice.invoiceNumber}
Invoice Data: ${JSON.stringify(invoice, null, 2)}
Attachments: ${JSON.stringify(attachmentData)}

Available Companies:
${companies.map(c => `${(c as any).name} (ID: ${(c as any).id})`).join('\n')}`;

  const schema = {
    type: 'object',
    properties: {
      companyId: { type: 'string', description: 'Workday company ID if found' },
      companyName: { type: 'string', description: 'Company name if found' },
      confidence: { type: 'number', description: 'Confidence level 0-1' },
      reasoning: { type: 'string', description: 'Explanation of the identification' }
    },
    required: ['companyId', 'companyName', 'confidence', 'reasoning']
  };

  const result = await callOpenAIWithSchema({
    prompt: systemPrompt,
    schema,
    messages: [{ role: 'user', content: userMessage }]
  });

  debug('Company identification result:', JSON.stringify(result, null, 2));
  
  return result as CompanyIdentificationResult;
}
