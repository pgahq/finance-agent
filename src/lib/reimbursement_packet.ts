import { debug } from '@pga/logger';
import type { LanguageModel } from 'ai';
import type { z } from 'zod';
import { getAiResponse } from './ai.js';
import type { DatabaseConnection } from './database.js';
import { getOcrModel } from './models.js';
import { formatChargeDollars, parseCanonicalChargeAmount } from './invoice_lines.js';
import { attachmentContentParts, convertOfficeAttachmentsForModel } from './invoice_ocr.js';
import { supplierNamesMatch } from './po_supplier.js';
import { findUniqueSupplierByNameEvidence } from './supplier_match.js';
import { resolveSupplierIdHints } from './supplier_note_hints.js';
import type { InvoiceData, PresignedAttachment } from './types.js';
import type { InvoiceEnrichmentResult } from '../prompts/enrich_invoice_prompt.js';
import { normalizePrintedDate, type InvoiceOcrResult } from '../prompts/invoice_ocr_prompt.js';
import {
  ReimbursementFormMathSchema,
  ReimbursementPacketSchema,
  reimbursementFormMathPrompt,
  reimbursementPacketPrompt,
  type ReimbursementFormMath,
  type ReimbursementPacket,
} from '../prompts/reimbursement_packet_prompt.js';

export type { ReimbursementPacket };

/** A fact the alert must not present as read from the form, because the reads did not agree on it. */
export type NotConfirmedFact = 'payeeName' | 'formAmount' | 'emailAmount';

/** What the form's own arithmetic was checked against, for the invoice note and the Slack post. */
export interface FormMathSummary {
  /** The words the form prints beside its total, such as "TOTALS". */
  label: string;
  columns: { label: string; total: string }[];
}

/**
 * The packet as read. `unconfirmed` names what the reads could not settle (set when a second, independent read of a
 * reimbursement disagreed with the first, or when no total was confirmed). `notConfirmed` lists the facts the manual-entry
 * alert must leave out, and `unconfirmedDetail` is the amount-free reason the form's own totals gave.
 */
export type ReimbursementRead = ReimbursementPacket & {
  unconfirmed?: string;
  unconfirmedDetail?: string;
  notConfirmed?: NotConfirmedFact[];
  /** The reads did not agree on a readable total; the form's own arithmetic confirmed this one. */
  confirmedByFormMath?: FormMathSummary;
};

/**
 * A reimbursement packet asks AP to pay a person back. The folio or receipt in it is backup, so the invoice goes to
 * the person for the amount the form approves, never to the merchant for what the folio prints.
 */
export interface AppliedReimbursement {
  payee: {
    workdayId: string;
    supplierName: string;
    supplierId?: string;
    nameOnForm: string;
    matchedBy: 'supplier_id' | 'name';
  };
  amount: number;
  amountLabel: string;
  /** The label the form prints beside the total, when it is a recognized payable-total label. */
  totalLabel?: string;
  /** The email's own limit when it worded its amount as "up to"; the form amount was checked against it. */
  emailCap?: number;
  /** The form total was confirmed by the form's own arithmetic, not by two agreeing reads. */
  confirmedByFormMath?: FormMathSummary;
  invoiceDate: string;
  description: string;
}

export interface ReimbursementManualEntry {
  reason: string;
  payeeName?: string;
  formAmount?: string;
  emailAmount?: string;
  /** Facts left out above because the reads did not agree on them. The alert says they are not confirmed. */
  notConfirmed?: NotConfirmedFact[];
}

export type ReimbursementDecision =
  | { outcome: 'not_reimbursement' }
  | { outcome: 'manual_entry'; manual: ReimbursementManualEntry }
  | { outcome: 'apply'; reimbursement: AppliedReimbursement };

type EmailContextInput = InvoiceData['emailContext'];

