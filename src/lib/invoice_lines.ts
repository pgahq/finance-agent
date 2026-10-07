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
  tableNumber?: number | null;
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
// A negative line is a credit whatever hasDiscount says: it must not invoice PO line quantity.
export function isDiscountLine(line: Pick<FinalInvoiceLine, 'hasDiscount' | 'extendedAmount' | 'unitCost'>): boolean {
  const amount = line.extendedAmount ?? line.unitCost;
  if (amount != null && amount < 0) return true;
  if (line.hasDiscount !== true) return false;
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

// Decimal limits on Supplier_Invoice_Line_Replacement_Data in the Resource_Management WSDL.
const QUANTITY_DECIMALS = 2;
const UNIT_COST_DECIMALS = 6;
const EXTENDED_AMOUNT_DECIMALS = 3;
const AMOUNT_DECIMALS = 2;

// Shifting the exponent in the decimal string rounds 1.005 to 1.01, where Math.round(1.005 * 100)
// gives 100. Halves round away from zero so credits and charges round alike.
function roundToDecimals(value: number, decimals: number): number {
  const magnitude = Math.abs(value);
  const shifted = String(magnitude).includes('e')
    ? magnitude * 10 ** decimals
    : Number(`${magnitude}e${decimals}`);
  const rounded = Math.round(shifted) / 10 ** decimals;
  return value < 0 && rounded !== 0 ? -rounded : rounded;
}

function parseExtractedNumber(raw: string, decimals: number, signed = false): number | undefined {
  const parsed = parseFloat(raw.replace(/[^0-9.]/g, ''));
  if (isNaN(parsed)) return undefined;
  const negative = signed && (/^[^\d]*[-\u2212]/.test(raw) || /^\s*\(.*\)\s*$/.test(raw));
  return roundToDecimals(negative ? -parsed : parsed, decimals);
}

// Header totals are unsigned: Control_Amount_Total, freight, and tax parse through here.
export function parseExtractedAmount(raw: string): number | undefined {
  return parseExtractedNumber(raw, AMOUNT_DECIMALS);
}

// Line amounts keep a printed credit ("-$250.00" or "($250.00)") negative, so a discount row is not
// submitted as a charge, and keep the three decimals Extended_Amount allows.
export function parseExtractedLineAmount(raw: string): number | undefined {
  return parseExtractedNumber(raw, EXTENDED_AMOUNT_DECIMALS, true);
}

// A unit cost keeps sub-cent precision (e.g. $224.9488753/h); rounding it to cents breaks quantity * unit cost.
export function parseExtractedUnitCost(raw: string): number | undefined {
  return parseExtractedNumber(raw, UNIT_COST_DECIMALS, true);
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

function isAllowedFreightToken(token: string): boolean {
  return FREIGHT_ALLOWED_WORDS.has(token) || /^\d+$/.test(token);
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
  const hasFreightAnchor = tokens.some(token => FREIGHT_CORE_WORDS.has(token) || FREIGHT_CARRIER_WORDS.has(token));
  return hasFreightAnchor && tokens.every(isAllowedFreightToken);
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
    const amount = lineAmount(line);
    if (amount != null) {
      freightAmountFromLines = Math.round(((freightAmountFromLines ?? 0) + amount) * 100) / 100;
    }
  }
  return { merchandiseLines, freightLines, freightAmountFromLines };
}

const TAX_CORE_WORDS = new Set(['tax', 'taxes', 'vat', 'vats', 'gst', 'hst']);
const TAX_COMPOUND_ANCHORS = new Set([
  'sales tax', 'sales taxes', 'use tax', 'use taxes', 'state tax', 'state taxes',
  'local tax', 'local taxes', 'county tax', 'county taxes', 'city tax', 'city taxes',
  'total tax', 'total taxes', 'provincial tax', 'provincial taxes', 'municipal tax',
  'municipal taxes', 'tax on sales', 'taxes on sales', 'sales and use tax', 'sales and use taxes',
]);
const TAX_METADATA_WORDS = new Set([
  'rate', 'id', 'number', 'exempt', 'registration', 'code', 'inclusion',
  'basis', 'subtotal', 'table', 'schedule', 'jurisdiction', 'percentage', 'percent',
  'taxable', 'taxability', 'withholding', 'recoverable', 'deductible', 'reclaimable',
  'receivable', 'balance',
]);
const TAX_QUALIFIERS = new Set([
  'sales', 'use', 'state', 'local', 'county', 'city', 'total', 'vat', 'gst', 'hst',
  'provincial', 'municipal', 'amount', 'due', 'charged', 'charge', 'paid', 'collectible',
  'line', 'item', 'included', 'inclusive', 'incl', 'payable', 'on', 'and', 'for', 'of',
  'estimated', 'estimate', 'est', 'approx', 'approximate',
  'new', 'york', 'california', 'texas', 'florida', 'illinois', 'pennsylvania', 'ohio',
  'georgia', 'north', 'carolina', 'michigan', 'jersey', 'virginia', 'washington', 'arizona',
  'massachusetts', 'tennessee', 'indiana', 'missouri', 'maryland', 'wisconsin', 'colorado',
  'minnesota', 'south', 'alabama', 'louisiana', 'kentucky', 'oregon', 'oklahoma',
  'connecticut', 'utah', 'iowa', 'nevada', 'arkansas', 'mississippi', 'kansas', 'mexico',
  'nebraska', 'west', 'idaho', 'hawaii', 'hampshire', 'maine', 'montana', 'rhode',
  'island', 'delaware', 'south', 'dakota', 'north', 'dakota', 'alaska', 'vermont', 'wyoming',
  'ca', 'ny', 'tx', 'fl', 'il', 'pa', 'oh', 'ga', 'nc', 'mi', 'nj', 'va', 'wa', 'az',
  'ma', 'tn', 'in', 'mo', 'md', 'wi', 'co', 'mn', 'sc', 'al', 'la', 'ky', 'or', 'ok',
  'ct', 'ut', 'ia', 'nv', 'ar', 'ms', 'ks', 'nm', 'ne', 'wv', 'id', 'hi', 'nh', 'me',
  'mt', 'ri', 'de', 'sd', 'nd', 'ak', 'vt', 'wy',
]);

function normalizeLabel(label: string | null | undefined): string | undefined {
  if (!label) return undefined;
  const normalized = label
    .toLowerCase()
    .replace(/[/_,-]+/g, ' ')
    .replace(/\b(\d+(?:\.\d+)?)\s*%\b/g, '$1%')
    .replace(/[^\w\s%]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || undefined;
}

const FREIGHT_LABEL_QUALIFIERS = new Set(['amount', 'total', 'due']);

function labelMatchesFreight(label: string | null | undefined): boolean {
  const normalized = normalizeLabel(label);
  if (!normalized) return false;
  return isFreightOrHandlingLine(normalized.split(' ').filter(token => !FREIGHT_LABEL_QUALIFIERS.has(token)).join(' '));
}

function labelMatchesTax(label: string | null | undefined): boolean {
  const normalized = normalizeLabel(label);
  if (!normalized) return false;
  if (TAX_METADATA_WORDS.has(normalized)) return false;
  if (TAX_COMPOUND_ANCHORS.has(normalized)) return true;
  if (TAX_CORE_WORDS.has(normalized)) return true;
  const tokens = normalized.split(' ').filter(Boolean);
  if (tokens.some(token => TAX_METADATA_WORDS.has(token))) return false;
  const hasAnchor = tokens.some((token, i) => {
    if (TAX_CORE_WORDS.has(token)) return true;
    const compound = [token, tokens[i + 1]].filter(Boolean).join(' ');
    return TAX_COMPOUND_ANCHORS.has(compound);
  });
  if (!hasAnchor) return false;
  return tokens.every(token => (
    TAX_CORE_WORDS.has(token)
    || TAX_QUALIFIERS.has(token)
    || /^\d+(\.\d+)?%$/.test(token)
    || /^\d+(\.\d+)?$/.test(token)
  ));
}

const SUPPORTED_CURRENCY_PREFIXES = /^(?:\$|€|£|¥|USD|EUR|GBP|JPY|CAD|AUD|CHF|CNY|INR)?\s*/i;

function parseCanonicalChargeAmount(value: string | number | null | undefined): number | undefined {
  if (value == null) return undefined;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? roundToDecimals(value, AMOUNT_DECIMALS) : undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/[\u2212-]/.test(trimmed)) return undefined;
  if (/\(.*\)/.test(trimmed)) return undefined;
  const prefixMatch = trimmed.match(SUPPORTED_CURRENCY_PREFIXES);
  const prefixEnd = prefixMatch ? prefixMatch[0].length : 0;
  const rest = trimmed.slice(prefixEnd).trim();
  if (!/^\d/.test(rest)) return undefined;
  const suffix = rest.replace(/^[\d,.]+/, '').trim();
  if (suffix && !/^(?:\$|€|£|¥|USD|EUR|GBP|JPY|CAD|AUD|CHF|CNY|INR)?\s*[*†‡]*$/i.test(suffix)) return undefined;
  const digits = rest.slice(0, rest.length - suffix.length).trim();
  if (!/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(digits)) return undefined;
  const numeric = digits.replace(/,/g, '');
  const parsed = parseFloat(numeric);
  if (Number.isNaN(parsed) || !Number.isFinite(parsed) || parsed < 0) return undefined;
  return roundToDecimals(parsed, AMOUNT_DECIMALS);
}

function isValidNonNegativeAmount(value: string | null | undefined): boolean {
  return parseCanonicalChargeAmount(value) !== undefined;
}

export interface NormalizedFreightAndTax {
  extractedFreightAmount?: string;
  extractedTaxAmount?: string;
  freightCleared: boolean;
  taxCleared: boolean;
  reviewNote?: string;
  // A read amount was not submitted, so the header keeps whatever Workday already has.
  chargeWithheld?: boolean;
}

function sameAmount(a: string | undefined, b: string | undefined): boolean {
  return a != null && b != null && parseCanonicalChargeAmount(a) === parseCanonicalChargeAmount(b);
}

function printable(value: string | null | undefined): string {
  const singleLine = (value ?? '').replace(/["\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return singleLine.length > 60 ? `${singleLine.slice(0, 57)}...` : singleLine;
}

function conflictingChargeNote(field: 'Freight' | 'Tax', amount: string | undefined, label: string | null | undefined, otherAmount: string | undefined): string {
  const other = field === 'Freight' ? 'tax' : 'freight';
  return `${field} amount ${printable(amount)} is labeled "${printable(label)}" and a separate ${other} amount ${printable(otherAmount)} was also read; both were kept as read. Verify freight and tax against the document.`;
}

function withheldChargeNote(withheld: { field: 'Freight' | 'Tax'; amount: string; label?: string | null }[]): string {
  const described = withheld
    .map(({ field, amount, label }) => `${field.toLowerCase()} amount "${printable(amount)}"${label ? ` labeled "${printable(label)}"` : ''}`)
    .join(' and ');
  return `Could not safely apply ${described}, so ${withheld.length > 1 ? 'they were' : 'it was'} not submitted; any value already on the Workday invoice was left as is. Verify freight and tax against the document.`;
}

interface ExtractedHeaderCharges {
  extractedFreightAmount?: string | null;
  extractedFreightLabel?: string | null;
  extractedTaxAmount?: string | null;
  extractedTaxLabel?: string | null;
}

export function normalizeExtractedFreightAndTax(options: ExtractedHeaderCharges): NormalizedFreightAndTax {
  return normalizeHeaderCharges(options).normalized;
}

// freightMovedToTax: freight was cleared because its amount was a tax row, not because the document printed zero freight.
function normalizeHeaderCharges(options: ExtractedHeaderCharges): { normalized: NormalizedFreightAndTax; freightMovedToTax: boolean } {
  const rawFreightAmount = options.extractedFreightAmount?.trim() ? options.extractedFreightAmount : undefined;
  const rawTaxAmount = options.extractedTaxAmount?.trim() ? options.extractedTaxAmount : undefined;
  const freightLabel = options.extractedFreightLabel;
  const taxLabel = options.extractedTaxLabel;

  const freightIsTax = labelMatchesTax(freightLabel);
  const taxIsFreight = !labelMatchesTax(taxLabel) && labelMatchesFreight(taxLabel);

  const freightNonZero = rawFreightAmount != null && isValidNonNegativeAmount(rawFreightAmount) && parseExtractedAmount(rawFreightAmount) !== 0;
  const taxNonZero = rawTaxAmount != null && isValidNonNegativeAmount(rawTaxAmount) && parseExtractedAmount(rawTaxAmount) !== 0;
  const freightZero = rawFreightAmount != null && isValidNonNegativeAmount(rawFreightAmount) && parseExtractedAmount(rawFreightAmount) === 0;
  const taxZero = rawTaxAmount != null && isValidNonNegativeAmount(rawTaxAmount) && parseExtractedAmount(rawTaxAmount) === 0;

  const freightValid = freightNonZero || freightZero;
  const taxValid = taxNonZero || taxZero;
  const freightUnreadable = rawFreightAmount != null && !freightValid;
  const taxUnreadable = rawTaxAmount != null && !taxValid;

  let freightAmount: string | undefined;
  let taxAmount: string | undefined;
  let freightCleared = false;
  let taxCleared = false;
  let freightMovedToTax = false;
  let reviewNote: string | undefined;
  let chargeWithheld = false;

  const labeledFreightZero = freightZero && Boolean(freightLabel);
  const labeledTaxZero = taxZero && Boolean(taxLabel);

  // The Workday builder parses leniently (it strips signs and separators), so an amount that does not parse cleanly is
  // withheld rather than submitted. With one amount unreadable, a crossed label on the other cannot be resolved either.
  if (freightUnreadable || taxUnreadable) {
    const withheld: { field: 'Freight' | 'Tax'; amount: string; label?: string | null }[] = [];
    if (rawFreightAmount != null && (freightUnreadable || freightIsTax)) {
      withheld.push({ field: 'Freight', amount: rawFreightAmount, label: freightLabel });
    } else if (labeledFreightZero) {
      freightCleared = true;
    } else {
      freightAmount = rawFreightAmount;
    }
    if (rawTaxAmount != null && (taxUnreadable || taxIsFreight)) {
      withheld.push({ field: 'Tax', amount: rawTaxAmount, label: taxLabel });
    } else if (labeledTaxZero) {
      taxCleared = true;
    } else {
      taxAmount = rawTaxAmount;
    }
    reviewNote = withheldChargeNote(withheld);
    chargeWithheld = true;
  } else if (freightIsTax && taxIsFreight) {
    if (freightValid && taxValid) {
      freightAmount = rawTaxAmount;
      taxAmount = rawFreightAmount;
      freightCleared = Boolean(rawTaxAmount && parseExtractedAmount(rawTaxAmount) === 0);
      taxCleared = Boolean(rawFreightAmount && parseExtractedAmount(rawFreightAmount) === 0);
    } else if (freightValid) {
      taxAmount = rawFreightAmount;
      freightCleared = true;
      freightMovedToTax = true;
      taxCleared = Boolean(rawFreightAmount && parseExtractedAmount(rawFreightAmount) === 0);
    } else if (taxValid) {
      freightAmount = rawTaxAmount;
      taxCleared = true;
      freightCleared = Boolean(rawTaxAmount && parseExtractedAmount(rawTaxAmount) === 0);
    }
  } else if (freightIsTax) {
    if (freightNonZero && taxNonZero && !sameAmount(rawFreightAmount, rawTaxAmount)) {
      freightAmount = rawFreightAmount;
      taxAmount = rawTaxAmount;
      reviewNote = conflictingChargeNote('Freight', rawFreightAmount, freightLabel, rawTaxAmount);
    } else if (freightNonZero) {
      freightCleared = true;
      freightMovedToTax = true;
      taxAmount = taxNonZero ? rawTaxAmount : rawFreightAmount;
    } else if (freightZero) {
      freightCleared = true;
      freightMovedToTax = true;
      if (taxNonZero) {
        taxAmount = rawTaxAmount;
      } else {
        taxCleared = true;
      }
    } else if (labeledTaxZero) {
      taxCleared = true;
    } else {
      taxAmount = rawTaxAmount;
    }
  } else if (taxIsFreight) {
    if (taxNonZero && freightNonZero && !sameAmount(rawTaxAmount, rawFreightAmount)) {
      freightAmount = rawFreightAmount;
      taxAmount = rawTaxAmount;
      reviewNote = conflictingChargeNote('Tax', rawTaxAmount, taxLabel, rawFreightAmount);
    } else if (taxNonZero) {
      taxCleared = true;
      freightAmount = freightNonZero ? rawFreightAmount : rawTaxAmount;
    } else if (taxZero) {
      taxCleared = true;
      if (freightNonZero) {
        freightAmount = rawFreightAmount;
      } else {
        freightCleared = true;
      }
    } else if (labeledFreightZero) {
      freightCleared = true;
    } else {
      freightAmount = rawFreightAmount;
    }
  } else {
    if (labeledFreightZero) {
      freightCleared = true;
    } else {
      freightAmount = rawFreightAmount;
    }
    if (labeledTaxZero) {
      taxCleared = true;
    } else {
      taxAmount = rawTaxAmount;
    }
  }

  return {
    normalized: {
      extractedFreightAmount: freightAmount,
      extractedTaxAmount: taxAmount,
      freightCleared,
      taxCleared,
      ...(reviewNote && { reviewNote }),
      ...(chargeWithheld && { chargeWithheld }),
    },
    freightMovedToTax,
  };
}

export function resolveHeaderChargeAmounts(options: {
  extractedFreightAmount?: string | null;
  extractedFreightLabel?: string | null;
  extractedTaxAmount?: string | null;
  extractedTaxLabel?: string | null;
  freightAmountFromLines?: number;
}): NormalizedFreightAndTax {
  const { freightAmountFromLines, ...extracted } = options;
  const { normalized, freightMovedToTax } = normalizeHeaderCharges(extracted);
  const freightFromLines = freightAmountFromLines != null ? String(freightAmountFromLines) : undefined;
  // splitFreightLines already removed freight rows from the lines, so their sum must land in the header or it is lost.
  if (freightMovedToTax && freightFromLines != null) {
    return {
      ...normalized,
      extractedFreightAmount: freightFromLines,
      freightCleared: false,
      extractedTaxAmount: normalized.taxCleared ? undefined : normalized.extractedTaxAmount,
    };
  }
  // Line-derived freight only fills a header with no amount read; a withheld header amount keeps the existing value.
  const lineFreight = !options.extractedFreightAmount?.trim() ? freightFromLines : undefined;
  return {
    ...normalized,
    extractedFreightAmount: normalized.freightCleared ? undefined : (normalized.extractedFreightAmount ?? lineFreight),
    extractedTaxAmount: normalized.taxCleared ? undefined : normalized.extractedTaxAmount,
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
    unitCost: line.unitCost ? (parseExtractedUnitCost(line.unitCost) ?? null) : null,
    extendedAmount: line.totalPrice ? (parseExtractedLineAmount(line.totalPrice) ?? null) : null,
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
  return Math.round(roundToDecimals(value, AMOUNT_DECIMALS) * 100);
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

// Rounding never moves the line total: the cents check below sees the rounded quantity and unit
// cost, and a line they no longer reproduce submits amount-only with its extended amount. A line
// with no extended amount first records the total Workday would compute from the unrounded values.
function limitLineAmountPrecision(line: FinalInvoiceLine): FinalInvoiceLine {
  const quantity = line.quantity != null ? roundToDecimals(line.quantity, QUANTITY_DECIMALS) : line.quantity;
  const unitCost = line.unitCost != null ? roundToDecimals(line.unitCost, UNIT_COST_DECIMALS) : line.unitCost;
  // An extended amount Workday can take is kept as printed; a longer one rounds to cents, so its cent total holds.
  const extendedAmount = line.extendedAmount != null && roundToDecimals(line.extendedAmount, EXTENDED_AMOUNT_DECIMALS) !== line.extendedAmount
    ? toCents(line.extendedAmount) / 100
    : line.extendedAmount;
  const roundedQuantityOrUnitCost = quantity !== line.quantity || unitCost !== line.unitCost;
  // An unmarked credit submits amount-only, so it records the total Workday would compute from its quantity.
  const unmarkedCredit = line.hasDiscount !== true && isDiscountLine(line);
  const computedExtendedAmount = extendedAmount == null && line.unitCost != null
    && (unmarkedCredit || (roundedQuantityOrUnitCost && !isDiscountLine(line)))
    ? toCents(line.unitCost * (line.quantity ?? 1)) / 100
    : undefined;
  return {
    ...line,
    ...(quantity != null && { quantity }),
    ...(unitCost != null && { unitCost }),
    ...(extendedAmount != null && { extendedAmount }),
    ...(computedExtendedAmount != null && { extendedAmount: computedExtendedAmount }),
  };
}

export function alignSupplierInvoiceLineAmounts(lines: FinalInvoiceLine[]): FinalInvoiceLine[] {
  return lines.map(limitLineAmountPrecision).map(line => {
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

// Mirrors the Extended_Amount the SOAP builder sends, or Quantity * Unit_Cost when it sends none.
function submittedLineAmount(line: FinalInvoiceLine): number | undefined {
  if (isDiscountLine(line)) return line.extendedAmount ?? line.unitCost ?? undefined;
  if (line.extendedAmount != null) return line.extendedAmount;
  if (line.unitCost != null) return line.unitCost * (line.quantity ?? 1);
  return undefined;
}

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

const UNREADABLE = Symbol('unreadable');

function readChargeAmount(value: unknown): number | undefined | typeof UNREADABLE {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') return UNREADABLE;
  return parseCanonicalChargeAmount(value) ?? UNREADABLE;
}

// Resolves a header charge the way buildSubmitInvoiceData does: a cleared charge is zero, a read
// amount wins, and otherwise the value already on the Workday invoice (or line-derived freight) stays.
function submittedHeaderCharge(
  extracted: string | undefined,
  cleared: boolean | undefined,
  fallbacks: unknown[]
): number | typeof UNREADABLE {
  if (cleared) return 0;
  const read = readChargeAmount(extracted);
  if (read !== undefined) return read;
  for (const fallback of fallbacks) {
    const amount = readChargeAmount(fallback);
    if (amount !== undefined) return amount;
  }
  return 0;
}

export interface LineTotalCharges {
  amountDue?: string;
  freightAmount?: string;
  taxAmount?: string;
  freightCleared?: boolean;
  taxCleared?: boolean;
  currentFreightAmount?: unknown;
  currentTaxAmount?: unknown;
}

interface ExpectedLineTotal {
  amountDueCents: number;
  freightCents: number;
  taxCents: number;
  expectedCents: number;
}

// Credit memos and amounts that do not parse cleanly leave nothing reliable to compare.
function expectedLineTotal(charges: LineTotalCharges, freightFallbacks: unknown[]): ExpectedLineTotal | undefined {
  const amountDue = parseCanonicalChargeAmount(charges.amountDue);
  if (amountDue == null) return undefined;
  const freight = submittedHeaderCharge(charges.freightAmount, charges.freightCleared, freightFallbacks);
  const tax = submittedHeaderCharge(charges.taxAmount, charges.taxCleared, [charges.currentTaxAmount]);
  if (freight === UNREADABLE || tax === UNREADABLE) return undefined;
  const amountDueCents = toCents(amountDue);
  const freightCents = toCents(freight);
  const taxCents = toCents(tax);
  return { amountDueCents, freightCents, taxCents, expectedCents: amountDueCents - freightCents - taxCents };
}

// Lines that restate another row (a monthly summary beside its hourly breakdown) would invoice
// the charge twice, so a line sum that misses the document's amount due is flagged for AP review.
export function lineTotalMismatchNote(lines: FinalInvoiceLine[], charges: LineTotalCharges): string | undefined {
  if (lines.length === 0) return undefined;
  // A row with no amount, freight-described or not, leaves the subtotal unknown.
  if (lines.some(line => submittedLineAmount(line) == null)) return undefined;
  const { merchandiseLines, freightAmountFromLines } = splitFreightLines(lines);
  if (merchandiseLines.length === 0) return undefined;
  const lineAmounts = merchandiseLines.map(submittedLineAmount);

  const expected = expectedLineTotal(charges, [charges.currentFreightAmount, freightAmountFromLines]);
  if (!expected) return undefined;
  const { amountDueCents, freightCents, taxCents, expectedCents } = expected;

  const lineCents = lineAmounts.reduce<number>((sum, amount) => sum + toCents(amount!), 0);
  if (lineCents === expectedCents) return undefined;

  const likelyCause = lineCents > expectedCents
    ? 'Check for a duplicated or summary line, or a payment, credit, or discount applied outside the lines, before approving.'
    : 'Check for a missing line or charge before approving.';
  return `Invoice lines total ${formatCents(lineCents)}, but the amount due ${formatCents(amountDueCents)}`
    + ` less freight ${formatCents(freightCents)} and tax ${formatCents(taxCents)} is ${formatCents(expectedCents)}.`
    + ` ${likelyCause}`;
}

const MONTH_TOKEN = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?(?![a-z])`;
// A two-digit year needs an apostrophe ("Sep'26"), so a day number ("May 15, 2026") is not read as a year.
const MONTH_THEN_YEAR = new RegExp(String.raw`\b${MONTH_TOKEN}\s*(?:['’]\s*(\d{2})(?!\d)|[\s,/-]*(\d{4})(?!\d))`, 'i');
const YEAR_THEN_MONTH = new RegExp(String.raw`\b(\d{4})\s*[-/\s]\s*${MONTH_TOKEN}`, 'i');
const NUMERIC_MONTH_YEAR = /\b(0?[1-9]|1[0-2])\/(\d{4})\b/;

interface StatedMonth {
  year: number;
  month: number;
}

function monthIndex(token: string): number {
  return ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
    .indexOf(token.slice(0, 3).toLowerCase()) + 1;
}

// Reads one month and year a row bills for, e.g. "Sep'26", "September 2026", "2026 - September", "09/2026".
function statedMonth(text: string | null | undefined): StatedMonth | undefined {
  if (!text) return undefined;
  const monthThenYear = text.match(MONTH_THEN_YEAR);
  if (monthThenYear) {
    const year = monthThenYear[2] ? 2000 + Number(monthThenYear[2]) : Number(monthThenYear[3]);
    return { year, month: monthIndex(monthThenYear[1]) };
  }
  const yearThenMonth = text.match(YEAR_THEN_MONTH);
  if (yearThenMonth) return { year: Number(yearThenMonth[1]), month: monthIndex(yearThenMonth[2]) };
  const numeric = text.match(NUMERIC_MONTH_YEAR);
  if (numeric) return { year: Number(numeric[2]), month: Number(numeric[1]) };
  return undefined;
}

// The PO line's service window must span the whole stated month; one open side counts as covering
// it, but a line with no dates says nothing about the month.
function poLineCoversMonth(line: Pick<PurchaseOrderLine, 'startDate' | 'endDate'>, { year, month }: StatedMonth): boolean {
  const startDate = toIsoDate(line.startDate);
  const endDate = toIsoDate(line.endDate);
  if (!startDate && !endDate) return false;
  // A date that is present but unparseable is unknown, not an open side.
  if ((line.startDate && !startDate) || (line.endDate && !endDate)) return false;
  const pad = (value: number) => String(value).padStart(2, '0');
  const firstDay = `${year}-${pad(month)}-01`;
  const lastDay = `${year}-${pad(month)}-${pad(new Date(Date.UTC(year, month, 0)).getUTCDate())}`;
  return (!startDate || startDate <= firstDay) && (!endDate || endDate >= lastDay);
}

function extractedLineCents(line: ExtractedInvoiceLine): number | undefined {
  if (line.totalPrice) {
    const amount = parseExtractedLineAmount(line.totalPrice);
    return amount == null ? undefined : toCents(amount);
  }
  // A unit cost with no printed quantity or total does not show what the row charges.
  if (line.quantity == null || !Number.isFinite(line.quantity) || line.quantity < 0) return undefined;
  const unitCost = line.unitCost ? parseExtractedUnitCost(line.unitCost) : undefined;
  return unitCost == null ? undefined : toCents(unitCost * line.quantity);
}

export type RepeatedTableKeepReason = 'purchase_order' | 'service_period' | 'unit_cost' | 'document_order';

export interface RepeatedLineTables<T extends ExtractedInvoiceLine> {
  lines: T[];
  removed: T[];
  keptTable?: number;
  keepReason?: RepeatedTableKeepReason;
  note?: string;
}

const KEEP_REASON_TEXT: Record<RepeatedTableKeepReason, string> = {
  purchase_order: 'its lines match open PO lines by amount and service period',
  service_period: 'its lines state the service period',
  unit_cost: 'its quantities and unit costs reproduce the line totals to the cent',
  document_order: 'nothing else told the tables apart, so the first table on the document was kept. Verify the kept lines before approving',
};

// Keeps the Workday note and Slack section short when a long table is removed.
const REMOVED_LINES_LISTED = 5;

interface TableCandidate<T> {
  tableNumber: number;
  lines: T[];
  lineCents: number[];
}

// Largest one-to-one pairing of a table's rows with PO lines of the same amount whose window spans
// the row's stated month (augmenting paths), so the order PO lines are listed in cannot change the score.
function maxPoLineMatches<T extends ExtractedInvoiceLine>(table: TableCandidate<T>, openPoLines: PurchaseOrderLine[]): number {
  const candidates = table.lines.map((line, index) => {
    const month = statedMonth(line.description);
    if (!month) return [];
    return openPoLines
      .map((poLine, poIndex) => ({ poLine, poIndex }))
      .filter(({ poLine }) => toCents(poLine.extendedAmount!) === table.lineCents[index] && poLineCoversMonth(poLine, month))
      .map(({ poIndex }) => poIndex);
  });
  const rowForPoLine = new Map<number, number>();
  const assign = (row: number, visited: Set<number>): boolean => {
    for (const poIndex of candidates[row]) {
      if (visited.has(poIndex)) continue;
      visited.add(poIndex);
      const holder = rowForPoLine.get(poIndex);
      if (holder === undefined || assign(holder, visited)) {
        rowForPoLine.set(poIndex, row);
        return true;
      }
    }
    return false;
  };
  return candidates.reduce((matches, _, row) => matches + (assign(row, new Set()) ? 1 : 0), 0);
}

function keepTable<T extends ExtractedInvoiceLine>(
  tables: TableCandidate<T>[],
  purchaseOrderLines: PurchaseOrderLine[]
): { table: TableCandidate<T>; reason: RepeatedTableKeepReason } {
  const openPoLines = purchaseOrderLines.filter(line => line.availableForInvoicing !== false && line.extendedAmount != null);
  const share = (table: TableCandidate<T>, matches: (line: T, cents: number) => boolean) =>
    table.lines.filter((line, index) => matches(line, table.lineCents[index])).length / table.lines.length;
  const criteria: Array<[RepeatedTableKeepReason, (table: TableCandidate<T>) => number]> = [
    // One PO line backs at most one row, so a table that repeats a charge cannot score twice on it.
    ['purchase_order', table => maxPoLineMatches(table, openPoLines) / table.lines.length],
    ['service_period', table => share(table, line => !!statedMonth(line.description))],
    ['unit_cost', table => share(table, (line, cents) => {
      const unitCost = line.unitCost ? parseExtractedUnitCost(line.unitCost) : undefined;
      return unitCost != null && line.quantity != null
        && roundToDecimals(unitCost, AMOUNT_DECIMALS) === unitCost
        && toCents(line.quantity * unitCost) === cents;
    })],
  ];

  let remaining = tables;
  for (const [reason, score] of criteria) {
    const scores = remaining.map(score);
    const best = Math.max(...scores);
    remaining = remaining.filter((_, index) => scores[index] === best);
    if (remaining.length === 1) return { table: remaining[0], reason };
  }
  return { table: remaining[0], reason: 'document_order' };
}

// Some invoices print the same charges twice, for example an hourly line-item table plus a monthly
// summary table. When extraction numbered the tables and each table on its own totals the amount due
// less freight and tax, one table restates the other, so only one table is kept. Anything less
// certain removes nothing and is left to lineTotalMismatchNote.
export function removeRepeatedLineTables<T extends ExtractedInvoiceLine>(
  lines: T[],
  charges: LineTotalCharges,
  purchaseOrderLines: PurchaseOrderLine[] = []
): RepeatedLineTables<T> {
  const unchanged: RepeatedLineTables<T> = { lines, removed: [] };
  if (lines.length < 2) return unchanged;
  if (lines.some(line => !Number.isInteger(line.tableNumber) || line.tableNumber! < 1)) return unchanged;
  // A credit or discount row is never removed with its table, and a malformed quantity leaves the
  // row's charge in doubt, so either keeps every line.
  if (lines.some(line => !line.description?.trim() || line.hasDiscount === true
    || (line.quantity != null && (!Number.isFinite(line.quantity) || line.quantity < 0)))) return unchanged;
  const lineCents = lines.map(extractedLineCents);
  if (lineCents.some(cents => cents == null || cents < 0)) return unchanged;
  const expected = expectedLineTotal(charges, [charges.currentFreightAmount]);
  if (!expected) return unchanged;
  const totalCents = lineCents.reduce<number>((sum, cents) => sum + cents!, 0);
  if (totalCents === expected.expectedCents) return unchanged;

  const byTable = new Map<number, TableCandidate<T>>();
  lines.forEach((line, index) => {
    const tableNumber = line.tableNumber as number;
    const table = byTable.get(tableNumber) ?? { tableNumber, lines: [], lineCents: [] };
    table.lines.push(line);
    table.lineCents.push(lineCents[index]!);
    byTable.set(tableNumber, table);
  });
  const tables = [...byTable.values()].sort((a, b) => a.tableNumber - b.tableNumber);
  if (tables.length < 2) return unchanged;
  // Numbering that skips a table means extraction lost track of the document's tables.
  if (tables.some((table, index) => table.tableNumber !== index + 1)) return unchanged;
  const tableTotals = tables.map(table => table.lineCents.reduce((sum, cents) => sum + cents, 0));
  if (tableTotals.some(cents => cents !== expected.expectedCents)) return unchanged;

  const { table: kept, reason } = keepTable(tables, purchaseOrderLines);
  const keptLines = lines.filter(line => line.tableNumber === kept.tableNumber);
  const removed = lines.filter(line => line.tableNumber !== kept.tableNumber);

  const removedTables = tables.filter(table => table !== kept).map(table => table.tableNumber);
  const listed = removed
    .slice(0, REMOVED_LINES_LISTED)
    .map(line => `"${printable(line.description)}" (${formatCents(extractedLineCents(line)!)})`);
  const unlisted = removed.length - listed.length;
  if (unlisted > 0) {
    const unlistedCents = removed.slice(REMOVED_LINES_LISTED).reduce((sum, line) => sum + extractedLineCents(line)!, 0);
    listed.push(`${unlisted} more ${unlisted === 1 ? 'line' : 'lines'} (${formatCents(unlistedCents)})`);
  }
  const note = `Removed ${removed.length === 1 ? 'line' : 'lines'} ${listed.join(', ')} because`
    + ` ${removedTables.length === 1 ? `table ${removedTables[0]} repeats` : `tables ${removedTables.join(', ')} repeat`}`
    + ` the charges in table ${kept.tableNumber}: each table totals ${formatCents(expected.expectedCents)},`
    + ` the amount due less freight and tax. Kept table ${kept.tableNumber} because ${KEEP_REASON_TEXT[reason]}.`;

  return { lines: keptLines, removed, keptTable: kept.tableNumber, keepReason: reason, note };
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
  invoiceContext?: InvoiceDateContext,
  abortSignal?: AbortSignal
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
      abortSignal,
    }) as MergeInvoiceLinesResult;
  } catch (error) {
    if (abortSignal?.aborted) {
      debug('Line merge aborted by deadline signal; rethrowing so the processor error path runs');
      throw error;
    }
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
