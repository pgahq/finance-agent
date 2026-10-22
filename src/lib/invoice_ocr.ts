import { debug } from '@pga/logger';
import { getAiResponse } from './ai.js';
import { getOcrModel } from './models.js';
import { invoiceOcrPrompt, InvoiceOcrSchema, normalizeInvoiceOcrResult, type InvoiceOcrResponse, type InvoiceOcrResult } from '../prompts/invoice_ocr_prompt.js';
import type { InvoiceEnrichmentResult, InvoiceMatchingResult } from '../prompts/enrich_invoice_prompt.js';
import type { PresignedAttachment } from './types.js';
import { lineSubtotalShortfallCents, sumExtractedLineCents } from './partial_payment.js';
import { formatChargeDollars, parseCanonicalChargeAmount } from './invoice_lines.js';

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

// Returns undefined when no PDF or image can be read. A model or schema failure throws; there is no fallback model.
export async function extractInvoiceDocuments(
  processedAttachments: PresignedAttachment[],
  attachmentRoles?: InvoiceAttachmentRole[],
  abortSignal?: AbortSignal
): Promise<InvoiceOcrResult | undefined> {
  const parts = attachmentContentParts(processedAttachments);
  if (parts.length === 0) {
    debug('Invoice OCR skipped: no PDF or image attachments');
    return undefined;
  }

  const fileList = processedAttachments.map((att) => `${att.fileName} (${att.contentType})`).join('; ');
  const documentRolesText = attachmentRoles?.length
    ? `\n\nDocument roles: ${attachmentRoles.map((role) => `${role.fileName} is ${role.role === 'invoice' ? 'the supplier invoice' : 'supporting backup'}`).join('; ')}. Extract header, lines, and amounts from the supplier invoice. Use supporting files only as backup context — do not extract a separate invoice from them.`
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

  const retryInstruction = missingRowsInstruction(result);
  if (retryInstruction) {
    debug('Invoice OCR lines fall short of the printed line total; reading the lines once more');
    try {
      const retried = await read(retryInstruction);
      const retriedCents = sumExtractedLineCents(retried.extractedInvoiceLines ?? []);
      // A second read replaces the first only when it closes the gap to the printed total exactly.
      if (retriedCents !== undefined && retriedCents === lineSubtotalCents(result)) {
        debug('Invoice OCR second read matches the printed line total; using it', { durationMs: Date.now() - startedAt });
        result = { ...result, extractedInvoiceLines: retried.extractedInvoiceLines };
      } else {
        debug('Invoice OCR second read does not match the printed line total; keeping the first read');
      }
    } catch (error) {
      if (abortSignal?.aborted) throw error;
      debug('Invoice OCR second read failed; keeping the first read', error);
    }
  }
  return result;
}

function lineSubtotalCents(result: InvoiceOcrResult): number | undefined {
  const parsed = parseCanonicalChargeAmount(result.extractedLineSubtotal?.amount);
  return parsed === undefined ? undefined : Math.round(parsed * 100);
}

function missingRowsInstruction(result: InvoiceOcrResult): string | undefined {
  const lines = result.extractedInvoiceLines ?? [];
  const shortfall = lineSubtotalShortfallCents(lines, result.extractedLineSubtotal);
  const summed = sumExtractedLineCents(lines);
  if (shortfall === undefined || summed === undefined || !result.extractedLineSubtotal) return undefined;
  return `A first read returned ${lines.length} rows totaling ${formatChargeDollars(summed / 100)}, but the document prints ${result.extractedLineSubtotal.amount} as "${result.extractedLineSubtotal.label}". `
    + 'Read the line table again row by row and return every printed row, including a row that is identical to another row but printed under a different date, event, or section heading.';
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
      extractedFreightAmount: null,
      extractedFreightLabel: null,
      extractedTaxAmount: null,
      extractedTaxLabel: null,
      extractedOtherCharges: null,
      extractedSummaryCharges: null,
      extractedLineSubtotal: null,
      extractedPartialPayment: null,
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
    extractedFreightAmount: ocr.extractedFreightAmount,
    extractedFreightLabel: ocr.extractedFreightLabel,
    extractedTaxAmount: ocr.extractedTaxAmount,
    extractedTaxLabel: ocr.extractedTaxLabel,
    extractedOtherCharges: ocr.extractedOtherCharges,
    extractedSummaryCharges: ocr.extractedSummaryCharges,
    extractedLineSubtotal: ocr.extractedLineSubtotal,
    extractedPartialPayment: ocr.extractedPartialPayment,
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
  };
}
