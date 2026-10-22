import {
  chargeAmount,
  formatChargeDollars,
  labelMatchesFreight,
  labelMatchesTax,
  normalizeLabel,
  parseCanonicalChargeAmount,
  parseExtractedLineAmount,
  parseExtractedUnitCost,
  printable,
  reconcileSubmittedCharges,
  signedChargeLineAmount,
  splitFreightLines,
  TAX_CORE_WORDS,
  TAX_METADATA_WORDS,
  type ExtractedInvoiceLine,
  type FinalInvoiceLine,
} from './invoice_lines.js';

/** A printed tax row besides the main tax, as OCR read it. Only rows whose label says tax are applied. */
export interface PrintedCharge {
  label: string;
  amount: string;
}

/**
 * A charge belongs in header tax when its printed label says tax (`Sales Tax`, `EnvChg Tax`,
 * `Tax - Environmental 5%`). A label without a tax word (`EnvChg`, `Fuel Surcharge`) is not moved,
 * and tax metadata such as `Tax ID` or `Tax Exempt` is not an amount.
 */
export function isTaxLikeChargeLabel(label: string | null | undefined): boolean {
  if (labelMatchesTax(label)) return true;
  const tokens = (normalizeLabel(label) ?? '').split(' ').filter(Boolean);
  return tokens.some(token => TAX_CORE_WORDS.has(token))
    && !tokens.some(token => TAX_METADATA_WORDS.has(token));
}

export interface AppliedTaxCharges {
  taxAmount?: string;
  taxCleared: boolean;
  /** Amount-check sentence naming the charges added to header tax. */
  message?: string;
  /** Tax note detail, for example `Sales Tax $28.26 + EnvChg $17.00`. */
  breakdown?: string;
}

interface TaxCandidate {
  label: string;
  cents: number;
}

function toCents(value: number): number {
  return Math.round(value * 100);
}

function describeCharges(candidates: TaxCandidate[]): string {
  return candidates.map(candidate => `"${printable(candidate.label)}" ${formatChargeDollars(candidate.cents / 100)}`).join(' and ');
}

/**
 * Adds printed tax-like charges to the header tax amount, but only when lines + freight + tax fall
 * short of the amount due by exactly those charges. A rate is never turned into an amount, a charge
 * that repeats the tax already read is skipped, and any other gap is left for the amount check.
 */
