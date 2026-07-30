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
    requestBody = event.body ? JSON.parse(event.body) as TriggerCreateInvoiceRequest : {};
  } catch (error) {
    debug('Invalid JSON body', { error: formatError(error) });
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

  const { attachment, emailContext } = conversationData;
  const fileName = attachment.name;
  const contentType = attachment.contentType;

  let buffer: Buffer;
  try {
    buffer = await downloadAttachment(attachment.url);
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
    const s3Key = `new-invoices/${requestId}/${fileName}`;

    debug('Uploading new invoice attachment to S3', {
      s3Key,
      contentType,
      size: buffer.length,
      conversationId,
    });
    await putBinaryToS3(s3Config, s3Key, buffer, contentType, {
      'original-filename': fileName,
      'upload-timestamp': new Date().toISOString(),
      'intercom-conversation-id': conversationId,
    });

    const processorFunctionName = `${process.env.AWS_STACK_NAME}-CreateInvoiceProcessor`;
    const lambda = new LambdaClient({ region: process.env.AWS_REGION });

    const invokeResult = await lambda.send(new InvokeCommand({
      FunctionName: processorFunctionName,
      InvocationType: 'Event',
      Payload: JSON.stringify({
        data: [{
          s3Key,
          fileName,
          contentType,
          conversationId,
          emailContext,
        }],
        page: 1,
        totalPages: 1,
      }),
    }));

    if (invokeResult.FunctionError) {
      debug('Create invoice processor invoke error', {
        functionError: invokeResult.FunctionError,
        payload: invokeResult.Payload
          ? Buffer.from(invokeResult.Payload).toString('utf8')
          : undefined,
      });
      return jsonResponse(500, { status: 'error', message: 'Internal server error' });
    }

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
