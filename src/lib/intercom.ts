import { debug } from '@pga/logger';
import { z } from 'zod';
import { buildConversationTranscript, type ConversationTranscript } from './conversation_transcript.js';
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
  transcript: ConversationTranscript;
  appId?: string;
  assigneeEmail?: string;
  conversationCreatedAt?: string;
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
const intercomAuthorSchema = z.object({
  name: z.string().nullable().optional().catch(undefined),
  email: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
});
const intercomConversationPartSchema = z.object({
  part_type: z.string().optional(),
  body: z.string().nullable().optional(),
  created_at: z.number().optional().catch(undefined),
  author: intercomAuthorSchema.optional(),
  attachments: z.array(intercomAttachmentSchema).optional(),
});
const intercomConversationSchema = z.object({
  id: z.string().optional(),
  app_id: z.string().optional(),
  created_at: z.number().optional().catch(undefined),
  title: z.string().nullable().optional().catch(undefined),
  custom_attributes: z.object({
    Brand: z.string().nullable().optional().catch(undefined),
  }).passthrough().nullable().optional().catch(undefined),
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

/** Intercom conversation created_at is Unix seconds; returns YYYY-MM-DD for Workday xsd:date. */
export function intercomConversationCreatedAtToIsoDate(createdAt: number): string | undefined {
  if (!Number.isFinite(createdAt)) {
    return undefined;
  }
  const ms = createdAt > 1e12 ? createdAt : createdAt * 1000;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toISOString().split('T')[0];
}

export function buildIntercomConversationUrl(
  conversationId: string,
  appId: string | undefined = process.env.INTERCOM_APP_ID
): string | undefined {
  const id = conversationId.trim();
  const workspaceId = appId?.trim();
  if (!id || !workspaceId) return undefined;

  return `https://app.intercom.com/a/inbox/${encodeURIComponent(workspaceId)}/inbox/conversation/${encodeURIComponent(id)}`;
}

export function resolveCustomActionStarterEmail(
  conversation: IntercomConversationResponse,
): string | undefined {
  const parts = conversation.conversation_parts?.conversation_parts ?? [];
  const customActionParts = parts.filter((part) => part.part_type === 'custom_action_started');
  const lastPart = customActionParts[customActionParts.length - 1];
  const email = lastPart?.author?.email?.trim();
  return email && email.includes('@') ? email : undefined;
}

function appendBodySegment(segments: string[], body: string | null | undefined): void {
  if (body == null) {
    return;
  }
  const trimmed = body.trim();
  if (trimmed.length > 0) {
    segments.push(body);
  }
}

/** Source email body plus non-empty conversation part bodies, in API order. */
export function buildIntercomPlainTextBody(conversation: IntercomConversationResponse): string | undefined {
  const segments: string[] = [];
  appendBodySegment(segments, conversation.source?.body);
  for (const part of conversation.conversation_parts?.conversation_parts ?? []) {
    appendBodySegment(segments, part.body);
  }
  return segments.length > 0 ? segments.join('\n\n') : undefined;
}

/** Bodies of internal `note` parts only, in API order. Intercom notes are teammate-only. */
export function buildIntercomInternalNotes(conversation: IntercomConversationResponse): string | undefined {
  const segments: string[] = [];
  for (const part of conversation.conversation_parts?.conversation_parts ?? []) {
    if (part.part_type === 'note') {
      appendBodySegment(segments, part.body);
    }
  }
  return segments.length > 0 ? segments.join('\n\n') : undefined;
}

function collectAttachments(conversation: IntercomConversationResponse): IntercomAttachment[] {
  const plainTextBody = buildIntercomPlainTextBody(conversation);
  const internalNotes = buildIntercomInternalNotes(conversation);
  const sourceContext: EmailContext = {
    emailFrom: conversation.source?.author?.email || undefined,
    subject: conversation.source?.subject || undefined,
    plainTextBody,
    ...(internalNotes ? { internalNotes } : {}),
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
        plainTextBody,
        ...(internalNotes ? { internalNotes } : {}),
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

  const assigneeEmail = resolveCustomActionStarterEmail(conversation);
  if (assigneeEmail) {
    debug('Resolved assignee email from custom_action_started', { conversationId, assigneeEmail });
  }

  const conversationCreatedAt = conversation.created_at != null
    ? intercomConversationCreatedAtToIsoDate(conversation.created_at)
    : undefined;
  const transcript = buildConversationTranscript(conversation, { conversationId });

  return {
    attachments: invoiceAttachments.map((attachment) => ({
      ...attachment,
      name: sanitizeFileName(attachment.name),
    })),
    transcript,
    ...(conversation.app_id?.trim() ? { appId: conversation.app_id.trim() } : {}),
    ...(assigneeEmail ? { assigneeEmail } : {}),
    ...(conversationCreatedAt ? { conversationCreatedAt } : {}),
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
