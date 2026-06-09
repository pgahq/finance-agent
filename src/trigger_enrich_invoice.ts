import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import loadEnv from '@pga/lambda-env';
import { debug } from '@pga/logger';
import { extractBearerToken, isAuthorizedBearer } from './lib/api_auth.js';
import { getWorkdayConfig, executeWorkdayQuery, getInboundEmailsForOCRInvoices } from './lib/workday.js';
import type { InvoiceData } from './lib/types.js';

interface TriggerEnrichInvoiceRequest {
  supplierInvoiceId?: string;
}

function jsonResponse(statusCode: number, body: Record<string, string>): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function buildInvoiceLookupQuery(supplierInvoiceId: string): string {
  return `
  SELECT
    workdayID,
    OCRSupplierInvoice,
    supplier,
    company1
  FROM supplierInvoices (dataSourceFilter = supplierInvoicesFilter)
  WHERE workdayID = '${supplierInvoiceId}'
`;
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  process.env = await loadEnv();

  const expectedToken = process.env.ENRICH_INVOICE_API_TOKEN;
  if (!expectedToken) {
    debug('ENRICH_INVOICE_API_TOKEN is not configured');
    return jsonResponse(500, { message: 'Internal server error' });
  }

  const providedToken = extractBearerToken(event.headers?.authorization);
  if (!isAuthorizedBearer(providedToken ?? '', expectedToken)) {
    return jsonResponse(401, { message: 'Unauthorized' });
  }

  let requestBody: TriggerEnrichInvoiceRequest;
  try {
    requestBody = event.body ? JSON.parse(event.body) as TriggerEnrichInvoiceRequest : {};
  } catch {
    return jsonResponse(400, { message: 'Invalid JSON body' });
  }

  const supplierInvoiceId = requestBody.supplierInvoiceId?.trim();
  if (!supplierInvoiceId) {
    return jsonResponse(400, { message: 'supplierInvoiceId is required' });
  }

  try {
    const workdayConfig = getWorkdayConfig(process.env);
    const [invoiceQuery, emailMap] = await Promise.all([
      executeWorkdayQuery(workdayConfig, buildInvoiceLookupQuery(supplierInvoiceId)),
      getInboundEmailsForOCRInvoices(workdayConfig),
    ]);

    const invoices = invoiceQuery.data;
    if (!invoices || !Array.isArray(invoices) || invoices.length === 0) {
      return jsonResponse(404, { message: 'Invoice not found' });
    }

    const invoice = invoices[0] as InvoiceData;
    const emailContext = emailMap.get(invoice.workdayID);
    const enrichedInvoice: InvoiceData = { ...invoice, emailContext };

    const processorFunctionName = `${process.env.AWS_STACK_NAME}-EnrichInvoiceProcessor`;
    const lambda = new LambdaClient({ region: process.env.AWS_REGION });

    await lambda.send(new InvokeCommand({
      FunctionName: processorFunctionName,
      InvocationType: 'Event',
      Payload: JSON.stringify({
        data: [enrichedInvoice],
        page: 1,
        totalPages: 1,
      }),
    }));

    debug(`Triggered enrichment for invoice ${supplierInvoiceId}`);
    return jsonResponse(202, {
      message: 'Enrichment triggered',
      supplierInvoiceId,
    });
  } catch (error) {
    debug('Error triggering invoice enrichment:', error);
    return jsonResponse(500, { message: 'Internal server error' });
  }
}
