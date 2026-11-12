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
  ReimbursementFormTotalSchema,
  ReimbursementPacketSchema,
  reimbursementFormTotalPrompt,
  reimbursementPacketPrompt,
  type ReimbursementFormTotal,
  type ReimbursementPacket,
} from '../prompts/reimbursement_packet_prompt.js';

export type { ReimbursementPacket };

/** The packet as read. `unconfirmed` is set when a second, independent read of a reimbursement disagreed with the first. */
export type ReimbursementRead = ReimbursementPacket & {
  unconfirmed?: string;
  /** One read found the form total and the other did not; a focused look at the form confirmed it. */
  checkedByFocusedLook?: true;
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
  /** The email's own limit when it worded its amount as "up to"; the form amount was checked against it. */
  emailCap?: number;
  /** The form total came from one full read plus a focused look at the form, not from two agreeing reads. */
  checkedByFocusedLook?: true;
  invoiceDate: string;
  description: string;
}

export interface ReimbursementManualEntry {
  reason: string;
  payeeName?: string;
  formAmount?: string;
  emailAmount?: string;
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
const AGGREGATE_ROW = /\bsub[-\s]*totals?\b|\b(?:grand\s+)?totals?\b|\bamount\s+to\s+pay\b/i;
// The figure the focused look reports must sit beside a label for the payable total, never a category or subtotal.
const PAYABLE_TOTAL_LABEL = /^\s*(?:grand\s+)?totals?\s*:?\s*$|\bamount\s+to\s+pay\b|\btotal\s+(?:reimbursement|to\s+be\s+reimbursed)\b/i;
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
  model?: LanguageModel
): Promise<T> {
  let lastFailure: unknown;
  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt += 1) {
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

function readFormTotal(
  fileList: string,
  parts: PacketParts,
  abortSignal: AbortSignal | undefined
): Promise<ReimbursementFormTotal> {
  return readWithRetries(
    'Reimbursement form total',
    ReimbursementFormTotalSchema,
    reimbursementFormTotalPrompt,
    `Read the total to pay and the expense category rows from the reimbursement form.\n\nDocuments: ${fileList}`,
    parts,
    abortSignal,
    getOcrModel()
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

/**
 * One read found a positive Amount to Pay on the form and the other found none. That is a missing total, not a
 * different one, so it is not a disagreement: the caller takes a focused second look at the form's total instead.
 * An amount that is unreadable, zero, or negative on the finding side is not a gap.
 */
export function formAmountGap(first: ReimbursementPacket, second: ReimbursementPacket): { found: string } | undefined {
  const found = isBlank(first.formAmountToPay) ? second.formAmountToPay : first.formAmountToPay;
  if (isBlank(first.formAmountToPay) === isBlank(second.formAmountToPay) || !found) return undefined;
  const amount = amountCents(parseFormAmountToPay(found));
  return amount !== null && amount > 0 ? { found } : undefined;
}

/**
 * What the two reads of one packet disagree on, if anything. Every fact that decides who is paid, how much, and
 * under what number must match. A form total found by one read and missing from the other is not a disagreement;
 * see `formAmountGap`.
 */
export function packetDisagreement(first: ReimbursementPacket, second: ReimbursementPacket): string | undefined {
  if (first.kind !== second.kind) return 'whether it is a reimbursement';
  if (!sameName(first.payeeName, second.payeeName)) return 'the payee';
  if (comparableId(first.payeeSupplierId) !== comparableId(second.payeeSupplierId)) return 'the payee Supplier ID';
  if (!formAmountGap(first, second)
    && amountCents(parseFormAmountToPay(first.formAmountToPay)) !== amountCents(parseFormAmountToPay(second.formAmountToPay))) {
    return "the form's Amount to Pay";
  }
  const firstEmailCents = amountCents(parseEmailAmount(first.emailAmount));
  if (firstEmailCents !== amountCents(parseEmailAmount(second.emailAmount))) return "the email's amount";
  if (firstEmailCents !== null && (first.emailAmountIsCap ?? null) !== (second.emailAmountIsCap ?? null)) {
    return "whether the email's amount is a limit";
  }
  if (normalizePrintedDate(first.formDate) !== normalizePrintedDate(second.formDate)) return 'the form date';
  return undefined;
}

/**
 * Whether a focused look at the form backs the total one read found: it must read the same Amount to Pay, and the
 * form's category rows must be listed and add up to it. The rows only check the total; they are never booked.
 */
export function formTotalFailure(foundAmount: number, look: ReimbursementFormTotal): string | undefined {
  const foundCents = cents(foundAmount);
  const total = isBlank(look.amountToPay) ? undefined : parseFormAmountToPay(look.amountToPay);
  if (total === undefined) {
    return isBlank(look.amountToPay)
      ? 'a focused look at the form found no Amount to Pay'
      : `a focused look read the form's Amount to Pay "${readableText(look.amountToPay ?? '')}", which is not a dollar amount`;
  }
  if (cents(total) !== foundCents) {
    return `a focused look at the form found ${formatChargeDollars(total)}`;
  }
  if (isBlank(look.totalsLabel)) return 'the focused look named no label for the form total';
  if (!PAYABLE_TOTAL_LABEL.test(look.totalsLabel ?? '')) {
    return `the focused look read the form total beside "${readableText(look.totalsLabel ?? '')}", which is not a payable-total label`;
  }
  if (look.categoryLines.length === 0) return 'the form lists no category lines to check the total against';
  let sum = 0;
  for (const line of look.categoryLines) {
    if (isBlank(line.label)) return 'a category line has no label';
    if (AGGREGATE_ROW.test(line.label)) return `the category line "${readableText(line.label)}" is a total, not an expense category`;
    const amount = parseEmailAmount(line.amount);
    if (amount === undefined) {
      return `the form's category line "${readableText(line.label)}" has an amount "${readableText(line.amount)}" that could not be read`;
    }
    sum += cents(amount);
  }
  if (sum !== foundCents) {
    return `the form's category lines add up to ${formatChargeDollars(sum / 100)}, not ${formatChargeDollars(foundAmount)}`;
  }
  return undefined;
}

async function confirmMissingFormTotal(
  first: ReimbursementPacket,
  gap: { found: string },
  fileList: string,
  parts: PacketParts,
  abortSignal: AbortSignal | undefined
): Promise<ReimbursementRead> {
  const found = formatChargeDollars(parseFormAmountToPay(gap.found) ?? 0);
  const unconfirmed = (reason: string): ReimbursementRead => ({
    ...first,
    unconfirmed: `the form's Amount to Pay: one read found ${found} and the other found none, and ${reason}`,
  });
  let look: ReimbursementFormTotal;
  try {
    look = await readFormTotal(fileList, parts, abortSignal);
  } catch (error) {
    if (abortSignal?.aborted) throw error;
    return unconfirmed('the focused look at the form could not be completed');
  }
  const failure = formTotalFailure(parseFormAmountToPay(gap.found) ?? 0, look);
  debug('Reimbursement form total focused look', { found: gap.found, look, failure });
  return failure ? unconfirmed(failure) : { ...first, formAmountToPay: gap.found, checkedByFocusedLook: true };
}

/**
 * Reads the packet when the email or file names mention reimbursement. Returns undefined when nothing hints at one or
 * no document can be read. A model or schema failure throws (after one retry), so a packet that may be a reimbursement
 * is never silently booked as a supplier invoice. A packet the first read calls a reimbursement is read a second time
 * by a different model, and the result is marked `unconfirmed` when the two reads disagree on who is paid or how much.
 * When only one read found the form's total, a focused look at the form's total and category lines decides whether it is
 * confirmed.
 */
export async function readReimbursementPacket(
  attachments: PresignedAttachment[],
  emailContext: EmailContextInput,
  abortSignal?: AbortSignal
): Promise<ReimbursementRead | undefined> {
  if (!hasReimbursementSignal(emailContext, attachments.map((attachment) => attachment.fileName))) return undefined;
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
  const disagreement = packetDisagreement(first, second);
  if (disagreement) {
    debug('Reimbursement packet reads disagree', { disagreement, first, second });
    return { ...first, unconfirmed: disagreement };
  }
  const gap = formAmountGap(first, second);
  return gap ? confirmMissingFormTotal(first, gap, fileList, parts, abortSignal) : first;
}

function cents(amount: number): number {
  return Math.round(amount * 100);
}

function manual(packet: ReimbursementPacket, reason: string): ReimbursementDecision {
  return {
    outcome: 'manual_entry',
    manual: {
      reason,
      ...(packet.payeeName?.trim() ? { payeeName: packet.payeeName.trim() } : {}),
      ...(packet.formAmountToPay?.trim() ? { formAmount: readableText(packet.formAmountToPay) } : {}),
      ...(packet.emailAmount?.trim() ? { emailAmount: readableText(packet.emailAmount) } : {}),
    },
  };
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
    return manual(packet, `two reads of the packet disagreed on ${packet.unconfirmed}`);
  }

  const amount = approvedAmount(packet);
  if ('failure' in amount) return manual(packet, amount.failure);

  // The invoice number is built from the supplier name and this date. Without it the draft has no number, and a
  // re-trigger of the conversation would create a second draft to the same person.
  const invoiceDate = normalizePrintedDate(packet.formDate);
  if (!invoiceDate) return manual(packet, 'the reimbursement form prints no readable date, so the invoice would have no number to stop a duplicate');

  const payee = await resolvePayee(db, packet, options.defaultSupplierWid);
  if ('failure' in payee) return manual(packet, payee.failure);

  return {
    outcome: 'apply',
    reimbursement: {
      payee,
      amount: amount.amount,
      amountLabel: formatChargeDollars(amount.amount),
      ...(amount.emailCap !== undefined ? { emailCap: amount.emailCap } : {}),
      ...(packet.checkedByFocusedLook ? { checkedByFocusedLook: true as const } : {}),
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
    bankingInfoPrinted: false,
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
  const checked = reimbursement.checkedByFocusedLook ? " One of two reads of the form found no Amount to Pay; the total came from the other read and was confirmed by a focused second look at the form, whose category lines add up to it." : '';
  return `Reimbursement packet: invoiced to ${who} for ${reimbursement.amountLabel}, the Amount to Pay on the reimbursement form.${cap}${checked} Receipts and folios in the packet are supporting documents only; their rooms, taxes, and totals were not booked.`;
}

/** Lines for the Slack success post. */
export function reimbursementSlackLines(reimbursement: AppliedReimbursement): string[] {
  const { payee } = reimbursement;
  return [
    `Payee: ${payee.supplierName}${payee.supplierId ? ` (${payee.supplierId})` : ''}, matched by ${payee.matchedBy === 'supplier_id' ? 'Supplier ID and name' : 'name'}`,
    `Amount: ${reimbursement.amountLabel} from the form's Amount to Pay${reimbursement.emailCap !== undefined ? `, within the email's ${formatChargeDollars(reimbursement.emailCap)} limit` : ''}`,
    ...(reimbursement.checkedByFocusedLook
      ? ["Check the total first: one read found no Amount to Pay, and a focused second look confirmed it with the category lines adding up."]
      : []),
    'Receipts and folios were not booked as invoice lines.',
  ];
}
