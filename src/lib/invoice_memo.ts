import { normalizePurchaseOrderNumber } from './purchase_order.js';
import type { InvoiceEnrichmentResult } from '../prompts/enrich_invoice_prompt.js';
import type { FinalInvoiceLine } from './invoice_lines.js';

// Not final: AP still has to confirm the check/ACH limit and which memo field feeds them.
export const INVOICE_MEMO_MAX_LENGTH = 500;
export const INVOICE_MEMO_TOKEN_SEPARATOR = ' ';
const LEGACY_TOKEN_SEPARATOR = '. ';

const ACCOUNT_TOKEN_LABEL = 'Acct';
const CUSTOMER_TOKEN_LABEL = 'Cust';
const SERVICE_PERIOD_TOKEN_LABEL = 'Svc Prd';
const UNKNOWN_REFERENCE_TOKEN_LABEL = 'Ref';

export interface InvoiceMemoIdentifierFields {
  /** Printed as `PO-######` when it normalizes to a PGA PO; also drops a supplier reference that is that PO. */
  po?: string | null;
  accountNumber?: string | null;
  customerId?: string | null;
  supplierReference?: string | null;
  supplierReferenceKind?: string | null;
  servicePeriod?: string | null;
}

export interface InvoiceMemoInput extends InvoiceMemoIdentifierFields {
  description?: string | null;
}

