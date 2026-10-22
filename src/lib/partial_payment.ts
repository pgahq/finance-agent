import {
  formatChargeDollars,
  normalizeLabel,
  parseCanonicalChargeAmount,
  parseExtractedLineAmount,
  printable,
  type ExtractedInvoiceLine,
} from './invoice_lines.js';
import type { PurchaseOrderLine } from './workday.js';

export interface PrintedAmount {
  label: string;
  amount: string;
}

export interface PrintedPartialPayment {
  label: string;
  /** The percentage as printed ("90%"), when the document prints one. */
  percent: string | null;
  amount: string;
}

const DEPOSIT_WORDS = new Set(['deposit', 'deposits', 'advance', 'down', 'downpayment', 'prepayment', 'installment', 'progress', 'partial']);
// Rows that report a payment already made or an amount still to come are not the amount this invoice bills.
const NOT_BILLED_WORDS = new Set(['less', 'paid', 'applied', 'received', 'credit', 'credits', 'balance', 'remaining', 'previous', 'retainer', 'refund']);

function toCents(amount: number): number {
  return Math.round(amount * 100);
}

function centsDollars(cents: number): string {
  return formatChargeDollars(cents / 100);
}

function isDepositLabel(label: string): boolean {
  const tokens = (normalizeLabel(label) ?? '').split(' ').filter(Boolean);
  return tokens.some(token => DEPOSIT_WORDS.has(token)) && !tokens.some(token => NOT_BILLED_WORDS.has(token));
}

function printedPercent(raw: string | null | undefined): number | undefined {
  const match = raw?.match(/(\d+(?:\.\d+)?)\s*%/);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 && value < 100 ? value : undefined;
}

