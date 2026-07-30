import { debug } from '@pga/logger';
import type { InvoiceData } from './types.js';

const DEFAULT_API_BASE_URL = 'https://api.intercom.io';
const INTERCOM_VERSION = '2.14';

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
  conversationId: string;
  attachment: IntercomAttachment;
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
    super(`No usable attachment found on conversation: ${conversationId}`);
    this.name = 'IntercomNoAttachmentError';
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

export function selectAttachment(attachments: IntercomAttachment[]): IntercomAttachment | undefined {
  const pdf = attachments.find((attachment) => attachment.contentType === 'application/pdf');
  if (pdf) {
    return pdf;
  }
  return attachments[0];
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
  const attachment = selectAttachment(attachments);
  if (!attachment) {
    throw new IntercomNoAttachmentError(conversationId);
  }

  return {
    conversationId,
    attachment,
    emailContext: buildEmailContext(conversation),
  };
}

export async function downloadAttachment(url: string): Promise<Buffer> {
  debug('Downloading Intercom attachment', { urlHost: safeUrlHost(url) });

  let response: Response;
  try {
    response = await fetch(url);
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

  const bytes = await response.arrayBuffer();
  return Buffer.from(bytes);
}

function safeUrlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}
