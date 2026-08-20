import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { InvokeCommand } from '@aws-sdk/client-lambda';
import { handler } from '../trigger_create_invoice_gmail.js';
import {
  GmailAttachmentTooLargeError,
  GmailNoAttachmentError,
  GmailNotFoundError,
  GmailUpstreamError,
} from '../lib/gmail.js';

const mockSend = jest.fn().mockResolvedValue({});
const mockPutBinaryToS3 = jest.fn().mockResolvedValue(undefined);
const mockGetGmailConfig = jest.fn();
const mockGetSupplierInvoiceLabelState = jest.fn();
const mockFetchGmailMessageInvoiceData = jest.fn();
const mockDownloadGmailAttachments = jest.fn();
const mockSetSupplierInvoiceLabel = jest.fn();

jest.mock('@pga/lambda-env', () => ({
  __esModule: true,
  default: jest.fn().mockResolvedValue({
    ENRICH_INVOICE_API_TOKEN: 'expected-token',
    GMAIL_SERVICE_ACCOUNT_SECRET_ARN: 'finance-agent/gmail-service-account',
    ADDON_ENVIRONMENT: 'sandbox',
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

jest.mock('../lib/gmail.js', () => {
  const actual = jest.requireActual('../lib/gmail.js') as typeof import('../lib/gmail.js');
  return {
    ...actual,
    getGmailConfig: (...args: unknown[]) => mockGetGmailConfig(...args),
    getSupplierInvoiceLabelState: (...args: unknown[]) => mockGetSupplierInvoiceLabelState(...args),
    fetchGmailMessageInvoiceData: (...args: unknown[]) => mockFetchGmailMessageInvoiceData(...args),
    downloadGmailAttachments: (...args: unknown[]) => mockDownloadGmailAttachments(...args),
    setSupplierInvoiceLabel: (...args: unknown[]) => mockSetSupplierInvoiceLabel(...args),
  };
});

jest.mock('node:crypto', () => ({
  ...jest.requireActual('node:crypto'),
  randomUUID: jest.fn().mockReturnValue('fixed-request-id'),
}));

function buildEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /create-invoice/gmail',
    rawPath: '/create-invoice/gmail',
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
        path: '/create-invoice/gmail',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'jest',
      },
      requestId: 'request-id',
      routeKey: 'POST /create-invoice/gmail',
      stage: '$default',
      time: '09/Jun/2026:00:00:00 +0000',
      timeEpoch: 0,
    },
    isBase64Encoded: false,
    body: JSON.stringify({ gmailMessageId: 'msg-1', userEmail: 'ap@pgahq.com' }),
    ...overrides,
  };
}

const emailContext = {
  emailFrom: 'ap@vendor.com',
  subject: 'Please process',
  plainTextBody: 'Invoice attached',
};
const messageInvoiceData = {
  attachments: [{
    name: 'invoice.pdf',
    contentType: 'application/pdf',
    emailContext,
    attachmentId: 'att-1',
  }],
  emailContext,
  labelIds: ['INBOX'],
};

describe('trigger_create_invoice_gmail handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockResolvedValue({});
    mockPutBinaryToS3.mockResolvedValue(undefined);
    mockSetSupplierInvoiceLabel.mockResolvedValue(undefined);
    mockGetGmailConfig.mockResolvedValue({
      accessToken: 'ya29.test',
      userEmail: 'ap@pgahq.com',
      environment: 'sandbox',
      apiBaseUrl: 'https://gmail.googleapis.com',
    });
    mockGetSupplierInvoiceLabelState.mockResolvedValue(null);
    mockFetchGmailMessageInvoiceData.mockResolvedValue(messageInvoiceData);
    mockDownloadGmailAttachments.mockResolvedValue([Buffer.from('invoice-content')]);
  });

  it('returns 401 when the bearer token is invalid', async () => {
    const response = await handler(buildEvent({
      headers: { authorization: 'Bearer wrong-token' },
    }));
    expect(response).toEqual({
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'error', message: 'Unauthorized' }),
    });
    expect(mockFetchGmailMessageInvoiceData).not.toHaveBeenCalled();
  });

  it('returns 400 when gmailMessageId is missing', async () => {
    const response = await handler(buildEvent({
      body: JSON.stringify({ userEmail: 'ap@pgahq.com' }),
    }));
    expect(response).toEqual({
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'error', message: 'gmailMessageId is required' }),
    });
  });

  it('returns 409 when the message is already labeled and force is not set', async () => {
    mockGetSupplierInvoiceLabelState.mockResolvedValue('success');
    const response = await handler(buildEvent());
    expect(response).toEqual({
      statusCode: 409,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'error',
        message: 'Supplier invoice already submitted for this message',
        gmailMessageId: 'msg-1',
        labelState: 'success',
      }),
    });
    expect(mockFetchGmailMessageInvoiceData).not.toHaveBeenCalled();
  });

  it('returns 404 when the Gmail message is missing', async () => {
    mockGetSupplierInvoiceLabelState.mockRejectedValue(new GmailNotFoundError('msg-1'));
    const response = await handler(buildEvent());
    expect(response).toEqual({
      statusCode: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'error',
        message: 'Message not found',
        gmailMessageId: 'msg-1',
      }),
    });
  });

  it('returns 400 when no PDF is attached', async () => {
    mockFetchGmailMessageInvoiceData.mockRejectedValue(new GmailNoAttachmentError('msg-1'));
    const response = await handler(buildEvent());
    expect(response).toEqual({
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'error',
        message: 'No PDF attachment found on message',
        gmailMessageId: 'msg-1',
      }),
    });
  });

  it('returns 400 when an attachment is too large', async () => {
    mockDownloadGmailAttachments.mockRejectedValue(new GmailAttachmentTooLargeError(99, true));
    const response = await handler(buildEvent());
    expect(response).toEqual({
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'error',
        message: 'Combined attachment size exceeds maximum allowed size',
        gmailMessageId: 'msg-1',
      }),
    });
  });

  it('returns 502 when Gmail is unavailable', async () => {
    mockFetchGmailMessageInvoiceData.mockRejectedValue(new GmailUpstreamError('boom', 500));
    const response = await handler(buildEvent());
    expect(response).toEqual({
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'error',
        message: 'Failed to fetch message from Gmail',
        gmailMessageId: 'msg-1',
      }),
    });
  });

  it('sets processing, uploads to S3, invokes the processor, and returns 202', async () => {
    const response = await handler(buildEvent());
    expect(response).toEqual({
      statusCode: 202,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'accepted',
        message: 'Supplier invoice creation triggered',
        requestId: 'fixed-request-id',
        gmailMessageId: 'msg-1',
        attachmentCount: 1,
      }),
    });
    expect(mockSetSupplierInvoiceLabel).toHaveBeenCalledWith(expect.anything(), 'msg-1', 'processing');
    expect(mockPutBinaryToS3).toHaveBeenCalledWith(
      { bucketName: 'test-bucket' },
      'new-invoices/fixed-request-id/1-invoice.pdf',
      Buffer.from('invoice-content'),
      'application/pdf',
      expect.objectContaining({
        'original-filename': 'invoice.pdf',
        'gmail-message-id': 'msg-1',
        'gmail-user-email': 'ap@pgahq.com',
      }),
    );
    expect(mockGetGmailConfig).toHaveBeenCalledWith(expect.anything(), 'ap@pgahq.com', undefined);
    expect(InvokeCommand).toHaveBeenCalledWith({
      FunctionName: 'finance-agent-CreateInvoiceProcessor',
      InvocationType: 'Event',
      Payload: JSON.stringify({
        data: [{
          s3Key: 'new-invoices/fixed-request-id/1-invoice.pdf',
          fileName: 'invoice.pdf',
          contentType: 'application/pdf',
          emailContext,
          gmailMessageId: 'msg-1',
          userEmail: 'ap@pgahq.com',
        }],
        page: 1,
        totalPages: 1,
      }),
    });
  });

  it('passes a user OAuth token to Gmail and the processor, not S3 metadata', async () => {
    const response = await handler(buildEvent({
      body: JSON.stringify({
        gmailMessageId: 'msg-1',
        userEmail: 'ap@pgahq.com',
        gmailAccessToken: 'ya29.user',
      }),
    }));
    expect(response).toMatchObject({ statusCode: 202 });
    expect(mockGetGmailConfig).toHaveBeenCalledWith(expect.anything(), 'ap@pgahq.com', 'ya29.user');
    expect(mockPutBinaryToS3).toHaveBeenCalledWith(
      { bucketName: 'test-bucket' },
      'new-invoices/fixed-request-id/1-invoice.pdf',
      Buffer.from('invoice-content'),
      'application/pdf',
      expect.not.objectContaining({
        'gmail-access-token': expect.anything(),
      }),
    );
    expect(JSON.stringify(mockPutBinaryToS3.mock.calls)).not.toContain('ya29.user');
    expect(InvokeCommand).toHaveBeenCalledWith({
      FunctionName: 'finance-agent-CreateInvoiceProcessor',
      InvocationType: 'Event',
      Payload: JSON.stringify({
        data: [{
          s3Key: 'new-invoices/fixed-request-id/1-invoice.pdf',
          fileName: 'invoice.pdf',
          contentType: 'application/pdf',
          emailContext,
          gmailMessageId: 'msg-1',
          userEmail: 'ap@pgahq.com',
          gmailAccessToken: 'ya29.user',
        }],
        page: 1,
        totalPages: 1,
      }),
    });
  });

  it('re-runs when force is true even if a label already exists', async () => {
    mockGetSupplierInvoiceLabelState.mockResolvedValue('success');
    const response = await handler(buildEvent({
      body: JSON.stringify({ gmailMessageId: 'msg-1', userEmail: 'ap@pgahq.com', force: true }),
    }));
    expect(response).toMatchObject({ statusCode: 202 });
    expect(mockSetSupplierInvoiceLabel).toHaveBeenCalledWith(expect.anything(), 'msg-1', 'processing');
  });

  it('sets failure when ingest fails after processing was applied', async () => {
    mockPutBinaryToS3.mockRejectedValue(new Error('s3 down'));
    const response = await handler(buildEvent());
    expect(response).toMatchObject({ statusCode: 500 });
    expect(mockSetSupplierInvoiceLabel).toHaveBeenNthCalledWith(1, expect.anything(), 'msg-1', 'processing');
    expect(mockSetSupplierInvoiceLabel).toHaveBeenNthCalledWith(2, expect.anything(), 'msg-1', 'failure');
  });

  it('still invokes the processor when exclusive labels cannot be read', async () => {
    mockGetSupplierInvoiceLabelState.mockRejectedValue(new GmailUpstreamError('Gmail labels API returned 403', 403));
    const response = await handler(buildEvent());
    expect(response).toMatchObject({ statusCode: 202 });
    expect(mockFetchGmailMessageInvoiceData).toHaveBeenCalled();
    expect(InvokeCommand).toHaveBeenCalled();
  });

  it('still invokes the processor when the processing label cannot be set', async () => {
    mockSetSupplierInvoiceLabel.mockRejectedValueOnce(new GmailUpstreamError('Gmail modify returned 403', 403));
    const response = await handler(buildEvent());
    expect(response).toMatchObject({ statusCode: 202 });
    expect(InvokeCommand).toHaveBeenCalled();
  });
});
