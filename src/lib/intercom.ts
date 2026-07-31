import { debug } from '@pga/logger';
import type { InvoiceData } from './types.js';

const DEFAULT_API_BASE_URL = 'https://api.intercom.io';
const INTERCOM_VERSION = '2.14';
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // Intercom inbound email total limit is 20MB

export interface IntercomConfig {
  accessToken: string;
  apiBaseUrl: string;
}

export interface IntercomAttachment {
  name: string;
  url: string;
  contentType: string;
}

export interface IntercomConversationInvoiceData {
  attachments: IntercomAttachment[];
  emailContext: NonNullable<InvoiceData['emailContext']>;
}

export class IntercomNotFoundError extends Error {
  constructor(conversationId: string) {
    super(`Conversation not found: ${conversationId}`);
    this.name = 'IntercomNotFoundError';
  }
}

export class IntercomNoAttachmentError extends Error {
  constructor(conversationId: string) {
    super(`No PDF attachment found on conversation: ${conversationId}`);
    this.name = 'IntercomNoAttachmentError';
  }
}

export class IntercomAttachmentTooLargeError extends Error {
  readonly sizeBytes: number;

  constructor(sizeBytes: number) {
    super(`Attachment exceeds maximum size of ${MAX_ATTACHMENT_BYTES} bytes (got ${sizeBytes})`);
    this.name = 'IntercomAttachmentTooLargeError';
    this.sizeBytes = sizeBytes;
  }
}

export class IntercomUpstreamError extends Error {
  readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'IntercomUpstreamError';
    this.statusCode = statusCode;
  }
}

interface IntercomPartAttachment {
  name?: string;
  url?: string;
  content_type?: string;
}

interface IntercomConversationPart {
  attachments?: IntercomPartAttachment[];
}

interface IntercomConversationResponse {
  id?: string;
  source?: {
    subject?: string | null;
    body?: string | null;
    author?: {
      email?: string | null;
    };
    attachments?: IntercomPartAttachment[];
  };
  conversation_parts?: {
    conversation_parts?: IntercomConversationPart[];
  };
}

export function getIntercomConfig(env: NodeJS.ProcessEnv): IntercomConfig {
  const accessToken = env.INTERCOM_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error('INTERCOM_ACCESS_TOKEN is required');
  }

  const apiBaseUrl = (env.INTERCOM_API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/$/, '');
  return { accessToken, apiBaseUrl };
}

function collectAttachments(conversation: IntercomConversationResponse): IntercomAttachment[] {
  const raw: IntercomPartAttachment[] = [
    ...(conversation.source?.attachments ?? []),
    ...(conversation.conversation_parts?.conversation_parts ?? []).flatMap(
      (part) => part.attachments ?? [],
    ),
  ];

  return raw
    .filter((attachment): attachment is IntercomPartAttachment & { url: string } => Boolean(attachment.url))
    .map((attachment) => ({
      name: attachment.name || 'attachment',
      url: attachment.url,
      contentType: attachment.content_type || 'application/octet-stream',
    }));
}

export function selectAttachments(attachments: IntercomAttachment[]): IntercomAttachment[] {
  return attachments.filter((attachment) => attachment.contentType === 'application/pdf');
}

export function sanitizeFileName(fileName: string): string {
  const base = fileName
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .pop()
    ?.replace(/\0/g, '')
    .trim() || 'attachment.pdf';

  const withoutTraversal = base.replace(/^\.+/, '') || 'attachment.pdf';
  return withoutTraversal.slice(0, 200);
}

export function buildEmailContext(
  conversation: IntercomConversationResponse,
): NonNullable<InvoiceData['emailContext']> {
  return {
    emailFrom: conversation.source?.author?.email || undefined,
    subject: conversation.source?.subject || undefined,
    plainTextBody: conversation.source?.body || undefined,
  };
}

const INTERCOM_CDN_HOST_PATTERN = /^(?:[a-z0-9-]+\.)*intercomcdn\.com$/i;
const INTERCOM_ATTACHMENTS_HOST_PATTERN = /^(?:[a-z0-9-]+\.)*intercom-attachments-\d+\.com$/i;

export function assertAllowedAttachmentUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new IntercomUpstreamError('Attachment URL is invalid');
  }

  if (parsed.protocol !== 'https:') {
    throw new IntercomUpstreamError('Attachment URL must use https');
  }

  const host = parsed.hostname.toLowerCase();
  const allowed =
    INTERCOM_CDN_HOST_PATTERN.test(host)
    || INTERCOM_ATTACHMENTS_HOST_PATTERN.test(host);

  if (!allowed) {
    throw new IntercomUpstreamError(`Attachment URL host is not an allowed Intercom CDN: ${host}`);
  }

  return parsed;
}

export async function fetchConversationInvoiceData(
  config: IntercomConfig,
  conversationId: string,
): Promise<IntercomConversationInvoiceData> {
  const url = `${config.apiBaseUrl}/conversations/${encodeURIComponent(conversationId)}?display_as=plaintext`;
  debug('Fetching Intercom conversation', { conversationId, apiBaseUrl: config.apiBaseUrl });

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        Accept: 'application/json',
        'Intercom-Version': INTERCOM_VERSION,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new IntercomUpstreamError(`Failed to reach Intercom Conversations API: ${message}`);
  }

  if (response.status === 404) {
    throw new IntercomNotFoundError(conversationId);
  }

  if (!response.ok) {
    throw new IntercomUpstreamError(
      `Intercom Conversations API returned ${response.status}`,
      response.status,
    );
  }

  const conversation = await response.json() as IntercomConversationResponse;
  const attachments = collectAttachments(conversation);
  const invoiceAttachments = selectAttachments(attachments);
  if (invoiceAttachments.length === 0) {
    throw new IntercomNoAttachmentError(conversationId);
  }
  debug('Selected Intercom invoice attachments', {
    conversationId,
    attachmentCount: invoiceAttachments.length,
  });

  return {
    attachments: invoiceAttachments.map((attachment) => ({
      ...attachment,
      name: sanitizeFileName(attachment.name),
    })),
    emailContext: buildEmailContext(conversation),
  };
}

export async function downloadAttachment(url: string): Promise<Buffer> {
  const parsed = assertAllowedAttachmentUrl(url);
  debug('Downloading Intercom attachment', { urlHost: parsed.host });

  let response: Response;
  try {
    // Do not follow redirects — an allowlisted URL that redirects elsewhere would bypass the host check.
    response = await fetch(parsed.toString(), { redirect: 'error' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new IntercomUpstreamError(`Failed to download Intercom attachment: ${message}`);
  }

  if (!response.ok) {
    throw new IntercomUpstreamError(
      `Intercom attachment download returned ${response.status}`,
      response.status,
    );
  }

  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > MAX_ATTACHMENT_BYTES) {
      throw new IntercomAttachmentTooLargeError(contentLength);
    }
  }

  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new IntercomAttachmentTooLargeError(bytes.byteLength);
  }

  return Buffer.from(bytes);
}

export { MAX_ATTACHMENT_BYTES };
