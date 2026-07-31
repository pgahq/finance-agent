import { randomUUID } from 'node:crypto';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import loadEnv from '@pga/lambda-env';
import { debug } from '@pga/logger';
import { extractBearerToken, isAuthorizedBearer } from './lib/api_auth.js';
import {
  downloadAttachment,
  fetchConversationInvoiceData,
  getIntercomConfig,
  IntercomAttachmentTooLargeError,
  IntercomNoAttachmentError,
  IntercomNotFoundError,
  IntercomUpstreamError,
  MAX_ATTACHMENT_BYTES,
} from './lib/intercom.js';
import { getS3Config, putBinaryToS3 } from './lib/s3.js';

interface TriggerCreateInvoiceRequest {
  conversationId?: string;
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

function readRequestBody(event: APIGatewayProxyEventV2): string {
  if (!event.body) {
    return '';
  }
  if (event.isBase64Encoded) {
    return Buffer.from(event.body, 'base64').toString('utf8');
  }
  return event.body;
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  debug('Trigger create invoice request received');
  process.env = await loadEnv();

  const expectedToken = process.env.ENRICH_INVOICE_API_TOKEN;
  if (!expectedToken) {
    debug('ENRICH_INVOICE_API_TOKEN is not configured');
    return jsonResponse(500, { status: 'error', message: 'Internal server error' });
  }

  const providedToken = extractBearerToken(event.headers?.authorization);
  if (!isAuthorizedBearer(providedToken ?? '', expectedToken)) {
    debug('Unauthorized create invoice trigger request', {
      hasAuthorizationHeader: Boolean(event.headers?.authorization),
    });
    return jsonResponse(401, { status: 'error', message: 'Unauthorized' });
  }

  let requestBody: TriggerCreateInvoiceRequest;
  try {
    const rawBody = readRequestBody(event);
    requestBody = rawBody ? JSON.parse(rawBody) as TriggerCreateInvoiceRequest : {};
  } catch (error) {
    debug('Invalid JSON body', { error: formatError(error), isBase64Encoded: event.isBase64Encoded });
    return jsonResponse(400, { status: 'error', message: 'Invalid JSON body' });
  }

  const conversationId = typeof requestBody.conversationId === 'string'
    ? requestBody.conversationId.trim()
    : '';
  if (!conversationId) {
    debug('Missing conversationId in create invoice trigger request');
    return jsonResponse(400, { status: 'error', message: 'conversationId is required' });
  }

  let intercomConfig;
  try {
    intercomConfig = getIntercomConfig(process.env);
  } catch (error) {
    debug('INTERCOM_ACCESS_TOKEN is not configured', { error: formatError(error) });
    return jsonResponse(500, { status: 'error', message: 'Internal server error' });
  }

  let conversationData;
  try {
    conversationData = await fetchConversationInvoiceData(intercomConfig, conversationId);
  } catch (error) {
    if (error instanceof IntercomNotFoundError) {
      debug('Intercom conversation not found', { conversationId });
      return jsonResponse(404, {
        status: 'error',
        message: 'Conversation not found',
        conversationId,
      });
    }
    if (error instanceof IntercomNoAttachmentError) {
      debug('No PDF Intercom attachment', { conversationId });
      return jsonResponse(400, {
        status: 'error',
        message: 'No PDF attachment found on conversation',
        conversationId,
      });
    }
    if (error instanceof IntercomUpstreamError) {
      debug('Intercom upstream error fetching conversation', {
        conversationId,
        error: formatError(error),
        statusCode: error.statusCode,
      });
      return jsonResponse(502, {
        status: 'error',
        message: 'Failed to fetch conversation from Intercom',
        conversationId,
      });
    }
    debug('Unexpected error fetching Intercom conversation', {
      conversationId,
      error: formatError(error),
    });
    return jsonResponse(500, { status: 'error', message: 'Internal server error' });
  }

  const { attachments, emailContext } = conversationData;
  let buffers: Buffer[];
  try {
    buffers = await Promise.all(
      attachments.map((attachment) => downloadAttachment(attachment.url))
    );
    const totalBytes = buffers.reduce((total, buffer) => total + buffer.length, 0);
    if (totalBytes > MAX_ATTACHMENT_BYTES) {
      throw new IntercomAttachmentTooLargeError(totalBytes);
    }
  } catch (error) {
    if (error instanceof IntercomAttachmentTooLargeError) {
      debug('Intercom attachment too large', {
        conversationId,
        sizeBytes: error.sizeBytes,
      });
      return jsonResponse(400, {
        status: 'error',
        message: 'Attachment exceeds maximum allowed size',
        conversationId,
      });
    }
    if (error instanceof IntercomUpstreamError) {
      debug('Intercom attachment download failed', {
        conversationId,
        error: formatError(error),
        statusCode: error.statusCode,
      });
      return jsonResponse(502, {
        status: 'error',
        message: 'Failed to download conversation attachment',
        conversationId,
      });
    }
    debug('Unexpected error downloading Intercom attachment', {
      conversationId,
      error: formatError(error),
    });
    return jsonResponse(500, { status: 'error', message: 'Internal server error' });
  }

  try {
    const s3Config = getS3Config(process.env);
    const requestId = randomUUID();
    const uploadedAttachments = await Promise.all(attachments.map(async (attachment, index) => {
      const s3Key = `new-invoices/${requestId}/${index + 1}-${attachment.name}`;
      const buffer = buffers[index];
      await putBinaryToS3(s3Config, s3Key, buffer, attachment.contentType, {
        'original-filename': attachment.name,
        'upload-timestamp': new Date().toISOString(),
        'intercom-conversation-id': conversationId,
      });
      return {
        s3Key,
        fileName: attachment.name,
        contentType: attachment.contentType,
      };
    }));

    debug('Uploaded new invoice attachments to S3', {
      attachmentCount: uploadedAttachments.length,
      totalBytes: buffers.reduce((total, buffer) => total + buffer.length, 0),
      conversationId,
    });

    const processorFunctionName = `${process.env.AWS_STACK_NAME}-CreateInvoiceProcessor`;
    const lambda = new LambdaClient({ region: process.env.AWS_REGION });

    await Promise.all(uploadedAttachments.map((attachment) =>
      lambda.send(new InvokeCommand({
        FunctionName: processorFunctionName,
        InvocationType: 'Event',
        Payload: JSON.stringify({
          data: [{ ...attachment, emailContext }],
          page: 1,
          totalPages: 1,
        }),
      }))
    ));

    return jsonResponse(202, {
      status: 'accepted',
      message: 'Invoice creation triggered',
      requestId,
      conversationId,
    });
  } catch (error) {
    debug('Error triggering invoice creation', { error: formatError(error), conversationId });
    return jsonResponse(500, { status: 'error', message: 'Internal server error' });
  }
}
