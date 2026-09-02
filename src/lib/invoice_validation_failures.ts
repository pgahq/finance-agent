import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const TABLE_NAME_ENV = 'INVOICE_VALIDATION_FAILURES_TABLE_NAME';
const VALIDATION_ERROR_PATTERN = /Validation_Fault|validation(?:[_\s-]+fault|[_\s-]+error)|validation fault/i;
const VALIDATION_MESSAGE_KEYS = ['Validation_Message', 'Message', 'message', 'faultstring', 'faultString', 'reason'];
const VALIDATION_DETAIL_MESSAGE_KEYS = ['Detail_Message', 'detailMessage'];
const VALIDATION_XPATH_KEYS = ['Xpath', 'XPath', 'xpath'];
const VALIDATION_CONTAINER_KEYS = [
  'Validation_Error',
  'Validation_Errors',
  'Validation_Fault',
  'ValidationFault',
  'detail',
  'Fault',
  'fault',
  'response',
  'body',
  'root',
];

let documentClient: DynamoDBDocumentClient | undefined;

export interface InvoiceValidationFailuresConfig {
  tableName: string;
}

export type WorkdayValidationDetails = {
  message?: string;
  detailMessage?: string;
  xpath?: string;
  field?: string;
};

export function getInvoiceValidationFailuresConfig(
  env: NodeJS.ProcessEnv
): InvoiceValidationFailuresConfig | undefined {
  const tableName = env[TABLE_NAME_ENV];

  if (!tableName) {
    return undefined;
  }

  return { tableName };
}

function getDocumentClient(): DynamoDBDocumentClient {
  if (!documentClient) {
    documentClient = DynamoDBDocumentClient.from(
      new DynamoDBClient({}),
      {
        marshallOptions: {
          removeUndefinedValues: true,
        },
      }
    );
  }

  return documentClient;
}

function normalizeErrorText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function getNormalizedString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const normalized = normalizeErrorText(value);
    return normalized || undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = getNormalizedString(item);
      if (candidate) {
        return candidate;
      }
    }
  }

  return undefined;
}

function getFirstStringByKey(objectValue: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = getNormalizedString(objectValue[key]);
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
}

function extractWorkdayValidationErrorDetailsList(value: unknown, results: Array<Omit<WorkdayValidationDetails, 'field'>> = []): Array<Omit<WorkdayValidationDetails, 'field'>> {
  if (Array.isArray(value)) {
    for (const item of value) extractWorkdayValidationErrorDetailsList(item, results);
    return results;
  }

  if (!value || typeof value !== 'object') {
    return results;
  }

  const objectValue = value as Record<string, unknown>;
  const details = {
    message: getFirstStringByKey(objectValue, VALIDATION_MESSAGE_KEYS),
    detailMessage: getFirstStringByKey(objectValue, VALIDATION_DETAIL_MESSAGE_KEYS),
    xpath: getFirstStringByKey(objectValue, VALIDATION_XPATH_KEYS),
  };

  const isValidationErrorNode = 'Validation_Error' in objectValue
    || 'Message' in objectValue
    || 'Validation_Message' in objectValue
    || 'Detail_Message' in objectValue
    || 'Xpath' in objectValue
    || 'XPath' in objectValue;

  if (isValidationErrorNode && (details.message || details.detailMessage || details.xpath)) {
    results.push(details);
  }

  for (const key of VALIDATION_CONTAINER_KEYS) {
    if (key in objectValue) {
      extractWorkdayValidationErrorDetailsList(objectValue[key], results);
    }
  }

  return results;
}

function extractWorkdayValidationErrorDetails(value: unknown): Omit<WorkdayValidationDetails, 'field'> | undefined {
  return extractWorkdayValidationErrorDetailsList(value)[0];
}

const GENERIC_WORKDAY_MESSAGES = [
  /^Validation error occurred\.?$/i,
  /^The entered information does not meet the restrictions defined for this field\.?$/i,
];

function isGenericWorkdayMessage(message: string): boolean {
  return GENERIC_WORKDAY_MESSAGES.some((pattern) => pattern.test(message));
}

function isWorkdayParmDetail(detail: string): boolean {
  return /^Parm /i.test(detail) || /Restricted by /i.test(detail);
}

