import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { JWT } from 'google-auth-library';
import { debug } from '@pga/logger';
import { z } from 'zod';
import { sanitizeFileName, MAX_ATTACHMENT_BYTES } from './intercom.js';
import { MAX_CONCURRENT_ATTACHMENT_DOWNLOADS } from './create_invoice_ingest.js';
import type { InvoiceData } from './types.js';

const GMAIL_API_BASE_URL = 'https://gmail.googleapis.com';
const GMAIL_HOST_PATTERN = /^(?:www\.)?gmail\.googleapis\.com$/i;
const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

type EmailContext = NonNullable<InvoiceData['emailContext']>;

export type AddonEnvironment = 'sandbox' | 'production';
export type SupplierInvoiceLabelState = 'processing' | 'success' | 'failure' | 'partial';

export interface GmailConfig {
  accessToken: string;
  userEmail: string;
  environment: AddonEnvironment;
  apiBaseUrl: string;
}

export interface GmailAttachment {
  name: string;
  contentType: string;
  emailContext: EmailContext;
  attachmentId?: string;
  inlineData?: string;
}

export interface GmailMessageInvoiceData {
  attachments: GmailAttachment[];
  emailContext: EmailContext;
  labelIds: string[];
}

export class GmailNotFoundError extends Error {
  constructor(gmailMessageId: string) {
    super(`Gmail message not found: ${gmailMessageId}`);
    this.name = 'GmailNotFoundError';
  }
}

export class GmailNoAttachmentError extends Error {
  constructor(gmailMessageId: string) {
    super(`No PDF attachment found on Gmail message: ${gmailMessageId}`);
    this.name = 'GmailNoAttachmentError';
  }
}

export class GmailAttachmentTooLargeError extends Error {
  readonly sizeBytes: number;
  readonly combined: boolean;

  constructor(sizeBytes: number, combined = false) {
    super(`Attachment exceeds maximum size of ${MAX_ATTACHMENT_BYTES} bytes (got ${sizeBytes})`);
    this.name = 'GmailAttachmentTooLargeError';
    this.sizeBytes = sizeBytes;
    this.combined = combined;
  }
}

export class GmailUpstreamError extends Error {
  readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'GmailUpstreamError';
    this.statusCode = statusCode;
  }
}

const serviceAccountSchema = z.object({
  client_email: z.string().min(1),
  private_key: z.string().min(1),
});

const gmailHeaderSchema = z.object({
  name: z.string().optional(),
  value: z.string().optional(),
});

const gmailBodySchema = z.object({
  size: z.number().optional(),
  data: z.string().optional(),
  attachmentId: z.string().optional(),
});

type GmailPart = {
  mimeType?: string;
  filename?: string;
  headers?: z.infer<typeof gmailHeaderSchema>[];
  body?: z.infer<typeof gmailBodySchema>;
  parts?: GmailPart[];
};

const gmailPartSchema: z.ZodType<GmailPart> = z.lazy(() =>
  z.object({
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    headers: z.array(gmailHeaderSchema).optional(),
    body: gmailBodySchema.optional(),
    parts: z.array(gmailPartSchema).optional(),
  })
);

const gmailMessageSchema = z.object({
  id: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
  payload: gmailPartSchema.optional(),
});

const gmailLabelsListSchema = z.object({
  labels: z.array(z.object({
    id: z.string(),
    name: z.string(),
  })).optional(),
});

const gmailAttachmentSchema = z.object({
  size: z.number().optional(),
  data: z.string().optional(),
});

export function getAddonEnvironment(env: NodeJS.ProcessEnv): AddonEnvironment {
  return env.ADDON_ENVIRONMENT === 'production' ? 'production' : 'sandbox';
}

export function supplierInvoiceLabelNames(
  environment: AddonEnvironment
): Record<SupplierInvoiceLabelState, string> {
  const prefix = environment === 'sandbox'
    ? 'Supplier invoice (sandbox)'
    : 'Supplier invoice';
  return {
    processing: `${prefix}/Processing`,
    success: `${prefix}/Success`,
    failure: `${prefix}/Failure`,
    partial: `${prefix}/Partial`,
  };
}

