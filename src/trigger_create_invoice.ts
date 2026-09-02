import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import loadEnv from '@pga/lambda-env';
import { debug } from '@pga/logger';
import { extractBearerToken, isAuthorizedBearer } from './lib/api_auth.js';
import { ingestCreateInvoiceAttachments } from './lib/create_invoice_ingest.js';
import { formatError, jsonResponse, readRequestBody } from './lib/http_api.js';
import {
  downloadAttachment,
  fetchConversationInvoiceData,
  getIntercomConfig,
  IntercomAttachmentTooLargeError,
  IntercomNoAttachmentError,
  IntercomNotFoundError,
  IntercomUpstreamError,
  MAX_ATTACHMENT_BYTES,
  type IntercomAttachment,
} from './lib/intercom.js';
import { MAX_CONCURRENT_ATTACHMENT_DOWNLOADS } from './lib/create_invoice_ingest.js';

interface TriggerCreateInvoiceRequest {
  conversationId?: string;
}

async function downloadInvoiceAttachments(attachments: IntercomAttachment[]): Promise<Buffer[]> {
  const buffers = new Array<Buffer>(attachments.length);
  let nextIndex = 0;
  let totalBytes = 0;
  let stopped = false;

  const worker = async () => {
    while (!stopped) {
      const index = nextIndex++;
      if (index >= attachments.length) return;

      try {
        const buffer = await downloadAttachment(attachments[index].url);
        totalBytes += buffer.length;
        if (totalBytes > MAX_ATTACHMENT_BYTES) {
          stopped = true;
          throw new IntercomAttachmentTooLargeError(totalBytes, true);
        }
        buffers[index] = buffer;
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(MAX_CONCURRENT_ATTACHMENT_DOWNLOADS, attachments.length) },
      worker
    )
  );
  return buffers;
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const rawBody = readRequestBody(event);
  debug('Trigger create invoice request body', rawBody);
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
    requestBody = rawBody ? JSON.parse(rawBody) as TriggerCreateInvoiceRequest : {};
  } catch (error) {
    debug('Invalid JSON body', { body: rawBody, error: formatError(error), isBase64Encoded: event.isBase64Encoded });
    return jsonResponse(400, { status: 'error', message: 'Invalid JSON body' });
  }

  const conversationId = typeof requestBody.conversationId === 'string'
    ? requestBody.conversationId.trim()
    : '';
  if (!conversationId) {
    return jsonResponse(400, {
      status: 'error',
      message: 'conversationId is required'
    });
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

  const attachments = conversationData.attachments;
  let buffers: Buffer[];
  try {
    buffers = await downloadInvoiceAttachments(attachments);
  } catch (error) {
    if (error instanceof IntercomAttachmentTooLargeError) {
      debug('Intercom attachment too large', {
        conversationId,
        sizeBytes: error.sizeBytes,
      });
      return jsonResponse(400, {
        status: 'error',
        message: error.combined
          ? 'Combined attachment size exceeds maximum allowed size'
          : 'Attachment exceeds maximum allowed size',
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
    const ingested = await ingestCreateInvoiceAttachments(
      process.env,
      attachments.map((attachment, index) => ({
        name: attachment.name,
        contentType: attachment.contentType,
        buffer: buffers[index],
        emailContext: attachment.emailContext,
        processorFields: { conversationId },
      })),
      { 'intercom-conversation-id': conversationId },
    );

    return jsonResponse(202, {
      status: 'accepted',
      message: 'Invoice creation triggered',
      requestId: ingested.requestId,
      conversationId,
    });
  } catch (error) {
    debug('Error triggering invoice creation', { error: formatError(error), conversationId });
    return jsonResponse(500, { status: 'error', message: 'Internal server error' });
  }
}
