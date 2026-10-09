import { debug } from '@pga/logger';
import { getAiResponse } from './ai.js';
import { getDatabaseConnection } from './database.js';
import { formatReferenceDirectory, resolveReferenceCodesFromText } from './reference_ids.js';
import {
  extractSupplierNoteHints,
  formatSupplierNoteHintContext,
  hasSupplierNoteHints,
  resolveSupplierIdHints,
  type ResolvedSupplierHint,
} from './supplier_note_hints.js';
import { invoiceMatchingPrompt, InvoiceMatchingSchema, type InvoiceEnrichmentResult, type InvoiceMatchingResult } from '../prompts/enrich_invoice_prompt.js';
import { extractInvoiceDocuments, mergeInvoiceEnrichment, type InvoiceAttachmentRole } from './invoice_ocr.js';
import { withComposedLineDescriptions } from './invoice_lines.js';
import { defaultModel } from './models.js';
import { type PurchaseOrderEnrichmentContext } from './purchase_order.js';
import type { InvoiceData, PresignedAttachment, WorkdayInvoice } from './types.js';

async function buildSupplierHintText(emailContext: InvoiceData['emailContext']): Promise<string> {
  const hints = extractSupplierNoteHints(emailContext?.subject, emailContext?.plainTextBody);
  if (!hasSupplierNoteHints(hints)) return '';

  let resolved: ResolvedSupplierHint[] | undefined = [];
  if (hints.supplierIds.length > 0) {
    try {
      const db = await getDatabaseConnection(process.env);
      resolved = await resolveSupplierIdHints(db, hints.supplierIds);
    } catch (error) {
      debug('Failed to resolve supplier ID hints from email context:', error);
      resolved = undefined;
    }
  }
  const trustedSupplierIds = extractSupplierNoteHints(emailContext?.conversationParts).supplierIds;
  debug('Supplier hints from email context', {
    supplierIds: hints.supplierIds,
    trustedSupplierIds,
    supplierNames: hints.supplierNames,
    resolvedWorkdayIds: resolved?.map((hint) => hint.workdayId),
  });
  return formatSupplierNoteHintContext(hints, resolved, trustedSupplierIds);
}

export type { InvoiceAttachmentRole };