export function applyPrintedTaxCharges(input: {
  charges?: PrintedCharge[] | null;
  amountDue?: string | null;
  lines: ExtractedInvoiceLine[];
  freight?: string;
  tax?: string;
  taxLabel?: string | null;
  taxCleared: boolean;
  chargeWithheld?: boolean;
}): AppliedTaxCharges {
  const unchanged: AppliedTaxCharges = { taxAmount: input.tax, taxCleared: input.taxCleared };
  if (input.chargeWithheld || !input.charges?.length || input.lines.length === 0) return unchanged;
  if (chargeAmount(input.amountDue) == null) return unchanged;

  const currentTax = input.taxCleared ? 0 : (chargeAmount(input.tax) ?? 0);
  const currentTaxCents = toCents(currentTax);
  const { merchandiseLines } = splitFreightLines(input.lines);
  const totals = reconcileSubmittedCharges(
    merchandiseLines,
    { amountDue: input.amountDue, freight: input.freight, tax: currentTax },
    { removeDuplicates: false, checkWithoutLines: true }
  ).unreconciled;
  if (!totals) return unchanged;
  const gapCents = toCents(totals.amountDue) - toCents(totals.lineTotal) - toCents(totals.freight) - toCents(totals.tax);
  if (gapCents <= 0) return unchanged;

  const seen = new Set<string>();
  const candidates: TaxCandidate[] = [];
  for (const charge of input.charges) {
    if (!isTaxLikeChargeLabel(charge.label)) continue;
    const amount = parseCanonicalChargeAmount(charge.amount);
    if (amount == null || amount <= 0) continue;
    const cents = toCents(amount);
    // A row that restates the header tax (same label, or a total row) is not a second tax; two different
    // taxes with the same amount (State Tax and County Tax) both count.
    const label = normalizeLabel(charge.label) ?? '';
    const restatesHeaderTax = label === normalizeLabel(input.taxLabel) || /\btotal\b/.test(label);
    if (cents === currentTaxCents && restatesHeaderTax) continue;
    const key = `${normalizeLabel(charge.label)}|${cents}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ label: charge.label, cents });
  }

  const allCents = candidates.reduce((total, candidate) => total + candidate.cents, 0);
  const applied = candidates.length && allCents === gapCents
    ? candidates
    : candidates.filter(candidate => candidate.cents === gapCents).slice(0, 1);
  if (applied.length === 0) return unchanged;

  const newTax = (currentTaxCents + gapCents) / 100;
  const described = describeCharges(applied);
  const printedTax = currentTaxCents > 0
    ? `${input.taxLabel ? `"${printable(input.taxLabel)}" ` : ''}${formatChargeDollars(currentTax)}`
    : undefined;
  return {
    taxAmount: newTax.toFixed(2),
    taxCleared: false,
    message: `Added ${described} to header Tax_Amount so lines, freight, and tax equal the amount due.`,
    breakdown: [printedTax, described].filter(Boolean).join(' + '),
  };
}

/** A priced totals-block row other than freight and tax (`Decoration $5.00`, `Merchandise Discount $13.80`). */
export interface PrintedSummaryCharge {
  label: string;
  /** Null when the row prints only a rate. */
  amount: string | null;
}

export interface PlacedSummaryCharges {
  /** Invoice lines for the rows that close the gap, in printed order. */
  lines: ExtractedInvoiceLine[];
  /** Amount-check sentence naming the rows added as lines. */
  message?: string;
  /** Review sentences for rows that were read but not added. */
  reviewNote?: string;
}

// `unsignedDiscount` is a discount-style label printed without a minus sign or parentheses: a credit by
// default, but only placed when the credit reading makes the invoice add up.
type SummarySign = 'charge' | 'credit' | 'unsignedDiscount';

interface SummaryCandidate {
  label: string;
  cents: number;
  sign: SummarySign;
}

const SUMMARY_ROW_WORDS = new Set([
  'due', 'balance', 'paid', 'payment', 'payments', 'deposit', 'deposits', 'prepayment', 'prepaid', 'prepay',
  'previous', 'remaining', 'owing',
]);
const TOTAL_WORDS = new Set(['total', 'totals', 'subtotal', 'subtotals']);
const GENERIC_SUMMARY_WORDS = new Set([
  'sub', 'grand', 'invoice', 'order', 'merchandise', 'goods', 'product', 'products', 'item', 'items',
  'line', 'lines', 'net', 'amount', 'the', 'of',
]);
const DISCOUNT_WORDS = new Set([
  'discount', 'discounts', 'disc', 'allowance', 'allowances', 'promo', 'promotion', 'promotional',
  'rebate', 'rebates', 'credit', 'credits', 'coupon', 'coupons', 'markdown', 'markdowns', 'less',
]);
const FEE_WORDS = new Set(['fee', 'fees', 'charge', 'charges', 'surcharge', 'surcharges']);

function labelTokens(label: string): string[] {
  return (normalizeLabel(label) ?? '').split(' ').filter(Boolean);
}

// `S&H`, `S & H`, and `S/H` normalize to `sh` or `s h`.
function isShippingAbbreviation(tokens: string[]): boolean {
  const body = tokens.filter(token => !TOTAL_WORDS.has(token) && token !== 'amount').join(' ');
  return body === 'sh' || body === 's h';
}

function isDiscountLabel(tokens: string[]): boolean {
  return tokens.some(token => DISCOUNT_WORDS.has(token)) && !tokens.some(token => FEE_WORDS.has(token));
}

// Subtotals, totals, and payments restate or settle the lines; they are never a charge of their own.
// `Merchandise Discount` is a discount, and `Decoration Total` names a charge, so neither is a summary.
function isSummaryLabel(tokens: string[]): boolean {
  if (tokens.some(token => SUMMARY_ROW_WORDS.has(token))) return true;
  if (isDiscountLabel(tokens)) return false;
  return tokens.every(token => TOTAL_WORDS.has(token) || GENERIC_SUMMARY_WORDS.has(token));
}

// Words that say what the charge is, so a line that repeats the row can be recognized.
function significantTokens(tokens: string[]): string[] {
  return tokens.filter(token => token.length > 2
    && !/\d/.test(token)
    && !GENERIC_SUMMARY_WORDS.has(token)
    && !TOTAL_WORDS.has(token)
    && !FEE_WORDS.has(token));
}

function parseSummaryAmount(raw: string | null | undefined): { cents: number; printedCredit: boolean } | undefined {
  const text = raw?.trim();
  if (!text || text.includes('%')) return undefined;
  const printedCredit = /^\s*(?:\$\s*)?[-\u2212(]/.test(text) || /[-\u2212]\s*$/.test(text);
  const amount = parseCanonicalChargeAmount(text.replace(/[-\u2212()]/g, '').trim());
  return amount == null ? undefined : { cents: toCents(amount), printedCredit };
}

function signedCents(candidate: SummaryCandidate): number {
  return candidate.sign === 'charge' ? candidate.cents : -candidate.cents;
}

function sumSignedCents(candidates: SummaryCandidate[]): number {
  return candidates.reduce((total, candidate) => total + signedCents(candidate), 0);
}

function centsDollars(cents: number): string {
  return formatChargeDollars(cents / 100);
}

// An unsigned discount is shown as printed, since its sign is what is in doubt.
function describeSummaryCandidates(candidates: SummaryCandidate[]): string {
  return candidates
    .map(candidate => `"${printable(candidate.label)}" ${centsDollars(candidate.sign === 'credit' ? -candidate.cents : candidate.cents)}`)
    .join(' and ');
}

// Merchandise rows that print a unit price, a quantity, and a lower net total already carry this much discount.
function lineDiscountCents(lines: ExtractedInvoiceLine[]): number {
  return lines.reduce((total, line) => {
    if (line.hasDiscount !== true || line.quantity == null || !Number.isFinite(line.quantity)) return total;
    const unitCost = line.unitCost ? parseExtractedUnitCost(line.unitCost) : undefined;
    const lineTotal = line.totalPrice ? parseExtractedLineAmount(line.totalPrice) : undefined;
    if (unitCost == null || lineTotal == null) return total;
    const discount = toCents(unitCost * line.quantity) - toCents(lineTotal);
    return discount > 0 ? total + discount : total;
  }, 0);
}

/**
 * Adds priced totals-block rows (a decoration fee, a merchandise discount) as invoice lines, but only when
 * lines + freight + tax miss the amount due by exactly those rows. An unsigned discount is a credit only when
 * the credit makes the invoice add up; when only the charge reading does, nothing is added and the review note
 * gives both readings. Rows already on a line, subtotals, payments, freight, tax, and rates are never added.
 */
export function placeSummaryCharges(input: {
  charges?: PrintedSummaryCharge[] | null;
  amountDue?: string | null;
  lines: ExtractedInvoiceLine[];
  freight?: string;
  tax?: string;
  freightCleared: boolean;
  taxCleared: boolean;
}): PlacedSummaryCharges {
  const none: PlacedSummaryCharges = { lines: [] };
  if (!input.charges?.length || input.lines.length === 0) return none;
  const amountDue = chargeAmount(input.amountDue);
  if (amountDue == null) return none;
  const lineAmounts = input.lines.map(line => signedChargeLineAmount(line));
  if (lineAmounts.some(amount => amount == null)) return none;

  const lineCents = lineAmounts.reduce<number>((total, amount) => total + toCents(amount ?? 0), 0);
  const freightCents = input.freightCleared ? 0 : toCents(chargeAmount(input.freight) ?? 0);
  const taxCents = input.taxCleared ? 0 : toCents(chargeAmount(input.tax) ?? 0);
  const submittedCents = lineCents + freightCents + taxCents;
  const gapCents = toCents(amountDue) - submittedCents;
  if (gapCents === 0) return none;

  const discountInLines = lineDiscountCents(input.lines);
  const lineEntries = input.lines.map((line, index) => ({
    tokens: new Set(labelTokens(line.description ?? '')),
    cents: toCents(lineAmounts[index] ?? 0),
  }));
  const seen = new Set<string>();
  const candidates: SummaryCandidate[] = [];
  const withoutAmount: string[] = [];
  for (const charge of input.charges) {
    const tokens = labelTokens(charge.label);
    if (tokens.length === 0 || isSummaryLabel(tokens)) continue;
    if (labelMatchesFreight(charge.label) || isShippingAbbreviation(tokens) || isTaxLikeChargeLabel(charge.label)) continue;
    const parsed = parseSummaryAmount(charge.amount);
    if (!parsed) {
      withoutAmount.push(charge.label);
      continue;
    }
    if (parsed.cents === 0) continue;
    const discount = isDiscountLabel(tokens);
    const sign: SummarySign = parsed.printedCredit ? 'credit' : discount ? 'unsignedDiscount' : 'charge';
    // A charge row for the same amount as header freight or tax is that charge under a label the matchers miss.
    if (sign === 'charge' && (parsed.cents === freightCents || parsed.cents === taxCents)) continue;
    const significant = significantTokens(tokens);
    const alreadyLine = lineEntries.some(entry => Math.abs(entry.cents) === parsed.cents
      && ((sign !== 'charge' && entry.cents < 0) || significant.some(token => entry.tokens.has(token))));
    if (alreadyLine) continue;
    if (sign !== 'charge' && discountInLines === parsed.cents) continue;
    const key = `${tokens.join(' ')}|${parsed.cents}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ label: charge.label, cents: parsed.cents, sign });
  }
  if (candidates.length === 0 && withoutAmount.length === 0) return none;

  const allCents = sumSignedCents(candidates);
  const singles = candidates.filter(candidate => signedCents(candidate) === gapCents);
  const matched = candidates.length && allCents === gapCents ? candidates : singles.length === 1 ? singles : [];
  const placed = lineCents + sumSignedCents(matched) > 0 ? matched : [];
  if (placed.length) {
    return {
      lines: placed.map(candidate => {
        const cents = signedCents(candidate);
        return {
          description: candidate.label,
          quantity: null,
          unitCost: null,
          totalPrice: (cents / 100).toFixed(2),
          hasDiscount: cents < 0 ? true : null,
        };
      }),
      message: `Added ${placed.map(candidate => `"${printable(candidate.label)}" ${centsDollars(signedCents(candidate))}`).join(' and ')} from the invoice totals as ${placed.length > 1 ? 'invoice lines' : 'an invoice line'} so lines, freight, and tax equal the amount due.`,
    };
  }

  const notes: string[] = [];
  let unexplained = candidates;
  const unsignedDiscounts = candidates.filter(candidate => candidate.sign === 'unsignedDiscount');
  const chargeAlone = unsignedDiscounts.find(candidate => candidate.cents === gapCents);
  const chargeWithOthers = chargeAlone ? undefined : unsignedDiscounts.find(candidate => allCents + 2 * candidate.cents === gapCents);
  const ambiguous = chargeAlone ?? chargeWithOthers;
  if (ambiguous) {
    const others = chargeWithOthers ? candidates.filter(candidate => candidate !== ambiguous) : [];
    const creditCents = submittedCents - ambiguous.cents + sumSignedCents(others);
    notes.push(`"${printable(ambiguous.label)}" ${centsDollars(ambiguous.cents)} was not added: as a credit, lines, freight, and tax would total ${centsDollars(creditCents)}; as a charge${others.length ? ` with ${describeSummaryCandidates(others)}` : ''}, ${centsDollars(toCents(amountDue))}, which matches the amount due. Check which it is before approving.`);
    unexplained = candidates.filter(candidate => candidate !== ambiguous && !others.includes(candidate));
  }
  if (unexplained.length) {
    const plural = unexplained.length > 1;
    notes.push(`${describeSummaryCandidates(unexplained)} ${plural ? 'were' : 'was'} printed in the invoice totals but not added: ${plural ? 'they do' : 'it does'} not explain the ${centsDollars(Math.abs(gapCents))} difference between lines, freight, and tax (${centsDollars(submittedCents)}) and the amount due (${centsDollars(toCents(amountDue))}).`);
  }
  if (withoutAmount.length) {
    const plural = withoutAmount.length > 1;
    notes.push(`${withoutAmount.map(label => `"${printable(label)}"`).join(' and ')} ${plural ? 'were' : 'was'} printed in the invoice totals without an amount, so ${plural ? 'they were' : 'it was'} not added.`);
  }
  return { lines: [], reviewNote: notes.join(' ') };
}

