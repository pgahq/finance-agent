import {
  chargeAmount,
  formatChargeDollars,
  labelMatchesTax,
  normalizeLabel,
  parseCanonicalChargeAmount,
  printable,
  reconcileSubmittedCharges,
  splitFreightLines,
  type ExtractedInvoiceLine,
} from './invoice_lines.js';

/** A printed charge row other than the header tax and freight (environmental, fuel, service, and so on). */
export interface PrintedCharge {
  label: string;
  amount: string;
}

const ENVIRONMENTAL_WORDS = new Set(['env', 'envchg', 'enviro', 'environmental', 'environment', 'eco', 'recycling', 'recycle']);
const ENVIRONMENTAL_ALLOWED_WORDS = new Set([
  ...ENVIRONMENTAL_WORDS,
  'chg', 'charge', 'charges', 'fee', 'fees', 'surcharge', 'levy', 'tax', 'taxes', 'and', 'amount', 'total',
]);

/**
 * Charges that belong in the header tax amount: anything the tax matcher accepts, plus environmental
 * charges (`EnvChg`, `Environmental Fee 5%`). Fuel, service, and other fees are not tax-like.
 */
export function isTaxLikeChargeLabel(label: string | null | undefined): boolean {
  if (labelMatchesTax(label)) return true;
  const normalized = normalizeLabel(label);
  if (!normalized) return false;
  const tokens = normalized.split(' ').filter(token => token && !/^\d+(\.\d+)?%?$/.test(token));
  return tokens.some(token => ENVIRONMENTAL_WORDS.has(token))
    && tokens.every(token => ENVIRONMENTAL_ALLOWED_WORDS.has(token));
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
    // The tax row the header already carries, listed again.
    if (cents === currentTaxCents && labelMatchesTax(charge.label)) continue;
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
