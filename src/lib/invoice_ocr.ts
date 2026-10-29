import { debug } from '@pga/logger';
import { getAiResponse } from './ai.js';
import { getOcrModel } from './models.js';
import { invoiceOcrPrompt, InvoiceOcrSchema, normalizeInvoiceOcrResult, type InvoiceOcrResponse, type InvoiceOcrResult } from '../prompts/invoice_ocr_prompt.js';
import type { InvoiceEnrichmentResult, InvoiceMatchingResult } from '../prompts/enrich_invoice_prompt.js';
import { officeKind, toModelDocument } from './office_to_pdf.js';
import type { PresignedAttachment } from './types.js';
import { amountDueGapCents, amountDueShortfallCents, lineSubtotalShortfallCents, subtotalFreightCents, sumExtractedLineCents } from './partial_payment.js';
import { summaryCreditCents } from './header_charges.js';
import { formatChargeDollars } from './invoice_lines.js';

export interface InvoiceAttachmentRole {
  fileName: string;
  role: 'invoice' | 'supporting';
}

type AttachmentContentPart =
  | { type: 'file'; data: Buffer; mediaType: string; filename: string }
  | { type: 'image'; image: URL };

export function attachmentContentParts(processedAttachments: PresignedAttachment[]): AttachmentContentPart[] {
  const parts: AttachmentContentPart[] = [];

  for (const att of processedAttachments) {
    if (att.contentType === 'application/pdf' && att.buffer) {
      parts.push({
        type: 'file',
        data: att.buffer,
        mediaType: att.contentType,
        filename: att.fileName
      });
      continue;
    }

    if (att.contentType.startsWith('image/')) {
      parts.push({
        type: 'image',
        image: new URL(att.presignedUrl)
      });
    }
  }

  return parts;
}

// Word and Excel attachments are read as PDFs converted in memory; the stored original is unchanged.
// One that cannot be converted is skipped so the rest of the invoice can still be read.
async function convertOfficeAttachmentsForModel(attachments: PresignedAttachment[]): Promise<PresignedAttachment[]> {
  const converted = await Promise.all(attachments.map(async (att) => {
    if (!att.buffer || !officeKind(att.fileName, att.contentType)) return att;
    const doc = await toModelDocument({ fileName: att.fileName, contentType: att.contentType, buffer: att.buffer });
    return doc ? { ...att, contentType: doc.contentType, buffer: doc.buffer } : undefined;
  }));
  return converted.filter((att): att is PresignedAttachment => att !== undefined);
}

export interface ExtractInvoiceDocumentsOptions {
  /** False when the caller will not submit lines, so a second read to find missing rows would be wasted. Default true. */
  retryMissingRows?: boolean;
  /**
   * A second read takes several times as long as the first (SUPIN-472322: 51 seconds, then 144), and a timed-out
   * run loses the whole invoice, so it is skipped when the first read took longer than this. Default 60 seconds.
   */
  retryMaxFirstReadMs?: number;
}

const DEFAULT_RETRY_MAX_FIRST_READ_MS = 60_000;

