import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import loadEnv from '@pga/lambda-env';
import { debug } from '@pga/logger';
import { extractBearerToken, isAuthorizedBearer } from './lib/api_auth.js';
import { ingestCreateInvoiceAttachments } from './lib/create_invoice_ingest.js';
import {
  downloadGmailAttachments,
  fetchGmailMessageInvoiceData,
  getGmailConfig,
  getSupplierInvoiceLabelState,
  GmailAttachmentTooLargeError,
  GmailNoAttachmentError,
  GmailNotFoundError,
  GmailUpstreamError,
  setSupplierInvoiceLabel,
} from './lib/gmail.js';
import { formatError, jsonResponse, readRequestBody } from './lib/http_api.js';

interface TriggerCreateInvoiceGmailRequest {
  gmailMessageId?: string;
  userEmail?: string;
  gmailAccessToken?: string;
  force?: boolean;
}

export interface CreateInvoiceFromGmailInput {
  gmailMessageId: string;
  userEmail: string;
  force: boolean;
  gmailAccessToken?: string;
}

export async function runCreateInvoiceFromGmail(
  input: CreateInvoiceFromGmailInput,
): Promise<APIGatewayProxyResultV2> {
  const { gmailMessageId, userEmail, force, gmailAccessToken } = input;

  let gmailConfig;
  try {
    gmailConfig = await getGmailConfig(process.env, userEmail, gmailAccessToken);
  } catch (error) {
    debug('Gmail auth is not configured', { error: formatError(error) });
    return jsonResponse(500, { status: 'error', message: 'Internal server error' });
  }

  try {
    const existingState = await getSupplierInvoiceLabelState(gmailConfig, gmailMessageId);
    if (existingState && !force) {
      return jsonResponse(409, {
        status: 'error',
        message: 'Supplier invoice already submitted for this message',
        gmailMessageId,
        labelState: existingState,
      });
    }
  } catch (error) {
    if (error instanceof GmailNotFoundError) {
      return jsonResponse(404, {
        status: 'error',
        message: 'Message not found',
        gmailMessageId,
      });
    }
    if (error instanceof GmailUpstreamError) {
      debug('Gmail upstream error reading labels; continuing without exclusive-label check', {
        gmailMessageId,
        error: formatError(error),
        statusCode: error.statusCode,
      });
    } else {
      debug('Unexpected error reading Gmail labels', { gmailMessageId, error: formatError(error) });
      return jsonResponse(500, { status: 'error', message: 'Internal server error' });
    }
  }

  let messageData;
  try {
    messageData = await fetchGmailMessageInvoiceData(gmailConfig, gmailMessageId);
  } catch (error) {
    if (error instanceof GmailNotFoundError) {
      return jsonResponse(404, {
        status: 'error',
        message: 'Message not found',
        gmailMessageId,
      });
    }
    if (error instanceof GmailNoAttachmentError) {
      return jsonResponse(400, {
        status: 'error',
        message: 'No PDF attachment found on message',
        gmailMessageId,
      });
    }
    if (error instanceof GmailUpstreamError) {
      debug('Gmail upstream error fetching message', {
        gmailMessageId,
        error: formatError(error),
        statusCode: error.statusCode,
      });
      return jsonResponse(502, {
        status: 'error',
        message: 'Failed to fetch message from Gmail',
        gmailMessageId,
      });
    }
    debug('Unexpected error fetching Gmail message', { gmailMessageId, error: formatError(error) });
    return jsonResponse(500, { status: 'error', message: 'Internal server error' });
  }

  let buffers: Buffer[];
  try {
    buffers = await downloadGmailAttachments(gmailConfig, gmailMessageId, messageData.attachments);
  } catch (error) {
    if (error instanceof GmailAttachmentTooLargeError) {
      return jsonResponse(400, {
        status: 'error',
        message: error.combined
          ? 'Combined attachment size exceeds maximum allowed size'
          : 'Attachment exceeds maximum allowed size',
        gmailMessageId,
      });
    }
    if (error instanceof GmailUpstreamError) {
      debug('Gmail attachment download failed', {
        gmailMessageId,
        error: formatError(error),
        statusCode: error.statusCode,
      });
      return jsonResponse(502, {
        status: 'error',
        message: 'Failed to download message attachment',
        gmailMessageId,
      });
    }
    debug('Unexpected error downloading Gmail attachment', { gmailMessageId, error: formatError(error) });
    return jsonResponse(500, { status: 'error', message: 'Internal server error' });
  }

  try {
    await setSupplierInvoiceLabel(gmailConfig, gmailMessageId, 'processing');
  } catch (error) {
    debug('Failed to set Gmail processing label; continuing to processor invoke', {
      gmailMessageId,
      error: formatError(error),
    });
  }

  try {
    const ingested = await ingestCreateInvoiceAttachments(
      process.env,
      messageData.attachments.map((attachment, index) => ({
        name: attachment.name,
        contentType: attachment.contentType,
        buffer: buffers[index],
        emailContext: attachment.emailContext,
        processorFields: {
          gmailMessageId,
          userEmail,
          ...(gmailAccessToken ? { gmailAccessToken } : {}),
        },
      })),
      {
        'gmail-message-id': gmailMessageId,
        'gmail-user-email': userEmail,
      },
    );

    return jsonResponse(202, {
      status: 'accepted',
      message: 'Supplier invoice creation triggered',
      requestId: ingested.requestId,
      gmailMessageId,
      attachmentCount: ingested.attachmentCount,
    });
  } catch (error) {
    debug('Error triggering Gmail supplier invoice creation', {
      error: formatError(error),
      gmailMessageId,
    });
    try {
      await setSupplierInvoiceLabel(gmailConfig, gmailMessageId, 'failure');
    } catch (labelError) {
      debug('Failed to set Gmail failure label after ingest error', {
        gmailMessageId,
        error: formatError(labelError),
      });
    }
    return jsonResponse(500, { status: 'error', message: 'Internal server error' });
  }
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  debug('Trigger create invoice from Gmail request received');
  process.env = await loadEnv();

  const expectedToken = process.env.ENRICH_INVOICE_API_TOKEN;
  if (!expectedToken) {
    debug('ENRICH_INVOICE_API_TOKEN is not configured');
    return jsonResponse(500, { status: 'error', message: 'Internal server error' });
  }

  const providedToken = extractBearerToken(event.headers?.authorization);
  if (!isAuthorizedBearer(providedToken ?? '', expectedToken)) {
    debug('Unauthorized Gmail create invoice trigger request', {
      hasAuthorizationHeader: Boolean(event.headers?.authorization),
    });
    return jsonResponse(401, { status: 'error', message: 'Unauthorized' });
  }

  let requestBody: TriggerCreateInvoiceGmailRequest;
  try {
    const rawBody = readRequestBody(event);
    requestBody = rawBody ? JSON.parse(rawBody) as TriggerCreateInvoiceGmailRequest : {};
  } catch (error) {
    debug('Invalid JSON body', { error: formatError(error), isBase64Encoded: event.isBase64Encoded });
    return jsonResponse(400, { status: 'error', message: 'Invalid JSON body' });
  }

  const gmailMessageId = typeof requestBody.gmailMessageId === 'string'
    ? requestBody.gmailMessageId.trim()
    : '';
  const userEmail = typeof requestBody.userEmail === 'string'
    ? requestBody.userEmail.trim()
    : '';
  const gmailAccessToken = typeof requestBody.gmailAccessToken === 'string'
    ? requestBody.gmailAccessToken.trim()
    : '';
  if (!gmailMessageId) {
    return jsonResponse(400, { status: 'error', message: 'gmailMessageId is required' });
  }
  if (!userEmail) {
    return jsonResponse(400, { status: 'error', message: 'userEmail is required' });
  }

  return runCreateInvoiceFromGmail({
    gmailMessageId,
    userEmail,
    force: requestBody.force === true,
    ...(gmailAccessToken ? { gmailAccessToken } : {}),
  });
}