export function supplierInvoiceLabelStates(
  environment: AddonEnvironment
): SupplierInvoiceLabelState[] {
  return Object.keys(supplierInvoiceLabelNames(environment)) as SupplierInvoiceLabelState[];
}

export function nextProcessorLabelState(
  current: SupplierInvoiceLabelState | null,
  outcome: 'success' | 'failure'
): SupplierInvoiceLabelState {
  if (outcome === 'success') {
    if (current === 'failure' || current === 'partial') return 'partial';
    return 'success';
  }
  if (current === 'success' || current === 'partial') return 'partial';
  return 'failure';
}

function headerValue(headers: z.infer<typeof gmailHeaderSchema>[] | undefined, name: string): string | undefined {
  const match = headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase());
  return match?.value || undefined;
}

function collectParts(part: GmailPart | undefined): GmailPart[] {
  if (!part) return [];
  return [part, ...(part.parts ?? []).flatMap(collectParts)];
}

function decodeBase64Url(data: string): Buffer {
  return Buffer.from(data, 'base64url');
}

function extractEmailContext(payload: GmailPart | undefined): EmailContext {
  const headers = payload?.headers;
  const textPart = collectParts(payload).find((part) => part.mimeType === 'text/plain' && part.body?.data);
  return {
    emailFrom: headerValue(headers, 'From'),
    subject: headerValue(headers, 'Subject'),
    plainTextBody: textPart?.body?.data
      ? decodeBase64Url(textPart.body.data).toString('utf8')
      : undefined,
  };
}

function collectPdfAttachments(payload: GmailPart | undefined, emailContext: EmailContext): GmailAttachment[] {
  return collectParts(payload)
    .filter((part) => part.mimeType === 'application/pdf' && (part.body?.attachmentId || part.body?.data))
    .map((part) => ({
      name: sanitizeFileName(part.filename || 'attachment.pdf'),
      contentType: 'application/pdf',
      emailContext,
      attachmentId: part.body?.attachmentId,
      inlineData: part.body?.data,
    }));
}

export function assertAllowedGmailUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new GmailUpstreamError('Gmail API URL is invalid');
  }
  if (parsed.protocol !== 'https:') {
    throw new GmailUpstreamError('Gmail API URL must use https');
  }
  if (!GMAIL_HOST_PATTERN.test(parsed.hostname)) {
    throw new GmailUpstreamError(`Gmail API host is not allowed: ${parsed.hostname}`);
  }
  return parsed;
}

export async function getGmailConfig(
  env: NodeJS.ProcessEnv,
  userEmail: string,
  userAccessToken?: string,
): Promise<GmailConfig> {
  if (!userEmail) {
    throw new Error('userEmail is required');
  }

  const accessTokenFromUser = userAccessToken?.trim();
  if (accessTokenFromUser) {
    return {
      accessToken: accessTokenFromUser,
      userEmail,
      environment: getAddonEnvironment(env),
      apiBaseUrl: GMAIL_API_BASE_URL,
    };
  }

  const secretId = env.GMAIL_SERVICE_ACCOUNT_SECRET_ARN;
  if (!secretId) {
    throw new Error('GMAIL_SERVICE_ACCOUNT_SECRET_ARN is required');
  }

  const secretsClient = new SecretsManagerClient({});
  const response = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!response.SecretString) {
    throw new Error('Gmail service account secret is empty');
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(response.SecretString);
  } catch {
    throw new Error('Gmail service account secret is not valid JSON');
  }
  const parsed = serviceAccountSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error('Gmail service account secret is missing client_email or private_key');
  }

  const jwt = new JWT({
    email: parsed.data.client_email,
    key: parsed.data.private_key,
    scopes: [GMAIL_MODIFY_SCOPE],
    subject: userEmail,
  });
  const tokenResponse = await jwt.getAccessToken();
  const accessToken = typeof tokenResponse === 'string' ? tokenResponse : tokenResponse?.token;
  if (!accessToken) {
    throw new GmailUpstreamError('Failed to obtain Gmail access token');
  }

  return {
    accessToken,
    userEmail,
    environment: getAddonEnvironment(env),
    apiBaseUrl: GMAIL_API_BASE_URL,
  };
}