// Returns undefined when no PDF or image can be read. A model or schema failure throws; there is no fallback model.
export async function extractInvoiceDocuments(
  processedAttachments: PresignedAttachment[],
  attachmentRoles?: InvoiceAttachmentRole[],
  abortSignal?: AbortSignal,
  options: ExtractInvoiceDocumentsOptions = {}
): Promise<InvoiceOcrResult | undefined> {
  const readable = await convertOfficeAttachmentsForModel(processedAttachments);
  const parts = attachmentContentParts(readable);
  if (parts.length === 0) {
    debug('Invoice OCR skipped: no PDF or image attachments');
    return undefined;
  }

  const readableNames = new Set(readable.map((att) => att.fileName));
  const fileList = readable.map((att) => `${att.fileName} (${att.contentType})`).join('; ');
  const readableRoles = attachmentRoles?.filter((role) => readableNames.has(role.fileName));
  const documentRolesText = readableRoles?.length
    ? `\n\nDocument roles: ${readableRoles.map((role) => `${role.fileName} is ${role.role === 'invoice' ? 'the supplier invoice' : 'supporting backup'}`).join('; ')}. Extract header, lines, and amounts from the supplier invoice. Use supporting files only as backup context — do not extract a separate invoice from them.`
    : '';

  const documentBytes = processedAttachments.reduce((total, att) => total + (att.buffer?.byteLength ?? 0), 0);
  const startedAt = Date.now();
  const read = async (extraInstruction?: string): Promise<InvoiceOcrResult> => {
    const response = await getAiResponse({
      prompt: invoiceOcrPrompt,
      schema: InvoiceOcrSchema,
      model: getOcrModel(),
      tools: {},
      temperature: null,
      abortSignal,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: `Extract the printed invoice details from the attached documents.\n\nDocuments: ${fileList}${documentRolesText}${extraInstruction ? `\n\n${extraInstruction}` : ''}` },
            ...parts
          ]
        }
      ]
    }) as InvoiceOcrResponse;
    return normalizeInvoiceOcrResult(response);
  };

  let result = await read();
  debug('Invoice OCR finished', { durationMs: Date.now() - startedAt, documentCount: parts.length, documentBytes });
  debug('Invoice OCR result:', result);

  const firstReadMs = Date.now() - startedAt;
  const retryPlan = options.retryMissingRows === false ? undefined : missingRowsPlan(result);
  if (retryPlan && firstReadMs > (options.retryMaxFirstReadMs ?? DEFAULT_RETRY_MAX_FIRST_READ_MS)) {
    debug('Invoice OCR missing-row retry', {
      outcome: 'skipped',
      reason: 'slow first read',
      firstRows: result.extractedInvoiceLines?.length ?? 0,
      durationMs: firstReadMs,
      checks: retryPlan.checks,
      amountDueShortfallCents: retryPlan.amountDueShortfall,
      subtotalShortfallCents: retryPlan.subtotalShortfall,
    });
  } else if (retryPlan) {
    const firstRows = result.extractedInvoiceLines ?? [];
    let outcome: 'accepted' | 'rejected' | 'failed' = 'rejected';
    try {
      const retried = await read(retryPlan.instruction);
      const retriedRows = retried.extractedInvoiceLines ?? [];
      const added = rowsAddedBySecondRead(firstRows, retriedRows);
      // A second read replaces the first only when it keeps every first-read row and the rows it adds close the
      // gap to the amount due, or the rows total the printed line total, to the cent, so it can only add rows.
      if (added && secondReadClosesGap(retryPlan, added, retriedRows)) {
        outcome = 'accepted';
        result = {
          ...result,
          extractedInvoiceLines: retriedRows,
          extractedRowsAddedOnSecondRead: added.map(row => ({ description: row.description, totalPrice: row.totalPrice ?? null })),
        };
      }
    } catch (error) {
      if (abortSignal?.aborted) throw error;
      outcome = 'failed';
      debug('Invoice OCR second read failed; keeping the first read', error);
    }
    debug('Invoice OCR missing-row retry', {
      outcome,
      firstRows: firstRows.length,
      durationMs: Date.now() - startedAt,
      checks: retryPlan.checks,
      amountDueShortfallCents: retryPlan.amountDueShortfall,
      subtotalShortfallCents: retryPlan.subtotalShortfall,
    });
  }
  return result;
}

function rowKey(row: { description: string; totalPrice?: string | null }): string {
  return `${row.description.replace(/\s+/g, ' ').trim().toLowerCase()}|${(row.totalPrice ?? '').replace(/[$,\s]/g, '')}`;
}

// The second read's rows that the first read did not have, or undefined when it dropped or changed a first-read row.
function rowsAddedBySecondRead<T extends { description: string; totalPrice?: string | null }>(first: T[], second: T[]): T[] | undefined {
  const remaining = new Map<string, T[]>();
  for (const row of second) remaining.set(rowKey(row), [...(remaining.get(rowKey(row)) ?? []), row]);
  for (const row of first) {
    const candidates = remaining.get(rowKey(row));
    if (!candidates?.length) return undefined;
    candidates.pop();
  }
  const added = [...remaining.values()].flat();
  return added.length > 0 ? added : undefined;
}

