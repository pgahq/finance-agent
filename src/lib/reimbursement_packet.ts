import { debug } from '@pga/logger';
import { getAiResponse } from './ai.js';
import type { DatabaseConnection } from './database.js';
import { formatChargeDollars, parseCanonicalChargeAmount } from './invoice_lines.js';
import { attachmentContentParts, convertOfficeAttachmentsForModel } from './invoice_ocr.js';
import { supplierNamesMatch } from './po_supplier.js';
import { findUniqueSupplierByNameEvidence } from './supplier_match.js';
import { resolveSupplierIdHints } from './supplier_note_hints.js';
import type { InvoiceData, PresignedAttachment } from './types.js';
import type { InvoiceEnrichmentResult } from '../prompts/enrich_invoice_prompt.js';
import { normalizePrintedDate, type InvoiceOcrResult } from '../prompts/invoice_ocr_prompt.js';
import {
  ReimbursementPacketSchema,
  reimbursementPacketPrompt,
  type ReimbursementPacket,
} from '../prompts/reimbursement_packet_prompt.js';

export type { ReimbursementPacket };

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
  invoiceDate: string | null;
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
const SIGNAL = /\breimburs\w*|\bamount\s+to\s+pay\b|\bexpense\s+report\b/i;
const EMAIL_TEXT_LIMIT = 12_000;
const DESCRIPTION_LIMIT = 120;
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

/**
 * Reads the packet when the email or file names mention reimbursement. Returns undefined when nothing hints at one or
 * no document can be read. A model or schema failure throws, so a packet that may be a reimbursement is never
 * silently booked as a supplier invoice.
 */
export async function readReimbursementPacket(
  attachments: PresignedAttachment[],
  emailContext: EmailContextInput,
  abortSignal?: AbortSignal
): Promise<ReimbursementPacket | undefined> {
  if (!hasReimbursementSignal(emailContext, attachments.map((attachment) => attachment.fileName))) return undefined;
  const readable = await convertOfficeAttachmentsForModel(attachments);
  const parts = attachmentContentParts(readable);
  if (parts.length === 0) {
    debug('Reimbursement packet read skipped: no PDF or image attachments');
    return undefined;
  }
  const fileList = readable.map((attachment) => `${attachment.fileName} (${attachment.contentType})`).join('; ');
  const response = await getAiResponse({
    prompt: reimbursementPacketPrompt,
    schema: ReimbursementPacketSchema,
    tools: {},
    abortSignal,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: `Decide whether this packet is an expense reimbursement.\n\nDocuments: ${fileList}\n\nEmail:\n${emailText(emailContext)}` },
          ...parts,
        ],
      },
    ],
  });
  const parsed = ReimbursementPacketSchema.safeParse(response);
  if (!parsed.success) {
    debug('Reimbursement packet read failed schema validation', { issues: parsed.error.issues });
    throw new Error('Reimbursement packet read returned an unexpected shape');
  }
  debug('Reimbursement packet read', parsed.data);
  return parsed.data;
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
      ...(packet.formAmountToPay?.trim() ? { formAmount: packet.formAmountToPay.trim() } : {}),
      ...(packet.emailAmount?.trim() ? { emailAmount: packet.emailAmount.trim() } : {}),
    },
  };
}

type AmountResult = { amount: number; emailCap?: number } | { failure: string };

/** The form's Amount to Pay is exact. An email amount must equal it, or be a limit the form stays within. */
function approvedAmount(packet: ReimbursementPacket): AmountResult {
  if (!packet.formAmountToPay?.trim()) return { failure: 'the reimbursement form prints no Amount to Pay' };
  const amount = parseCanonicalChargeAmount(packet.formAmountToPay);
  if (amount === undefined) return { failure: `the form's Amount to Pay "${packet.formAmountToPay.trim()}" could not be read as a dollar amount` };
  if (cents(amount) <= 0) return { failure: 'the form\'s Amount to Pay is zero' };

  if (!packet.emailAmount?.trim()) return { amount };
  const emailAmount = parseCanonicalChargeAmount(packet.emailAmount);
  if (emailAmount === undefined) return { failure: `the email's amount "${packet.emailAmount.trim()}" could not be read as a dollar amount` };
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
  const text = (value ?? '').replace(/[|<>\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
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
  packet: ReimbursementPacket | undefined,
  options: { defaultSupplierWid?: string } = {}
): Promise<ReimbursementDecision> {
  if (!packet || packet.kind !== 'reimbursement') return { outcome: 'not_reimbursement' };
  if (packet.confidence < MIN_CONFIDENCE) {
    return manual(packet, 'the packet looks like a reimbursement but the read was not confident enough to book it');
  }

  const amount = approvedAmount(packet);
  if ('failure' in amount) return manual(packet, amount.failure);

  const payee = await resolvePayee(db, packet, options.defaultSupplierWid);
  if ('failure' in payee) return manual(packet, payee.failure);

  return {
    outcome: 'apply',
    reimbursement: {
      payee,
      amount: amount.amount,
      amountLabel: formatChargeDollars(amount.amount),
      ...(amount.emailCap !== undefined ? { emailCap: amount.emailCap } : {}),
      invoiceDate: normalizePrintedDate(packet.formDate),
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
  return `Reimbursement packet: invoiced to ${who} for ${reimbursement.amountLabel}, the Amount to Pay on the reimbursement form.${cap} Receipts and folios in the packet are supporting documents only; their rooms, taxes, and totals were not booked.`;
}

/** Lines for the Slack success post. */
export function reimbursementSlackLines(reimbursement: AppliedReimbursement): string[] {
  const { payee } = reimbursement;
  return [
    `Payee: ${payee.supplierName}${payee.supplierId ? ` (${payee.supplierId})` : ''}, matched by ${payee.matchedBy === 'supplier_id' ? 'Supplier ID and name' : 'name'}`,
    `Amount: ${reimbursement.amountLabel} from the form's Amount to Pay${reimbursement.emailCap !== undefined ? `, within the email's ${formatChargeDollars(reimbursement.emailCap)} limit` : ''}`,
    'Receipts and folios were not booked as invoice lines.',
  ];
}
