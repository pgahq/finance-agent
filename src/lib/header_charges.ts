import {
  chargeAmount,
  formatChargeDollars,
  isFreightOrHandlingLine,
  isTaxChargeDescription,
  labelMatchesFreight,
  labelMatchesTax,
  normalizeLabel,
  parseCanonicalChargeAmount,
  parseExtractedLineAmount,
  parseExtractedUnitCost,
  printable,
  reconcileSubmittedCharges,
  restoreClearedFreightFromRows,
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

interface SettlementRow {
  label: string;
  cents?: number;
  printedCredit: boolean;
}

const SUMMARY_ROW_WORDS = new Set([
  'due', 'balance', 'paid', 'payment', 'payments', 'deposit', 'deposits', 'prepayment', 'prepaid', 'prepay',
  'previous', 'remaining', 'owing',
]);
// A credit memo, retainer, or refund applied to the bill settles it; it does not lower the cost of the goods,
// and the credit may already be its own document in Workday.
const SETTLEMENT_WORDS = new Set(['credit', 'credits', 'memo', 'memos', 'retainer', 'retainers', 'refund', 'refunds']);
const TOTAL_WORDS = new Set(['total', 'totals', 'subtotal', 'subtotals']);
const GENERIC_SUMMARY_WORDS = new Set([
  'sub', 'grand', 'invoice', 'order', 'merchandise', 'goods', 'product', 'products', 'item', 'items',
  'line', 'lines', 'net', 'amount', 'the', 'of',
]);
const DISCOUNT_WORDS = new Set([
  'discount', 'discounts', 'disc', 'allowance', 'allowances', 'promo', 'promotion', 'promotional',
  'rebate', 'rebates', 'coupon', 'coupons', 'markdown', 'markdowns',
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

function hasFeeWord(tokens: string[]): boolean {
  return tokens.some(token => FEE_WORDS.has(token));
}

function isDiscountLabel(tokens: string[]): boolean {
  return tokens.some(token => DISCOUNT_WORDS.has(token)) && !hasFeeWord(tokens);
}

// `Credit Card Fee` is a fee, not an applied credit.
function isSettlementLabel(tokens: string[]): boolean {
  return tokens.some(token => SETTLEMENT_WORDS.has(token)) && !hasFeeWord(tokens);
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
    && !FEE_WORDS.has(token)
    && token !== 'less');
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

function describeSettlementRows(rows: SettlementRow[]): string {
  return rows
    .map(row => `"${printable(row.label)}"${row.cents == null ? '' : ` ${centsDollars(row.printedCredit ? -row.cents : row.cents)}`}`)
    .join(' and ');
}

function describeExtractedLines(lines: ExtractedInvoiceLine[]): string {
  return lines.map(line => `"${printable(line.description)}" ${formatChargeDollars(chargeAmount(line.totalPrice) ?? 0)}`).join(' and ');
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

function notAddedNotes(rows: {
  unexplained: SummaryCandidate[];
  withoutAmount: string[];
  settlements: SettlementRow[];
  /** Set when nothing was added, to say what difference the rows fail to explain. */
  gap?: { gapCents: number; submittedCents: number; amountDueCents: number };
}): string[] {
  const notes: string[] = [];
  const { unexplained, withoutAmount, settlements, gap } = rows;
  if (unexplained.length) {
    const plural = unexplained.length > 1;
    const reason = gap
      ? `${plural ? 'they do' : 'it does'} not explain the ${centsDollars(Math.abs(gap.gapCents))} difference between lines, freight, and tax (${centsDollars(gap.submittedCents)}) and the amount due (${centsDollars(gap.amountDueCents)})`
      : `lines, freight, and tax equal the amount due without ${plural ? 'them' : 'it'}`;
    notes.push(`${describeSummaryCandidates(unexplained)} ${plural ? 'were' : 'was'} printed in the invoice totals but not added: ${reason}.`);
  }
  if (settlements.length) {
    const plural = settlements.length > 1;
    notes.push(`${describeSettlementRows(settlements)} in the invoice totals ${plural ? 'look' : 'looks'} like an applied credit, credit memo, retainer, or refund, so ${plural ? 'they were' : 'it was'} not added as ${plural ? 'lines' : 'a line'}. Check whether the credit is already in Workday before approving.`);
  }
  if (withoutAmount.length) {
    const plural = withoutAmount.length > 1;
    notes.push(`${withoutAmount.map(label => `"${printable(label)}"`).join(' and ')} ${plural ? 'were' : 'was'} printed in the invoice totals without an amount, so ${plural ? 'they were' : 'it was'} not added.`);
  }
  return notes;
}

/**
 * Adds priced totals-block rows (a decoration fee, a merchandise discount) as invoice lines, but only when
 * lines + freight + tax miss the amount due by exactly those rows. An unsigned discount is a credit only when
 * the credit makes the invoice add up; when only the charge reading does, nothing is added and the review note
 * gives both readings. Rows already on a line, subtotals, payments, applied credits, freight, tax, and rates are
 * never added; rows that were read but not added are named in the review note.
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
  const amountDueCents = toCents(amountDue);
  const gapCents = amountDueCents - submittedCents;
  if (gapCents === 0) return none;

  const discountInLines = lineDiscountCents(input.lines);
  const lineEntries = input.lines.map((line, index) => ({
    tokens: new Set(labelTokens(line.description ?? '')),
    cents: toCents(lineAmounts[index] ?? 0),
  }));
  const seen = new Set<string>();
  const candidates: SummaryCandidate[] = [];
  const withoutAmount: string[] = [];
  const settlements: SettlementRow[] = [];
  for (const charge of input.charges) {
    const tokens = labelTokens(charge.label);
    if (tokens.length === 0 || isSummaryLabel(tokens)) continue;
    if (labelMatchesFreight(charge.label) || isShippingAbbreviation(tokens) || isTaxLikeChargeLabel(charge.label)) continue;
    const parsed = parseSummaryAmount(charge.amount);
    if (isSettlementLabel(tokens)) {
      if (parsed?.cents !== 0) settlements.push({ label: charge.label, cents: parsed?.cents, printedCredit: Boolean(parsed?.printedCredit) });
      continue;
    }
    if (!parsed) {
      withoutAmount.push(charge.label);
      continue;
    }
    if (parsed.cents === 0) continue;
    const discount = isDiscountLabel(tokens);
    // `Less Early Pay $3.00` says the row reduces the bill, the same as a printed minus sign.
    const printedCredit = parsed.printedCredit || tokens[0] === 'less';
    const sign: SummarySign = printedCredit ? 'credit' : discount ? 'unsignedDiscount' : 'charge';
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
  if (candidates.length === 0 && withoutAmount.length === 0 && settlements.length === 0) return none;

  const allCents = sumSignedCents(candidates);
  const singles = candidates.filter(candidate => signedCents(candidate) === gapCents);
  const matched = candidates.length && allCents === gapCents ? candidates : singles.length === 1 ? singles : [];
  const placed = lineCents + sumSignedCents(matched) > 0 ? matched : [];
  if (placed.length) {
    const notes = notAddedNotes({
      unexplained: candidates.filter(candidate => !placed.includes(candidate)),
      withoutAmount,
      settlements,
    });
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
      ...(notes.length && { reviewNote: notes.join(' ') }),
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
    notes.push(`"${printable(ambiguous.label)}" ${centsDollars(ambiguous.cents)} was not added: as a credit, lines, freight, and tax would total ${centsDollars(creditCents)}; as a charge${others.length ? ` with ${describeSummaryCandidates(others)}` : ''}, ${centsDollars(amountDueCents)}, which matches the amount due. Check which it is before approving.`);
    unexplained = candidates.filter(candidate => candidate !== ambiguous && !others.includes(candidate));
  }
  notes.push(...notAddedNotes({ unexplained, withoutAmount, settlements, gap: { gapCents, submittedCents, amountDueCents } }));
  return { lines: [], reviewNote: notes.join(' ') };
}

export interface SettledSummaryLines {
  lines: FinalInvoiceLine[];
  /** Amount-check sentence for the rows added from the totals. */
  message?: string;
  /** Review sentences: a placed row the submitted lines do not show, or a discount beside several cost centers. */
  reviewNote?: string;
}

function finalLineAmount(line: FinalInvoiceLine): number | undefined {
  if (line.extendedAmount != null) return line.extendedAmount;
  if (line.unitCost != null) return line.unitCost * (line.quantity ?? 1);
  return undefined;
}

function sumCentsOrUndefined(amounts: Array<number | undefined>): number | undefined {
  return amounts.some(amount => amount == null)
    ? undefined
    : amounts.reduce<number>((total, amount) => total + toCents(amount ?? 0), 0);
}

/**
 * After the line merge, finds the lines placeSummaryCharges added and drops any PO line link from them: a fee
 * or discount read from the totals is not a PO line's goods, so it keeps the matched coding without invoicing
 * PO quantity. A placed row the merge or an email budget split folded into other lines is still named: as
 * included when the submitted lines total what was read, otherwise as a review item.
 */
export function settlePlacedSummaryLines(
  finalLines: FinalInvoiceLine[],
  placed: PlacedSummaryCharges,
  candidateLines: ExtractedInvoiceLine[]
): SettledSummaryLines {
  if (placed.lines.length === 0 || !placed.message) return { lines: finalLines };
  const claimed: number[] = [];
  const missing: ExtractedInvoiceLine[] = [];
  for (const line of placed.lines) {
    const cents = toCents(chargeAmount(line.totalPrice) ?? 0);
    const index = finalLines.findIndex((final, i) => {
      const amount = final.extendedAmount ?? final.unitCost;
      return !claimed.includes(i) && final.description === line.description && amount != null && toCents(amount) === cents;
    });
    if (index < 0) missing.push(line);
    else claimed.push(index);
  }

  const unlinked = claimed.filter(index => finalLines[index].purchaseOrderLineId).map(index => finalLines[index]);
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
  const unlinkedSentence = unlinked.length === 0
    ? ''
    : missing.length === 0 && unlinked.length === claimed.length
      ? ` ${claimed.length > 1 ? 'They are' : 'It is'} not linked to a PO line.`
      : ` ${unlinked.map(line => `"${printable(line.description)}"`).join(' and ')} ${unlinked.length > 1 ? 'are' : 'is'} not linked to a PO line.`;

  const costCenters = new Set(lines.filter((_, index) => !claimed.includes(index)).map(line => line.costCenterId ?? ''));
  const discounts = claimed.map(index => lines[index]).filter(line => (line.extendedAmount ?? line.unitCost ?? 0) < 0);
  const codingNote = discounts.length && costCenters.size > 1
    ? discounts.map(line => `"${printable(line.description)}" ${formatChargeDollars(line.extendedAmount ?? line.unitCost ?? 0)}`).join(' and ')
      + ` ${discounts.length > 1 ? 'are single lines' : 'is a single line'}, but the invoice lines use more than one cost center. Check how the discount should be coded before approving.`
    : undefined;

  if (missing.length === 0) {
    return { lines, message: placed.message + unlinkedSentence, ...(codingNote && { reviewNote: codingNote }) };
  }

  const plural = missing.length > 1;
  const submittedCents = sumCentsOrUndefined(finalLines.map(finalLineAmount));
  const readCents = sumCentsOrUndefined(candidateLines.map(line => signedChargeLineAmount(line)));
  const included = submittedCents != null && submittedCents === readCents;
  const described = describeExtractedLines(placed.lines);
  const message = included
    ? `Added ${described} from the invoice totals so lines, freight, and tax equal the amount due. ${describeExtractedLines(missing)} ${plural ? 'are' : 'is'} included in the submitted lines but not as ${plural ? 'separate lines' : 'a separate line'}.${unlinkedSentence}`
    : undefined;
  const missingNote = included
    ? undefined
    : `${describeExtractedLines(missing)} from the invoice totals ${plural ? 'were' : 'was'} added before line coding, but the submitted lines do not show ${plural ? 'them' : 'it'}. Check the lines before approving.${unlinkedSentence}`;
  const reviewNote = [missingNote, codingNote].filter(Boolean).join(' ') || undefined;
  return { lines, ...(message && { message }), ...(reviewNote && { reviewNote }) };
}

export interface SinglePriceReinterpretation {
  lines: ExtractedInvoiceLine[];
  /** Review sentence naming the lines whose single price was read as a unit price. */
  note?: string;
}

// Eligible lines are searched as subsets, so the cap bounds the work (2^8 candidates).
const SINGLE_PRICE_MAX_ELIGIBLE_LINES = 8;

function wholeCents(amount: number): number | undefined {
  const cents = amount * 100;
  return Math.abs(cents - Math.round(cents)) < 1e-6 ? Math.round(cents) : undefined;
}

type LinePriceReadingKind = 'unitPrice' | 'extension';

interface LinePriceReading {
  kind: LinePriceReadingKind;
  /** The line total in cents under the alternative reading. */
  cents: number;
}

function isChargeRowDescription(description: string): boolean {
  return isFreightOrHandlingLine(description) || isTaxChargeDescription(description);
}

// Quantity above 1, no unit price, one positive price printed as the total, and a product that is a whole-cent amount.
function singlePriceReading(line: ExtractedInvoiceLine): LinePriceReading | undefined {
  const quantity = line.quantity;
  if (quantity == null || !Number.isFinite(quantity) || quantity <= 1) return undefined;
  if (line.unitCost?.trim() || line.hasDiscount === true) return undefined;
  if (isChargeRowDescription(line.description)) return undefined;
  const price = line.totalPrice ? chargeAmount(line.totalPrice) : undefined;
  if (price == null || price <= 0) return undefined;
  const cents = wholeCents(quantity * price);
  return cents == null ? undefined : { kind: 'unitPrice', cents };
}

// A positive quantity and unit price whose whole-cent product differs from the printed positive line total.
function extensionReading(line: ExtractedInvoiceLine): LinePriceReading | undefined {
  const quantity = line.quantity;
  if (quantity == null || !Number.isFinite(quantity) || quantity <= 0) return undefined;
  if (!line.unitCost?.trim() || !line.totalPrice || line.hasDiscount === true) return undefined;
  if (isChargeRowDescription(line.description)) return undefined;
  const unitCost = parseExtractedUnitCost(line.unitCost);
  const total = chargeAmount(line.totalPrice);
  if (unitCost == null || unitCost <= 0 || total == null || total <= 0) return undefined;
  const cents = wholeCents(quantity * unitCost);
  if (cents == null || cents <= 0) return undefined;
  // A unit price printed rounded to the cent is off by at most half a cent per unit, so a gap that small is the
  // vendor's rounding and the printed total stands (3 x $33.33 printed as $100.00).
  const totalCents = Math.round(total * 100);
  return Math.abs(totalCents - cents) <= Math.ceil(quantity / 2) ? undefined : { kind: 'extension', cents };
}

function linePriceReading(line: ExtractedInvoiceLine, allowExtension: boolean): LinePriceReading | undefined {
  return singlePriceReading(line) ?? (allowExtension ? extensionReading(line) : undefined);
}

function describeSinglePriceLines(lines: ExtractedInvoiceLine[]): string {
  return lines
    .map(line => {
      const price = chargeAmount(line.totalPrice) ?? 0;
      return `"${printable(line.description)}" prints quantity ${line.quantity} and one price of ${formatChargeDollars(price)}`;
    })
    .join('; ');
}

function describeExtensionLines(lines: ExtractedInvoiceLine[], readings: Map<ExtractedInvoiceLine, number>): string {
  return lines
    .map(line => {
      const unitCost = parseExtractedUnitCost(line.unitCost ?? '') ?? 0;
      const total = chargeAmount(line.totalPrice) ?? 0;
      const product = (readings.get(line) ?? 0) / 100;
      return `"${printable(line.description)}" prints quantity ${line.quantity} at ${formatChargeDollars(unitCost)} (${formatChargeDollars(product)}) but a line total of ${formatChargeDollars(total)}`;
    })
    .join('; ');
}

function singlePriceNote(changed: ExtractedInvoiceLine[]): string {
  const many = changed.length > 1;
  return `${describeSinglePriceLines(changed)}. Read as ${many ? 'line totals' : 'a line total'}, the lines do not add up to the amount due, but reading ${many ? 'those prices' : 'that price'} as ${many ? 'unit prices' : 'a unit price'} does, so the line ${many ? 'totals were' : 'total was'} set to quantity x price.`;
}

function extensionNote(changed: ExtractedInvoiceLine[], readings: Map<ExtractedInvoiceLine, number>): string {
  const many = changed.length > 1;
  return `${describeExtensionLines(changed, readings)}. With the printed ${many ? 'line totals' : 'line total'}, the lines do not add up to the amount due, but with quantity x unit price they do, so the line ${many ? 'totals were' : 'total was'} set to quantity x unit price.`;
}

export interface LinePriceReadingOptions {
  /**
   * Whether a line whose printed total differs from quantity x unit price may take the product as its total.
   * Callers turn it off when a deposit, prior payment, or balance due is printed, because the lines then
   * legitimately exceed the amount due and a coincidental match proves nothing.
   */
  allowExtension?: boolean;
}

/**
 * Two readings of a line whose quantity and prices disagree with the amount due:
 * - A line that prints a quantity and one price may print that price per unit, with the line total
 *   left off. OCR then reads it as the line total (unit cost null), and the line submits amount-only
 *   at the unit price. The line total becomes quantity x price.
 * - A line that prints a quantity, a unit price, and a line total that is not their product (OCR took
 *   the tax-inclusive amount due as the total). The line total becomes quantity x unit price.
 * Either reading is taken only when the lines as read do not reconcile with the amount due and the
 * reading does. `reconciles` is the caller's check against the amount due; the search takes a reading
 * only when exactly one set of lines reconciles, so an ambiguous or unreconcilable invoice keeps its
 * mismatch flag.
 */
export function reinterpretSinglePriceLines(
  lines: ExtractedInvoiceLine[],
  reconciles: (candidate: ExtractedInvoiceLine[]) => boolean,
  options: LinePriceReadingOptions = {}
): SinglePriceReinterpretation {
  const unchanged: SinglePriceReinterpretation = { lines };
  const allowExtension = options.allowExtension ?? true;
  const eligible = lines.flatMap((line, index) => {
    const reading = linePriceReading(line, allowExtension);
    return reading == null ? [] : [{ index, reading }];
  });
  // Quantity x unit price rows share the cap with single-price rows, so too many of them must not switch off the
  // single-price reading, which has always worked on its own.
  if (eligible.length > SINGLE_PRICE_MAX_ELIGIBLE_LINES && allowExtension) {
    return reinterpretSinglePriceLines(lines, reconciles, { ...options, allowExtension: false });
  }
  if (eligible.length === 0 || eligible.length > SINGLE_PRICE_MAX_ELIGIBLE_LINES) return unchanged;
  if (reconciles(lines)) return unchanged;

  const apply = (mask: number): ExtractedInvoiceLine[] => {
    const chosen = new Map(eligible.filter((_, bit) => mask & (1 << bit)).map(entry => [entry.index, entry.reading]));
    return lines.map((line, index) => {
      const reading = chosen.get(index);
      if (reading == null) return line;
      const totalPrice = formatChargeDollars(reading.cents / 100);
      return reading.kind === 'unitPrice' ? { ...line, unitCost: line.totalPrice, totalPrice } : { ...line, totalPrice };
    });
  };
  const matches: number[] = [];
  for (let mask = 1; mask < 1 << eligible.length; mask += 1) {
    if (reconciles(apply(mask))) matches.push(mask);
  }
  if (matches.length !== 1) return unchanged;

  const reinterpreted = apply(matches[0]);
  const changedEntries = eligible.filter((_, bit) => matches[0] & (1 << bit));
  const ofKind = (kind: LinePriceReadingKind) => changedEntries.filter(entry => entry.reading.kind === kind).map(entry => lines[entry.index]);
  const singlePrice = ofKind('unitPrice');
  const extension = ofKind('extension');
  const products = new Map(changedEntries.map(entry => [lines[entry.index], entry.reading.cents]));
  return {
    lines: reinterpreted,
    note: [
      ...(singlePrice.length ? [singlePriceNote(singlePrice)] : []),
      ...(extension.length ? [extensionNote(extension, products)] : []),
    ].join(' '),
  };
}

export interface SinglePriceChargeContext {
  amountDue?: string | null;
  /** Header freight and tax as resolveHeaderChargeAmounts returned them, before any restore or added charge. */
  freight?: string;
  tax?: string;
  taxLabel?: string | null;
  freightCleared: boolean;
  taxCleared: boolean;
  chargeWithheld?: boolean;
  /** False when the caller will not place totals-block charges (a printed row was dropped), so one cannot close the gap. */
  summaryChargesPlaceable: boolean;
  printedTaxCharges?: PrintedCharge[] | null;
  printedSummaryCharges?: PrintedSummaryCharge[] | null;
  /** A deposit, prior payment, or balance due is printed, so a line total is not replaced by quantity x unit price. */
  settlementPrinted?: boolean;
}

/** Whether the document or email prints a deposit, a payment already received, or a remaining balance. */
export function hasPrintedSettlement(result: {
  extractedPartialPayment: unknown;
  extractedPriorPayments: unknown[] | null | undefined;
  emailBalanceDue: unknown;
}): boolean {
  return Boolean(result.extractedPartialPayment || result.extractedPriorPayments?.length || result.emailBalanceDue);
}

/**
 * reinterpretSinglePriceLines against the same gap-closing steps create and enrich run next:
 * restored freight, duplicate freight and tax lines, printed tax-like charges, and totals-block
 * charges. A reading counts as reconciled only when none of those is still needed.
 */
export function reinterpretSinglePriceLinesForCharges(
  lines: ExtractedInvoiceLine[],
  context: SinglePriceChargeContext
): SinglePriceReinterpretation {
  if (context.chargeWithheld || chargeAmount(context.amountDue) == null) return { lines };
  const reconciles = (candidate: ExtractedInvoiceLine[]): boolean => {
    const restored = restoreClearedFreightFromRows(candidate, {
      amountDue: context.amountDue ?? undefined,
      tax: context.tax,
      freightCleared: context.freightCleared,
    });
    const freight = restored.freight ?? context.freight;
    const taxCharges = applyPrintedTaxCharges({
      charges: context.printedTaxCharges,
      amountDue: context.amountDue,
      lines: candidate,
      freight,
      tax: context.tax,
      taxLabel: context.taxLabel,
      taxCleared: context.taxCleared,
    });
    const { merchandiseLines } = splitFreightLines(candidate);
    const reconciliation = reconcileSubmittedCharges(
      merchandiseLines,
      { amountDue: context.amountDue, freight, tax: taxCharges.taxAmount },
      { allowSingleLineFreight: true, removeDuplicates: true }
    );
    if (!reconciliation.unreconciled) return true;
    if (!context.summaryChargesPlaceable) return false;
    return placeSummaryCharges({
      charges: context.printedSummaryCharges,
      amountDue: context.amountDue,
      lines: reconciliation.lines,
      freight,
      tax: taxCharges.taxAmount,
      freightCleared: context.freightCleared && restored.freight == null,
      taxCleared: taxCharges.taxCleared,
    }).lines.length > 0;
  };
  return reinterpretSinglePriceLines(lines, reconciles, { allowExtension: !context.settlementPrinted });
}