interface MissingRowsPlan {
  instruction: string;
  /** Cents the lines, freight, and tax are short of the amount due, when the document makes that checkable. */
  amountDueShortfall?: number;
  /** Set when the rows fall short of the printed line total, so a second read that reaches it exactly is accepted. */
  subtotalShortfall?: number;
  /** The rows' total a second read must reach to close the subtotal shortfall: the printed total less any freight inside it. */
  subtotalRowsCents?: number;
  /** Which checks fired, for the retry log. */
  checks: Array<'amountDue' | 'subtotal'>;
}

function missingRowsPlan(result: InvoiceOcrResult): MissingRowsPlan | undefined {
  const lines = result.extractedInvoiceLines ?? [];
  const summed = sumExtractedLineCents(lines);
  if (summed === undefined) return undefined;
  const gapInput = {
    lines,
    amountDue: result.extractedAmountDue,
    freight: result.extractedFreightAmount,
    tax: result.extractedTaxAmount,
    otherCharges: result.extractedOtherCharges,
    summaryCharges: result.extractedSummaryCharges,
    creditCents: summaryCreditCents(result.extractedSummaryCharges, lines),
    partialPayment: result.extractedPartialPayment,
    priorPayments: result.extractedPriorPayments,
  };
  // Rows, freight, and tax that already reach the amount due leave nothing missing, whatever part of the table a
  // printed subtotal covers (an agreement subtotal can leave a fuel row out).
  if (amountDueGapCents(gapInput) === 0) return undefined;
  const amountDueShortfall = amountDueShortfallCents(gapInput);
  const discountCounted = Boolean(gapInput.creditCents) && (amountDueGapCents({ ...gapInput, creditCents: 0 }) ?? 0) < 0;
  // A subtotal that already contains the freight is compared with the rows without it.
  const subtotalFreight = subtotalFreightCents({
    subtotal: result.extractedLineSubtotal,
    amountDue: result.extractedAmountDue,
    freight: result.extractedFreightAmount,
    tax: result.extractedTaxAmount,
    otherCharges: result.extractedOtherCharges,
    creditCents: gapInput.creditCents,
  }) ?? 0;
  // A row that prints a net-of-discount total never reaches a subtotal printed before discounts.
  const subtotalShortfall = lines.some(line => line.hasDiscount === true)
    ? undefined
    : lineSubtotalShortfallCents(lines, result.extractedLineSubtotal, subtotalFreight);
  if (amountDueShortfall === undefined && subtotalShortfall === undefined) return undefined;

  const parts = [`A first read returned ${lines.length} rows totaling ${formatChargeDollars(summed / 100)}`];
  if (subtotalShortfall !== undefined && result.extractedLineSubtotal) {
    parts[0] += `, but the document prints ${result.extractedLineSubtotal.amount} as "${result.extractedLineSubtotal.label}"${subtotalFreight > 0 ? `, which includes ${formatChargeDollars(subtotalFreight / 100)} of freight` : ''}.`;
  } else {
    parts[0] += '.';
  }
  if (amountDueShortfall !== undefined) {
    parts.push(`With the printed freight and tax${discountCounted ? ' and after the printed discount' : ''}, those rows are ${formatChargeDollars(amountDueShortfall / 100)} short of the amount due ${result.extractedAmountDue}, so printed charges are missing. A section subtotal may cover only some of the rows.`);
  }
  parts.push('Read every table and section again row by row (rental or equipment items, sales or miscellaneous items, delivery, pickup, fuel, and other charge rows) and return every printed row, including a row that is identical to another row but printed under a different date, event, or section heading.');
  return { instruction: parts.join(' '), amountDueShortfall, subtotalShortfall, subtotalRowsCents: subtotalShortfall === undefined ? undefined : subtotalShortfall + summed,
    checks: [...(amountDueShortfall !== undefined ? ['amountDue' as const] : []), ...(subtotalShortfall !== undefined ? ['subtotal' as const] : [])],
  };
}

function secondReadClosesGap(
  plan: MissingRowsPlan,
  added: Array<{ description: string; totalPrice?: string | null }>,
  retriedRows: InvoiceOcrResult['extractedInvoiceLines'] & object
): boolean {
  if (plan.amountDueShortfall !== undefined) {
    const addedRows = retriedRows.filter(row => added.includes(row));
    const addedCents = sumExtractedLineCents(addedRows);
    if (addedCents === plan.amountDueShortfall && addedRows.every(row => (sumExtractedLineCents([row]) ?? -1) >= 0)) return true;
  }
  if (plan.subtotalShortfall !== undefined) {
    const retriedCents = sumExtractedLineCents(retriedRows);
    return retriedCents !== undefined && retriedCents === plan.subtotalRowsCents;
  }
  return false;
}