function errorTextCandidates(error: unknown): string[] {
  const texts: string[] = [];
  if (typeof error === 'string') texts.push(error);
  if (error instanceof Error && error.message) texts.push(error.message);
  if (error && typeof error === 'object') {
    const objectValue = error as Record<string, unknown>;
    if (typeof objectValue.detail === 'string') texts.push(objectValue.detail);
    if (typeof objectValue.body === 'string') texts.push(objectValue.body);
    if (typeof objectValue.message === 'string') texts.push(objectValue.message);
  }
  return texts;
}

function parseEmbeddedValidationFault(text: string): unknown | undefined {
  const match = text.match(/detail:\s*(\{[\s\S]*\})\s*$/i);
  if (match) {
    try {
      return JSON.parse(match[1]);
    } catch {
      // fall through
    }
  }

  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed.Validation_Fault || parsed.Validation_Error) {
        return parsed;
      }
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function extractValidationDetailsIncludingEmbedded(
  error: unknown
): Array<Omit<WorkdayValidationDetails, 'field'>> {
  const fromObject = extractWorkdayValidationErrorDetailsList(error);
  if (fromObject.length > 0) {
    return fromObject;
  }

  for (const text of errorTextCandidates(error)) {
    const embedded = parseEmbeddedValidationFault(text);
    if (!embedded) continue;
    const fromEmbedded = extractWorkdayValidationErrorDetailsList(embedded);
    if (fromEmbedded.length > 0) {
      return fromEmbedded;
    }
  }

  return [];
}

export function parseWorkdayValidationDetails(error: unknown): Omit<WorkdayValidationDetails, 'field'> | undefined {
  return extractValidationDetailsIncludingEmbedded(error)[0];
}

export function humanWorkdayValidationMessage(error: unknown): string {
  const details = parseWorkdayValidationDetails(error);
  const message = details?.message?.trim();
  const detailMessage = details?.detailMessage?.trim();

  if (
    detailMessage
    && !isWorkdayParmDetail(detailMessage)
    && (!message || isGenericWorkdayMessage(message))
  ) {
    return detailMessage.slice(0, 1000);
  }

  if (message && !isGenericWorkdayMessage(message)) {
    return message.slice(0, 1000);
  }

  if (detailMessage) {
    const embeddedSentence = detailMessage.match(/(?:You |Enter |The )[^.]+(?:\.|$)/);
    if (embeddedSentence) {
      return embeddedSentence[0].replace(/\{\+\d+\}.*$/, '').trim().slice(0, 1000);
    }
    if (!isWorkdayParmDetail(detailMessage)) {
      return detailMessage.slice(0, 1000);
    }
  }

  if (message) {
    return message.slice(0, 1000);
  }

  return stripSoapFaultEnvelope(summarizeValidationError(error)).slice(0, 1000);
}

function stripSoapFaultEnvelope(text: string): string {
  const xmlFaultstring = text.match(/<(?:\w+:)?faultstring>([^<]*)<\/(?:\w+:)?faultstring>/i)?.[1]?.trim();
  if (xmlFaultstring) return xmlFaultstring;

  return text
    .replace(/^faultcode:\s*\S+\s+/i, '')
    .replace(/^faultstring:\s*/i, '')
    .replace(/\s+detail:\s*\{[\s\S]*$/, '')
    .trim();
}

export function collectWorkdayValidationErrorText(error: unknown): string {
  const details = extractValidationDetailsIncludingEmbedded(error);
  if (details.length > 0) {
    return details.map(formatWorkdayValidationErrorDetails).join(' ');
  }

  if (error instanceof Error) {
    return normalizeErrorText(error.message);
  }

  return extractErrorText(error);
}

function formatWorkdayValidationErrorDetails(details: Omit<WorkdayValidationDetails, 'field'> & { field?: string }): string {
  const parts: string[] = [];

  if (details.message) {
    parts.push(details.message);
  }

  if (details.detailMessage && details.detailMessage !== details.message) {
    parts.push(`Detail: ${details.detailMessage}`);
  }

  if (details.xpath) {
    parts.push(`Xpath: ${details.xpath}`);
  }

  if (details.field) {
    parts.push(`Field: ${details.field}`);
  }

  return parts.join(' ');
}

function getFirstString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const normalized = normalizeErrorText(value);
    return normalized || undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = getFirstString(item);
      if (candidate) {
        return candidate;
      }
    }
  }

  if (value && typeof value === 'object') {
    const objectValue = value as Record<string, unknown>;

    for (const key of [...VALIDATION_MESSAGE_KEYS, ...VALIDATION_DETAIL_MESSAGE_KEYS, ...VALIDATION_XPATH_KEYS]) {
      const candidate = getFirstString(objectValue[key]);
      if (candidate) {
        return candidate;
      }
    }

    for (const key of VALIDATION_CONTAINER_KEYS) {
      const candidate = getFirstString(objectValue[key]);
      if (candidate) {
        return candidate;
      }
    }
  }

  return undefined;
}

