import { debug } from '@pga/logger';
import { getAiResponse } from './ai.js';
import type { PurchaseOrderLine } from './workday.js';
import { mergeInvoiceLinesPromptFor, MergeInvoiceLinesSchema, type MergeInvoiceLinesResult } from '../prompts/merge_invoice_lines_prompt.js';
import { isPoLineSelectionEnabled } from './po_line_selection_flag.js';
import {
  extractLineOfBusinessId,
  relatedLobAllowsId,
  relatedLobHasUsableValue,
  relatedLobIdsMatch,
  resolveRelatedLobId,
  type RelatedLob,
} from './related_worktags.js';
import { worktagIdentity, type PurchaseOrderLineSplit } from './po_worktags.js';

export interface ExtractedInvoiceLine {
  description: string;
  descriptionCells?: string[] | null;
  quantity?: number | null;
  unitCost?: string | null;
  totalPrice?: string | null;
  hasDiscount?: boolean | null;
}

export const INVOICE_LINE_DESCRIPTION_SEPARATOR = ' - ';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compactAmount(value: string): string {
  return value.replace(/[$,\s]/g, '');
}

function isCurrencyCell(value: string): boolean {
  return /\$/.test(value) && /^\$?-?[\d,]+(?:\.\d+)?$/.test(value.replace(/\s/g, ''));
}

function cellMatchesLineAmount(
  cell: string,
  line?: Pick<ExtractedInvoiceLine, 'quantity' | 'unitCost' | 'totalPrice'>
): boolean {
  if (isCurrencyCell(cell)) return true;
  if (!line) return false;
  const compact = compactAmount(cell);
  const candidates = [
    line.quantity != null ? String(line.quantity) : null,
    line.unitCost ?? null,
    line.totalPrice ?? null,
  ];
  return candidates.some(candidate => candidate != null && compactAmount(String(candidate)) === compact);
}