export async function enrichInvoiceFromAttachments(
  invoice: WorkdayInvoice,
  processedAttachments: PresignedAttachment[],
  existingSupplier?: { descriptor: string; id: string },
  existingCompany?: { descriptor: string; id: string },
  emailContext?: InvoiceData['emailContext'],
  purchaseOrder?: PurchaseOrderEnrichmentContext,
  attachmentRoles?: InvoiceAttachmentRole[],
  abortSignal?: AbortSignal
): Promise<InvoiceEnrichmentResult> {
  debug('Enriching invoice:', invoice.Invoice_Number);

  try {
    const ocr = await extractInvoiceDocuments(processedAttachments, attachmentRoles, abortSignal);

    const company = existingCompany
      ? { name: existingCompany.descriptor, id: existingCompany.id }
      : undefined;

    const invoiceData = {
      existingSupplier: existingSupplier
        ? { name: existingSupplier.descriptor, id: existingSupplier.id }
        : undefined,
      existingCompany: company,
      companyName: existingCompany?.descriptor || invoice.OCRSupplierInvoice?.descriptor,
      address: extractAddressFromInvoice(invoice),
      phone: extractPhoneFromInvoice(invoice),
      email: extractEmailFromInvoice(invoice),
      invoiceNumber: invoice.Invoice_Number,
      currentInvoiceDate: invoice.Invoice_Date,
      amount: invoice.controlTotalAmount,
      attachments: processedAttachments.map(att => ({
        fileName: att.fileName,
        contentType: att.contentType,
        presignedUrl: att.presignedUrl
      })),
      emailContext,
      purchaseOrder,
    };

    let referenceDirectoryText = '';
    if (emailContext?.plainTextBody) {
      try {
        const db = await getDatabaseConnection(process.env);
        const resolved = await resolveReferenceCodesFromText(db, emailContext.plainTextBody);
        referenceDirectoryText = formatReferenceDirectory(resolved);
      } catch (error) {
        debug('Failed to pre-resolve email reference codes:', error);
      }
    }

    const emailContextText = emailContext
      ? `\n\nAdditional context from inbound email:\nFrom: ${emailContext.emailFrom || 'N/A'}\nSubject: ${emailContext.subject || 'N/A'}\nBody: ${emailContext.plainTextBody || 'N/A'}${referenceDirectoryText}`
      : '';
    const supplierHintText = await buildSupplierHintText(emailContext);

    const purchaseOrderText = purchaseOrder
      ? `\n\nMatching Workday purchase order ${purchaseOrder.documentNumber}:${purchaseOrder.company ? `\nPO Company: ${purchaseOrder.company.name} (WID: ${purchaseOrder.company.workdayId})` : ''}\nPO Lines: ${JSON.stringify(purchaseOrder.lines, null, 2)}`
      : '';

    const existingSupplierText = existingSupplier
      ? `\nExisting Supplier: ${existingSupplier.descriptor} (ID: ${existingSupplier.id})`
      : '\nExisting Supplier: None (supplier has not been assigned yet)';

    const existingCompanyText = company
      ? `\nExisting Company: ${company.name} (ID: ${company.id})`
      : '';

    const taskDescription = existingSupplier
      ? 'Please verify the supplier and company on this invoice'
      : 'Please identify the supplier and verify the company on this invoice';

    const poInstructions = purchaseOrder
      ? ' A matching Workday purchase order is included — use its company as the billed-entity signal when email coding does not identify a company. Do not recommend a different company from the invoice PDF over the PO company.'
      : '';

    const companySearchInstructions = ' When calling findCompanies, pass the billed company name or Company_Reference_ID in query and the bill-to street address in address. A billed name can be a Finance Agent alias, not only the legal companyName. Never concatenate street, city, state, or ZIP into query. Name rank is embedding similarity, plus exact companyName / Company_Reference_ID / Finance Agent alias at 1.0, not substring. Address tags (unique / shared / none) are independent of name order. Do not prefer address over name or name over address. Recommend a company when those signals agree; if they disagree, leave workdayId unset.';

    const taskInstructions = existingSupplier
      ? `Use the printed supplier and bill-to company from the invoice document extraction. Compare them with the existing supplier and company. Use the findSuppliers tool if you think the supplier might be different. Use the findCompanies tool if you think the company might be different.${companySearchInstructions} If email context is provided, extract coding including company, cost center, event, LOB, fund, and spend category. Call resolveReferenceCode for short codes before assuming a number is a cost center.${poInstructions}`
      : `Use the findSuppliers tool to search for relevant suppliers and then provide your analysis. Use the printed supplier details in the invoice document extraction to help you identify the supplier. Also verify the company using the findCompanies tool if needed.${companySearchInstructions} If email context is provided, extract coding including company, cost center, event, LOB, fund, and spend category. Call resolveReferenceCode for short codes before assuming a number is a cost center.${poInstructions}`;

    const documentExtractionText = ocr
      ? `\n\nInvoice document extraction (read from the invoice documents by a separate OCR pass):\n${JSON.stringify(ocr, null, 2)}`
      : '\n\nInvoice document extraction: none (no readable PDF or image was attached).';

    const matching = await getAiResponse({
      prompt: invoiceMatchingPrompt,
      schema: InvoiceMatchingSchema,
      model: defaultModel,
      abortSignal,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `${taskDescription}:${existingSupplierText}${existingCompanyText}\n\nInvoice Data: ${JSON.stringify(invoiceData, null, 2)}\n\n${taskInstructions}${documentExtractionText}${emailContextText}${supplierHintText}${purchaseOrderText}`
            }
          ]
        }
      ]
    }) as InvoiceMatchingResult;

    return mergeInvoiceEnrichment(matching, ocr);

  } catch (error) {
    debug('Error in invoice enrichment:', error);
    throw error;
  }
}

export function formatSupplierNotes(result: InvoiceEnrichmentResult): string {
  return `Supplier: ${result.supplier.reason}`;
}

export function formatCompanyNotes(
  result: InvoiceEnrichmentResult,
  existingCompanyDescriptor?: string,
  options?: { appliedRecommended?: boolean; overriddenByEmail?: boolean }
): string {
  const cv = result.companyVerification;
  if (!cv || cv.status === 'matching') return '';
  let notes = `\n\n${options?.overriddenByEmail ? 'Invoice bill-to check' : 'Company'}: ${cv.reason}`;
  if (cv.status === 'different' && cv.recommended && options?.appliedRecommended !== false) {
    notes += ` Changed to: ${cv.recommended.companyName}${existingCompanyDescriptor ? ` (was: ${existingCompanyDescriptor})` : ''}`;
  }
  return notes;
}

export interface EmailCompanyReview {
  appliedName?: string;
  referenceId?: string;
  origin?: 'code' | 'name';
  conflictWith?: 'po' | 'bill_to';
  /** Name of the PO company or bill-to company the email company replaced. */
  conflictName?: string;
}