const MIN_CONFIDENCE = 0.8;
// "reimbursable expenses" on a supplier's invoice is common, so only the verbs and the noun count.
const SIGNAL = /\breimburs(?:e|es|ed|ing|ement|ements)\b|\bamount\s+to\s+pay\b|\bexpense\s+report\b/i;
const READ_ATTEMPTS = 2;
const EMAIL_TEXT_LIMIT = 12_000;
const DESCRIPTION_LIMIT = 120;
// A totals or subtotal row listed as a category would make the rows add up to the total by itself.
const AGGREGATE_ROW = /\bsub[-\s]*totals?\b|\b(?:grand\s+)?totals?\b|\bamount\s+to\s+pay\b|\bsum\s+of\s+all\s+columns\b/i;
// The whole label beside the figure must be one of these, never a category or subtotal and never a label with other
// words added ("Total Reimbursement estimate"). It is tested on the label with whitespace collapsed.
const PAYABLE_TOTAL_LABEL = /^(?:(?:grand\s+)?totals?(?:\s*[-:\u2013]\s*sum\s+of\s+all\s+columns)?|sum\s+of\s+all\s+columns|(?:total\s+)?amount\s+to\s+pay|total\s+reimbursement|total\s+to\s+be\s+reimbursed)\s*:?$/i;
// The most a form-math look may return before it is rejected (not truncated): columns, line items per column, and
// characters in any label or amount.
const MAX_COLUMNS = 12;
const MAX_ENTRIES = 60;
const MAX_TEXT = 80;
// Looks at one form before giving up: two run together, then one at a time while no two passing looks agree. Each look
// is one model call, so the provider calls for the looks never exceed this.
const MAX_LOOKS = 4;
// The processor has 480 s for the reads, the looks, OCR, matching and the Workday write. The live runs took 11-47 s end
// to end; no look starts once this much of the run is gone, and the packet stops in manual entry instead of timing out.
const LOOK_BUDGET_MS = 150_000;
const SUPPLIER_ID_PATTERN = /\bS-\d{4,}\b/i;

/** A cheap text gate so ordinary invoices never pay for the packet read. */
export function hasReimbursementSignal(
  emailContext: Pick<NonNullable<EmailContextInput>, 'subject' | 'plainTextBody' | 'messageSubject' | 'messageBody'> | undefined,
  fileNames: string[]
): boolean {
  const text = [
    emailContext?.subject,
    emailContext?.messageSubject,
    emailContext?.messageBody,
    emailContext?.plainTextBody,
    ...fileNames,
  ].filter(Boolean).join('\n');
  return SIGNAL.test(text);
}

function emailText(emailContext: EmailContextInput): string {
  if (!emailContext) return 'No email context.';
  const body = (emailContext.messageBody || emailContext.plainTextBody || 'N/A').slice(0, EMAIL_TEXT_LIMIT);
  return `From: ${emailContext.emailFrom || 'N/A'}\nSubject: ${emailContext.messageSubject || emailContext.subject || 'N/A'}\nBody: ${body}`;
}

type PacketParts = ReturnType<typeof attachmentContentParts>;

async function readWithRetries<T>(
  name: string,
  schema: z.ZodType<T>,
  prompt: string,
  text: string,
  parts: PacketParts,
  abortSignal: AbortSignal | undefined,
  model?: LanguageModel,
  attempts = READ_ATTEMPTS
): Promise<T> {
  let lastFailure: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (abortSignal?.aborted) break;
    try {
      const response = await getAiResponse({
        prompt,
        schema,
        tools: {},
        abortSignal,
        ...(model ? { model, temperature: null } : {}),
        messages: [{ role: 'user', content: [{ type: 'text', text }, ...parts] }],
      });
      const parsed = schema.safeParse(response);
      if (parsed.success) {
        debug(`${name} read`, parsed.data);
        return parsed.data;
      }
      debug(`${name} read failed schema validation`, { attempt, issues: parsed.error.issues });
      lastFailure = new Error(`${name} read returned an unexpected shape`);
    } catch (error) {
      debug(`${name} read failed`, { attempt, error });
      lastFailure = error;
    }
  }
  throw lastFailure ?? new Error(`${name} read was aborted`);
}

function readPacketOnce(
  fileList: string,
  parts: PacketParts,
  emailContext: EmailContextInput,
  abortSignal: AbortSignal | undefined,
  verifier = false
): Promise<ReimbursementPacket> {
  return readWithRetries(
    'Reimbursement packet',
    ReimbursementPacketSchema,
    reimbursementPacketPrompt,
    `Decide whether this packet is an expense reimbursement.\n\nDocuments: ${fileList}\n\nEmail:\n${emailText(emailContext)}`,
    parts,
    abortSignal,
    // The confirming read uses the document-reading model from another vendor, so a consistent misread by
    // the first model is not simply repeated.
    verifier ? getOcrModel() : undefined
  );
}

function readFormMath(
  fileList: string,
  parts: PacketParts,
  abortSignal: AbortSignal | undefined,
  model: LanguageModel
): Promise<ReimbursementFormMath> {
  return readWithRetries(
    'Reimbursement form math',
    ReimbursementFormMathSchema,
    reimbursementFormMathPrompt,
    `Read the grand total, the column totals and the line items from the reimbursement form.\n\nDocuments: ${fileList}`,
    parts,
    abortSignal,
    model,
    // One call per look: a look that fails is replaced by the next look, so retries inside a look would double the calls.
    1
  );
}

// Only padding beside the field's own symbols goes. Whitespace inside the digits ("1 335.93", "1 ,335.93") is kept so
// a malformed number stays unreadable instead of becoming a valid-looking one.
function withoutPadding(value: string): string {
  return value.trim().replace(/\s*([()$€£¥])\s*/g, '$1');
}

