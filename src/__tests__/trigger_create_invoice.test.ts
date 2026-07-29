import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { InvokeCommand } from '@aws-sdk/client-lambda';
import { handler } from '../trigger_create_invoice.js';

const mockSend = jest.fn().mockResolvedValue({});
const mockPutBinaryToS3 = jest.fn().mockResolvedValue(undefined);

jest.mock('@pga/lambda-env', () => ({
  __esModule: true,
  default: jest.fn().mockResolvedValue({
    ENRICH_INVOICE_API_TOKEN: 'expected-token',
    AWS_STACK_NAME: 'finance-agent',
    AWS_REGION: 'us-east-1',
    S3_BUCKET_NAME: 'test-bucket',
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

jest.mock('../lib/s3.js', () => ({
  getS3Config: jest.fn().mockReturnValue({ bucketName: 'test-bucket' }),
  putBinaryToS3: (...args: unknown[]) => mockPutBinaryToS3(...args),
}));

jest.mock('node:crypto', () => ({
  ...jest.requireActual('node:crypto'),
  randomUUID: jest.fn().mockReturnValue('fixed-request-id'),
}));

function buildEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /create-invoice',
    rawPath: '/create-invoice',
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
        path: '/create-invoice',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'jest',
      },
      requestId: 'request-id',
      routeKey: 'POST /create-invoice',
      stage: '$default',
      time: '09/Jun/2026:00:00:00 +0000',
      timeEpoch: 0,
    },
    isBase64Encoded: false,
    body: JSON.stringify({
      fileName: 'invoice.pdf',
      contentType: 'application/pdf',
      fileContent: Buffer.from('fake-pdf-content').toString('base64'),
    }),
    ...overrides,
  };
}

describe('trigger_create_invoice handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockResolvedValue({});
    mockPutBinaryToS3.mockResolvedValue(undefined);
  });

  it('returns 401 when Authorization header is missing', async () => {
    const response = await handler(buildEvent({ headers: {} }));

    expect(response).toEqual({
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Unauthorized' }),
    });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockPutBinaryToS3).not.toHaveBeenCalled();
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
    expect(mockPutBinaryToS3).not.toHaveBeenCalled();
  });

  it('returns 400 when body is invalid JSON', async () => {
    const response = await handler(buildEvent({ body: 'not-json' }));

    expect(response).toEqual({
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Invalid JSON body' }),
    });
    expect(mockPutBinaryToS3).not.toHaveBeenCalled();
  });

  it('returns 400 when required fields are missing', async () => {
    const response = await handler(buildEvent({ body: JSON.stringify({ fileName: 'invoice.pdf' }) }));

    expect(response).toEqual({
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'fileName, contentType, and fileContent (base64) are required' }),
    });
    expect(mockPutBinaryToS3).not.toHaveBeenCalled();
  });

  it('returns 202 and invokes the processor with the uploaded S3 key when the request is valid', async () => {
    const response = await handler(buildEvent());

    expect(response).toEqual({
      statusCode: 202,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Invoice creation triggered',
        requestId: 'fixed-request-id',
      }),
    });

    expect(mockPutBinaryToS3).toHaveBeenCalledWith(
      { bucketName: 'test-bucket' },
      'new-invoices/fixed-request-id/invoice.pdf',
      Buffer.from('fake-pdf-content'),
      'application/pdf',
      expect.objectContaining({ 'original-filename': 'invoice.pdf' }),
    );

    expect(InvokeCommand).toHaveBeenCalledWith({
      FunctionName: 'finance-agent-CreateInvoiceProcessor',
      InvocationType: 'Event',
      Payload: JSON.stringify({
        data: [{
          s3Key: 'new-invoices/fixed-request-id/invoice.pdf',
          fileName: 'invoice.pdf',
          contentType: 'application/pdf',
        }],
        page: 1,
        totalPages: 1,
      }),
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when the processor invoke reports a function error', async () => {
    mockSend.mockResolvedValue({ FunctionError: 'Unhandled', Payload: Buffer.from('{"errorMessage":"boom"}') });

    const response = await handler(buildEvent());

    expect(response).toEqual({
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Internal server error' }),
    });
  });
});
