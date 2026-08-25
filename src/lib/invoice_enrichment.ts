import { debug } from '@pga/logger';
import { getAiResponse } from './ai.js';
import { getDatabaseConnection } from './database.js';
import { formatReferenceDirectory, resolveReferenceCodesFromText } from './reference_ids.js';
import { invoiceEnrichmentPrompt, InvoiceEnrichmentSchema, type InvoiceEnrichmentResult } from '../prompts/enrich_invoice_prompt.js';
import { type PurchaseOrderEnrichmentContext } from './purchase_order.js';
import type { InvoiceData, PresignedAttachment, WorkdayInvoice } from './types.js';

function attachmentContentParts(processedAttachments: PresignedAttachment[]): Array<
  { type: 'file'; data: Buffer; mediaType: string; filename: string }
  | { type: 'image'; image: URL }
> {
  const parts: Array<
    { type: 'file'; data: Buffer; mediaType: string; filename: string }
    | { type: 'image'; image: URL }
  > = [];

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

export async function enrichInvoiceFromAttachments(
  invoice: WorkdayInvoice,
  processedAttachments: PresignedAttachment[],
  existingSupplier?: { descriptor: string; id: string },
  existingCompany?: { descriptor: string; id: string },
  emailContext?: InvoiceData['emailContext'],
  purchaseOrder?: PurchaseOrderEnrichmentContext
): Promise<InvoiceEnrichmentResult> {
  debug('Enriching invoice:', invoice.Invoice_Number);

  try {
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
      ? ' A matching Workday purchase order is included — use its company as the strongest billed-entity signal, and use its lines as context when extracting invoice lines.'
      : '';

    const taskInstructions = existingSupplier
      ? `Extract supplier and company information from the invoice attachments. Compare them with the existing supplier and company. Use the findSuppliers tool if you think the supplier might be different. Use the findCompanies tool if you think the company might be different. If email context is provided, extract coding including company, cost center, event, LOB, fund, and spend category. Call resolveReferenceCode for short codes before assuming a number is a cost center.${poInstructions}`
      : `Use the findSuppliers tool to search for relevant suppliers and then provide your analysis. Reference the invoice attachments to help you identify the supplier. Also verify the company using the findCompanies tool if needed. If email context is provided, extract coding including company, cost center, event, LOB, fund, and spend category. Call resolveReferenceCode for short codes before assuming a number is a cost center.${poInstructions}`;

    const result = await getAiResponse({
      prompt: invoiceEnrichmentPrompt,
      schema: InvoiceEnrichmentSchema,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `${taskDescription}:${existingSupplierText}${existingCompanyText}\n\nInvoice Data: ${JSON.stringify(invoiceData, null, 2)}\n\n${taskInstructions}${emailContextText}${purchaseOrderText}`
            },
            ...attachmentContentParts(processedAttachments)
          ]
        }
      ]
    });

    return result as InvoiceEnrichmentResult;

  } catch (error) {
    debug('Error in invoice enrichment:', error);
    throw error;
  }
}

export function formatSupplierNotes(result: InvoiceEnrichmentResult): string {
  return `Supplier: ${result.supplier.reason}`;
}

export function formatCompanyNotes(result: InvoiceEnrichmentResult, existingCompanyDescriptor?: string): string {
  const cv = result.companyVerification;
  if (!cv || cv.status === 'matching') return '';
  let notes = `\n\nCompany: ${cv.reason}`;
  if (cv.status === 'different' && cv.recommended) {
    notes += ` Changed to: ${cv.recommended.companyName}${existingCompanyDescriptor ? ` (was: ${existingCompanyDescriptor})` : ''}`;
  }
  return notes;
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

export function formatFreightAmountNotes(result: InvoiceEnrichmentResult): string {
  if (!result.extractedFreightAmount) return '';
  return `\n\nFreight Amount (from document): ${result.extractedFreightAmount}`;
}

export function formatTaxAmountNotes(result: InvoiceEnrichmentResult): string {
  if (!result.extractedTaxAmount) return '';
  return `\n\nTax Amount (from document): ${result.extractedTaxAmount}`;
}

export function formatInvoiceNumberNotes(result: InvoiceEnrichmentResult): string {
  if (!result.extractedSuppliersInvoiceNumber) return '';
  return `\n\nSupplier Invoice Number (from document): ${result.extractedSuppliersInvoiceNumber}`;
}

export function formatPurchaseOrderNotes(result: InvoiceEnrichmentResult): string {
  if (!result.extractedPurchaseOrderNumber) return '';
  return `\n\nPurchase Order Number (from document): ${result.extractedPurchaseOrderNumber}`;
}

export function formatPaymentTermsNotes(result: InvoiceEnrichmentResult): string {
  if (!result.extractedPaymentTerms) return '';
  const { name, workdayId } = result.extractedPaymentTerms;
  const resolvedSuffix = workdayId ? ` (resolved: ${workdayId})` : ' (no Workday match found)';
  return `\n\nPayment Terms (from document): ${name}${resolvedSuffix}`;
}

export function formatInvoiceLinesNotes(result: InvoiceEnrichmentResult): string {
  if (!result.extractedInvoiceLines?.length) return '';
  const lineTexts = result.extractedInvoiceLines.map((line, i) => {
    const parts = [line.description];
    if (line.quantity != null) parts.push(`Qty: ${line.quantity}`);
    if (line.unitCost) parts.push(`Unit Cost: ${line.unitCost}`);
    if (line.totalPrice) parts.push(`Total: ${line.totalPrice}`);
    return `${i + 1}. ${parts.join(' | ')}`;
  });
  return `\n\nInvoice Lines (from document):\n${lineTexts.join('\n')}`;
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
