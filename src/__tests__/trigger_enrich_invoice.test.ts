import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { InvokeCommand } from '@aws-sdk/client-lambda';
import { handler } from '../trigger_enrich_invoice.js';

const mockSend = jest.fn().mockResolvedValue({});

jest.mock('@pga/lambda-env', () => ({
  __esModule: true,
  default: jest.fn().mockResolvedValue({
    ENRICH_INVOICE_API_TOKEN: 'expected-token',
    AWS_STACK_NAME: 'finance-agent',
    AWS_REGION: 'us-east-1',
    WORKDAY_DOMAIN: 'test.workday.com',
    WORKDAY_TENANT: 'test-tenant',
    WORKDAY_CLIENT_ID: 'client-id',
    WORKDAY_CLIENT_SECRET: 'client-secret',
    WORKDAY_REFRESH_TOKEN: 'refresh-token',
  }),
}));

jest.mock('@pga/logger', () => ({
  debug: jest.fn(),
}));

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({
    send: mockSend,
  })),
  InvokeCommand: jest.fn(),
}));

jest.mock('../lib/workday.js', () => ({
  getWorkdayConfig: jest.fn().mockReturnValue({
    domain: 'test.workday.com',
    tenant: 'test-tenant',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    refreshToken: 'refresh-token',
  }),
  executeWorkdayQuery: jest.fn(),
  getInboundEmailsForOCRInvoices: jest.fn(),
}));

const mockClearInvoiceValidationFailure = jest.fn().mockResolvedValue(undefined);

jest.mock('../lib/invoice_validation_failures.js', () => {
  const actual = jest.requireActual('../lib/invoice_validation_failures.js');
  return {
    ...actual,
    getInvoiceValidationFailuresConfig: jest.fn().mockReturnValue({
      tableName: 'finance-agent-invoice-validation-failures',
    }),
    clearInvoiceValidationFailure: (...args: unknown[]) => mockClearInvoiceValidationFailure(...args),
  };
});

import { executeWorkdayQuery, getInboundEmailsForOCRInvoices } from '../lib/workday.js';

const mockExecuteWorkdayQuery = executeWorkdayQuery as jest.MockedFunction<typeof executeWorkdayQuery>;
const mockGetInboundEmailsForOCRInvoices = getInboundEmailsForOCRInvoices as jest.MockedFunction<typeof getInboundEmailsForOCRInvoices>;

function buildEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /enrich-invoice',
    rawPath: '/enrich-invoice',
    rawQueryString: '',
    headers: {
      authorization: 'Bearer expected-token',
      'content-type': 'application/json',
    },
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      domainName: 'example.execute-api.us-east-1.amazonaws.com',
      domainPrefix: 'example',
      http: {
        method: 'POST',
        path: '/enrich-invoice',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'jest',
      },
      requestId: 'request-id',
      routeKey: 'POST /enrich-invoice',
      stage: '$default',
      time: '09/Jun/2026:00:00:00 +0000',
      timeEpoch: 0,
    },
    isBase64Encoded: false,
    body: JSON.stringify({ supplierInvoiceId: 'invoice-wid-123' }),
    ...overrides,
  };
}