/** One line saying where the applied company came from, and whether it replaced a different verified company. */
export function describeEmailCompanyReview(review: EmailCompanyReview): { note: string; review?: string } {
  const name = review.appliedName ?? review.referenceId ?? 'the email company';
  const source = review.origin === 'name'
    ? 'the company named in the email'
    : `email coding${review.referenceId ? ` (code ${review.referenceId})` : ''}`;
  const note = `Company applied from ${source}: ${name}.`;
  if (!review.conflictWith) return { note };
  const other = review.conflictWith === 'po'
    ? `the purchase order company${review.conflictName ? ` (${review.conflictName})` : ''}`
    : `the invoice bill-to company${review.conflictName ? ` (${review.conflictName})` : ''}`;
  return {
    note: `${note} This differs from ${other}; verify the company before approving.`,
    review: `Company ${name} ${review.origin === 'name' ? 'was named in the email' : `came from email coding${review.referenceId ? ` ${review.referenceId}` : ''}`} but differs from ${other}; verify.`,
  };
}

export function formatEmailCompanyNotes(review: EmailCompanyReview): string {
  return `\n\n${describeEmailCompanyReview(review).note}`;
}

function getFirstDayOfCurrentMonth(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = `${now.getUTCMonth() + 1}`.padStart(2, '0');
  return `${year}-${month}-01`;
}

export function formatAmountNotes(result: InvoiceEnrichmentResult): string {
  if (!result.extractedAmountDue) return '';
  return `\n\nInvoice Amount (from document): ${result.extractedAmountDue}`;
}

export function formatFreightAmountNotes(freightAmount: string | undefined, freightCleared: boolean): string {
  if (freightCleared) return '\n\nFreight Amount (from document): none';
  if (!freightAmount) return '';
  return `\n\nFreight Amount (from document): ${freightAmount}`;
}

export function formatTaxAmountNotes(taxAmount: string | undefined, taxCleared: boolean): string {
  if (taxCleared) return '\n\nTax Amount (from document): none';
  if (!taxAmount) return '';
  return `\n\nTax Amount (from document): ${taxAmount}`;
}

export function formatChargeReviewNotes(reviewNote: string | undefined): string {
  return reviewNote ? `\n\nFreight/Tax review: ${reviewNote}` : '';
}

export function formatLineTotalReviewNotes(reviewNote: string | undefined): string {
  return reviewNote ? `\n\nLine total review: ${reviewNote}` : '';
}

export function formatRepeatedLineNotes(note: string | undefined): string {
  return note ? `\n\nRepeated line review: ${note}` : '';
}

export function formatInvoiceNumberNotes(result: InvoiceEnrichmentResult): string {
  if (!result.extractedSuppliersInvoiceNumber) return '';
  return `\n\nSupplier Invoice Number (from document): ${result.extractedSuppliersInvoiceNumber}`;
}

export function formatPurchaseOrderNotes(result: InvoiceEnrichmentResult): string {
  if (!result.extractedPurchaseOrderNumber) return '';
  return `\n\nPurchase Order Number (from document): ${result.extractedPurchaseOrderNumber}`;
}

export function formatMemoIdentifierNotes(
  result: Pick<
    InvoiceEnrichmentResult,
    'extractedAccountNumber' | 'extractedJobNumber' | 'extractedCustomerId' | 'extractedServicePeriod'
  >
): string {
  const parts: string[] = [];
  if (result.extractedAccountNumber) {
    parts.push(`Account Number (from document): ${result.extractedAccountNumber}`);
  }
  if (result.extractedJobNumber) {
    parts.push(`Job Number (from document): ${result.extractedJobNumber}`);
  }
  if (result.extractedCustomerId) {
    parts.push(`Customer ID (from document): ${result.extractedCustomerId}`);
  }
  if (result.extractedServicePeriod) {
    parts.push(`Service Period (from document): ${result.extractedServicePeriod}`);
  }
  return parts.length ? `\n\n${parts.join('\n\n')}` : '';
}

export function formatPaymentTermsNotes(result: InvoiceEnrichmentResult): string {
  if (!result.extractedPaymentTerms) return '';
  const { name, workdayId } = result.extractedPaymentTerms;
  const resolvedSuffix = workdayId ? ` (resolved: ${workdayId})` : ' (no Workday match found)';
  return `\n\nPayment Terms (from document): ${name}${resolvedSuffix}`;
}