async function gmailRequest(
  config: GmailConfig,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = assertAllowedGmailUrl(`${config.apiBaseUrl}${path}`);
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      ...init,
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GmailUpstreamError(`Failed to reach Gmail API: ${message}`);
  }
  return response;
}

async function fetchGmailMessage(
  config: GmailConfig,
  gmailMessageId: string,
  format: 'full' | 'metadata',
): Promise<z.infer<typeof gmailMessageSchema>> {
  debug('Fetching Gmail message', { gmailMessageId, format });
  const query = format === 'full' ? 'format=full' : 'format=metadata&metadataHeaders=From';
  const response = await gmailRequest(
    config,
    `/gmail/v1/users/me/messages/${encodeURIComponent(gmailMessageId)}?${query}`,
  );

  if (response.status === 404) {
    throw new GmailNotFoundError(gmailMessageId);
  }
  if (!response.ok) {
    throw new GmailUpstreamError(`Gmail messages API returned ${response.status}`, response.status);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new GmailUpstreamError('Gmail messages API returned invalid JSON');
  }
  const parsed = gmailMessageSchema.safeParse(payload);
  if (!parsed.success) {
    throw new GmailUpstreamError('Gmail messages API returned an unexpected response');
  }
  return parsed.data;
}

export async function fetchGmailMessageInvoiceData(
  config: GmailConfig,
  gmailMessageId: string,
): Promise<GmailMessageInvoiceData> {
  const message = await fetchGmailMessage(config, gmailMessageId, 'full');
  const emailContext = extractEmailContext(message.payload);
  const attachments = collectPdfAttachments(message.payload, emailContext);
  if (attachments.length === 0) {
    throw new GmailNoAttachmentError(gmailMessageId);
  }

  debug('Selected Gmail invoice attachments', {
    gmailMessageId,
    attachmentCount: attachments.length,
  });

  return {
    attachments,
    emailContext,
    labelIds: message.labelIds ?? [],
  };
}

export async function downloadGmailAttachment(
  config: GmailConfig,
  gmailMessageId: string,
  attachment: GmailAttachment,
): Promise<Buffer> {
  if (attachment.inlineData) {
    const buffer = decodeBase64Url(attachment.inlineData);
    if (buffer.length > MAX_ATTACHMENT_BYTES) {
      throw new GmailAttachmentTooLargeError(buffer.length);
    }
    return buffer;
  }
  if (!attachment.attachmentId) {
    throw new GmailUpstreamError('Gmail attachment is missing attachmentId and inline data');
  }

  const response = await gmailRequest(
    config,
    `/gmail/v1/users/me/messages/${encodeURIComponent(gmailMessageId)}/attachments/${encodeURIComponent(attachment.attachmentId)}`,
  );
  if (!response.ok) {
    throw new GmailUpstreamError(
      `Gmail attachment download returned ${response.status}`,
      response.status,
    );
  }

  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > MAX_ATTACHMENT_BYTES) {
      throw new GmailAttachmentTooLargeError(contentLength);
    }
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new GmailUpstreamError('Failed to read Gmail attachment response');
  }
  const parsed = gmailAttachmentSchema.safeParse(payload);
  if (!parsed.success || !parsed.data.data) {
    throw new GmailUpstreamError('Gmail attachment download returned an unexpected response');
  }
  const buffer = decodeBase64Url(parsed.data.data);
  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    throw new GmailAttachmentTooLargeError(buffer.length);
  }
  return buffer;
}