/**
 * A reimbursement form's Amount to Pay is a positive amount to pay, never a credit. A fillable PDF field in an
 * accounting number format can extract as "($      1,335.93)" while the page shows no parentheses, so padding is
 * dropped and one pair of wrapping parentheses is read as the plain amount. A minus sign still makes it unreadable.
 * Only the form's amount gets this: parentheses mean a credit on a supplier invoice.
 */
export function parseFormAmountToPay(value: string | null | undefined): number | undefined {
  if (value == null) return undefined;
  const compact = withoutPadding(value);
  const wrapped = compact.match(/^\(([^()]*)\)$/);
  return parseCanonicalChargeAmount(wrapped ? wrapped[1] : compact);
}

function parseEmailAmount(value: string | null | undefined): number | undefined {
  return value == null ? undefined : parseCanonicalChargeAmount(withoutPadding(value));
}

function amountCents(amount: number | undefined): number | null {
  return amount === undefined ? null : Math.round(amount * 100);
}

function readableText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

// Text copied off a document reaches the invoice note and Slack, so control characters go and whitespace collapses.
function cleanText(value: string): string {
  return readableText(value.replace(/\p{Cc}/gu, ' '));
}

/** The printed label beside a form total, when it is one of the recognized payable-total labels. */
function payableTotalLabel(value: string | null | undefined): string | undefined {
  const label = cleanText(value ?? '');
  return label.length <= MAX_TEXT && PAYABLE_TOTAL_LABEL.test(label) ? label : undefined;
}

function nameWords(value: string | null): Set<string> {
  return new Set(
    (value ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 1)
  );
}

// Single letters are dropped, so "Morgan Ellery" and "MORGAN T ELLERY" are one person. A dropped whole word
// ("Jane Doe" and "Jane Doe Smith") is not: the first read's name picks the supplier, so it must be the name both saw.
function sameName(left: string | null, right: string | null): boolean {
  const a = nameWords(left);
  const b = nameWords(right);
  return a.size === b.size && [...a].every((word) => b.has(word));
}

function comparableId(value: string | null): string | null {
  return value?.match(SUPPLIER_ID_PATTERN)?.[0].toUpperCase() ?? null;
}

const isBlank = (value: string | null | undefined): boolean => !value?.trim();

interface Disagreement {
  phrase: string;
  /** The fact the alert must not show as read from the form. */
  field?: NotConfirmedFact;
}

/**
 * Every fact the two reads disagree on, in a fixed order. The form amount joins the list only when asked and only
 * when both reads found one; a total found by one read and missing from the other is not a disagreement.
 */
function disagreements(first: ReimbursementPacket, second: ReimbursementPacket, includeAmount: boolean): Disagreement[] {
  const found: Disagreement[] = [];
  if (first.kind !== second.kind) found.push({ phrase: 'whether it is a reimbursement' });
  if (!sameName(first.payeeName, second.payeeName)) found.push({ phrase: 'the payee', field: 'payeeName' });
  if (comparableId(first.payeeSupplierId) !== comparableId(second.payeeSupplierId)) found.push({ phrase: 'the payee Supplier ID' });
  if (includeAmount && !isBlank(first.formAmountToPay) && !isBlank(second.formAmountToPay)
    && amountCents(parseFormAmountToPay(first.formAmountToPay)) !== amountCents(parseFormAmountToPay(second.formAmountToPay))) {
    found.push({ phrase: "the form's Amount to Pay", field: 'formAmount' });
  }
  const firstEmailCents = amountCents(parseEmailAmount(first.emailAmount));
  if (firstEmailCents !== amountCents(parseEmailAmount(second.emailAmount))) {
    found.push({ phrase: "the email's amount", field: 'emailAmount' });
  } else if (firstEmailCents !== null && (first.emailAmountIsCap ?? null) !== (second.emailAmountIsCap ?? null)) {
    found.push({ phrase: "whether the email's amount is a limit", field: 'emailAmount' });
  }
  if (normalizePrintedDate(first.formDate) !== normalizePrintedDate(second.formDate)) found.push({ phrase: 'the form date' });
  return found;
}

/**
 * What the two reads of one packet disagree on, if anything. Every fact that decides who is paid, how much, and
 * under what number must match. A form total found by one read and missing from the other is not a disagreement here;
 * `readReimbursementPacket` checks any total the reads do not both give against the form's own arithmetic.
 */
export function packetDisagreement(first: ReimbursementPacket, second: ReimbursementPacket): string | undefined {
  return disagreements(first, second, true)[0]?.phrase;
}

/** The total both reads found, when it is the same readable, positive amount. Anything else needs the form's arithmetic. */
function agreedFormAmount(first: ReimbursementPacket, second: ReimbursementPacket): string | undefined {
  const firstCents = amountCents(parseFormAmountToPay(first.formAmountToPay));
  const secondCents = amountCents(parseFormAmountToPay(second.formAmountToPay));
  return firstCents !== null && firstCents > 0 && firstCents === secondCents ? first.formAmountToPay ?? undefined : undefined;
}

