import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { InvokeCommand } from '@aws-sdk/client-lambda';
import { handler } from '../trigger_create_invoice.js';
import {
  IntercomAttachmentTooLargeError,
  IntercomNoAttachmentError,
  IntercomNotFoundError,
  IntercomUpstreamError,
} from '../lib/intercom.js';

const mockSend = jest.fn().mockResolvedValue({});
const mockPutBinaryToS3 = jest.fn().mockResolvedValue(undefined);
const mockFetchConversationInvoiceData = jest.fn();
const mockDownloadAttachment = jest.fn();
const mockGetIntercomConfig = jest.fn();

jest.mock('@pga/lambda-env', () => ({
  __esModule: true,
  default: jest.fn().mockResolvedValue({
    ENRICH_INVOICE_API_TOKEN: 'expected-token',
    INTERCOM_ACCESS_TOKEN: 'intercom-token',
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

jest.mock('../lib/intercom.js', () => {
  const actual = jest.requireActual('../lib/intercom.js');
  return {
    ...actual,
    getIntercomConfig: (...args: unknown[]) => mockGetIntercomConfig(...args),
    fetchConversationInvoiceData: (...args: unknown[]) => mockFetchConversationInvoiceData(...args),
    downloadAttachment: (...args: unknown[]) => mockDownloadAttachment(...args),
  };
});

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
    body: JSON.stringify({ conversationId: '1234567890' }),
    ...overrides,
  };
}

const invoiceEmailContext = {
  emailFrom: 'ap@vendor.com',
  subject: 'Please process',
  plainTextBody: 'Invoice attached',
};
const supportEmailContext = {
  emailFrom: 'approver@pgahq.com',
  subject: 'Please process',
  plainTextBody: 'Use cost center 72200',
};
const conversationInvoiceData = {
  attachments: [
    {
      name: 'invoice.pdf',
      url: 'https://downloads.intercomcdn.com/invoice.pdf',
      contentType: 'application/pdf',
      emailContext: invoiceEmailContext,
    },
    {
      name: 'support.pdf',
      url: 'https://downloads.intercomcdn.com/support.pdf',
      contentType: 'application/pdf',
      emailContext: supportEmailContext,
    },
  ],
};

describe('trigger_create_invoice handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockResolvedValue({});
    mockPutBinaryToS3.mockResolvedValue(undefined);
    mockGetIntercomConfig.mockReturnValue({
      accessToken: 'intercom-token',
      apiBaseUrl: 'https://api.intercom.io',
    });
    mockFetchConversationInvoiceData.mockResolvedValue(conversationInvoiceData);
    mockDownloadAttachment.mockImplementation(async (url: string) =>
      Buffer.from(url.includes('support') ? 'support-content' : 'invoice-content')
    );
  });

  it('returns 401 when Authorization header is missing', async () => {
    const response = await handler(buildEvent({ headers: {} }));

    expect(response).toEqual({
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'error', message: 'Unauthorized' }),
    });
    expect(mockFetchConversationInvoiceData).not.toHaveBeenCalled();
  });

  it('returns 401 when bearer token is invalid', async () => {
    const response = await handler(buildEvent({
      headers: { authorization: 'Bearer wrong-token' },
    }));

    expect(response).toEqual({
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'error', message: 'Unauthorized' }),
    });
  });

  it('returns 400 when body is invalid JSON', async () => {
    const response = await handler(buildEvent({ body: 'not-json' }));

    expect(response).toEqual({
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'error', message: 'Invalid JSON body' }),
    });
  });

  it('returns 400 when conversationId is missing', async () => {
    const response = await handler(buildEvent({ body: JSON.stringify({}) }));

    expect(response).toEqual({
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'error', message: 'conversationId is required' }),
    });
  });

  it('decodes a base64-encoded JSON body from API Gateway', async () => {
    const jsonBody = JSON.stringify({ conversationId: '1234567890' });
    const response = await handler(buildEvent({
      isBase64Encoded: true,
      body: Buffer.from(jsonBody, 'utf8').toString('base64'),
    }));

    expect(response).toMatchObject({ statusCode: 202 });
    expect(mockFetchConversationInvoiceData).toHaveBeenCalledWith(
      expect.anything(),
      '1234567890',
    );
  });

  it('returns 404 when the Intercom conversation is not found', async () => {
    mockFetchConversationInvoiceData.mockRejectedValue(new IntercomNotFoundError('1234567890'));

    const response = await handler(buildEvent());

    expect(response).toEqual({
      statusCode: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'error',
        message: 'Conversation not found',
        conversationId: '1234567890',
      }),
    });
  });

  it('returns 400 when the conversation has no PDF attachment', async () => {
    mockFetchConversationInvoiceData.mockRejectedValue(new IntercomNoAttachmentError('1234567890'));

    const response = await handler(buildEvent());

    expect(response).toEqual({
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'error',
        message: 'No PDF attachment found on conversation',
        conversationId: '1234567890',
      }),
    });
  });

  it('returns 400 when the attachment exceeds the max size', async () => {
    mockDownloadAttachment.mockRejectedValue(new IntercomAttachmentTooLargeError(21 * 1024 * 1024));

    const response = await handler(buildEvent());

    expect(response).toEqual({
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'error',
        message: 'Attachment exceeds maximum allowed size',
        conversationId: '1234567890',
      }),
    });
  });

  it('returns 400 when the combined attachments exceed the max size', async () => {
    mockDownloadAttachment.mockResolvedValue(Buffer.alloc(11 * 1024 * 1024));

    const response = await handler(buildEvent());

    expect(response).toEqual({
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'error',
        message: 'Attachment exceeds maximum allowed size',
        conversationId: '1234567890',
      }),
    });
  });

  it('returns 502 when Intercom Conversations API fails', async () => {
    mockFetchConversationInvoiceData.mockRejectedValue(
      new IntercomUpstreamError('Intercom Conversations API returned 503', 503),
    );

    const response = await handler(buildEvent());

    expect(response).toEqual({
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'error',
        message: 'Failed to fetch conversation from Intercom',
        conversationId: '1234567890',
      }),
    });
  });

  it('returns 502 when the attachment download fails', async () => {
    mockDownloadAttachment.mockRejectedValue(
      new IntercomUpstreamError('Intercom attachment download returned 403', 403),
    );

    const response = await handler(buildEvent());

    expect(response).toEqual({
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'error',
        message: 'Failed to download conversation attachment',
        conversationId: '1234567890',
      }),
    });
  });

  it('uploads every PDF and invokes the processor with all attachment metadata', async () => {
    const response = await handler(buildEvent());

    expect(response).toEqual({
      statusCode: 202,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'accepted',
        message: 'Invoice creation triggered',
        requestId: 'fixed-request-id',
        conversationId: '1234567890',
      }),
    });

    expect(mockPutBinaryToS3).toHaveBeenNthCalledWith(
      1,
      { bucketName: 'test-bucket' },
      'new-invoices/fixed-request-id/1-invoice.pdf',
      Buffer.from('invoice-content'),
      'application/pdf',
      expect.objectContaining({
        'original-filename': 'invoice.pdf',
        'intercom-conversation-id': '1234567890',
      }),
    );
    expect(mockPutBinaryToS3).toHaveBeenNthCalledWith(
      2,
      { bucketName: 'test-bucket' },
      'new-invoices/fixed-request-id/2-support.pdf',
      Buffer.from('support-content'),
      'application/pdf',
      expect.objectContaining({
        'original-filename': 'support.pdf',
        'intercom-conversation-id': '1234567890',
      }),
    );

    expect(InvokeCommand).toHaveBeenCalledWith({
      FunctionName: 'finance-agent-CreateInvoiceProcessor',
      InvocationType: 'Event',
      Payload: JSON.stringify({
        data: [
          {
            s3Key: 'new-invoices/fixed-request-id/1-invoice.pdf',
            fileName: 'invoice.pdf',
            contentType: 'application/pdf',
            emailContext: invoiceEmailContext,
          },
          {
            s3Key: 'new-invoices/fixed-request-id/2-support.pdf',
            fileName: 'support.pdf',
            contentType: 'application/pdf',
            emailContext: supportEmailContext,
          },
        ],
        page: 1,
        totalPages: 1,
      }),
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

});