function extractErrorText(error: unknown): string {
  const validationDetails = extractWorkdayValidationErrorDetails(error);
  if (validationDetails) {
    return formatWorkdayValidationErrorDetails(validationDetails);
  }

  if (typeof error === 'string') {
    return normalizeErrorText(error);
  }

  if (error instanceof Error) {
    return normalizeErrorText(error.message);
  }

  if (!error || typeof error !== 'object') {
    return '';
  }

  const objectValue = error as Record<string, unknown>;
  const candidates = [
    objectValue.detail,
    objectValue.Validation_Fault,
    objectValue.ValidationFault,
    objectValue.Fault,
    objectValue.fault,
    objectValue.response,
    objectValue.body,
    objectValue.root,
    objectValue,
  ];

  for (const candidate of candidates) {
    const message = getFirstString(candidate);
    if (message) {
      return message;
    }
  }

  return '';
}

function hasValidationFaultShape(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const objectValue = error as Record<string, unknown>;

  return Boolean(
    objectValue.Validation_Fault
    || objectValue.ValidationFault
    || (objectValue.detail && typeof objectValue.detail === 'object'
      && ('Validation_Fault' in (objectValue.detail as Record<string, unknown>)
        || 'ValidationFault' in (objectValue.detail as Record<string, unknown>)))
  );
}

export function summarizeValidationError(error: unknown): string {
  return extractErrorText(error).slice(0, 1000);
}

export function isWorkdayValidationError(error: unknown): boolean {
  const validationMessage = summarizeValidationError(error);
  return Boolean(validationMessage)
    && (hasValidationFaultShape(error) || VALIDATION_ERROR_PATTERN.test(validationMessage));
}

function asValidationText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return collectWorkdayValidationErrorText(value);
}

export function isRequiredLineOfBusinessWorktagError(text: unknown): boolean {
  return /must also have a value:\s*Line of Business/i.test(asValidationText(text));
}

export function isDisallowedLineOfBusinessWorktagError(text: unknown): boolean {
  return /does not allow worktag values:[\s\S]*Line of Business/i.test(asValidationText(text));
}

export function isLineOfBusinessRelatedWorktagError(text: unknown): boolean {
  return isRequiredLineOfBusinessWorktagError(text) || isDisallowedLineOfBusinessWorktagError(text);
}

export function isWorkdayTaskNotAuthorizedError(error: unknown): boolean {
  return /the task submitted is not authorized/i.test(asValidationText(error));
}

export async function recordInvoiceValidationFailure(
  config: InvoiceValidationFailuresConfig | undefined,
  invoiceWorkdayID: string,
  error: unknown
): Promise<void> {
  if (!config || !invoiceWorkdayID) {
    return;
  }

  const errorMessage = summarizeValidationError(error);

  await getDocumentClient().send(new PutCommand({
    TableName: config.tableName,
    Item: {
      invoiceWorkdayID,
      createdAt: new Date().toISOString(),
      errorMessage,
    },
  }));
}

export async function clearInvoiceValidationFailure(
  config: InvoiceValidationFailuresConfig | undefined,
  invoiceWorkdayID: string,
): Promise<void> {
  if (!config || !invoiceWorkdayID) {
    return;
  }

  try {
    await getDocumentClient().send(new DeleteCommand({
      TableName: config.tableName,
      Key: { invoiceWorkdayID },
      ConditionExpression: 'attribute_exists(invoiceWorkdayID)',
    }));
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      return;
    }

    throw error;
  }
}

export async function isInvoiceMarkedForSkip(
  config: InvoiceValidationFailuresConfig | undefined,
  invoiceWorkdayID: string
): Promise<boolean> {
  if (!config || !invoiceWorkdayID) {
    return false;
  }

  const response = await getDocumentClient().send(new GetCommand({
    TableName: config.tableName,
    Key: { invoiceWorkdayID },
    ProjectionExpression: 'invoiceWorkdayID',
  }));

  return typeof response.Item?.invoiceWorkdayID === 'string';
}