type FormMathResult =
  | { total: number; totalText: string; summary: FormMathSummary }
  | { failure: string; noTotal?: true };

/** A label for a failure reason. Digits and currency signs are dropped so an amount in a label never reaches the alert. */
function diagnosticLabel(text: string | null | undefined): string {
  return cleanText((text ?? '').normalize('NFKC')).replace(/[\p{N}\p{Sc}]/gu, '').replace(/\s+/g, ' ').trim();
}

function oversized(look: ReimbursementFormMath): boolean {
  // Amount fields are padded with spaces on some forms ("$      1,335.93"), so only their visible characters count.
  const labels = [look.grandTotalLabel, ...look.columns.map((column) => column.label)];
  const amounts = [look.grandTotal, ...look.columns.flatMap((column) => [column.total, ...column.entries])];
  return look.columns.length > MAX_COLUMNS
    || look.columns.some((column) => column.entries.length > MAX_ENTRIES)
    || labels.some((text) => (text ?? '').length > MAX_TEXT)
    || amounts.some((text) => (text ?? '').replace(/\s+/g, '').length > MAX_TEXT);
}

/**
 * Whether the form's own arithmetic backs the total the look read: the total sits beside a payable-total label, the
 * column totals add up to it, and each column's line items add up to that column's total. The code sums in cents;
 * the model never does. Reasons name columns and labels but never amounts, because they reach the Slack alert. A look
 * with more columns, entries, or characters than a form has is rejected, never trimmed to fit.
 */
export function formMathResult(look: ReimbursementFormMath): FormMathResult {
  if (isBlank(look.grandTotal)) return { failure: 'the form shows no total to check', noTotal: true };
  if (oversized(look)) return { failure: 'the look returned more columns, line items, or text than a form holds' };
  const total = parseFormAmountToPay(look.grandTotal);
  if (total === undefined) return { failure: "the form's total could not be read as a dollar amount" };
  if (cents(total) <= 0) return { failure: "the form's total is zero" };
  if (isBlank(look.grandTotalLabel)) return { failure: 'no label was read for the form total' };
  const totalLabel = payableTotalLabel(look.grandTotalLabel);
  if (!totalLabel) {
    return { failure: `the form total was read beside "${diagnosticLabel(look.grandTotalLabel)}", which is not a payable-total label` };
  }
  if (look.columns.length === 0) return { failure: 'the form lists no expense columns to check the total against' };

  let columnSum = 0;
  const columns: FormMathSummary['columns'] = [];
  const seen = new Set<string>();
  for (const column of look.columns) {
    if (isBlank(column.label)) return { failure: 'a column has no label' };
    const label = cleanText(column.label);
    const shown = diagnosticLabel(label);
    if (AGGREGATE_ROW.test(label)) return { failure: `the column "${shown}" is a total, not an expense category` };
    const key = label.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    if (seen.has(key)) return { failure: `the column "${shown}" is listed more than once` };
    seen.add(key);
    if (isBlank(column.total)) return { failure: `the column "${shown}" has no printed total` };
    const columnTotal = parseEmailAmount(column.total);
    if (columnTotal === undefined) return { failure: `the total of column "${shown}" could not be read as a dollar amount` };
    let entrySum = 0;
    for (const entry of column.entries) {
      const amount = parseEmailAmount(entry);
      if (amount === undefined) return { failure: `an amount in column "${shown}" could not be read as a dollar amount` };
      entrySum += cents(amount);
    }
    if (entrySum !== cents(columnTotal)) return { failure: `the line items in column "${shown}" do not add up to its total` };
    columnSum += cents(columnTotal);
    columns.push({ label, total: formatChargeDollars(columnTotal) });
  }
  if (columnSum !== cents(total)) return { failure: 'the column totals do not add up to the form total' };
  return { total, totalText: cleanText(look.grandTotal ?? ''), summary: { label: totalLabel, columns } };
}

type Look = { passed: { total: number; totalText: string; summary: FormMathSummary } } | { failed: string; noTotal: boolean };

async function lookAtForm(
  first: ReimbursementPacket,
  second: ReimbursementPacket,
  fileList: string,
  parts: PacketParts,
  abortSignal: AbortSignal | undefined
): Promise<Look> {
  let look: ReimbursementFormMath;
  try {
    look = await readFormMath(fileList, parts, abortSignal, getOcrModel());
  } catch (error) {
    if (abortSignal?.aborted) throw error;
    return { failed: 'a look at the form could not be completed', noTotal: false };
  }
  const result = formMathResult(look);
  debug('Reimbursement form math look', { first: first.formAmountToPay, second: second.formAmountToPay, look, result });
  return 'total' in result
    ? { passed: { total: result.total, totalText: result.totalText, summary: result.summary } }
    : { failed: result.failure, noTotal: result.noTotal === true };
}

