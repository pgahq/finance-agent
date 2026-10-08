import { debug } from '@pga/logger';
import { getAiResponse } from './ai.js';
import { getOcrModel } from './models.js';
import { invoiceOcrPrompt, InvoiceOcrSchema, type InvoiceOcrResult } from '../prompts/invoice_ocr_prompt.js';
import type { InvoiceEnrichmentResult, InvoiceMatchingResult } from '../prompts/enrich_invoice_prompt.js';
import type { PresignedAttachment } from './types.js';

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
  const result = await getAiResponse({
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
          { type: 'text', text: `Extract the printed invoice details from the attached documents.\n\nDocuments: ${fileList}${documentRolesText}` },
          ...parts
        ]
      }
    ]
  }) as InvoiceOcrResult;
  debug('Invoice OCR finished', { durationMs: Date.now() - startedAt, documentCount: parts.length, documentBytes });
  debug('Invoice OCR result:', result);
  return result;
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
      extractedAmountDue: null,
      extractedSuppliersInvoiceNumber: null,
      extractedFreightAmount: null,
      extractedFreightLabel: null,
      extractedTaxAmount: null,
      extractedTaxLabel: null,
      extractedPurchaseOrderNumber: null,
      extractedAccountNumber: null,
      extractedJobNumber: null,
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
    extractedAmountDue: ocr.extractedAmountDue,
    extractedSuppliersInvoiceNumber: ocr.extractedSuppliersInvoiceNumber,
    extractedFreightAmount: ocr.extractedFreightAmount,
    extractedFreightLabel: ocr.extractedFreightLabel,
    extractedTaxAmount: ocr.extractedTaxAmount,
    extractedTaxLabel: ocr.extractedTaxLabel,
    extractedPurchaseOrderNumber: ocr.extractedPurchaseOrderNumber,
    extractedAccountNumber: ocr.extractedAccountNumber,
    extractedJobNumber: ocr.extractedJobNumber,
    extractedCustomerId: ocr.extractedCustomerId,
    extractedServicePeriod: ocr.extractedServicePeriod,
    extractedPaymentTerms: ocr.extractedPaymentTerms
      ? { name: ocr.extractedPaymentTerms.name, workdayId: matching.extractedPaymentTerms?.workdayId ?? null }
      : null,
    invoiceLineQuantityDisplayed: ocr.invoiceLineQuantityDisplayed,
    extractedInvoiceLines: ocr.extractedInvoiceLines,
    emailWorktags: matching.emailWorktags,
  };
}
