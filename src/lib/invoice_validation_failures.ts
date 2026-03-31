import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const TABLE_NAME_ENV = 'INVOICE_VALIDATION_FAILURES_TABLE_NAME';
const VALIDATION_ERROR_PATTERN = /validation(?:[_\s-]+fault|[_\s-]+error|\b)|validation fault/i;

let documentClient: DynamoDBDocumentClient | undefined;

export interface InvoiceValidationFailuresConfig {
  tableName: string;
}

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

    for (const key of ['Validation_Message', 'message', 'faultstring', 'faultString', 'reason']) {
      const candidate = getFirstString(objectValue[key]);
      if (candidate) {
        return candidate;
      }
    }

    for (const key of ['Validation_Fault', 'ValidationFault', 'detail', 'Fault', 'fault', 'response', 'body', 'root']) {
      const candidate = getFirstString(objectValue[key]);
      if (candidate) {
        return candidate;
      }
    }
  }

  return undefined;
}

function extractErrorText(error: unknown): string {
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
  return hasValidationFaultShape(error) || VALIDATION_ERROR_PATTERN.test(summarizeValidationError(error));
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