const ACCOUNT_LABEL = /^(?:account(?:\s*(?:number|#))?|acct(?:\s*#)?|ac(?:\s*#|\s+|:\s*)|customer\s+account|sold\s*to(?:\s*(?:number|#))?)\s*[:#.-]*\s*/i;
const REFERENCE_LABEL = /^(job|order|confirmation|conf|file|case|matter|ref(?:erence)?)\b(?:\s*(?:number|num|no\.?|id|#))?\s*[:#.-]*\s*/i;
const CUSTOMER_LABEL = /^(?:bill[-\s]?to\s+)?(?:customer|cust)(?:\s*(?:id|#|number))?\s*[:#.-]*\s*/i;
const SERVICE_PERIOD_LABEL = /^(?:service\s+period|billing\s+period|period\s+covered)\s*[:#.-]*\s*/i;

// Labels a period can sit behind when the model copies it into the description.
const PERIOD_LABELS = [
  'Service Period', 'Billing Period', 'Period Covered', 'Pay Date Range', 'Pay Period', 'Week Ending',
  'Week Of', 'Date Range', 'Service Dates', 'Billing Dates',
];

const REFERENCE_TOKEN_LABELS: ReadonlyArray<readonly [prefix: string, label: string]> = [
  ['ord', 'Ord'],
  ['conf', 'Conf'],
  ['job', 'Job'],
  ['file', 'File'],
  ['matter', 'File'],
  ['case', 'Case'],
];

function referenceTokenLabel(kind?: string | null): string | null {
  const normalized = kind?.trim().toLowerCase();
  if (!normalized) return null;
  return REFERENCE_TOKEN_LABELS.find(([prefix]) => normalized.startsWith(prefix))?.[1] ?? null;
}

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
    | 'extractedSupplierReference'
    | 'extractedSupplierReferenceKind'
    | 'extractedCustomerId'
    | 'extractedServicePeriod'
  >,
  po?: string | null
): InvoiceMemoIdentifierFields {
  return {
    po: blankToNull(po) ?? normalizePurchaseOrderNumber(result.extractedPurchaseOrderNumber) ?? null,
    accountNumber: result.extractedAccountNumber,
    customerId: result.extractedCustomerId,
    supplierReference: result.extractedSupplierReference,
    supplierReferenceKind: result.extractedSupplierReferenceKind,
    servicePeriod: result.extractedServicePeriod,
  };
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DATE_PATTERN = '(?:\\d{1,2}\\/\\d{1,2}\\/(?:\\d{4}|\\d{2})|\\d{4}-\\d{1,2}-\\d{1,2}|[A-Za-z]{3,9}\\.?\\s+\\d{1,2},?\\s+\\d{4})';
const DATE_RANGE = new RegExp(`^(${DATE_PATTERN})\\s*(?:-|to:?|through|thru)\\s*(${DATE_PATTERN})$`, 'i');
const SINGLE_DATE = new RegExp(`^(${DATE_PATTERN})$`, 'i');

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

// Whole month names and their usual short forms only; a word that merely starts like a month ("Augusta") is not one.
const MONTH_WORD = /^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?$/i;

function monthFromName(name: string): number | undefined {
  const match = name.match(MONTH_WORD);
  return match ? MONTH_NAMES.indexOf(match[1].slice(0, 3).toLowerCase()) + 1 : undefined;
}

function fullYear(value: string): number {
  return value.length === 2 ? 2000 + Number(value) : Number(value);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function validCalendarDate(year: number, month: number, day: number): CalendarDate | undefined {
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return undefined;
  return { year, month, day };
}

function parseDateToken(token: string): CalendarDate | undefined {
  const text = token.trim();
  const numeric = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/);
  if (numeric) return validCalendarDate(fullYear(numeric[3]), Number(numeric[1]), Number(numeric[2]));
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return validCalendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const named = text.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  const month = named ? monthFromName(named[1]) : undefined;
  return named && month ? validCalendarDate(Number(named[3]), month, Number(named[2])) : undefined;
}

function formatMemoDate({ year, month, day }: CalendarDate): string {
  return `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/${String(year).slice(-2)}`;
}

function wholeMonth(year: number, month: number | undefined): string | undefined {
  if (!month || month < 1 || month > 12) return undefined;
  return `${formatMemoDate({ year, month, day: 1 })} - ${formatMemoDate({ year, month, day: daysInMonth(year, month) })}`;
}

function parseQuarter(text: string): string | undefined {
  const quarterFirst = text.match(/^Q([1-4])\s*[-,']?\s*(\d{4}|\d{2})$/i);
  if (quarterFirst) return `Q${quarterFirst[1]} ${String(fullYear(quarterFirst[2])).slice(-2)}`;
  const yearFirst = text.match(/^(\d{4})\s*[-,]?\s*Q([1-4])$/i);
  if (yearFirst) return `Q${yearFirst[2]} ${yearFirst[1].slice(-2)}`;
  return undefined;
}

function parseWholeMonth(text: string): string | undefined {
  const nameYear = text.match(/^([A-Za-z]{3,9})\.?,?\s+(\d{4})$/);
  if (nameYear) return wholeMonth(Number(nameYear[2]), monthFromName(nameYear[1]));
  const yearName = text.match(/^(\d{4})\s*[-/,]?\s*([A-Za-z]{3,9})\.?$/);
  if (yearName) return wholeMonth(Number(yearName[1]), monthFromName(yearName[2]));
  const yearNumber = text.match(/^(\d{4})-(\d{1,2})$/);
  if (yearNumber) return wholeMonth(Number(yearNumber[1]), Number(yearNumber[2]));
  const numberYear = text.match(/^(\d{1,2})\/(\d{4})$/);
  if (numberYear) return wholeMonth(Number(numberYear[2]), Number(numberYear[1]));
  return undefined;
}

function parseServiceDates(text: string): string | undefined {
  const quarter = parseQuarter(text);
  if (quarter) return quarter;
  const month = parseWholeMonth(text);
  if (month) return month;
  const range = text.match(DATE_RANGE);
  if (range) {
    const start = parseDateToken(range[1]);
    const end = parseDateToken(range[2]);
    if (start && end) return `${formatMemoDate(start)} - ${formatMemoDate(end)}`;
  }
  if (SINGLE_DATE.test(text)) {
    const date = parseDateToken(text);
    if (date) return formatMemoDate(date);
  }
  return undefined;
}

// Invoices label the dates in many ways ("Pay Date Range", "Week Ending"). Drop up to this many leading words
// to reach dates that start further in.
const MAX_LEADING_LABEL_WORDS = 5;

function parseLabeledServiceDates(value: string): string | undefined {
  // A delimiter stuck to the first date ("Pay Date Range:09/28/2026") would otherwise hide the date from the word split.
  const text = value.replace(/([A-Za-z])[:#/.-]+(?=\d)/g, '$1 ');
  const words = text.split(' ');
  for (let skip = 1; skip <= Math.min(MAX_LEADING_LABEL_WORDS, words.length - 1); skip++) {
    // A label word never holds a digit, a month, or a quarter; skipping one would cut the start off a range.
    const skipped = words[skip - 1].replace(/[:#.,]+$/, '');
    if (/\d/.test(skipped) || monthFromName(skipped) || /^q[1-4]$/i.test(skipped)) return undefined;
    const rest = words.slice(skip).join(' ').replace(/^[:#.-]+\s*/, '');
    const dates = parseServiceDates(rest);
    if (dates) return dates;
  }
  return undefined;
}

/**
 * Service dates as MM/DD/YY, a range as "MM/DD/YY - MM/DD/YY", a quarter as "Q4 26". A whole month becomes its
 * first and last day. A label in front of the dates ("Pay Date Range 09/28/2026 - 10/11/2026") is dropped. Text
 * that is not a recognizable date or period (no year, odd wording) stays as printed.
 */
export function formatMemoServiceDates(value: string): string {
  const text = value.trim().replace(/[\u2013\u2014]/g, '-').replace(/\s+/g, ' ');
  return parseServiceDates(text) ?? parseLabeledServiceDates(text) ?? text;
}

interface IdentifierParts {
  po: string | null;
  accountNumber: string | null;
  customerId: string | null;
  referenceLabel: string;
  reference: string | null;
  servicePeriodText: string | null;
  servicePeriod: string | null;
}

function identifierParts(fields: InvoiceMemoIdentifierFields): IdentifierParts {
  const po = sanitizeMemoFragment(normalizePurchaseOrderNumber(fields.po) ?? null);
  const accountNumber = sanitizeMemoFragment(stripLeadingLabel(blankToNull(fields.accountNumber), ACCOUNT_LABEL));
  const customerId = sanitizeMemoFragment(stripLeadingLabel(blankToNull(fields.customerId), CUSTOMER_LABEL));
  const rawReference = blankToNull(fields.supplierReference);
  const labelWord = rawReference?.match(REFERENCE_LABEL)?.[1];
  const referenceValue = sanitizeMemoFragment(stripLeadingLabel(rawReference, REFERENCE_LABEL));
  const referenceIsPo = referenceValue ? normalizePurchaseOrderNumber(referenceValue) === po : false;
  // Dates are read before sanitizing, which would turn an en or em dash into a space and break the range.
  const rawServicePeriod = stripLeadingLabel(blankToNull(fields.servicePeriod), SERVICE_PERIOD_LABEL);
  const servicePeriodText = sanitizeMemoFragment(rawServicePeriod);

  return {
    po,
    accountNumber,
    customerId,
    referenceLabel:
      referenceTokenLabel(fields.supplierReferenceKind) ?? referenceTokenLabel(labelWord) ?? UNKNOWN_REFERENCE_TOKEN_LABEL,
    reference: referenceIsPo ? null : referenceValue,
    servicePeriodText,
    servicePeriod: rawServicePeriod ? sanitizeMemoFragment(formatMemoServiceDates(rawServicePeriod)) : null,
  };
}

function identifierTokens(fields: InvoiceMemoIdentifierFields): string[] {
  const { po, accountNumber, customerId, referenceLabel, reference, servicePeriod } = identifierParts(fields);
  const tokens: string[] = [];
  if (accountNumber) tokens.push(`${ACCOUNT_TOKEN_LABEL} ${accountNumber}`);
  else if (customerId) tokens.push(`${CUSTOMER_TOKEN_LABEL} ${customerId}`);
  if (reference) tokens.push(`${referenceLabel} ${reference}`);
  if (po) tokens.push(po);
  if (servicePeriod) tokens.push(`${SERVICE_PERIOD_TOKEN_LABEL} ${servicePeriod}`);
  return tokens;
}

export function hasMemoIdentifiers(fields: InvoiceMemoIdentifierFields): boolean {
  return identifierTokens(fields).length > 0;
}

// Tokens the model may still copy into the description: the current labels and the earlier "AC 123. Job 456." form.
function descriptionTokensToStrip(fields: InvoiceMemoIdentifierFields, tokens: string[]): string[] {
  const { accountNumber, customerId, reference, servicePeriodText, servicePeriod } = identifierParts(fields);
  const legacy: string[] = [];
  if (accountNumber) legacy.push(`AC ${accountNumber}`);
  if (customerId) legacy.push(`Customer ID ${customerId}`, `${CUSTOMER_TOKEN_LABEL} ${customerId}`);
  if (reference) legacy.push(`Job ${reference}`);
  const periods = [servicePeriodText, servicePeriod].filter((period): period is string => Boolean(period));
  for (const period of periods) {
    for (const label of [...PERIOD_LABELS, SERVICE_PERIOD_TOKEN_LABEL]) legacy.push(`${label} ${period}`);
  }
  // The model may copy the period as printed, with or without its label ("Pay Date Range 09/28/2026 - 10/11/2026").
  legacy.push(...periods);
  return [...tokens, ...legacy];
}

function stripIdentifierTokensFromDescription(description: string, tokens: string[]): string {
  let result = description
    .replace(/\bAC\s*#/gi, 'AC ')
    .replace(/\bJob\s*#/gi, 'Job ')
    .replace(/\s*\|\s*/g, ' ');

  const separators = [INVOICE_MEMO_TOKEN_SEPARATOR, LEGACY_TOKEN_SEPARATOR].map(escapeRegExp).join('|');
  for (const token of tokens) {
    const pattern = new RegExp(
      `(?:^|\\s+|${separators})${escapeRegExp(token)}(?:\\s+|${separators}|$)`,
      'ig'
    );
    result = result.replace(pattern, ' ');
  }

  return result.replace(/^\.+\s*/, '').replace(/\s+/g, ' ').trim();
}

// Lowercase and unpunctuated, like "elevator phone line service". An acronym or a word with a digit keeps its case.
function polishDescription(description: string): string {
  const withoutPeriod = description.replace(/\.+$/, '').trim();
  const firstWord = withoutPeriod.match(/^[^\s]+/)?.[0] ?? '';
  if (!/^[A-Z][a-z]+[^A-Za-z0-9]*$/.test(firstWord)) return withoutPeriod;
  return withoutPeriod.charAt(0).toLowerCase() + withoutPeriod.slice(1);
}

export function composeInvoiceMemo(input: InvoiceMemoInput): string | undefined {
  const tokens = identifierTokens(input);
  const prefix = tokens.join(INVOICE_MEMO_TOKEN_SEPARATOR);
  let description = sanitizeMemoFragment(blankToNull(input.description)) ?? '';
  const strippable = descriptionTokensToStrip(input, tokens);
  if (strippable.length && description) {
    description = stripIdentifierTokensFromDescription(description, strippable);
  }
  description = polishDescription(description);

  // Identifiers are never cut; the description is left out when it would not fit. A description-only memo is cut.
  const composed = prefix ? `${prefix}${description ? `${INVOICE_MEMO_TOKEN_SEPARATOR}${description}` : ''}` : description;
  const memo = sanitizeMemoText(composed);
  if (!prefix && memo.length > INVOICE_MEMO_MAX_LENGTH) return memo.slice(0, INVOICE_MEMO_MAX_LENGTH).trimEnd();
  if (prefix && memo.length > INVOICE_MEMO_MAX_LENGTH) return sanitizeMemoText(prefix);
  return memo || undefined;
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