function containsAsToken(haystack: string, needle: string): boolean {
  if (haystack.length <= needle.length) return false;
  return new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(needle)}([^A-Za-z0-9]|$)`, 'i').test(haystack);
}

function identifyingCells(
  cells: Array<string | null | undefined> | null | undefined,
  line?: Pick<ExtractedInvoiceLine, 'quantity' | 'unitCost' | 'totalPrice'>
): string[] {
  const cleaned: string[] = [];
  for (const raw of cells ?? []) {
    const cell = raw?.replace(/\s+/g, ' ').trim();
    if (!cell || cellMatchesLineAmount(cell, line)) continue;
    const lower = cell.toLowerCase();
    if (cleaned.some(existing => existing.toLowerCase() === lower)) continue;
    cleaned.push(cell);
  }
  return cleaned.filter((cell, index) => (
    !cleaned.some((other, otherIndex) => (
      otherIndex !== index
      && other.length > cell.length
      && containsAsToken(other, cell)
    ))
  ));
}

export function composeInvoiceLineDescription(
  cells?: Array<string | null | undefined> | null,
  description?: string | null,
  line?: Pick<ExtractedInvoiceLine, 'quantity' | 'unitCost' | 'totalPrice'>
): string | undefined {
  const fromDescription = identifyingCells([description], line);
  const original = fromDescription.length
    ? fromDescription.join(INVOICE_LINE_DESCRIPTION_SEPARATOR)
    : undefined;
  const fromCells = identifyingCells(cells, line);
  if (!fromCells.length) return original;
  const composed = fromCells.join(INVOICE_LINE_DESCRIPTION_SEPARATOR);
  if (isFreightOrHandlingLine(composed) && !isFreightOrHandlingLine(original)) {
    return original;
  }
  return composed;
}

export function withComposedLineDescriptions<T extends ExtractedInvoiceLine>(lines: T[]): T[] {
  return lines.map(line => {
    const composed = composeInvoiceLineDescription(line.descriptionCells, line.description, line);
    if (!composed || composed === line.description) return line;
    return { ...line, description: composed };
  });
}

export function pinExtractedLineDescriptions(
  merged: FinalInvoiceLine[],
  extracted: ExtractedInvoiceLine[]
): FinalInvoiceLine[] {
  return merged.map((line, index) => {
    const extractedDescription = extracted[index]?.description;
    if (!extractedDescription || extractedDescription === line.description) return line;
    return { ...line, description: extractedDescription };
  });
}

export interface FinalInvoiceLine {
  lineOrder: number;
  description: string;
  memo?: string | null;
  quantity?: number | null;
  unitCost?: number | null;
  extendedAmount?: number | null;
  hasDiscount?: boolean | null;
  costCenterId?: string | null;
  fundId?: string | null;
  spendCategoryId?: string | null;
  lineOfBusinessId?: string | null;
  eventId?: string | null;
  eventWid?: string | null;
  shipToAddressId?: string | null;
  purchaseOrderLineId?: string | null;
  /** Matched PO line is fully invoiced or closed: keep its coding, drop its reference. */
  omitPurchaseOrderLineReference?: boolean;
  poPassthroughWorktagsReference?: any[];
  supplierInvoiceSplitLineData?: PurchaseOrderLineSplit[];
}

// Extraction sets hasDiscount on merchandise rows that print a discounted net price.
// Only a row that credits money back is a discount line; a positive row is merchandise
// and must keep its quantity and PO line link so Workday records the PO as invoiced.
export function isDiscountLine(line: Pick<FinalInvoiceLine, 'hasDiscount' | 'extendedAmount' | 'unitCost'>): boolean {
  if (line.hasDiscount !== true) return false;
  const amount = line.extendedAmount ?? line.unitCost;
  return amount == null || amount <= 0;
}

export interface LineFallbacks {
  fund: boolean;
  costCenter: boolean;
  spendCategory: boolean;
  lineOfBusiness: boolean;
}

export type InvoiceLineFallbackIds = {
  fundId?: string;
  costCenterId?: string;
  spendCategoryId?: string;
  lineOfBusinessId?: string;
};

export type RelatedLobLookup = (costCenterIds: string[]) => Promise<Map<string, RelatedLob>>;

export function parseExtractedAmount(raw: string): number | undefined {
  const parsed = parseFloat(raw.replace(/[^0-9.]/g, ''));
  return isNaN(parsed) ? undefined : Math.round(parsed * 100) / 100;
}

const FREIGHT_CORE_WORDS = new Set(['freight', 'shipping', 'handling', 'delivery', 'deliveries', 'postage']);
const FREIGHT_CARRIER_WORDS = new Set(['ups', 'fedex', 'usps', 'dhl']);
const FREIGHT_ALLOWED_WORDS = new Set([
  ...FREIGHT_CORE_WORDS,
  ...FREIGHT_CARRIER_WORDS,
  'charge', 'charges', 'fee', 'fees', 'cost', 'costs', 'and', 'inbound', 'outbound', 's', 'h',
  'ground', 'overnight', 'express',
  'standard', 'priority', 'next', 'day', 'free', 'in', 'out',
  'air', 'ocean', 'parcel', 'home', 'local', 'rush', 'misc', 'surcharge',
]);

const FREIGHT_WEIGHT_WORDS = new Set(['pound', 'pounds', 'lb', 'lbs', 'kg', 'kgs']);

function isAllowedFreightToken(token: string): boolean {
  return FREIGHT_ALLOWED_WORDS.has(token) || /^\d+$/.test(token);
}

function isFreightAnchorToken(token: string): boolean {
  return FREIGHT_CORE_WORDS.has(token) || FREIGHT_CARRIER_WORDS.has(token);
}

// Carrier rows lead with a pro or shipment number and print the billed weight,
// e.g. `FRN52118A - Freight Charge - 42,000.00 Pounds`. A pro number is up to four letters,
// at least five digits, then up to two letters; short item codes (`SKU123`) do not match.
function isShipmentReferenceToken(token: string): boolean {
  return /^[a-z]{0,4}\d{5,}[a-z]{0,2}$/.test(token) && /[a-z]/.test(token);
}

function normalizeLineDescription(description: string): string {
  return description
    .toLowerCase()
    .replace(/s\s*[&/]\s*h\b/g, 's and h')
    .replace(/&/g, ' and ')
    .replace(/[/_,-]+/g, ' ')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isFreightOrHandlingLine(description: string | null | undefined): boolean {
  if (!description) return false;
  const normalized = normalizeLineDescription(description);
  if (!normalized) return false;
  if (normalized === 's and h') return true;
  const tokens = normalized.split(' ');
  // A leading pro/shipment number is only skipped on a row that prints a billed weight, so an
  // item code in front of freight words (`SKU123 Freight Charge`) stays merchandise.
  const printsWeight = tokens.some(token => FREIGHT_WEIGHT_WORDS.has(token));
  const body = printsWeight && tokens.length > 1 && isShipmentReferenceToken(tokens[0]) ? tokens.slice(1) : tokens;
  return body.some(isFreightAnchorToken)
    && body.every(token => isAllowedFreightToken(token) || FREIGHT_WEIGHT_WORDS.has(token));
}

function lineDescription(line: { description?: string | null; Item_Description?: string | null }): string | undefined {
  return line.description ?? line.Item_Description ?? undefined;
}

function lineAmount(line: {
  totalPrice?: string | null;
  unitCost?: string | number | null;
  Unit_Cost?: string | number | null;
  extendedAmount?: number | null;
  Extended_Amount?: number | string | null;
  quantity?: number | null;
  Quantity?: number | string | null;
}): number | undefined {
  if (typeof line.extendedAmount === 'number') return line.extendedAmount;
  if (line.totalPrice) return parseExtractedAmount(line.totalPrice);
  if (typeof line.Extended_Amount === 'number') return line.Extended_Amount;
  if (typeof line.Extended_Amount === 'string') return parseExtractedAmount(line.Extended_Amount);
  const rawUnitCost = line.unitCost ?? line.Unit_Cost;
  const unitCost = typeof rawUnitCost === 'number'
    ? rawUnitCost
    : (typeof rawUnitCost === 'string' ? parseExtractedAmount(rawUnitCost) : undefined);
  if (unitCost == null) return undefined;
  const rawQuantity = line.quantity ?? line.Quantity;
  const quantity = typeof rawQuantity === 'number'
    ? rawQuantity
    : (typeof rawQuantity === 'string' ? parseExtractedAmount(rawQuantity) : undefined);
  const multiplier = quantity != null && Number.isFinite(quantity) ? quantity : 1;
  return Math.round(unitCost * multiplier * 100) / 100;
}

export function splitFreightLines<T extends {
  description?: string | null;
  Item_Description?: string | null;
  totalPrice?: string | null;
  unitCost?: string | number | null;
  Unit_Cost?: string | number | null;
  extendedAmount?: number | null;
  Extended_Amount?: number | string | null;
  quantity?: number | null;
  Quantity?: number | string | null;
}>(lines: T[]): { merchandiseLines: T[]; freightLines: T[]; freightAmountFromLines?: number } {
  const merchandiseLines: T[] = [];
  const freightLines: T[] = [];
  for (const line of lines) {
    if (isFreightOrHandlingLine(lineDescription(line))) {
      freightLines.push(line);
    } else {
      merchandiseLines.push(line);
    }
  }
  let freightAmountFromLines: number | undefined;
  for (const line of freightLines) {
    const amount = signedChargeLineAmount(line);
    if (amount != null) {
      freightAmountFromLines = Math.round(((freightAmountFromLines ?? 0) + amount) * 100) / 100;
    }
  }
  return { merchandiseLines, freightLines, freightAmountFromLines };
}

const TAX_CORE_WORDS = new Set(['tax', 'taxes', 'vat', 'gst', 'hst', 'pst', 'qst']);
const TAX_ALLOWED_WORDS = new Set([
  ...TAX_CORE_WORDS,
  'sales', 'use', 'state', 'county', 'city', 'local', 'excise', 'and', 'amount', 'total',
]);

function descriptionTokens(description: string | undefined): string[] {
  const normalized = description ? normalizeLineDescription(description) : '';
  return normalized ? normalized.split(' ') : [];
}

function isTaxChargeLine(description: string | undefined): boolean {
  const tokens = descriptionTokens(description);
  return tokens.some(token => TAX_CORE_WORDS.has(token))
    && tokens.every(token => TAX_ALLOWED_WORDS.has(token) || /^\d+$/.test(token));
}

type ChargeLine = Parameters<typeof lineAmount>[0] & {
  description?: string | null;
  Item_Description?: string | null;
};

type ChargeAmount = string | number | null | undefined;

// parseExtractedAmount drops the sign, so a printed credit (`-$10.00`, `($10.00)`) is negated here.
function isPrintedCredit(printed: string): boolean {
  return /^\s*(?:\$\s*)?[-\u2212(]/.test(printed) || /[-\u2212]\s*$/.test(printed);
}

function chargeAmount(value: ChargeAmount): number | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) / 100 : undefined;
  const amount = parseExtractedAmount(value);
  return amount != null && isPrintedCredit(value) ? -amount : amount;
}

// Reads the sign from the same field lineAmount took the amount from.
function signedChargeLineAmount(line: ChargeLine): number | undefined {
  const amount = lineAmount(line);
  if (amount == null) return undefined;
  const credit = (printed: string) => (isPrintedCredit(printed) ? -Math.abs(amount) : amount);
  if (typeof line.extendedAmount === 'number') return amount;
  if (line.totalPrice) return credit(line.totalPrice);
  if (typeof line.Extended_Amount === 'number') return amount;
  if (typeof line.Extended_Amount === 'string') return credit(line.Extended_Amount);
  const rawUnitCost = line.unitCost ?? line.Unit_Cost;
  return typeof rawUnitCost === 'string' ? credit(rawUnitCost) : amount;
}

export interface ChargeTotals {
  lineTotal: number;
  freight: number;
  tax: number;
  amountDue: number;
}

export interface SubmittedChargeReconciliation<T> {
  lines: T[];
  /** Lines removed because header Freight_Amount already counts them. */
  duplicateFreightLines: T[];
  /** Lines removed because header Tax_Amount already counts them. */
  duplicateTaxLines: T[];
  /** Set when lines + freight + tax still differ from the amount due. */
  unreconciled?: ChargeTotals;
  /** All-freight invoice: freight submitted as invoice lines instead of header Freight_Amount. */
  freightLineTotal?: number;
}

interface CentsLine<T> {
  index: number;
  line: T;
  cents: number;
}

function sumCents<T>(entries: CentsLine<T>[]): number {
  return entries.reduce((total, entry) => total + entry.cents, 0);
}

function linesMatchingCharge<T>(
  entries: CentsLine<T>[],
  chargeCents: number,
  isChargeLine: (entry: CentsLine<T>) => boolean,
  allowSingleLine: boolean
): CentsLine<T>[] | undefined {
  const labeled = entries.filter(isChargeLine);
  if (labeled.length && sumCents(labeled) === chargeCents) return labeled;
  const single = labeled.find(entry => entry.cents === chargeCents);
  if (single) return [single];
  // An all-freight carrier invoice can describe its only row with a pro number and weight the
  // freight matcher does not recognize. Only prepareInvoiceCharges allows this, because it puts
  // the row back as the invoice line and drops the header freight instead.
  if (allowSingleLine && entries.length === 1 && entries[0].cents === chargeCents) return entries;
  return undefined;
}

/**
 * Header Freight_Amount and Tax_Amount are added to the line total in Workday, so a charge that
 * is also an invoice line is counted twice. When lines + freight + tax exceed the amount due by
 * exactly the header freight and/or tax, drop the lines that repeat it. Otherwise leave every
 * amount as extracted and report the totals that do not reconcile.
 */
export function reconcileSubmittedCharges<T extends ChargeLine>(
  lines: T[],
  charges: { amountDue?: ChargeAmount; freight?: ChargeAmount; tax?: ChargeAmount },
  options: { allowSingleLineFreight?: boolean; checkWithoutLines?: boolean } = {}
): SubmittedChargeReconciliation<T> {
  const unchanged: SubmittedChargeReconciliation<T> = { lines, duplicateFreightLines: [], duplicateTaxLines: [] };
  const amountDue = chargeAmount(charges.amountDue);
  if (amountDue == null || (lines.length === 0 && !options.checkWithoutLines)) return unchanged;

  const freight = chargeAmount(charges.freight) ?? 0;
  const tax = chargeAmount(charges.tax) ?? 0;
  // A row printed as "Included" or "N/C" has no parseable amount and adds nothing to the total.
  const entries: CentsLine<T>[] = lines.map((line, index) => ({
    index,
    line,
    cents: toCents(signedChargeLineAmount(line) ?? 0),
  }));
  const freightCents = toCents(freight);
  const taxCents = toCents(tax);
  const excessCents = sumCents(entries) + freightCents + taxCents - toCents(amountDue);
  if (excessCents === 0) return unchanged;

  const isFreightEntry = (entry: CentsLine<T>) => isFreightOrHandlingLine(lineDescription(entry.line));
  const isTaxEntry = (entry: CentsLine<T>) => isTaxChargeLine(lineDescription(entry.line));
  let freightDuplicates: CentsLine<T>[] | undefined;
  let taxDuplicates: CentsLine<T>[] | undefined;
  if (freightCents > 0 && excessCents === freightCents) {
    freightDuplicates = linesMatchingCharge(entries, freightCents, isFreightEntry, Boolean(options.allowSingleLineFreight));
  } else if (taxCents > 0 && excessCents === taxCents) {
    taxDuplicates = linesMatchingCharge(entries, taxCents, isTaxEntry, false);
  } else if (freightCents > 0 && taxCents > 0 && excessCents === freightCents + taxCents) {
    const freightMatch = linesMatchingCharge(entries, freightCents, isFreightEntry, false);
    const remaining = freightMatch ? entries.filter(entry => !freightMatch.includes(entry)) : [];
    const taxMatch = freightMatch ? linesMatchingCharge(remaining, taxCents, isTaxEntry, false) : undefined;
    if (freightMatch && taxMatch) {
      freightDuplicates = freightMatch;
      taxDuplicates = taxMatch;
    }
  }

  if (!freightDuplicates && !taxDuplicates) {
    return {
      ...unchanged,
      unreconciled: { lineTotal: sumCents(entries) / 100, freight, tax, amountDue },
    };
  }

  const removed = new Set([...(freightDuplicates ?? []), ...(taxDuplicates ?? [])].map(entry => entry.index));
  return {
    lines: lines.filter((_, index) => !removed.has(index)),
    duplicateFreightLines: (freightDuplicates ?? []).map(entry => entry.line),
    duplicateTaxLines: (taxDuplicates ?? []).map(entry => entry.line),
  };
}

function formatChargeDollars(amount: number): string {
  const sign = amount < 0 ? '-' : '';
  return `${sign}$${Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const REMOVED_LINE_DESCRIPTION_LIMIT = 120;
const REMOVED_LINES_LISTED = 5;

// Descriptions are supplier-controlled; cap their length and count so the Workday note stays bounded.
function describeRemovedLines(lines: ChargeLine[]): string {
  const listed = lines
    .slice(0, REMOVED_LINES_LISTED)
    .map(line => {
      const description = lineDescription(line) ?? 'Invoice line';
      const shown = description.length > REMOVED_LINE_DESCRIPTION_LIMIT
        ? `${description.slice(0, REMOVED_LINE_DESCRIPTION_LIMIT - 1)}…`
        : description;
      return `"${shown}" (${formatChargeDollars(signedChargeLineAmount(line) ?? 0)})`;
    })
    .join(', ');
  const more = lines.length - REMOVED_LINES_LISTED;
  return more > 0 ? `${listed} and ${more} more` : listed;
}

/** Plain sentences for the Workday note and Slack; empty when nothing was removed or flagged. */
export function chargeReconciliationMessages(reconciliation: SubmittedChargeReconciliation<ChargeLine>): string[] {
  const messages: string[] = [];
  if (reconciliation.freightLineTotal != null) {
    messages.push(`All-freight invoice: freight ${formatChargeDollars(reconciliation.freightLineTotal)} submitted as an invoice line so it carries the line coding; header Freight_Amount is not set.`);
  }
  if (reconciliation.duplicateFreightLines.length) {
    messages.push(`Removed invoice line ${describeRemovedLines(reconciliation.duplicateFreightLines)}: that amount is already on the header Freight_Amount.`);
  }
  if (reconciliation.duplicateTaxLines.length) {
    messages.push(`Removed invoice line ${describeRemovedLines(reconciliation.duplicateTaxLines)}: that amount is already on the header Tax_Amount.`);
  }
  const totals = reconciliation.unreconciled;
  if (totals) {
    const submitted = (toCents(totals.lineTotal) + toCents(totals.freight) + toCents(totals.tax)) / 100;
    messages.push(
      `Lines ${formatChargeDollars(totals.lineTotal)} + freight ${formatChargeDollars(totals.freight)} + tax ${formatChargeDollars(totals.tax)} = ${formatChargeDollars(submitted)}, `
      + `but the amount due is ${formatChargeDollars(totals.amountDue)}. Review lines and header charges.`
    );
  }
  return messages;
}

export function formatChargeReconciliationNotes(reconciliation: SubmittedChargeReconciliation<ChargeLine>): string {
  return formatAmountCheckNotes(chargeReconciliationMessages(reconciliation));
}

// A blank or unparseable extracted freight (`'n/a'`) is missing, so the freight recovered from
// freight rows is used instead.
function documentFreight(extracted: string | undefined, freightAmountFromLines: number | undefined): string | undefined {
  if (extracted?.trim() && chargeAmount(extracted) != null) return extracted;
  return freightAmountFromLines != null ? String(freightAmountFromLines) : undefined;
}

/** Reconciliation of the extracted totals, for runs that annotate the invoice without submitting lines. */
export function extractedChargeReconciliation(
  extractedLines: ExtractedInvoiceLine[],
  charges: { amountDue?: string; freight?: string; tax?: string }
): SubmittedChargeReconciliation<ExtractedInvoiceLine> {
  const { merchandiseLines, freightAmountFromLines } = splitFreightLines(extractedLines);
  const freight = documentFreight(charges.freight, freightAmountFromLines);
  return reconcileSubmittedCharges(merchandiseLines, {
    amountDue: charges.amountDue,
    freight,
    tax: charges.tax,
  }, { checkWithoutLines: Boolean(freight || charges.tax) });
}

/** Only the mismatch: nothing is submitted, so there is no removal to report. */
export function extractedChargeCheck(
  extractedLines: ExtractedInvoiceLine[],
  charges: { amountDue?: string; freight?: string; tax?: string }
): string[] {
  const { unreconciled } = extractedChargeReconciliation(extractedLines, charges);
  return unreconciled
    ? chargeReconciliationMessages({ lines: [], duplicateFreightLines: [], duplicateTaxLines: [], unreconciled })
    : [];
}

/** Counts only, so line descriptions and amounts stay out of logs. */
export function chargeReconciliationLogSummary(reconciliation: SubmittedChargeReconciliation<unknown>) {
  return {
    freightAsLines: reconciliation.freightLineTotal != null,
    removedFreightLines: reconciliation.duplicateFreightLines.length,
    removedTaxLines: reconciliation.duplicateTaxLines.length,
    unreconciled: Boolean(reconciliation.unreconciled),
  };
}

export interface PreparedInvoiceCharges {
  /** Lines to merge and submit, before description composition. */
  lines: ExtractedInvoiceLine[];
  /** Document freight. With freightAsLines, submit omits it from the header unless no line survives merge. */
  freightAmount?: string;
  freightAsLines: boolean;
  /** Removals and freight-as-lines decisions made here; never `unreconciled`. */
  reconciliation: SubmittedChargeReconciliation<ExtractedInvoiceLine>;
}

export const CHARGE_RECONCILIATION_FALLBACK_FIELD = 'chargeReconciliation';

/** Workday note text for amount-check sentences from extraction and from submit. */
export function formatAmountCheckNotes(messages: string[]): string {
  return messages.length ? `\n\nAmount check: ${messages.join(' ')}` : '';
}

// Freight rows (plus duplicates the reconciliation removed), in document order, that make up
// the whole invoice. Falls back to one line for the header freight when the rows do not add up
// to it, or when the document's freight row was only extracted as the header amount.
function allFreightInvoiceLines(
  extractedLines: ExtractedInvoiceLine[],
  freightRows: Set<ExtractedInvoiceLine>,
  charges: { amountDue?: ChargeAmount; freight?: ChargeAmount; tax?: ChargeAmount }
): ExtractedInvoiceLine[] | undefined {
  const freight = chargeAmount(charges.freight);
  const amountDue = chargeAmount(charges.amountDue);
  if (freight == null || freight <= 0 || amountDue == null) return undefined;
  if (toCents(freight) + toCents(chargeAmount(charges.tax) ?? 0) !== toCents(amountDue)) return undefined;

  const rows = extractedLines.filter(line => freightRows.has(line));
  const amounts = rows.map(signedChargeLineAmount);
  if (rows.length && amounts.every(amount => amount != null)
    && amounts.reduce<number>((total, amount) => total + toCents(amount ?? 0), 0) === toCents(freight)) {
    return rows;
  }
  return [{
    description: rows[0]?.description ?? 'Freight',
    quantity: null,
    unitCost: null,
    totalPrice: String(freight),
    hasDiscount: null,
  }];
}

/**
 * Splits freight from merchandise and reconciles header charges for create and enrich.
 * Mixed invoices submit freight on header Freight_Amount. When no merchandise remains and
 * freight + tax is the whole amount due, freight is submitted as invoice lines instead, so it
 * carries the line coding (spend category, cost center) and Workday has a line to post.
 */
export function prepareInvoiceCharges(
  extractedLines: ExtractedInvoiceLine[],
  charges: { amountDue?: string; freight?: string; tax?: string },
  options: { allowFreightAsLines: boolean } = { allowFreightAsLines: true }
): PreparedInvoiceCharges {
  const { merchandiseLines, freightLines, freightAmountFromLines } = splitFreightLines(extractedLines);
  const freightAmount = documentFreight(charges.freight, freightAmountFromLines);
  const reconciliation = reconcileSubmittedCharges(merchandiseLines, {
    amountDue: charges.amountDue,
    freight: freightAmount,
    tax: charges.tax,
  }, { allowSingleLineFreight: options.allowFreightAsLines });

  if (options.allowFreightAsLines && reconciliation.lines.length === 0) {
    const freightRows = new Set([...freightLines, ...reconciliation.duplicateFreightLines]);
    const lines = allFreightInvoiceLines(extractedLines, freightRows, {
      amountDue: charges.amountDue,
      freight: freightAmount,
      tax: charges.tax,
    });
    if (lines) {
      return {
        lines,
        freightAmount,
        freightAsLines: true,
        reconciliation: {
          lines,
          duplicateFreightLines: [],
          duplicateTaxLines: reconciliation.duplicateTaxLines,
          freightLineTotal: chargeAmount(freightAmount),
        },
      };
    }
  }

  // A mismatch is reported once, by buildSubmitInvoiceData, against the lines actually submitted.
  return {
    lines: reconciliation.lines,
    freightAmount,
    freightAsLines: false,
    reconciliation: { ...reconciliation, unreconciled: undefined },
  };
}

function extractWorktagId(worktags: any[], type: string): string | null {
  for (const worktag of worktags) {
    const ids = ([] as any[]).concat(worktag.ID ?? []);
    const match = ids.find((id: any) => id.$attributes?.type === type);
    if (match) return match.$value;
  }
  return null;
}

function uniformSplitWorktagId(splits: PurchaseOrderLineSplit[], type: string): string | null {
  const values = new Set<string>();
  for (const split of splits) {
    const id = extractWorktagId(split.worktagReference, type);
    if (id) values.add(id);
  }
  return values.size === 1 ? [...values][0] : null;
}

function uniformSplitLineOfBusinessId(splits: PurchaseOrderLineSplit[]): string | null {
  const values = splits
    .map(split => extractLineOfBusinessId(split.worktagReference))
    .filter((id): id is string => Boolean(id));
  if (values.length === 0) return null;
  const first = values[0];
  return values.every(id => id === first) ? first : null;
}

function scalarWorktagIdsFromPoLine(
  line: PurchaseOrderLine,
  lineLevelWorktagsReference: any[]
): { costCenterId: string | null; fundId: string | null; lineOfBusinessId: string | null } {
  const splits = line.splitLineData ?? [];
  if (splits.length === 0) {
    const worktags = ([] as any[]).concat(line.worktagsReference ?? []);
    return {
      costCenterId: extractWorktagId(worktags, 'Cost_Center_Reference_ID'),
      fundId: extractWorktagId(worktags, 'Fund_ID'),
      lineOfBusinessId: extractLineOfBusinessId(worktags),
    };
  }

  return {
    costCenterId: uniformSplitWorktagId(splits, 'Cost_Center_Reference_ID')
      ?? extractWorktagId(lineLevelWorktagsReference, 'Cost_Center_Reference_ID'),
    fundId: uniformSplitWorktagId(splits, 'Fund_ID')
      ?? extractWorktagId(lineLevelWorktagsReference, 'Fund_ID'),
    lineOfBusinessId: uniformSplitLineOfBusinessId(splits)
      ?? extractLineOfBusinessId(lineLevelWorktagsReference),
  };
}


function extractSpendCategoryId(spendCategoryReference: any): string | null {
  if (!spendCategoryReference) return null;
  const ids = ([] as any[]).concat(spendCategoryReference.ID ?? []);
  const match = ids.find((id: any) => id.$attributes?.type === 'Spend_Category_ID');
  return match?.$value ?? null;
}

export interface ParsedPoLineWorktags {
  purchaseOrderLineId: string | null;
  lineOfBusinessId: string | null;
  costCenterId: string | null;
  fundId: string | null;
  spendCategoryId: string | null;
  worktagsReference: any[];
  lineLevelWorktagsReference?: any[];
  lineOrder: number;
  description: string | null;
  memo: string | null;
  shipToAddressId: string | null;
  splitLineData: PurchaseOrderLineSplit[];
  startDate?: string | null;
  endDate?: string | null;
  availableForInvoicing?: boolean;
}

function parsePoLineWorktags(poLines: PurchaseOrderLine[] | undefined): ParsedPoLineWorktags[] {
  return (poLines ?? []).map(line => {
    const worktags = ([] as any[]).concat(line.worktagsReference ?? []);
    const lineLevelWorktagsReference = ([] as any[]).concat(
      line.lineLevelWorktagsReference ?? line.worktagsReference ?? []
    );
    const scalarIds = scalarWorktagIdsFromPoLine(line, lineLevelWorktagsReference);
    return {
      lineOrder: line.lineOrder,
      purchaseOrderLineId: line.purchaseOrderLineId ?? null,
      description: line.description ?? null,
      memo: line.memo ?? null,
      costCenterId: scalarIds.costCenterId,
      fundId: scalarIds.fundId,
      spendCategoryId: extractSpendCategoryId(line.spendCategoryReference),
      lineOfBusinessId: scalarIds.lineOfBusinessId,
      worktagsReference: worktags,
      lineLevelWorktagsReference,
      shipToAddressId: line.shipToAddressId ?? null,
      splitLineData: line.splitLineData ?? [],
      startDate: line.startDate ?? null,
      endDate: line.endDate ?? null,
      availableForInvoicing: line.availableForInvoicing !== false,
    };
  });
}

function passthroughForPoLine(poLine: ParsedPoLineWorktags): any[] {
  return poLine.lineLevelWorktagsReference?.length
    ? poLine.lineLevelWorktagsReference
    : poLine.worktagsReference;
}

function sharedPassthroughWorktags(poLines: ParsedPoLineWorktags[]): any[] {
  if (poLines.length === 0) return [];
  const perLineIdentities = poLines.map(
    line =>
      new Set(
        passthroughForPoLine(line)
          .map(tag => worktagIdentity(tag))
          .filter((identity): identity is string => identity != null)
      )
  );
  return passthroughForPoLine(poLines[0]).filter(tag => {
    const identity = worktagIdentity(tag);
    return identity != null && perLineIdentities.every(set => set.has(identity));
  });
}

export function overlayPoWorktagsFromPurchaseOrder(
  lines: FinalInvoiceLine[],
  poLines: ParsedPoLineWorktags[]
): FinalInvoiceLine[] {
  if (poLines.length === 0) return lines;

  const byPurchaseOrderLineId = new Map(
    poLines
      .filter(line => line.purchaseOrderLineId)
      .map(line => [line.purchaseOrderLineId as string, line])
  );
  const fallbackPassthrough = sharedPassthroughWorktags(poLines);

  return lines.map(line => {
    const poLine = line.purchaseOrderLineId
      ? byPurchaseOrderLineId.get(line.purchaseOrderLineId)
      : undefined;
    if (poLine) {
      return {
        ...line,
        poPassthroughWorktagsReference: passthroughForPoLine(poLine),
        ...(poLine.splitLineData.length > 0 && { supplierInvoiceSplitLineData: poLine.splitLineData }),
      };
    }
    if (fallbackPassthrough.length === 0 || line.poPassthroughWorktagsReference?.length) return line;
    return { ...line, poPassthroughWorktagsReference: fallbackPassthrough };
  });
}

export function overlaySharedPoWorktagsOnUnmatchedLines(
  lines: FinalInvoiceLine[],
  poLines: PurchaseOrderLine[] | undefined
): FinalInvoiceLine[] {
  const unmatched = lines.map(line => ({
    ...line,
    purchaseOrderLineId: null,
    poPassthroughWorktagsReference: undefined,
    supplierInvoiceSplitLineData: undefined,
  }));
  return overlayPoWorktagsFromPurchaseOrder(unmatched, parsePoLineWorktags(poLines));
}

function applyFallbacks(
  mergedLines: MergeInvoiceLinesResult['lines'],
  fallbackIds: InvoiceLineFallbackIds
): { lines: FinalInvoiceLine[]; appliedFallbacks: LineFallbacks } {
  let fundApplied = false;
  let costCenterApplied = false;
  let spendCategoryApplied = false;

  const lines: FinalInvoiceLine[] = mergedLines.map(line => {
    const fundId = line.fundId ?? fallbackIds.fundId ?? null;
    const costCenterId = line.costCenterId ?? fallbackIds.costCenterId ?? null;
    const spendCategoryId = line.spendCategoryId ?? fallbackIds.spendCategoryId ?? null;

    if (!line.fundId && fallbackIds.fundId) fundApplied = true;
    if (!line.costCenterId && fallbackIds.costCenterId) costCenterApplied = true;
    if (!line.spendCategoryId && fallbackIds.spendCategoryId) spendCategoryApplied = true;

    return {
      lineOrder: line.lineOrder,
      description: line.description,
      memo: line.memo ?? null,
      quantity: line.quantity,
      unitCost: line.unitCost,
      extendedAmount: line.extendedAmount,
      hasDiscount: line.hasDiscount ?? null,
      costCenterId,
      fundId,
      spendCategoryId,
      lineOfBusinessId: line.lineOfBusinessId ?? null,
      eventId: line.eventId ?? null,
      eventWid: null,
      shipToAddressId: line.shipToAddressId ?? null,
      purchaseOrderLineId: line.purchaseOrderLineId ?? null,
    };
  });

  return { lines, appliedFallbacks: { fund: fundApplied, costCenter: costCenterApplied, spendCategory: spendCategoryApplied, lineOfBusiness: false } };
}

function buildFallbackLines(
  extractedLines: ExtractedInvoiceLine[],
  fallbackIds: InvoiceLineFallbackIds
): { lines: FinalInvoiceLine[]; appliedFallbacks: LineFallbacks } {
  const lines: FinalInvoiceLine[] = extractedLines.map((line, idx) => ({
    lineOrder: idx + 1,
    description: line.description,
    quantity: line.quantity,
    unitCost: line.unitCost ? (parseExtractedAmount(line.unitCost) ?? null) : null,
    extendedAmount: line.totalPrice ? (parseExtractedAmount(line.totalPrice) ?? null) : null,
    hasDiscount: line.hasDiscount ?? null,
    costCenterId: fallbackIds.costCenterId ?? null,
    fundId: fallbackIds.fundId ?? null,
    spendCategoryId: fallbackIds.spendCategoryId ?? null,
    lineOfBusinessId: null,
    eventId: null,
    shipToAddressId: null,
  }));
  return {
    lines,
    appliedFallbacks: {
      fund: !!fallbackIds.fundId,
      costCenter: !!fallbackIds.costCenterId,
      spendCategory: !!fallbackIds.spendCategoryId,
      lineOfBusiness: false,
    },
  };
}

function applyEmailWorktags(lines: FinalInvoiceLine[], emailWorktags?: EmailWorktags): FinalInvoiceLine[] {
  if (!emailWorktags) return lines;
  return lines.map(line => ({
    ...line,
    ...(emailWorktags.costCenterId != null && { costCenterId: emailWorktags.costCenterId }),
    ...(emailWorktags.eventWid != null && { eventWid: emailWorktags.eventWid }),
    ...(emailWorktags.lobReferenceId != null && { lineOfBusinessId: emailWorktags.lobReferenceId }),
    ...(emailWorktags.fundReferenceId != null && { fundId: emailWorktags.fundReferenceId }),
    ...(emailWorktags.spendCategoryReferenceId != null && { spendCategoryId: emailWorktags.spendCategoryReferenceId }),
  }));
}

export function constrainEmailLobToRelatedWorktags(
  lines: FinalInvoiceLine[],
  relatedByCostCenterId: Map<string, RelatedLob>,
  emailWorktags?: EmailWorktags,
  fallbackCostCenterId?: string | null
): FinalInvoiceLine[] {
  if (!emailWorktags?.costCenterId || !emailWorktags.lobReferenceId) return lines;

  return lines.map(line => {
    const costCenterId = line.costCenterId;
    if (!costCenterId || costCenterId === fallbackCostCenterId) return line;
    const related = relatedByCostCenterId.get(costCenterId);
    if (!relatedLobHasUsableValue(related)) return line;
    if (relatedLobAllowsId(related, line.lineOfBusinessId)) return line;
    const resolved = resolveRelatedLobId(related, costCenterId, fallbackCostCenterId);
    return resolved && resolved !== line.lineOfBusinessId
      ? { ...line, lineOfBusinessId: resolved }
      : line;
  });
}

export function overlayPoLineOfBusiness(
  lines: FinalInvoiceLine[],
  poLines: ParsedPoLineWorktags[]
): FinalInvoiceLine[] {
  if (poLines.length === 0) return lines;

  const byPurchaseOrderLineId = new Map(
    poLines
      .filter(line => line.purchaseOrderLineId && line.lineOfBusinessId)
      .map(line => [line.purchaseOrderLineId as string, line.lineOfBusinessId as string])
  );
  const uniquePoLobs = [...new Set(poLines.map(line => line.lineOfBusinessId).filter((id): id is string => !!id))];

  return lines.map(line => {
    if (line.lineOfBusinessId) return line;
    if (line.purchaseOrderLineId && byPurchaseOrderLineId.has(line.purchaseOrderLineId)) {
      return { ...line, lineOfBusinessId: byPurchaseOrderLineId.get(line.purchaseOrderLineId) };
    }
    if (uniquePoLobs.length === 1) {
      return { ...line, lineOfBusinessId: uniquePoLobs[0] };
    }
    return line;
  });
}

export function applyRelatedLobWorktags(
  lines: FinalInvoiceLine[],
  relatedByCostCenterId: Map<string, RelatedLob>,
  fallbackCostCenterId?: string | null,
  options?: { replaceIds?: Iterable<string>; anyAllowed?: boolean; replaceDisallowed?: boolean }
): FinalInvoiceLine[] {
  const replaceIds = new Set(options?.replaceIds ?? []);
  const replaceDisallowed = Boolean(options?.replaceDisallowed);
  return lines.map(line => {
    const current = line.lineOfBusinessId;
    const related = relatedByCostCenterId.get(line.costCenterId ?? '');
    const relatedDefault = related?.defaultReferenceId;
    if (current && relatedDefault && relatedLobIdsMatch(relatedDefault, current)) {
      return relatedDefault !== current
        ? { ...line, lineOfBusinessId: relatedDefault }
        : line;
    }
    const shouldReplace = !current
      || replaceIds.has(current)
      || replaceDisallowed;
    if (!shouldReplace) return line;
    const exclude = new Set(replaceIds);
    if (replaceDisallowed && current && !relatedLobAllowsId(related, current)) {
      exclude.add(current);
    }
    const resolved = resolveRelatedLobId(
      related,
      line.costCenterId,
      fallbackCostCenterId,
      exclude,
      { anyAllowed: Boolean(options?.anyAllowed) }
    );
    return resolved && resolved !== current ? { ...line, lineOfBusinessId: resolved } : line;
  });
}

export interface EmailWorktags {
  costCenterId?: string | null;
  eventWid?: string | null;
  lobReferenceId?: string | null;
  fundReferenceId?: string | null;
  spendCategoryReferenceId?: string | null;
}

export function applyDefaultCompanyLineWorktags(
  lines: FinalInvoiceLine[],
  fallbackIds: InvoiceLineFallbackIds
): FinalInvoiceLine[] {
  return lines.map(line => ({
    ...line,
    costCenterId: fallbackIds.costCenterId ?? null,
    fundId: fallbackIds.fundId ?? null,
    spendCategoryId: fallbackIds.spendCategoryId ?? null,
    lineOfBusinessId: fallbackIds.lineOfBusinessId ?? null,
    purchaseOrderLineId: null,
    omitPurchaseOrderLineReference: undefined,
    eventId: null,
    eventWid: null,
    shipToAddressId: null,
  }));
}

export function applyFallbackLineOfBusiness(
  lines: FinalInvoiceLine[],
  fallbackLineOfBusinessId?: string | null
): { lines: FinalInvoiceLine[]; applied: boolean } {
  if (!fallbackLineOfBusinessId) return { lines, applied: false };
  let applied = false;
  const next = lines.map(line => {
    if (line.lineOfBusinessId) return line;
    applied = true;
    return { ...line, lineOfBusinessId: fallbackLineOfBusinessId };
  });
  return { lines: next, applied };
}

export function resolveInvoiceLineQuantityDisplayed(
  flag: boolean | undefined | null,
  extractedLines: ExtractedInvoiceLine[]
): boolean {
  if (extractedLines.some(l => l.quantity != null)) {
    return true;
  }
  if (flag === true) return true;
  if (flag === false) return false;
  if (
    extractedLines.length > 0
    && extractedLines.every(l => l.quantity == null)
    && extractedLines.some(l => l.totalPrice || l.unitCost)
  ) {
    return false;
  }
  return true;
}

function finalLineExtendedAmount(line: FinalInvoiceLine): number | null {
  if (line.extendedAmount != null) return line.extendedAmount;
  if (line.unitCost != null) return line.unitCost;
  return null;
}

function toCents(value: number): number {
  return Math.round(value * 100);
}

function asAmountOnlyLine(line: FinalInvoiceLine, extendedAmount: number | null): FinalInvoiceLine {
  return {
    ...line,
    quantity: 0,
    unitCost: 0,
    extendedAmount,
  };
}

export function applyMissingQuantityColumnLines(
  lines: FinalInvoiceLine[],
  invoiceLineQuantityDisplayed: boolean
): FinalInvoiceLine[] {
  if (invoiceLineQuantityDisplayed) return lines;
  return lines.map(line => {
    if (isDiscountLine(line)) return line;
    return asAmountOnlyLine(line, finalLineExtendedAmount(line));
  });
}

// Workday only counts PO quantity as invoiced when the linked line keeps its quantity.
// A PO-linked discount line (printed price before discount) submits the net unit price
// when that price reproduces the printed line total. The WSDL allows six decimal places
// on Unit_Cost; we round to four, which covers ordinary percentage discounts that do not
// divide evenly to cents (e.g. 7 × $29.88 at 10% off = $188.24 → $26.8914).
function netUnitCostForDiscountedPurchaseOrderLine(line: FinalInvoiceLine, extendedAmount: number): number | null {
  const quantity = line.quantity;
  if (line.hasDiscount !== true || !line.purchaseOrderLineId || quantity == null || quantity <= 0) return null;
  const netUnitCost = Math.round((extendedAmount / quantity) * 10000) / 10000;
  if (line.unitCost != null && netUnitCost >= line.unitCost) return null;
  return toCents(quantity * netUnitCost) === toCents(extendedAmount) ? netUnitCost : null;
}

export function alignSupplierInvoiceLineAmounts(lines: FinalInvoiceLine[]): FinalInvoiceLine[] {
  return lines.map(line => {
    if (isDiscountLine(line)) return line;
    if (line.quantity === 0 && line.unitCost === 0) return line;

    const extendedAmount = line.extendedAmount ?? null;
    const unitCost = line.unitCost ?? null;
    const soapQuantity = line.quantity ?? 1;

    if (extendedAmount != null && unitCost == null) {
      return asAmountOnlyLine(line, extendedAmount);
    }

    if (extendedAmount != null && unitCost != null && toCents(soapQuantity * unitCost) !== toCents(extendedAmount)) {
      const netUnitCost = netUnitCostForDiscountedPurchaseOrderLine(line, extendedAmount);
      if (netUnitCost != null) return { ...line, unitCost: netUnitCost };
      return asAmountOnlyLine(line, extendedAmount);
    }

    return line;
  });
}

export function normalizeSupplierInvoiceLineAmounts(
  lines: FinalInvoiceLine[],
  invoiceLineQuantityDisplayed: boolean
): FinalInvoiceLine[] {
  return alignSupplierInvoiceLineAmounts(
    applyMissingQuantityColumnLines(lines, invoiceLineQuantityDisplayed)
  );
}

function hasNonZeroQuantityOrUnitCost(line: FinalInvoiceLine): boolean {
  return (line.quantity != null && line.quantity !== 0)
    || (line.unitCost != null && line.unitCost !== 0);
}

export function lineHasQuantityOrUnitAndExtended(line: FinalInvoiceLine): boolean {
  return hasNonZeroQuantityOrUnitCost(line) && line.extendedAmount != null;
}

export function applyAmountOnlyLineRetry(lines: FinalInvoiceLine[]): FinalInvoiceLine[] {
  return lines.map(line => {
    if (isDiscountLine(line)) return line;
    if (!lineHasQuantityOrUnitAndExtended(line)) return line;
    return {
      ...line,
      quantity: 0,
      unitCost: 0,
    };
  });
}

export interface InvoiceDateContext {
  invoiceDate?: string | null;
  servicePeriod?: string | null;
}

function isValidIsoDate(iso: string): boolean {
  const parsed = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso;
}

function toIsoDate(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const iso = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return isValidIsoDate(iso[1]) ? iso[1] : undefined;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().split('T')[0];
}

// Month names, quarters, and numeric dates or month-years. Text that matches is a period the
// merge model must honor, so the invoice-date guard leaves it alone. Over-matching only keeps
// the model pick; under-matching would let the guard override a stated period.
const SERVICE_PERIOD_PATTERN = new RegExp([
  String.raw`\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?=\d|\b)`,
  String.raw`\bq[1-4]\b|\bh[12]\b|\bquarter\b|\b(?:first|second|third|fourth|1st|2nd|3rd|4th)\s+qtr\b`,
  String.raw`\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b`,
  String.raw`\b\d{1,2}[/-]\d{4}\b|\b\d{4}[/.-]\d{1,2}(?:[/.-]\d{1,2})?\b`,
  String.raw`\b\d{1,2}\.\d{1,2}\.\d{2,4}\b`,
].join('|'), 'i');

export function statesServicePeriod(text?: string | null): boolean {
  return !!text && SERVICE_PERIOD_PATTERN.test(text);
}

// A missing Start_Date or End_Date leaves that side of the window open. An unparseable or
// inverted window is unknown, so it neither triggers nor receives a relink.
function poLineCoversDate(line: Pick<ParsedPoLineWorktags, 'startDate' | 'endDate'>, isoDate: string): boolean | undefined {
  const startDate = toIsoDate(line.startDate);
  const endDate = toIsoDate(line.endDate);
  if ((line.startDate && !startDate) || (line.endDate && !endDate)) return undefined;
  if (!startDate && !endDate) return undefined;
  if (startDate && endDate && startDate > endDate) return undefined;
  return (!startDate || startDate <= isoDate) && (!endDate || isoDate <= endDate);
}

function worktagIdentityKey(worktags: any[]): string {
  const identities = worktags
    .map(worktagIdentity)
    .filter((identity): identity is string => !!identity);
  return [...new Set(identities)].sort().join('|');
}

function poLineCodingKey(line: ParsedPoLineWorktags): string {
  const passthrough = worktagIdentityKey(passthroughForPoLine(line));
  if (!passthrough) return '';
  const splits = line.splitLineData.map(split => worktagIdentityKey(split.worktagReference ?? [])).sort();
  return JSON.stringify([
    line.costCenterId,
    line.fundId,
    line.spendCategoryId,
    line.lineOfBusinessId,
    passthrough,
    splits,
  ]);
}

// A relink changes only the PO line reference, so it is allowed only between lines whose
// scalar IDs, passthrough worktags, and split worktags all match; every PO-derived field the
// merge copied from the original line is then also true of the target. Lines with no
// worktags never qualify.
function poLinesShareCoding(a: ParsedPoLineWorktags, b: ParsedPoLineWorktags): boolean {
  const key = poLineCodingKey(a);
  return key !== '' && key === poLineCodingKey(b);
}

// Stated service periods are left to the merge model. This only corrects a pick whose
// Start-End window excludes the invoice date when exactly one unclaimed PO line with the
// same coding covers it, so multi-month invoices that already split across lines are untouched.
export function alignPoLinesToInvoiceDate(
  lines: FinalInvoiceLine[],
  poLines: ParsedPoLineWorktags[],
  invoiceDate?: string | null
): FinalInvoiceLine[] {
  const isoDate = toIsoDate(invoiceDate);
  if (!isoDate || poLines.length < 2) return lines;
  const poLinesById = new Map(
    poLines
      .filter((line): line is ParsedPoLineWorktags & { purchaseOrderLineId: string } => !!line.purchaseOrderLineId)
      .map(line => [line.purchaseOrderLineId, line])
  );
  const claimed = new Set(lines.map(line => line.purchaseOrderLineId).filter((id): id is string => !!id));
  return lines.map(line => {
    const picked = line.purchaseOrderLineId ? poLinesById.get(line.purchaseOrderLineId) : undefined;
    if (!picked || statesServicePeriod(line.description) || poLineCoversDate(picked, isoDate) !== false) return line;
    const covering = [...poLinesById.values()].filter(candidate =>
      !claimed.has(candidate.purchaseOrderLineId)
      && poLineCoversDate(candidate, isoDate) === true
      && poLinesShareCoding(candidate, picked)
    );
    if (covering.length !== 1) return line;
    const target = covering[0];
    claimed.add(target.purchaseOrderLineId);
    debug(`Invoice date ${isoDate} is outside PO line ${picked.purchaseOrderLineId} (${picked.startDate} to ${picked.endDate}); linking line ${line.lineOrder} to ${target.purchaseOrderLineId} (${target.startDate} to ${target.endDate}) instead`);
    return {
      ...line,
      purchaseOrderLineId: target.purchaseOrderLineId,
      shipToAddressId: target.shipToAddressId,
    };
  });
}

export function markConsumedPoLineReferences(
  lines: FinalInvoiceLine[],
  poLines: ParsedPoLineWorktags[]
): FinalInvoiceLine[] {
  const consumedIds = new Set(
    poLines
      .filter(line => line.availableForInvoicing === false && line.purchaseOrderLineId)
      .map(line => line.purchaseOrderLineId as string)
  );
  if (consumedIds.size === 0) return lines;
  return lines.map(line => {
    if (!line.purchaseOrderLineId || !consumedIds.has(line.purchaseOrderLineId)) return line;
    debug(`Invoice line ${line.lineOrder} matched consumed PO line ${line.purchaseOrderLineId}; coding from it without Purchase_Order_Line_Reference`);
    return { ...line, omitPurchaseOrderLineReference: true };
  });
}

export async function buildFinalInvoiceLines(
  extractedLines: ExtractedInvoiceLine[],
  poLines: PurchaseOrderLine[] | undefined,
  emailBody: string | undefined,
  fallbackIds: InvoiceLineFallbackIds,
  emailWorktags?: EmailWorktags,
  relatedLobLookup?: RelatedLobLookup,
  invoiceLineQuantityDisplayed?: boolean,
  invoiceContext?: InvoiceDateContext
): Promise<{ lines: FinalInvoiceLine[]; appliedFallbacks: LineFallbacks; relatedLobByCostCenter: Map<string, RelatedLob> }> {
  const parsedPoLines = parsePoLineWorktags(poLines);
  // Callers omit invoiceContext for Closed or Pending Close POs, which keep the legacy merge.
  const poLineSelectionEnabled = isPoLineSelectionEnabled() && invoiceContext !== undefined;
  const invoiceServicePeriod = invoiceContext?.servicePeriod?.trim() || null;
  const mergeInput = {
    invoiceLineQuantityDisplayed: invoiceLineQuantityDisplayed ?? true,
    ...(poLineSelectionEnabled ? {
      invoiceDate: invoiceContext?.invoiceDate?.trim() || null,
      invoiceServicePeriod,
    } : {}),
    extractedInvoiceLines: extractedLines,
    purchaseOrderLines: parsedPoLines.map(line => ({
      lineOrder: line.lineOrder,
      purchaseOrderLineId: line.purchaseOrderLineId,
      description: line.description,
      memo: line.memo,
      costCenterId: line.costCenterId,
      fundId: line.fundId,
      spendCategoryId: line.spendCategoryId,
      lineOfBusinessId: line.lineOfBusinessId,
      worktagsReference: line.worktagsReference,
      shipToAddressId: line.shipToAddressId,
      splitLineData: line.splitLineData ?? [],
      ...(poLineSelectionEnabled ? {
        startDate: line.startDate,
        endDate: line.endDate,
        availableForInvoicing: line.availableForInvoicing,
      } : {}),
    })),
    emailBody: emailBody ?? null,
  };

  let mergeResult: MergeInvoiceLinesResult;
  try {
    mergeResult = await getAiResponse({
      prompt: mergeInvoiceLinesPromptFor(poLineSelectionEnabled),
      schema: MergeInvoiceLinesSchema,
      messages: [{ role: 'user', content: JSON.stringify(mergeInput, null, 2) }],
      tools: {},
    }) as MergeInvoiceLinesResult;
  } catch (error) {
    debug('Failed to merge invoice lines via AI, falling back to extracted lines with fallback worktags:', error);
    const fallback = buildFallbackLines(extractedLines, fallbackIds);
    return finalizeInvoiceLines(fallback.lines, fallback.appliedFallbacks, parsedPoLines, emailWorktags, relatedLobLookup, fallbackIds);
  }

  if (!mergeResult?.lines?.length) {
    debug('AI merge returned no lines, falling back to extracted lines with fallback worktags');
    const fallback = buildFallbackLines(extractedLines, fallbackIds);
    return finalizeInvoiceLines(fallback.lines, fallback.appliedFallbacks, parsedPoLines, emailWorktags, relatedLobLookup, fallbackIds);
  }

  const { lines, appliedFallbacks } = applyFallbacks(mergeResult.lines, fallbackIds);
  const pinnedLines = pinExtractedLineDescriptions(lines, extractedLines);
  // invoiceServicePeriod covers every line that states no period of its own, so when it
  // names a period no line is left for the invoice-date fallback.
  const selectedLines = !poLineSelectionEnabled
    ? pinnedLines
    : markConsumedPoLineReferences(
      statesServicePeriod(invoiceServicePeriod)
        ? pinnedLines
        : alignPoLinesToInvoiceDate(pinnedLines, parsedPoLines, invoiceContext?.invoiceDate),
      parsedPoLines
    );
  return finalizeInvoiceLines(
    selectedLines,
    appliedFallbacks,
    parsedPoLines,
    emailWorktags,
    relatedLobLookup,
    fallbackIds
  );
}

async function finalizeInvoiceLines(
  lines: FinalInvoiceLine[],
  appliedFallbacks: LineFallbacks,
  parsedPoLines: ParsedPoLineWorktags[],
  emailWorktags: EmailWorktags | undefined,
  relatedLobLookup: RelatedLobLookup | undefined,
  fallbackIds: InvoiceLineFallbackIds
): Promise<{ lines: FinalInvoiceLine[]; appliedFallbacks: LineFallbacks; relatedLobByCostCenter: Map<string, RelatedLob> }> {
  const withPoLob = overlayPoLineOfBusiness(lines, parsedPoLines);
  const withPoWorktags = overlayPoWorktagsFromPurchaseOrder(withPoLob, parsedPoLines);
  const withEmail = applyEmailWorktags(withPoWorktags, emailWorktags);
  const { lines: withRelated, relatedByCostCenterId } = await fillRelatedLobs(withEmail, relatedLobLookup);
  const withConstrainedEmailLob = constrainEmailLobToRelatedWorktags(
    withRelated,
    relatedByCostCenterId,
    emailWorktags,
    process.env.FALLBACK_COST_CENTER_ID
  );
  const fallbackLob = applyFallbackLineOfBusiness(withConstrainedEmailLob, fallbackIds.lineOfBusinessId);
  return {
    lines: fallbackLob.lines,
    appliedFallbacks: {
      ...appliedFallbacks,
      lineOfBusiness: appliedFallbacks.lineOfBusiness || fallbackLob.applied,
    },
    relatedLobByCostCenter: relatedByCostCenterId,
  };
}

async function fillRelatedLobs(
  lines: FinalInvoiceLine[],
  relatedLobLookup?: RelatedLobLookup
): Promise<{ lines: FinalInvoiceLine[]; relatedByCostCenterId: Map<string, RelatedLob> }> {
  const empty = new Map<string, RelatedLob>();
  if (!relatedLobLookup) return { lines, relatedByCostCenterId: empty };

  const fallbackCostCenterId = process.env.FALLBACK_COST_CENTER_ID;
  const costCenterIds = [...new Set(
    lines
      .filter(line => line.costCenterId && line.costCenterId !== fallbackCostCenterId)
      .map(line => line.costCenterId)
      .filter((id): id is string => !!id)
  )];
  if (costCenterIds.length === 0) return { lines, relatedByCostCenterId: empty };

  try {
    const relatedByCostCenterId = await relatedLobLookup(costCenterIds);
    return {
      lines: applyRelatedLobWorktags(lines, relatedByCostCenterId, fallbackCostCenterId),
      relatedByCostCenterId,
    };
  } catch (error) {
    debug('Failed to look up related Line of Business worktags for cost centers:', error);
    return { lines, relatedByCostCenterId: empty };
  }
}
