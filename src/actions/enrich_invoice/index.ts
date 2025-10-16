import { EventBridgeHandler } from 'aws-lambda';
import { loadEnv } from '@pga/lambda-env';
import { debug } from '@pga/logger';
import { getWorkdayConfig, executeWorkdayQuery, getAttachmentContent, type WorkdayConfig } from '../../lib/workday.js';
import { identifySupplier } from './identify_supplier.js';
import { identifyCompany } from './identify_company.js';
import type { WorkdayQueryResultDetail } from '../../wqlToEvent.js';

export const handler: EventBridgeHandler<'WorkdayQueryResult', WorkdayQueryResultDetail, void> = async (event) => {
  process.env = await loadEnv();
  debug('Event received:', JSON.stringify(event, null, 2));

  const { data, timestamp, requestId } = event.detail;
  
  debug(`Event timestamp: ${timestamp}`);
  debug(`Request ID: ${requestId}`);

  const workdayConfig = getWorkdayConfig(process.env);

  await processAction(workdayConfig, data);

  debug('Successfully processed event');
};

export async function processAction(
  config: WorkdayConfig,
  invoiceData: unknown
): Promise<void> {
  debug('Enriching invoice with AI and Workday data');
  debug('Invoice data:', JSON.stringify(invoiceData, null, 2));
  
  // Cast the invoice data to expected structure
  const invoice = invoiceData as {
    id: string;
    invoiceNumber: string;
    company1: unknown;
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

  // Determine missing fields
  const { missing: missingFields } = evaluateInvoice(detailedInvoice);

  if (missingFields.length === 0) {
    debug('No missing fields - invoice is complete');
    return;
  }

  // Process missing fields with specialized utilities
  if (missingFields.includes('supplier')) {
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
  }

  if (missingFields.includes('company')) {
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
  }
}

function evaluateInvoice(detailedInvoice: any) {
  const missing: string[] = [];
  if (!detailedInvoice.supplier) missing.push('supplier');
  if (!detailedInvoice.company1) missing.push('company');

  return { missing };
}
