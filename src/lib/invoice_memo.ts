import { normalizePurchaseOrderNumber } from './purchase_order.js';
import type { InvoiceEnrichmentResult } from '../prompts/enrich_invoice_prompt.js';
import type { FinalInvoiceLine } from './invoice_lines.js';

export const INVOICE_MEMO_MAX_LENGTH = 500;
export const INVOICE_MEMO_TOKEN_SEPARATOR = '. ';

export interface InvoiceMemoIdentifierFields {
  po?: string | null;
  accountNumber?: string | null;
  jobNumber?: string | null;
  customerId?: string | null;
  servicePeriod?: string | null;
}

export interface InvoiceMemoInput extends InvoiceMemoIdentifierFields {
  description?: string | null;
}

const ACCOUNT_LABEL = /^(?:account(?:\s*(?:number|#))?|acct(?:\s*#)?|ac(?:\s*#|\s+|:\s*)|customer\s+account|sold\s*to(?:\s*(?:number|#))?)\s*[:#.-]*\s*/i;
const JOB_LABEL = /^(?:job(?:\s*(?:number|#|no\.?)?)?|order(?:\s*(?:number|#))?)\s*[:#.-]*\s*/i;
const CUSTOMER_LABEL = /^(?:bill[-\s]?to\s+)?(?:customer|cust)(?:\s*(?:id|#|number))?\s*[:#.-]*\s*/i;
const SERVICE_PERIOD_LABEL = /^(?:service\s+period|billing\s+period|period\s+covered)\s*[:#.-]*\s*/i;

function blankToNull(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function stripLeadingLabel(value: string | null, label: RegExp): string | null {
  if (!value) return null;
  const stripped = value.replace(label, '').replace(/^[#:-]+\s*/, '').trim();
  return stripped || null;
}

function comparableId(value: string): string {
  return value.replace(/[\s#-]+/g, '').toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function sanitizeMemoText(value: string): string {
  return value
    .replace(/[^A-Za-z0-9 #./,'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sanitizeSuppliersInvoiceNumber(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const sanitized = trimmed
    .replace(/[^A-Za-z0-9#./-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || undefined;
}

const MONTH_ABBREVIATIONS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] as const;

export interface SuppliersInvoiceNumberInput {
  invoiceNumber?: string | null;
  accountNumber?: string | null;
  invoiceDate?: string | null;
  supplierName?: string | null;
}

function parseInvoiceCalendarDate(value?: string | null): { month: number; day: number; year: number } | undefined {
  const match = value?.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) return undefined;
  return { month, day, year };
}

function supplierNamePrefix(name?: string | null): string | undefined {
  const letters = name?.toUpperCase().replace(/[^A-Z]/g, '') ?? '';
  return letters ? letters.slice(0, 4) : undefined;
}

/** First name that yields an A–Z prefix: extracted PDF name, then the resolved Workday name. */
export function supplierNameForInvoiceNumber(...names: Array<string | null | undefined>): string | undefined {
  return names.find((name) => supplierNamePrefix(name)) ?? undefined;
}

/**
 * HQ supplier invoice number: a distinct printed number as-is; otherwise the
 * account number plus MMMYY; otherwise the first four letters of the supplier
 * plus MMDDYY. Generated numbers use the document invoice date and stay unset
 * when that date is missing.
 */
export function composeSuppliersInvoiceNumber(input: SuppliersInvoiceNumberInput): string | undefined {
  const rawInvoice = input.invoiceNumber?.trim();
  const rawAccount = input.accountNumber?.trim();
  const sameAsAccount = Boolean(
    rawInvoice && rawAccount && comparableId(rawInvoice) === comparableId(rawAccount)
  );
  const invoiceNumber = sanitizeSuppliersInvoiceNumber(input.invoiceNumber);
  const accountNumber = sanitizeSuppliersInvoiceNumber(input.accountNumber);
  if (invoiceNumber && !sameAsAccount) return invoiceNumber;

  const date = parseInvoiceCalendarDate(input.invoiceDate);
  if (!date) return undefined;

  const year = String(date.year).slice(-2);
  if (accountNumber) {
    return sanitizeSuppliersInvoiceNumber(`${accountNumber}${MONTH_ABBREVIATIONS[date.month - 1]}${year}`);
  }

  const prefix = supplierNamePrefix(input.supplierName);
  if (!prefix) return undefined;
  const month = String(date.month).padStart(2, '0');
  const day = String(date.day).padStart(2, '0');
  return sanitizeSuppliersInvoiceNumber(`${prefix}${month}${day}${year}`);
}

function sanitizeMemoFragment(value: string | null): string | null {
  if (!value) return null;
  const sanitized = sanitizeMemoText(value);
  return sanitized || null;
}

export function memoIdentifiersFromEnrichment(
  result: Pick<
    InvoiceEnrichmentResult,
    | 'extractedPurchaseOrderNumber'
    | 'extractedAccountNumber'
    | 'extractedJobNumber'
    | 'extractedCustomerId'
    | 'extractedServicePeriod'
  >,
  po?: string | null
): InvoiceMemoIdentifierFields {
  return {
    po: blankToNull(po) ?? normalizePurchaseOrderNumber(result.extractedPurchaseOrderNumber) ?? null,
    accountNumber: result.extractedAccountNumber,
    jobNumber: result.extractedJobNumber,
    customerId: result.extractedCustomerId,
    servicePeriod: result.extractedServicePeriod,
  };
}

function identifierTokens(fields: InvoiceMemoIdentifierFields): string[] {
  const po = sanitizeMemoFragment(normalizePurchaseOrderNumber(fields.po) ?? null);
  const accountNumber = sanitizeMemoFragment(stripLeadingLabel(blankToNull(fields.accountNumber), ACCOUNT_LABEL));
  const jobNumber = sanitizeMemoFragment(stripLeadingLabel(blankToNull(fields.jobNumber), JOB_LABEL));
  const customerId = sanitizeMemoFragment(stripLeadingLabel(blankToNull(fields.customerId), CUSTOMER_LABEL));
  const servicePeriod = sanitizeMemoFragment(stripLeadingLabel(blankToNull(fields.servicePeriod), SERVICE_PERIOD_LABEL));

  const tokens: string[] = [];
  if (accountNumber) tokens.push(`AC ${accountNumber}`);
  if (customerId && (!accountNumber || comparableId(customerId) !== comparableId(accountNumber))) {
    tokens.push(`Customer ID ${customerId}`);
  }
  const jobAsPo = jobNumber ? normalizePurchaseOrderNumber(jobNumber) : undefined;
  if (jobNumber && jobAsPo !== po) {
    tokens.push(`Job ${jobNumber}`);
  }
  if (po) tokens.push(po);
  if (servicePeriod) tokens.push(`Service Period ${servicePeriod}`);
  return tokens;
}

export function hasMemoIdentifiers(fields: InvoiceMemoIdentifierFields): boolean {
  return identifierTokens(fields).length > 0;
}

function stripIdentifierTokensFromDescription(description: string, tokens: string[]): string {
  let result = description
    .replace(/\bAC\s*#/gi, 'AC ')
    .replace(/\bJob\s*#/gi, 'Job ')
    .replace(/\s*\|\s*/g, ' ');

  const separator = escapeRegExp(INVOICE_MEMO_TOKEN_SEPARATOR);
  for (const token of tokens) {
    const pattern = new RegExp(
      `(?:^|\\s+|${separator})${escapeRegExp(token)}(?:\\s+|${separator}|$)`,
      'ig'
    );
    result = result.replace(pattern, ' ');
  }

  return result.replace(/^\.+\s*/, '').replace(/\s+/g, ' ').trim();
}

function capMemo(value: string): string {
  if (value.length <= INVOICE_MEMO_MAX_LENGTH) return value;
  return value.slice(0, INVOICE_MEMO_MAX_LENGTH).trimEnd();
}

export function composeInvoiceMemo(input: InvoiceMemoInput): string | undefined {
  const tokens = identifierTokens(input);
  const prefix = tokens.join(INVOICE_MEMO_TOKEN_SEPARATOR);
  let description = sanitizeMemoFragment(blankToNull(input.description)) ?? '';
  if (tokens.length && description) {
    description = stripIdentifierTokensFromDescription(description, tokens);
  }

  if (!prefix && !description) return undefined;
  const composed = !prefix
    ? description
    : !description
      ? prefix
      : `${prefix}${INVOICE_MEMO_TOKEN_SEPARATOR}${description}`;
  return capMemo(sanitizeMemoText(composed));
}

export function applyInvoiceMemoIdentifiersToLines(
  lines: FinalInvoiceLine[],
  identifiers: InvoiceMemoIdentifierFields
): FinalInvoiceLine[] {
  return lines.map(line => {
    const memo = composeInvoiceMemo({ ...identifiers, description: line.memo });
    if (memo == null || memo === (line.memo ?? undefined)) return line;
    return { ...line, memo };
  });
}