function formatPercent(percent: number): string {
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2).replace(/0+$/, '')}%`;
}

/** Sum of the printed line totals in cents, or undefined when any row has no readable total. */
export function sumExtractedLineCents(lines: ExtractedInvoiceLine[]): number | undefined {
  if (lines.length === 0) return undefined;
  let total = 0;
  for (const line of lines) {
    const amount = line.totalPrice ? parseExtractedLineAmount(line.totalPrice) : undefined;
    if (amount == null) return undefined;
    total += toCents(amount);
  }
  return total;
}

/**
 * How far the extracted rows fall short of the line-table total the document prints, in cents. Undefined when the
 * document prints no readable total, a row has no total, or the rows do not fall short.
 */
export function lineSubtotalShortfallCents(
  lines: ExtractedInvoiceLine[],
  subtotal: PrintedAmount | null | undefined
): number | undefined {
  const printed = parseCanonicalChargeAmount(subtotal?.amount);
  const summed = sumExtractedLineCents(lines);
  if (printed == null || summed == null) return undefined;
  const gap = toCents(printed) - summed;
  return gap > 0 ? gap : undefined;
}

function describeLines(lines: ExtractedInvoiceLine[]): string {
  return lines.map(line => `"${printable(line.description)}"`).join(', ');
}

/** A review sentence when the extracted rows do not add up to the printed line-table total. */
export function lineSubtotalReviewNote(
  lines: ExtractedInvoiceLine[],
  subtotal: PrintedAmount | null | undefined
): string | undefined {
  const printed = parseCanonicalChargeAmount(subtotal?.amount);
  const summed = sumExtractedLineCents(lines);
  if (printed == null || summed == null) return undefined;
  const printedCents = toCents(printed);
  if (printedCents === summed) return undefined;
  const label = printable(subtotal?.label) || 'line total';
  const gap = printedCents - summed;
  const head = `The extracted lines total ${centsDollars(summed)}, but the document prints ${centsDollars(printedCents)} as "${label}".`;
  if (gap < 0) return `${head} Check for a row that was read twice or a charge that is not a line.`;
  const matching = lines.filter(line => {
    const amount = line.totalPrice ? parseExtractedLineAmount(line.totalPrice) : undefined;
    return amount != null && toCents(amount) === gap;
  });
  const hint = matching.length
    ? ` The ${centsDollars(gap)} difference equals ${describeLines(matching.slice(0, 3))}; check whether that row is printed more than once.`
    : ` The ${centsDollars(gap)} difference may be a row that was not read.`;
  return `${head}${hint}`;
}

export interface PartialPaymentPlan {
  applied: boolean;
  /** The single invoice line that replaces the printed lines. Present only when applied. */
  line?: ExtractedInvoiceLine;
  /** The PO lines to code and link the deposit line from. Present only when applied. */
  poLines?: PurchaseOrderLine[];
  /** Sentence for the Workday note. */
  note: string;
  /** What Slack shows under the Amount Due bullet, e.g. "90% deposit of $38,255.00". */
  amountDueNote?: string;
  /** Lines for the Slack Deposit section. */
  slackLines: string[];
}

function poLineAmountCents(line: PurchaseOrderLine): number | undefined {
  const extended = line.extendedAmount != null ? Number(line.extendedAmount) : undefined;
  if (extended != null && Number.isFinite(extended)) return toCents(extended);
  if (line.quantity != null && line.unitCost != null && Number.isFinite(line.quantity * line.unitCost)) {
    return toCents(line.quantity * line.unitCost);
  }
  return undefined;
}

type DepositPoSelection =
  | { status: 'no_po' }
  | { status: 'matched'; line: PurchaseOrderLine; consumed: boolean }
  | { status: 'unmatched'; reason: string };

/** The one PO line whose amount is the deposit. An open line wins over a consumed one with the same amount. */
export function selectDepositPoLine(poLines: PurchaseOrderLine[] | undefined, depositCents: number): DepositPoSelection {
  if (!poLines?.length) return { status: 'no_po' };
  const matching = poLines.filter(line => poLineAmountCents(line) === depositCents);
  const open = matching.filter(line => line.availableForInvoicing !== false);
  if (open.length === 1) return { status: 'matched', line: open[0], consumed: false };
  if (matching.length === 1) return { status: 'matched', line: matching[0], consumed: matching[0].availableForInvoicing === false };
  if (matching.length === 0) return { status: 'unmatched', reason: `no PO line is for ${centsDollars(depositCents)}` };
  return { status: 'unmatched', reason: `several PO lines are for ${centsDollars(depositCents)}` };
}

export interface PartialPaymentInput {
  partialPayment: PrintedPartialPayment | null | undefined;
  lineSubtotal: PrintedAmount | null | undefined;
  amountDue: string | null | undefined;
  freightAmount?: string | null;
  taxAmount?: string | null;
  /** The extracted merchandise rows, used only when the document prints no line-table total. */
  lines: ExtractedInvoiceLine[];
  /** The PO's lines after availability marking, or undefined when no PO line is used. */
  poLines: PurchaseOrderLine[] | undefined;
}

function notApplied(reason: string, label: string): PartialPaymentPlan {
  return {
    applied: false,
    note: `"${label}" looks like a deposit or partial payment, but ${reason}, so the printed lines were submitted unchanged. The submitted lines may not match the amount due; check before approving.`,
    slackLines: [`Deposit or partial payment not applied: ${reason}.`],
  };
}

/**
 * A deposit or advance-payment invoice prints its lines and a contract total, then a smaller amount due. The
 * submitted invoice must bill the amount due, so the printed lines are replaced by one line for that printed
 * amount. Nothing is computed from the percentage, which is only a cross-check. Returns undefined when the
 * document prints no deposit row.
 */
export function planPartialPayment(input: PartialPaymentInput): PartialPaymentPlan | undefined {
  const printed = input.partialPayment;
  if (!printed || !isDepositLabel(printed.label)) return undefined;

  const label = printable(printed.label);
  const depositAmount = parseCanonicalChargeAmount(printed.amount);
  const amountDue = parseCanonicalChargeAmount(input.amountDue);
  if (depositAmount == null) return notApplied('the deposit amount is not a readable amount', label);
  if (amountDue == null) return notApplied('the amount due is not a readable amount', label);
  const depositCents = toCents(depositAmount);
  if (depositCents !== toCents(amountDue)) {
    return notApplied(`the printed deposit ${centsDollars(depositCents)} is not the amount due ${centsDollars(toCents(amountDue))}`, label);
  }
  const freight = parseCanonicalChargeAmount(input.freightAmount) ?? 0;
  const tax = parseCanonicalChargeAmount(input.taxAmount) ?? 0;
  // AP does not pay tax on a deposit; it is paid with the balance invoice, so a printed tax needs a person to say
  // whether the amount due includes it.
  if (tax > 0) return notApplied('a tax amount is printed, and AP does not pay tax on a deposit (it is paid with the balance invoice), so check whether the amount due includes it', label);
  if (freight > 0) return notApplied('freight is also printed', label);

  const printedBase = parseCanonicalChargeAmount(input.lineSubtotal?.amount);
  const baseCents = printedBase != null ? toCents(printedBase) : sumExtractedLineCents(input.lines);
  if (baseCents == null) return notApplied('the document prints no contract total to compare it with', label);
  if (baseCents <= depositCents) return notApplied(`the deposit ${centsDollars(depositCents)} is not less than the contract total ${centsDollars(baseCents)}`, label);

  const percent = printedPercent(printed.percent);
  if (percent != null) {
    const expected = Math.round(baseCents * percent / 100);
    if (Math.abs(expected - depositCents) > 1) {
      return notApplied(`${formatPercent(percent)} of ${centsDollars(baseCents)} is ${centsDollars(expected)}, not the printed ${centsDollars(depositCents)}`, label);
    }
  }

  const selection = selectDepositPoLine(input.poLines, depositCents);
  if (selection.status === 'unmatched') return notApplied(selection.reason, label);

  const depositText = centsDollars(depositCents);
  const baseText = centsDollars(baseCents);
  const share = percent != null ? `${formatPercent(percent)} of ${baseText}` : `part of ${baseText}`;
  const description = `${label} (${share})`;
  const lineCount = input.lines.length;
  const consumedNote = selection.status === 'matched' && selection.consumed
    ? ` The PO line for this amount is already fully invoiced or closed; check whether this deposit was billed before approving.`
    : '';
  const lineText = lineCount > 0 ? ` (${lineCount} printed line${lineCount === 1 ? '' : 's'})` : '';
  const amount = formatChargeDollars(depositCents / 100);
  return {
    applied: true,
    line: { description, quantity: 1, unitCost: amount, totalPrice: amount, hasDiscount: null, tableNumber: 1 },
    ...(selection.status === 'matched' ? { poLines: [selection.line] } : {}),
    note: `"${label}" ${depositText} is ${share} for the contract total${lineText}. The invoice bills the deposit, so it was submitted as one ${depositText} line instead of the printed lines. The full line list is below and on the attached PDF.${consumedNote}`,
    amountDueNote: `${percent != null ? `${formatPercent(percent)} deposit` : 'deposit'} of ${baseText}`,
    slackLines: [
      `${label}: ${depositText} is ${share}. Submitted as one deposit line, not the printed lines.`,
      ...(consumedNote ? [`The PO line for this amount is already fully invoiced or closed; check whether this deposit was billed before approving.`] : []),
    ],
  };
}

export interface SecondReadRow {
  description: string;
  totalPrice: string | null;
}

const SECOND_READ_ROWS_LISTED = 5;

/** Tells AP that rows came from a second read of the document, so the lines are checked against the PDF. */
export function secondReadRowsNote(rows: SecondReadRow[] | null | undefined): string | undefined {
  if (!rows?.length) return undefined;
  const listed = rows.slice(0, SECOND_READ_ROWS_LISTED)
    .map(row => `"${printable(row.description)}"${row.totalPrice ? ` ${printable(row.totalPrice)}` : ''}`)
    .join(', ');
  const more = rows.length > SECOND_READ_ROWS_LISTED ? `, and ${rows.length - SECOND_READ_ROWS_LISTED} more` : '';
  return `A second read of the document added ${rows.length === 1 ? 'a row' : `${rows.length} rows`} the first read missed: ${listed}${more}. Check ${rows.length === 1 ? 'it' : 'them'} against the PDF.`;
}

export function formatPartialPaymentNotes(note: string | undefined): string {
  return note ? `\n\nDeposit invoice: ${note}` : '';
}

export function formatLineSubtotalNotes(note: string | undefined): string {
  return note ? `\n\nLine subtotal review: ${note}` : '';
}