type PassedLook = Extract<Look, { passed: unknown }>['passed'];

function settleLooks(looks: Look[]): { passed: PassedLook[]; agreeing?: PassedLook; conflicting: boolean; noTotal: boolean } {
  const passed = looks.flatMap((look) => ('passed' in look ? [look.passed] : []));
  return {
    passed,
    agreeing: passed.find((candidate) => passed.filter((other) => cents(other.total) === cents(candidate.total)).length >= 2),
    conflicting: new Set(passed.map((look) => cents(look.total))).size > 1,
    noTotal: looks.length > 0 && looks.every((look) => 'failed' in look && look.noTotal),
  };
}

/**
 * The reads did not both give the same readable total, so the form's own arithmetic decides. Arithmetic that holds is
 * not enough on its own: a model that cannot read the scan can build a table that adds up from the receipts behind
 * the form (the live check on the real packet did exactly that on gpt-5.4). So two independent looks, both on the
 * document-reading model, must each pass the arithmetic and read the same total. Two looks run together; further
 * looks (up to `MAX_LOOKS`) run one at a time until two passing looks agree, and stop early when passing looks
 * conflict or the form shows no total. That model often misreads a digit on a scan and the arithmetic rejects it, so
 * a failed look costs time, never a wrong total. The booked total can come from neither full read. A form that shows
 * no total to either read or any look is left as it is, so the packet stops as one that prints no Amount to Pay.
 */
async function confirmFormTotal(
  first: ReimbursementPacket,
  second: ReimbursementPacket,
  fileList: string,
  parts: PacketParts,
  abortSignal: AbortSignal | undefined,
  startedAt: number
): Promise<ReimbursementRead> {
  const timeLeft = () => Date.now() - startedAt < LOOK_BUDGET_MS;
  const looks: Look[] = timeLeft()
    ? await Promise.all([0, 1].map(() => lookAtForm(first, second, fileList, parts, abortSignal)))
    : [];
  let settled = settleLooks(looks);
  while (looks.length < MAX_LOOKS && !settled.agreeing && !settled.conflicting && !settled.noTotal && timeLeft()) {
    looks.push(await lookAtForm(first, second, fileList, parts, abortSignal));
    settled = settleLooks(looks);
  }
  const outOfTime = looks.length < MAX_LOOKS && !settled.agreeing && !settled.conflicting && !settled.noTotal;
  if (settled.agreeing) {
    const { totalText, summary } = settled.agreeing;
    return { ...first, formAmountToPay: totalText, formAmountLabel: summary.label, confirmedByFormMath: summary };
  }
  if (settled.noTotal && isBlank(first.formAmountToPay) && isBlank(second.formAmountToPay)) return first;

  const failures = looks.flatMap((look) => ('failed' in look ? [look.failed] : []));
  if (settled.passed.length > 0) failures.push('no two looks at the form both passed and read the same total');
  if (outOfTime) failures.push('there was not enough time left to look at the form again');
  return {
    ...first,
    formAmountToPay: null,
    formAmountLabel: null,
    unconfirmed: "the form's Amount to Pay",
    unconfirmedDetail: [...new Set(failures)].join('; '),
    notConfirmed: ['formAmount'],
  };
}

/**
 * Reads the packet when the email or file names mention reimbursement. Returns undefined when nothing hints at one or
 * no document can be read. A model or schema failure throws (after one retry), so a packet that may be a reimbursement
 * is never silently booked as a supplier invoice. A packet the first read calls a reimbursement is read a second time
 * by a different model, and the result is marked `unconfirmed` when the two reads disagree on who is paid or on the
 * email's amount. A form total both reads found is booked as read. Otherwise (one read found none, the reads found
 * different totals, or neither found one) the form's own arithmetic decides; see `confirmFormTotal`.
 */