describe('trigger_enrich_invoice handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClearInvoiceValidationFailure.mockResolvedValue(undefined);
    mockSend.mockResolvedValue({});
    mockGetInboundEmailsForOCRInvoices.mockResolvedValue(new Map());
    mockExecuteWorkdayQuery.mockResolvedValue({
      total: 1,
      data: [{
        workdayID: 'invoice-wid-123',
        invoiceStatusAsText: 'Draft',
        OCRSupplierInvoice: {
          descriptor: '24953$4729',
          id: 'ocr-id',
        },
      }],
    });
  });

  it('returns 401 when Authorization header is missing', async () => {
    const response = await handler(buildEvent({ headers: {} }));

    expect(response).toEqual({
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Unauthorized' }),
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns 401 when bearer token is invalid', async () => {
    const response = await handler(buildEvent({
      headers: { authorization: 'Bearer wrong-token' },
    }));

    expect(response).toEqual({
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Unauthorized' }),
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns 400 when supplierInvoiceId is missing', async () => {
    const response = await handler(buildEvent({ body: '{}' }));

    expect(response).toEqual({
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'supplierInvoiceId is required' }),
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns 400 when body is invalid JSON', async () => {
    const response = await handler(buildEvent({ body: 'not-json' }));

    expect(response).toEqual({
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Invalid JSON body; supplierInvoiceId must be a quoted string',
      }),
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('accepts an unquoted supplierInvoiceId WID in the request body', async () => {
    const response = await handler(buildEvent({
      body: '{\n  "supplierInvoiceId": 77bfcad92b869001464c934999520000\n}',
    }));

    expect(response).toEqual({
      statusCode: 202,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Enrichment triggered',
        supplierInvoiceId: '77bfcad92b869001464c934999520000',
      }),
    });
    expect(mockGetInboundEmailsForOCRInvoices).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('returns 404 when invoice is not found by WID or invoice number', async () => {
    mockExecuteWorkdayQuery.mockResolvedValue({ total: 0, data: [] });

    const response = await handler(buildEvent());

    expect(response).toEqual({
      statusCode: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Invoice not found' }),
    });
    expect(mockExecuteWorkdayQuery).toHaveBeenCalledTimes(2);
    expect(mockGetInboundEmailsForOCRInvoices).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('falls back to invoice number lookup when WID lookup returns no rows', async () => {
    mockExecuteWorkdayQuery
      .mockResolvedValueOnce({ total: 0, data: [] })
      .mockResolvedValueOnce({
        total: 1,
        data: [{
          workdayID: 'invoice-wid-123',
          invoiceStatusAsText: 'Draft',
          OCRSupplierInvoice: {
            descriptor: '24953$4729',
            id: 'ocr-id',
          },
        }],
      });

    const response = await handler(buildEvent({
      body: JSON.stringify({ supplierInvoiceId: 'SUPIN-412727' }),
    }));

    expect(response).toEqual({
      statusCode: 202,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Enrichment triggered',
        supplierInvoiceId: 'SUPIN-412727',
      }),
    });
    expect(mockExecuteWorkdayQuery).toHaveBeenCalledTimes(2);
    expect(mockGetInboundEmailsForOCRInvoices).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('returns 202 and invokes processor when request is valid', async () => {
    const emailContext = {
      emailFrom: 'ap@vendor.com',
      subject: 'Invoice attached',
      plainTextBody: 'Please process',
    };
    mockGetInboundEmailsForOCRInvoices.mockResolvedValue(new Map([
      ['invoice-wid-123', emailContext],
    ]));

    const response = await handler(buildEvent());

    expect(response).toEqual({
      statusCode: 202,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Enrichment triggered',
        supplierInvoiceId: 'invoice-wid-123',
      }),
    });

    expect(InvokeCommand).toHaveBeenCalledWith({
      FunctionName: 'finance-agent-EnrichInvoiceProcessor',
      InvocationType: 'Event',
      Payload: JSON.stringify({
        data: [{
          workdayID: 'invoice-wid-123',
          invoiceStatusAsText: 'Draft',
          OCRSupplierInvoice: {
            descriptor: '24953$4729',
            id: 'ocr-id',
          },
          emailContext,
        }],
        page: 1,
        totalPages: 1,
      }),
    });
    expect(mockGetInboundEmailsForOCRInvoices).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('clears validation failure record before invoking processor', async () => {
    const response = await handler(buildEvent());

    expect(response).toEqual({
      statusCode: 202,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Enrichment triggered',
        supplierInvoiceId: 'invoice-wid-123',
      }),
    });
    expect(mockClearInvoiceValidationFailure).toHaveBeenCalledTimes(1);
    expect(mockClearInvoiceValidationFailure).toHaveBeenCalledWith(
      { tableName: 'finance-agent-invoice-validation-failures' },
      'invoice-wid-123',
    );
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('clears validation failure using resolved workdayID when lookup is by invoice number', async () => {
    mockExecuteWorkdayQuery
      .mockResolvedValueOnce({ total: 0, data: [] })
      .mockResolvedValueOnce({
        total: 1,
        data: [{
          workdayID: 'resolved-wid-from-number',
          invoiceStatusAsText: 'Draft',
          OCRSupplierInvoice: {
            descriptor: '24953$4729',
            id: 'ocr-id',
          },
        }],
      });

    await handler(buildEvent({
      body: JSON.stringify({ supplierInvoiceId: 'SUPIN-412727' }),
    }));

    expect(mockClearInvoiceValidationFailure).toHaveBeenCalledWith(
      { tableName: 'finance-agent-invoice-validation-failures' },
      'resolved-wid-from-number',
    );
  });
});