export interface SettledSummaryLines {
  lines: FinalInvoiceLine[];
  /** Amount-check sentence, set only when every placed row is still a submitted line. */
  message?: string;
  /** Review sentence when a placed discount sits beside lines coded to more than one cost center. */
  codingNote?: string;
}

/**
 * After the line merge, finds the lines placeSummaryCharges added and drops any PO line link from them: a fee
 * or discount read from the totals is not a PO line's goods, so it keeps the matched coding without invoicing
 * PO quantity. The Amount-check sentence is kept only when every placed row is still a submitted line.
 */
export function settlePlacedSummaryLines(finalLines: FinalInvoiceLine[], placed: PlacedSummaryCharges): SettledSummaryLines {
  if (placed.lines.length === 0 || !placed.message) return { lines: finalLines };
  const claimed: number[] = [];
  for (const line of placed.lines) {
    const cents = toCents(chargeAmount(line.totalPrice) ?? 0);
    const index = finalLines.findIndex((final, i) => {
      const amount = final.extendedAmount ?? final.unitCost;
      return !claimed.includes(i) && final.description === line.description && amount != null && toCents(amount) === cents;
    });
    if (index < 0) return { lines: finalLines };
    claimed.push(index);
  }

  const linked = claimed.some(index => finalLines[index].purchaseOrderLineId);
  const lines = finalLines.map((line, index) => (claimed.includes(index)
    ? {
      ...line,
      purchaseOrderLineId: null,
      purchaseOrderLineQuantity: null,
      purchaseOrderLineUnitCost: null,
      forcePositivePoQuantity: undefined,
      omitPurchaseOrderLineReference: undefined,
    }
    : line));
  const plural = placed.lines.length > 1;
  const costCenters = new Set(lines.filter((_, index) => !claimed.includes(index)).map(line => line.costCenterId ?? ''));
  const discounts = claimed.map(index => lines[index]).filter(line => (line.extendedAmount ?? line.unitCost ?? 0) < 0);
  const codingNote = discounts.length && costCenters.size > 1
    ? discounts.map(line => `"${printable(line.description)}" ${formatChargeDollars(line.extendedAmount ?? line.unitCost ?? 0)}`).join(' and ')
      + ` ${discounts.length > 1 ? 'are single lines' : 'is a single line'}, but the invoice lines use more than one cost center. Check how the discount should be coded before approving.`
    : undefined;
  return {
    lines,
    message: placed.message + (linked ? ` ${plural ? 'They are' : 'It is'} not linked to a PO line.` : ''),
    ...(codingNote && { codingNote }),
  };
}