export async function readReimbursementPacket(
  attachments: PresignedAttachment[],
  emailContext: EmailContextInput,
  abortSignal?: AbortSignal
): Promise<ReimbursementRead | undefined> {
  if (!hasReimbursementSignal(emailContext, attachments.map((attachment) => attachment.fileName))) return undefined;
  const startedAt = Date.now();
  const readable = await convertOfficeAttachmentsForModel(attachments);
  const parts = attachmentContentParts(readable);
  if (parts.length === 0) {
    debug('Reimbursement packet read skipped: no PDF or image attachments');
    return undefined;
  }
  const fileList = readable.map((attachment) => `${attachment.fileName} (${attachment.contentType})`).join('; ');
  const first = await readPacketOnce(fileList, parts, emailContext, abortSignal);
  if (first.kind !== 'reimbursement') return first;

  const second = await readPacketOnce(fileList, parts, emailContext, abortSignal, true);
  const others = disagreements(first, second, false);
  const amountAgreed = agreedFormAmount(first, second) !== undefined;
  if (others.length > 0) {
    debug('Reimbursement packet reads disagree', { disagreement: others.map((item) => item.phrase), first, second });
    const notConfirmed = new Set<NotConfirmedFact>(others.flatMap((item) => (item.field ? [item.field] : [])));
    if (!amountAgreed) notConfirmed.add('formAmount');
    return {
      ...first,
      ...(amountAgreed ? {} : { formAmountToPay: null, formAmountLabel: null }),
      unconfirmed: others[0].phrase,
      notConfirmed: [...notConfirmed],
    };
  }
  if (!amountAgreed) return confirmFormTotal(first, second, fileList, parts, abortSignal, startedAt);
  const agreedLabel = payableTotalLabel(first.formAmountLabel);
  const sameLabel = agreedLabel !== undefined && agreedLabel.toLowerCase() === payableTotalLabel(second.formAmountLabel)?.toLowerCase();
  return sameLabel ? first : { ...first, formAmountLabel: null };
}

function cents(amount: number): number {
  return Math.round(amount * 100);
}

const ALL_FACTS: NotConfirmedFact[] = ['payeeName', 'formAmount', 'emailAmount'];

// A fact the reads did not agree on is the first read's guess, so it never reaches AP as "on the form".
function manual(packet: ReimbursementRead, reason: string): ReimbursementDecision {
  const hidden = new Set<NotConfirmedFact>(packet.unconfirmed ? packet.notConfirmed ?? ALL_FACTS : []);
  return {
    outcome: 'manual_entry',
    manual: {
      reason,
      ...(packet.payeeName?.trim() && !hidden.has('payeeName') ? { payeeName: packet.payeeName.trim() } : {}),
      ...(packet.formAmountToPay?.trim() && !hidden.has('formAmount') ? { formAmount: readableText(packet.formAmountToPay) } : {}),
      ...(packet.emailAmount?.trim() && !hidden.has('emailAmount') ? { emailAmount: readableText(packet.emailAmount) } : {}),
      ...(hidden.size > 0 ? { notConfirmed: [...hidden] } : {}),
    },
  };
}

function unconfirmedReason(packet: ReimbursementRead): string {
  return packet.unconfirmedDetail === undefined
    ? `two reads of the packet disagreed on ${packet.unconfirmed}`
    : `the reads of the packet did not give one confirmed Amount to Pay, and the form's own totals could not confirm it (${packet.unconfirmedDetail})`;
}

type AmountResult = { amount: number; emailCap?: number } | { failure: string };

/** The form's Amount to Pay is exact. An email amount must equal it, or be a limit the form stays within. */
function approvedAmount(packet: ReimbursementPacket): AmountResult {
  if (!packet.formAmountToPay?.trim()) return { failure: 'the reimbursement form prints no Amount to Pay' };
  const amount = parseFormAmountToPay(packet.formAmountToPay);
  if (amount === undefined) return { failure: `the form's Amount to Pay "${readableText(packet.formAmountToPay)}" could not be read as a dollar amount` };
  if (cents(amount) <= 0) return { failure: 'the form\'s Amount to Pay is zero' };

  if (!packet.emailAmount?.trim()) return { amount };
  const emailAmount = parseEmailAmount(packet.emailAmount);
  if (emailAmount === undefined) return { failure: `the email's amount "${readableText(packet.emailAmount)}" could not be read as a dollar amount` };
  if (packet.emailAmountIsCap === true) {
    if (cents(amount) > cents(emailAmount)) {
      return { failure: `the form's Amount to Pay ${formatChargeDollars(amount)} is above the email's limit of ${formatChargeDollars(emailAmount)}` };
    }
    return { amount, emailCap: emailAmount };
  }
  if (cents(amount) !== cents(emailAmount)) {
    return { failure: `the form's Amount to Pay ${formatChargeDollars(amount)} and the email's ${formatChargeDollars(emailAmount)} disagree` };
  }
  return { amount };
}

