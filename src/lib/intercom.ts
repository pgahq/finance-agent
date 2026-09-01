import { debug } from '@pga/logger';
import { z } from 'zod';
import type { InvoiceData } from './types.js';

const DEFAULT_API_BASE_URL = 'https://api.intercom.io';
const INTERCOM_VERSION = '2.14';
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // Intercom inbound email total limit is 20MB
type EmailContext = NonNullable<InvoiceData['emailContext']>;

export interface IntercomConfig {
  accessToken: string;
  apiBaseUrl: string;
}

export interface IntercomAttachment {
  name: string;
  url: string;
  contentType: string;
  emailContext: EmailContext;
}

export interface IntercomConversationInvoiceData {
  attachments: IntercomAttachment[];
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
  readonly combined: boolean;

  constructor(sizeBytes: number, combined = false) {
    super(`Attachment exceeds maximum size of ${MAX_ATTACHMENT_BYTES} bytes (got ${sizeBytes})`);
    this.name = 'IntercomAttachmentTooLargeError';
    this.sizeBytes = sizeBytes;
    this.combined = combined;
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

const intercomAttachmentSchema = z.object({
  name: z.string().optional(),
  url: z.string().optional(),
  content_type: z.string().optional(),
});
const intercomAuthorSchema = z.object({ email: z.string().nullable().optional() });
const intercomConversationPartSchema = z.object({
  body: z.string().nullable().optional(),
  author: intercomAuthorSchema.optional(),
  attachments: z.array(intercomAttachmentSchema).optional(),
});
const intercomConversationSchema = z.object({
  id: z.string().optional(),
  source: z.object({
    subject: z.string().nullable().optional(),
    body: z.string().nullable().optional(),
    author: intercomAuthorSchema.optional(),
    attachments: z.array(intercomAttachmentSchema).optional(),
  }).optional(),
  conversation_parts: z.object({
    conversation_parts: z.array(intercomConversationPartSchema).optional(),
  }).optional(),
});
type IntercomConversationResponse = z.infer<typeof intercomConversationSchema>;

export function getIntercomConfig(env: NodeJS.ProcessEnv): IntercomConfig {
  const accessToken = env.INTERCOM_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error('INTERCOM_ACCESS_TOKEN is required');
  }

  const apiBaseUrl = (env.INTERCOM_API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/$/, '');
  return { accessToken, apiBaseUrl };
}

function collectAttachments(conversation: IntercomConversationResponse): IntercomAttachment[] {
  const sourceContext = {
    emailFrom: conversation.source?.author?.email || undefined,
    subject: conversation.source?.subject || undefined,
    plainTextBody: conversation.source?.body || undefined,
  };
  const mapAttachments = (
    attachments: IntercomPartAttachment[],
    emailContext: EmailContext
  ): IntercomAttachment[] => attachments
    .filter((attachment): attachment is IntercomPartAttachment & { url: string } => Boolean(attachment.url))
    .map((attachment) => ({
      name: attachment.name || 'attachment',
      url: attachment.url,
      contentType: attachment.content_type || 'application/octet-stream',
      emailContext,
    }));

  return [
    ...mapAttachments(conversation.source?.attachments ?? [], sourceContext),
    ...(conversation.conversation_parts?.conversation_parts ?? []).flatMap((part) =>
      mapAttachments(part.attachments ?? [], {
        emailFrom: part.author?.email || sourceContext.emailFrom,
        subject: sourceContext.subject,
        plainTextBody: part.body || sourceContext.plainTextBody,
      })
    ),
  ];
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

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new IntercomUpstreamError('Intercom Conversations API returned invalid JSON');
  }
  debug('Intercom conversation payload', { conversationId, payload });
  const parsed = intercomConversationSchema.safeParse(payload);
  if (!parsed.success) {
    throw new IntercomUpstreamError('Intercom Conversations API returned an unexpected response');
  }
  const conversation = parsed.data;
  const attachments = collectAttachments(conversation);
  const invoiceAttachments = attachments.filter(
    (attachment) => attachment.contentType === 'application/pdf'
  );
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

  let bytes: ArrayBuffer;
  try {
    bytes = await response.arrayBuffer();
  } catch {
    throw new IntercomUpstreamError('Failed to read Intercom attachment response');
  }
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new IntercomAttachmentTooLargeError(bytes.byteLength);
  }

  return Buffer.from(bytes);
}

export { MAX_ATTACHMENT_BYTES };