export function formatWorkQueueAssigneeNotes(
  appliedFallbacks: Array<{ label?: string }>,
  options: {
    assigneeEmail?: string;
    assigneeName?: string;
    assigneeSetInWorkday: boolean;
  },
): string {
  const email = options.assigneeEmail?.trim();
  if (!email && !options.assigneeSetInWorkday) {
    return '';
  }

  const displayName = options.assigneeName?.trim();
  const person = displayName && email
    ? `${displayName} (${email})`
    : (displayName ?? email ?? 'Unknown');
  const assigneeOmitted = appliedFallbacks.some((fallback) => fallback.label === 'omitted assignee');

  if (assigneeOmitted && email) {
    return `\n\nWork queue assignee: ${person} (not applied in Workday)`;
  }
  if (options.assigneeSetInWorkday) {
    return `\n\nWork queue assignee: ${person}`;
  }
  if (email) {
    return `\n\nWork queue assignee: not set (${email}; no active worker match in cache)`;
  }
  return '';
}

export function formatInvoiceLinesNotes(
  result: InvoiceEnrichmentResult,
  resolvedInvoiceLineQuantityDisplayed?: boolean
): string {
  if (!result.extractedInvoiceLines?.length) return '';
  const lineTexts = withComposedLineDescriptions(result.extractedInvoiceLines).map((line, i) => {
    const parts = [line.description];
    if (line.quantity != null) parts.push(`Qty: ${line.quantity}`);
    if (line.unitCost) parts.push(`Unit Cost: ${line.unitCost}`);
    if (line.totalPrice) parts.push(`Total: ${line.totalPrice}`);
    return `${i + 1}. ${parts.join(' | ')}`;
  });
  const quantityDisplayed = resolvedInvoiceLineQuantityDisplayed ?? result.invoiceLineQuantityDisplayed;
  const noQtyNote = quantityDisplayed === false
    ? '\n(Document has no quantity column — lines will submit with Quantity 0 and Extended Amount from line total.)'
    : '';
  return `\n\nInvoice Lines (from document):\n${lineTexts.join('\n')}${noQtyNote}`;
}

export function formatEmailWorktagNotes(result: InvoiceEnrichmentResult): string {
  const wt = result.emailWorktags;
  if (!wt) return '';
  const parts: string[] = [];
  if (wt.costCenter?.extracted) {
    const resolved = wt.costCenter.code ? ` (resolved: ${wt.costCenter.name ?? wt.costCenter.code})` : ' (no Workday match found)';
    parts.push(`Cost Center: ${wt.costCenter.extracted}${resolved}`);
  }
  if (wt.event?.extracted) {
    const resolved = wt.event.workdayId ? ' (resolved)' : ' (no Workday match found)';
    parts.push(`Event: ${wt.event.extracted}${resolved}`);
  }
  if (wt.lineOfBusiness?.extracted) {
    const resolved = wt.lineOfBusiness.referenceId ? ` (resolved: ${wt.lineOfBusiness.referenceId})` : ' (no Workday match found)';
    parts.push(`Line of Business: ${wt.lineOfBusiness.extracted}${resolved}`);
  }
  if (wt.fund?.extracted) {
    const resolved = wt.fund.referenceId ? ` (resolved: ${wt.fund.referenceId})` : ' (no Workday match found)';
    parts.push(`Fund: ${wt.fund.extracted}${resolved}`);
  }
  if (wt.company?.extracted) {
    const resolved = wt.company.workdayId || wt.company.referenceId
      ? ` (resolved: ${wt.company.name ?? wt.company.referenceId ?? wt.company.workdayId})`
      : ' (no Workday match found)';
    parts.push(`Company: ${wt.company.extracted}${resolved}`);
  }
  if (!parts.length) return '';
  return `\n\nEmail Worktags: ${parts.join('; ')}`;
}

export function formatInvoiceDateNotes(result: InvoiceEnrichmentResult): string {
  if (result.extractedInvoiceDate) {
    return `\n\nInvoice Date (from document): ${result.extractedInvoiceDate}`;
  }

  const fallbackInvoiceDate = getFirstDayOfCurrentMonth();
  return `\n\nInvoice Date: Date was not extracted from the document and defaulted to the beginning of the current month (${fallbackInvoiceDate}).`;
}

// Helper functions to extract data from invoice
function extractAddressFromInvoice(invoice: WorkdayInvoice): string | undefined {
  if (invoice.allAddresses && invoice.allAddresses.length > 0) {
    return invoice.allAddresses.map(addr => addr.descriptor).join(', ');
  }
  return undefined;
}

function extractPhoneFromInvoice(invoice: WorkdayInvoice): string | undefined {
  if (invoice.allPhoneNumbers && invoice.allPhoneNumbers.length > 0) {
    return invoice.allPhoneNumbers.map(phone => phone.descriptor).join(', ');
  }
  return undefined;
}

function extractEmailFromInvoice(invoice: WorkdayInvoice): string | undefined {
  if (invoice.allEmailAddresses && invoice.allEmailAddresses.length > 0) {
    return invoice.allEmailAddresses.map(email => email.descriptor).join(', ');
  }
  return undefined;
}