function clean(value: string | null | undefined): string | undefined {
  const text = (value ?? '').replace(/[|<>\p{Cc}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, DESCRIPTION_LIMIT) : undefined;
}

export function reimbursementDescription(packet: Pick<ReimbursementPacket, 'expenseKind' | 'purpose'>): string {
  const kind = clean(packet.expenseKind);
  const purpose = clean(packet.purpose);
  const head = kind ? `${kind.charAt(0).toUpperCase()}${kind.slice(1)} reimbursement` : 'Expense reimbursement';
  return purpose ? `${head} - ${purpose}` : head;
}

type PayeeResult = AppliedReimbursement['payee'] | { failure: string };

async function resolvePayee(
  db: DatabaseConnection,
  packet: ReimbursementPacket,
  defaultSupplierWid: string | undefined
): Promise<PayeeResult> {
  const nameOnForm = packet.payeeName?.trim();
  if (!nameOnForm) return { failure: 'the packet does not name the person to pay' };

  const printedId = packet.payeeSupplierId?.match(SUPPLIER_ID_PATTERN)?.[0];
  if (printedId) {
    const supplierId = printedId.toUpperCase();
    const [hint] = await resolveSupplierIdHints(db, [supplierId]);
    if (!hint) return { failure: `Supplier ID ${supplierId} is not in the supplier cache` };
    if (!hint.supplierName || !supplierNamesMatch(nameOnForm, hint.supplierName)) {
      return { failure: `Supplier ID ${supplierId} belongs to ${hint.supplierName ?? 'a supplier with no name'}, which does not match ${nameOnForm}` };
    }
    if (hint.workdayId === defaultSupplierWid) return { failure: `Supplier ID ${supplierId} is the default supplier` };
    return { workdayId: hint.workdayId, supplierName: hint.supplierName, supplierId, nameOnForm, matchedBy: 'supplier_id' };
  }

  const match = await findUniqueSupplierByNameEvidence(db, {
    printedName: nameOnForm,
    excludeWorkdayIds: [defaultSupplierWid],
  });
  if (!match) return { failure: `no single supplier in the cache matches the payee name ${nameOnForm}` };
  return {
    workdayId: match.workdayId,
    supplierName: match.supplierName,
    ...(match.supplierId ? { supplierId: match.supplierId } : {}),
    nameOnForm,
    matchedBy: 'name',
  };
}

/**
 * Turns a read packet into either the payee and approved amount to invoice, a manual-entry stop, or "not a
 * reimbursement". Anything not picked confidently stops: nothing is written to Workday.
 */
export async function decideReimbursement(
  db: DatabaseConnection,
  packet: ReimbursementRead | undefined,
  options: { defaultSupplierWid?: string } = {}
): Promise<ReimbursementDecision> {
  if (!packet || packet.kind !== 'reimbursement') return { outcome: 'not_reimbursement' };
  if (packet.confidence < MIN_CONFIDENCE) {
    return manual(packet, 'the packet looks like a reimbursement but the read was not confident enough to book it');
  }

  if (packet.unconfirmed) {
    return manual(packet, unconfirmedReason(packet));
  }

  const amount = approvedAmount(packet);
  if ('failure' in amount) return manual(packet, amount.failure);

  // The invoice number is built from the supplier name and this date. Without it the draft has no number, and a
  // re-trigger of the conversation would create a second draft to the same person.
  const invoiceDate = normalizePrintedDate(packet.formDate);
  if (!invoiceDate) return manual(packet, 'the reimbursement form prints no readable date, so the invoice would have no number to stop a duplicate');

  const totalLabel = packet.confirmedByFormMath?.label ?? payableTotalLabel(packet.formAmountLabel);
  const payee = await resolvePayee(db, packet, options.defaultSupplierWid);
  if ('failure' in payee) return manual(packet, payee.failure);

  return {
    outcome: 'apply',
    reimbursement: {
      payee,
      amount: amount.amount,
      amountLabel: formatChargeDollars(amount.amount),
      ...(totalLabel ? { totalLabel } : {}),
      ...(amount.emailCap !== undefined ? { emailCap: amount.emailCap } : {}),
      ...(packet.confirmedByFormMath ? { confirmedByFormMath: packet.confirmedByFormMath } : {}),
      invoiceDate,
      description: reimbursementDescription(packet),
    },
  };
}

function supplierReason(reimbursement: AppliedReimbursement): string {
  const { payee } = reimbursement;
  const matched = payee.matchedBy === 'supplier_id' ? `Supplier ID ${payee.supplierId} and name` : 'exact name';
  return `Reimbursement payee ${payee.nameOnForm} matched Workday supplier ${payee.supplierId ? `${payee.supplierId} ` : ''}${payee.supplierName} by ${matched}. The merchant on receipts or folios was not used as the supplier.`;
}

/** The invoice the packet stands for, in place of reading the folio as an invoice. One line at the approved amount. */
export function reimbursementOcr(reimbursement: AppliedReimbursement): InvoiceOcrResult {
  return {
    extractedInvoiceDate: reimbursement.invoiceDate,
    extractedDueDate: null,
    extractedAmountDue: reimbursement.amountLabel,
    extractedSuppliersInvoiceNumber: null,
    invoiceNumbersInDocument: null,
    extractedFreightAmount: null,
    extractedFreightLabel: null,
    extractedTaxAmount: null,
    extractedTaxLabel: null,
    extractedOtherCharges: null,
    extractedSummaryCharges: null,
    extractedLineSubtotal: null,
    extractedPartialPayment: null,
    extractedPriorPayments: null,
    extractedPurchaseOrderNumber: null,
    extractedAccountNumber: null,
    extractedSupplierReference: null,
    extractedSupplierReferenceKind: null,
    extractedCustomerId: null,
    extractedServicePeriod: null,
    extractedPaymentTerms: null,
    invoiceLineQuantityDisplayed: false,
    extractedInvoiceLines: [{
      description: reimbursement.description,
      descriptionCells: null,
      quantity: null,
      unitCost: null,
      totalPrice: reimbursement.amountLabel,
      hasDiscount: false,
      tableNumber: 1,
      sectionLabel: null,
    }],
    printedSupplier: {
      supplierName: reimbursement.payee.nameOnForm,
      address: null,
      phone: null,
      email: null,
      website: null,
      taxId: null,
      industry: null,
      contactPerson: null,
      memo: null,
      remitToAddress: null,
    },
    printedBillTo: { companyName: null, address: null, phone: null, email: null },
  };
}

/**
 * Pins the payee as the supplier and drops what the matching read can say about the folio. The payee came from the
 * packet read and the supplier cache, so the matching model's own supplier pick and any balance-due reading are
 * replaced; its email coding is kept.
 */
export function applyReimbursementToEnrichment(
  result: InvoiceEnrichmentResult,
  reimbursement: AppliedReimbursement
): InvoiceEnrichmentResult {
  const reason = supplierReason(reimbursement);
  return {
    ...result,
    supplier: {
      ...result.supplier,
      status: 'found',
      confidence: 1,
      reason,
      extractedInformation: {
        supplierName: reimbursement.payee.supplierName,
        address: null,
        phone: null,
        email: null,
        website: null,
        taxId: null,
        industry: null,
        contactPerson: null,
        memo: null,
      },
      resolvedSupplier: {
        workdayId: reimbursement.payee.workdayId,
        supplierName: reimbursement.payee.supplierName,
        confidence: 1,
        reason,
      },
      potentialDuplicateSuppliers: null,
      recommendation: { action: 'update_invoice', reason },
    },
    emailBalanceDue: null,
    extractedPurchaseOrderNumber: null,
  };
}

/** Added to the matching model's email text so it codes the reimbursement, not the folio. */
export function reimbursementMatchingContext(reimbursement: AppliedReimbursement): string {
  return `\n\nReimbursement packet: AP asked to pay ${reimbursement.payee.nameOnForm} back ${reimbursement.amountLabel}. The supplier is already fixed to that person. Take the company, cost center, and other coding only from the email text or AP notes. Receipts and folios in the packet are backup, not an invoice.`;
}

/** One paragraph for the Workday invoice notes, claiming only what was submitted. */
export function reimbursementNote(reimbursement: AppliedReimbursement): string {
  const { payee } = reimbursement;
  const who = `${payee.supplierId ? `${payee.supplierId} ` : ''}${payee.supplierName}`;
  const cap = reimbursement.emailCap !== undefined ? ` The email's limit of ${formatChargeDollars(reimbursement.emailCap)} was not exceeded.` : '';
  const math = reimbursement.confirmedByFormMath;
  const columns = math?.columns.map((column) => `${column.label} ${column.total}`).join(', ');
  const checked = math ? ` The reads of the form did not give one agreed total, so it was checked against the form's own arithmetic: the column totals (${columns}) add up to it, and each column's line items add up to its column total.` : '';
  const named = `the ${reimbursement.totalLabel ?? 'Amount to Pay'} on the reimbursement form`;
  return `Reimbursement packet: invoiced to ${who} for ${reimbursement.amountLabel}, ${named}.${cap}${checked} Receipts and folios in the packet are supporting documents only; their rooms, taxes, and totals were not booked.`;
}

/** Lines for the Slack success post. */
export function reimbursementSlackLines(reimbursement: AppliedReimbursement): string[] {
  const { payee } = reimbursement;
  return [
    `Payee: ${payee.supplierName}${payee.supplierId ? ` (${payee.supplierId})` : ''}, matched by ${payee.matchedBy === 'supplier_id' ? 'Supplier ID and name' : 'name'}`,
    `Amount: ${reimbursement.amountLabel} from the form's ${reimbursement.totalLabel ?? 'Amount to Pay'}${reimbursement.emailCap !== undefined ? `, within the email's ${formatChargeDollars(reimbursement.emailCap)} limit` : ''}`,
    ...(reimbursement.confirmedByFormMath
      ? ["Check the total first: the reads of the form did not give one agreed total, and the form's own arithmetic confirmed it (the column totals and each column's line items add up)."]
      : []),
    'Receipts and folios were not booked as invoice lines.',
  ];
}
