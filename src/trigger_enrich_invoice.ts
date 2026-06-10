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

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function jsonResponse(statusCode: number, body: Record<string, string>): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

const INVOICE_LOOKUP_SELECT = `
  SELECT
    workdayID,
    OCRSupplierInvoice,
    supplier,
    company1
  FROM supplierInvoices (dataSourceFilter = supplierInvoicesFilter)
`;

function escapeWqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function buildInvoiceLookupByWidQuery(workdayId: string): string {
  return `${INVOICE_LOOKUP_SELECT} WHERE workdayID = '${escapeWqlLiteral(workdayId)}'`;
}

function buildInvoiceLookupByNumberQuery(invoiceNumber: string): string {
  return `${INVOICE_LOOKUP_SELECT} WHERE invoiceNumber = '${escapeWqlLiteral(invoiceNumber)}'`;
}

async function lookupSupplierInvoice(
  workdayConfig: ReturnType<typeof getWorkdayConfig>,
  supplierInvoiceId: string,
): Promise<InvoiceData[]> {
  const byWid = await executeWorkdayQuery(workdayConfig, buildInvoiceLookupByWidQuery(supplierInvoiceId));
  const widMatches = byWid.data;
  if (Array.isArray(widMatches) && widMatches.length > 0) {
    return widMatches as InvoiceData[];
  }

  const byNumber = await executeWorkdayQuery(workdayConfig, buildInvoiceLookupByNumberQuery(supplierInvoiceId));
  const numberMatches = byNumber.data;
  if (Array.isArray(numberMatches) && numberMatches.length > 0) {
    return numberMatches as InvoiceData[];
  }

  return [];
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  debug('Trigger enrich invoice request body', event.body);
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
  } catch (error) {
    debug('Invalid JSON body', { body: event.body, error: formatError(error) });
    return jsonResponse(400, { message: 'Invalid JSON body' });
  }

  const supplierInvoiceId = requestBody.supplierInvoiceId?.trim();
  if (!supplierInvoiceId) {
    return jsonResponse(400, { message: 'supplierInvoiceId is required' });
  }

  try {
    const workdayConfig = getWorkdayConfig(process.env);
    const invoices = await lookupSupplierInvoice(workdayConfig, supplierInvoiceId);

    if (invoices.length === 0) {
      return jsonResponse(404, { message: 'Invoice not found' });
    }

    const emailMap = await getInboundEmailsForOCRInvoices(workdayConfig);
    const invoice = invoices[0];
    const emailContext = emailMap.get(invoice.workdayID);
    const enrichedInvoice: InvoiceData = { ...invoice, emailContext };

    const processorFunctionName = `${process.env.AWS_STACK_NAME}-EnrichInvoiceProcessor`;
    const lambda = new LambdaClient({ region: process.env.AWS_REGION });

    const invokeResult = await lambda.send(new InvokeCommand({
      FunctionName: processorFunctionName,
      InvocationType: 'Event',
      Payload: JSON.stringify({
        data: [enrichedInvoice],
        page: 1,
        totalPages: 1,
      }),
    }));

    if (invokeResult.FunctionError) {
      debug('Enrich invoice processor invoke error', {
        body: event.body,
        functionError: invokeResult.FunctionError,
        payload: invokeResult.Payload
          ? Buffer.from(invokeResult.Payload).toString('utf8')
          : undefined,
      });
      return jsonResponse(500, { message: 'Internal server error' });
    }

    return jsonResponse(202, {
      message: 'Enrichment triggered',
      supplierInvoiceId,
    });
  } catch (error) {
    debug('Error triggering invoice enrichment', {
      body: event.body,
      error: formatError(error),
    });
    return jsonResponse(500, { message: 'Internal server error' });
  }
}