// OCR values win for every document field; the matching pass supplies supplier, company, coding, and the payment terms ID.
export function mergeInvoiceEnrichment(
  matching: InvoiceMatchingResult,
  ocr: InvoiceOcrResult | undefined
): InvoiceEnrichmentResult {
  if (!ocr) {
    return {
      ...matching,
      extractedInvoiceDate: null,
      extractedDueDate: null,
      extractedAmountDue: null,
      extractedSuppliersInvoiceNumber: null,
      invoiceNumbersInDocument: null,
      extractedFreightAmount: null,
      extractedFreightLabel: null,
      extractedTaxAmount: null,
      extractedTaxLabel: null,
      extractedOtherCharges: null,
      extractedSummaryCharges: null,
      extractedLineSubtotal: null,
      extractedRowsAddedOnSecondRead: null,
      extractedPartialPayment: null,
      extractedPriorPayments: null,
      extractedPurchaseOrderNumber: null,
      extractedAccountNumber: null,
      extractedSupplierReference: null,
      extractedSupplierReferenceKind: null,
      extractedCustomerId: null,
      extractedServicePeriod: null,
      invoiceLineQuantityDisplayed: false,
      extractedInvoiceLines: null,
    };
  }

  const printed = ocr.printedSupplier;
  return {
    supplier: {
      ...matching.supplier,
      extractedInformation: {
        supplierName: printed.supplierName,
        address: printed.address,
        phone: printed.phone,
        email: printed.email,
        taxId: printed.taxId,
        website: printed.website,
        industry: printed.industry,
        contactPerson: printed.contactPerson,
        memo: printed.memo,
      },
    },
    companyVerification: { ...matching.companyVerification, extractedInformation: ocr.printedBillTo },
    emailSummary: matching.emailSummary,
    extractedInvoiceDate: ocr.extractedInvoiceDate,
    extractedDueDate: ocr.extractedDueDate,
    extractedAmountDue: ocr.extractedAmountDue,
    extractedSuppliersInvoiceNumber: ocr.extractedSuppliersInvoiceNumber,
    invoiceNumbersInDocument: ocr.invoiceNumbersInDocument,
    extractedFreightAmount: ocr.extractedFreightAmount,
    extractedFreightLabel: ocr.extractedFreightLabel,
    extractedTaxAmount: ocr.extractedTaxAmount,
    extractedTaxLabel: ocr.extractedTaxLabel,
    extractedOtherCharges: ocr.extractedOtherCharges,
    extractedSummaryCharges: ocr.extractedSummaryCharges,
    extractedLineSubtotal: ocr.extractedLineSubtotal,
    extractedRowsAddedOnSecondRead: ocr.extractedRowsAddedOnSecondRead ?? null,
    extractedPartialPayment: ocr.extractedPartialPayment,
    extractedPriorPayments: ocr.extractedPriorPayments,
    extractedPurchaseOrderNumber: ocr.extractedPurchaseOrderNumber,
    extractedAccountNumber: ocr.extractedAccountNumber,
    extractedSupplierReference: ocr.extractedSupplierReference,
    extractedSupplierReferenceKind: ocr.extractedSupplierReferenceKind,
    extractedCustomerId: ocr.extractedCustomerId,
    extractedServicePeriod: ocr.extractedServicePeriod,
    extractedPaymentTerms: ocr.extractedPaymentTerms
      ? { name: ocr.extractedPaymentTerms.name, workdayId: matching.extractedPaymentTerms?.workdayId ?? null }
      : null,
    invoiceLineQuantityDisplayed: ocr.invoiceLineQuantityDisplayed,
    extractedInvoiceLines: ocr.extractedInvoiceLines,
    emailWorktags: matching.emailWorktags,
    emailBudgetSplits: matching.emailBudgetSplits ?? null,
    emailBalanceDue: matching.emailBalanceDue ?? null,
  };
}