export async function downloadGmailAttachments(
  config: GmailConfig,
  gmailMessageId: string,
  attachments: GmailAttachment[],
): Promise<Buffer[]> {
  const buffers = new Array<Buffer>(attachments.length);
  let nextIndex = 0;
  let totalBytes = 0;
  let stopped = false;

  const worker = async () => {
    while (!stopped) {
      const index = nextIndex++;
      if (index >= attachments.length) return;
      try {
        const buffer = await downloadGmailAttachment(config, gmailMessageId, attachments[index]);
        totalBytes += buffer.length;
        if (totalBytes > MAX_ATTACHMENT_BYTES) {
          stopped = true;
          throw new GmailAttachmentTooLargeError(totalBytes, true);
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

async function listGmailLabels(config: GmailConfig): Promise<Map<string, string>> {
  const response = await gmailRequest(config, '/gmail/v1/users/me/labels');
  if (!response.ok) {
    throw new GmailUpstreamError(`Gmail labels API returned ${response.status}`, response.status);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new GmailUpstreamError('Gmail labels API returned invalid JSON');
  }
  const parsed = gmailLabelsListSchema.safeParse(payload);
  if (!parsed.success) {
    throw new GmailUpstreamError('Gmail labels API returned an unexpected response');
  }
  return new Map((parsed.data.labels ?? []).map((label) => [label.name, label.id]));
}

async function ensureLabelId(
  config: GmailConfig,
  labelName: string,
  existing: Map<string, string>,
): Promise<string> {
  const cached = existing.get(labelName);
  if (cached) return cached;

  const response = await gmailRequest(config, '/gmail/v1/users/me/labels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: labelName,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    }),
  });
  if (!response.ok) {
    throw new GmailUpstreamError(`Gmail create label returned ${response.status}`, response.status);
  }
  const created = z.object({ id: z.string(), name: z.string() }).safeParse(await response.json());
  if (!created.success) {
    throw new GmailUpstreamError('Gmail create label returned an unexpected response');
  }
  existing.set(created.data.name, created.data.id);
  return created.data.id;
}

export function labelStateFromIds(
  environment: AddonEnvironment,
  labelIds: string[],
  nameById: Map<string, string>,
): SupplierInvoiceLabelState | null {
  const names = supplierInvoiceLabelNames(environment);
  const nameToState = new Map(
    (Object.entries(names) as Array<[SupplierInvoiceLabelState, string]>)
      .map(([state, name]) => [name, state] as const)
  );
  for (const labelId of labelIds) {
    const name = nameById.get(labelId);
    if (!name) continue;
    const state = nameToState.get(name);
    if (state) return state;
  }
  return null;
}

export async function getSupplierInvoiceLabelState(
  config: GmailConfig,
  gmailMessageId: string,
): Promise<SupplierInvoiceLabelState | null> {
  const message = await fetchGmailMessage(config, gmailMessageId, 'metadata');
  const labels = await listGmailLabels(config);
  const nameById = new Map([...labels.entries()].map(([name, id]) => [id, name]));
  return labelStateFromIds(config.environment, message.labelIds ?? [], nameById);
}

export async function setSupplierInvoiceLabel(
  config: GmailConfig,
  gmailMessageId: string,
  state: SupplierInvoiceLabelState,
): Promise<void> {
  const names = supplierInvoiceLabelNames(config.environment);
  const labels = await listGmailLabels(config);
  const parentName = names.processing.slice(0, names.processing.lastIndexOf('/'));
  await ensureLabelId(config, parentName, labels);
  const addId = await ensureLabelId(config, names[state], labels);
  const removeIds = supplierInvoiceLabelStates(config.environment)
    .filter((labelState) => labelState !== state)
    .map((labelState) => labels.get(names[labelState]))
    .filter((id): id is string => Boolean(id));

  const response = await gmailRequest(
    config,
    `/gmail/v1/users/me/messages/${encodeURIComponent(gmailMessageId)}/modify`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        addLabelIds: [addId],
        removeLabelIds: removeIds,
      }),
    }
  );
  if (!response.ok) {
    throw new GmailUpstreamError(`Gmail modify labels returned ${response.status}`, response.status);
  }
}

export async function applyProcessorLabelOutcome(
  config: GmailConfig,
  gmailMessageId: string,
  outcome: 'success' | 'failure',
): Promise<SupplierInvoiceLabelState> {
  const current = await getSupplierInvoiceLabelState(config, gmailMessageId);
  const next = nextProcessorLabelState(current, outcome);
  await setSupplierInvoiceLabel(config, gmailMessageId, next);
  return next;
}

export { MAX_ATTACHMENT_BYTES };
