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
import { normalizePrintedDate } from '../prompts/invoice_ocr_prompt.js';
import { dayMonthYearReading } from './due_date.js';
import { withComposedLineDescriptions, type EmailBudgetSplitOutcome } from './invoice_lines.js';
import { defaultModel } from './models.js';
import { type PurchaseOrderEnrichmentContext } from './purchase_order.js';
import {
  MAX_POSSIBLE_SUPPLIERS,
  findSupplierByDistinctiveWord,
  findUniqueSupplierByNameEvidence,
  printedSupplierNameCandidates,
  supplierRecordFromDocument,
  type PossibleSupplier,
  type SupplierNameMatch,
} from './supplier_match.js';
import { queryDocuments } from './rag.js';
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

    // Matching never uses the due date, so it stays out of the matching prompt.
    const { extractedDueDate: _unusedDueDate, ...ocrForMatching } = ocr ?? {};
    const documentExtractionText = ocr
      ? `\n\nInvoice document extraction (read from the invoice documents by a separate OCR pass):\n${JSON.stringify(ocrForMatching, null, 2)}`
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

    const merged = mergeInvoiceEnrichment(matching, ocr);
    return existingSupplier ? merged : await resolveSupplierByNameEvidence(merged, ocr?.printedSupplier.remitToAddress);

  } catch (error) {
    debug('Error in invoice enrichment:', error);
    throw error;
  }
}

const NAME_EVIDENCE_CONFIDENCE = 0.85;
const DISTINCTIVE_WORD_CONFIDENCE = 0.8;
const NAME_SEARCH_LIMIT = 5;
const NAME_SEARCH_MIN_SIMILARITY = 0.6;

function describeSupplier(supplier: { supplierId?: string; supplierName: string }): string {
  return `${supplier.supplierId ? `${supplier.supplierId} ` : ''}${supplier.supplierName}`;
}

/**
 * A name-only vector search (no address, phone, or industry in the query) for suppliers the model's combined
 * query ranked low. Its results are only ever listed for AP; they never pick a supplier.
 */
async function nameOnlySupplierCandidates(
  printedName: string,
  excluded: Set<string>
): Promise<PossibleSupplier[]> {
  const queries = printedSupplierNameCandidates(printedName).slice(0, 2);
  const found = new Map<string, PossibleSupplier>();
  for (const query of queries) {
    const results = await queryDocuments({
      query,
      documentType: 'supplier',
      limit: NAME_SEARCH_LIMIT,
      similarityThreshold: NAME_SEARCH_MIN_SIMILARITY,
    });
    debug('Supplier name-only search', {
      query,
      candidates: results.map((result) => {
        const record = supplierRecordFromDocument(result);
        return { workdayId: result.workday_id, supplierId: record.supplierId, supplierName: record.supplierName, alternateNames: record.alternateNames, similarity: result.similarity.toFixed(3) };
      }),
    });
    for (const result of results) {
      if (excluded.has(result.workday_id) || found.has(result.workday_id)) continue;
      const record = supplierRecordFromDocument(result);
      found.set(result.workday_id, {
        workdayId: result.workday_id,
        ...(record.supplierId ? { supplierId: record.supplierId } : {}),
        supplierName: record.supplierName,
        reason: `name search "${query}" scored ${result.similarity.toFixed(2)}`,
      });
    }
  }
  return [...found.values()];
}

/**
 * A branch prints its own address and phone, which the parent supplier record does not carry, and a printed name
 * can carry words the record lacks, so the model scores such a match low and reports not_found. A supplier is found
 * when the remit-to company or the printed name equals exactly one cached supplier's name or alternate name, or when
 * a distinctive word of the printed name is on exactly one supplier. When no supplier can be picked, the near
 * candidates are listed in the supplier note instead. A model result that is not not_found stays as decided.
 */
export async function resolveSupplierByNameEvidence(
  result: InvoiceEnrichmentResult,
  remitToAddress: string | null | undefined
): Promise<InvoiceEnrichmentResult> {
  if (result.supplier.status !== 'not_found') return result;

  const printedName = result.supplier.extractedInformation.supplierName;
  const excludeWorkdayIds = [process.env.WORKDAY_DEFAULT_SUPPLIER_WID];
  let match: SupplierNameMatch | undefined;
  let confidence = NAME_EVIDENCE_CONFIDENCE;
  let wordPossible: PossibleSupplier[] = [];
  let byWord = false;
  try {
    const db = await getDatabaseConnection(process.env);
    match = await findUniqueSupplierByNameEvidence(db, { printedName, remitToAddress, excludeWorkdayIds });
    if (!match) {
      const lookup = await findSupplierByDistinctiveWord(db, { printedName, phone: result.supplier.extractedInformation.phone, excludeWorkdayIds });
      match = lookup.match;
      wordPossible = lookup.possible;
      byWord = Boolean(match);
      confidence = DISTINCTIVE_WORD_CONFIDENCE;
    }
  } catch (error) {
    debug('Supplier name evidence lookup failed; keeping the not_found result:', error);
    return result;
  }

  if (match) {
    const note = byWord
      ? `${match.evidence.join('; ')}. The rest of the printed name, the address, and the phone are not required to match the supplier record; confirm ${describeSupplier(match)}.`
      : `${match.evidence.join('; ')}. The printed branch address and phone are not required to match the supplier record; confirm ${describeSupplier(match)}.`;
    return {
      ...result,
      supplier: {
        ...result.supplier,
        status: 'found',
        confidence,
        resolvedSupplier: {
          workdayId: match.workdayId,
          supplierName: match.supplierName,
          confidence,
          reason: note,
        },
        potentialDuplicateSuppliers: null,
        recommendation: { action: 'update_invoice', reason: note },
        reason: `${note} Model result before the name check: ${result.supplier.reason}`,
      },
    };
  }

  const excluded = new Set(excludeWorkdayIds.filter((id): id is string => Boolean(id)));
  let searched: PossibleSupplier[] = [];
  if (printedName) {
    try {
      searched = await nameOnlySupplierCandidates(printedName, excluded);
    } catch (error) {
      debug('Supplier name-only search failed; listing only the word matches:', error);
    }
  }
  const possible = [...new Map([...wordPossible, ...searched].map((supplier) => [supplier.workdayId, supplier])).values()].slice(0, MAX_POSSIBLE_SUPPLIERS);
  if (possible.length === 0) return result;

  const listed = possible.map((supplier) => `${describeSupplier(supplier)} (${supplier.reason})`).join('; ');
  return {
    ...result,
    supplier: {
      ...result.supplier,
      reason: `${result.supplier.reason} Possible Workday suppliers the agent did not apply because no single supplier was a confident match, confirm before using one: ${listed}.`,
    },
  };
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

export function formatTaxAmountNotes(taxAmount: string | undefined, taxCleared: boolean, breakdown?: string): string {
  if (taxCleared) return '\n\nTax Amount (from document): none';
  if (!taxAmount) return '';
  return `\n\nTax Amount (from document): ${taxAmount}${breakdown ? ` (${breakdown})` : ''}`;
}

export function formatChargeReviewNotes(reviewNote: string | undefined): string {
  return reviewNote ? `\n\nFreight/Tax review: ${reviewNote}` : '';
}

export function formatLineTotalReviewNotes(reviewNote: string | undefined): string {
  return reviewNote ? `\n\nLine total review: ${reviewNote}` : '';
}

export function formatPositivePoQuantityNotes(note: string | undefined): string {
  return note ? `\n\nPO line quantity: ${note}` : '';
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
    'extractedAccountNumber' | 'extractedSupplierReference' | 'extractedSupplierReferenceKind' | 'extractedCustomerId' | 'extractedServicePeriod'
  >
): string {
  const parts: string[] = [];
  if (result.extractedAccountNumber) {
    parts.push(`Account Number (from document): ${result.extractedAccountNumber}`);
  }
  if (result.extractedSupplierReference) {
    const kind = result.extractedSupplierReferenceKind?.trim();
    const label = kind ? `${kind.charAt(0).toUpperCase()}${kind.slice(1).toLowerCase()} ` : '';
    parts.push(`Supplier Reference (from document): ${label}${result.extractedSupplierReference}`);
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
  if (wt.spendCategory?.extracted) {
    const resolved = wt.spendCategory.referenceId ? ` (resolved: ${wt.spendCategory.name ?? wt.spendCategory.referenceId})` : ' (no Workday match found)';
    parts.push(`Spend Category: ${wt.spendCategory.extracted}${resolved}`);
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

function formatBudgetAmount(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

// One line per budget the invoice was split into, for the Workday note and Slack.
export function describeEmailBudgetSplit(outcome: EmailBudgetSplitOutcome | undefined): string[] {
  if (!outcome?.applied) return [];
  return outcome.budgets.map(budget => {
    const coding = [
      budget.companyId && `Company ${budget.companyId}`,
      budget.costCenterId && `Cost Center ${budget.costCenterId}`,
      budget.spendCategoryId && `Spend Category ${budget.spendCategoryId}`,
    ].filter(Boolean).join(', ');
    return `${formatBudgetAmount(budget.amountCents)} ${budget.label}${coding ? ` (${coding})` : ''}`;
  });
}

// The cost centers the email's budgets name, for the enrich Slack suggestion when no invoice-wide cost center exists.
export function suggestedBudgetCostCenters(
  splits: InvoiceEnrichmentResult['emailBudgetSplits'] | undefined
): Array<{ code?: string | null; name: string }> | undefined {
  const centers = (splits ?? [])
    .map(split => split?.costCenter)
    .filter((costCenter): costCenter is NonNullable<typeof costCenter> => Boolean(costCenter))
    .map(costCenter => ({ name: costCenter.name ?? costCenter.extracted ?? '', code: costCenter.code }));
  return centers.length ? centers : undefined;
}

export function formatEmailBudgetSplitNotes(outcome: EmailBudgetSplitOutcome | undefined): string {
  if (!outcome) return '';
  if (!outcome.applied) return outcome.review ? `\n\nBudget split review: ${outcome.review}` : '';
  const scaled = outcome.headerChargesRolledIn
    ? `. The email's amounts total ${formatBudgetAmount(outcome.headerChargesRolledIn.amountDueCents)}, the full amount due, so each budget line carries its share of the ${formatBudgetAmount(outcome.headerChargesRolledIn.amountDueCents - outcome.headerChargesRolledIn.lineTotalCents)} of tax and freight and the invoice header tax and freight were cleared`
    : '';
  const review = outcome.review ? `\n\nBudget split review: ${outcome.review}` : '';
  return `\n\nEmail budget split (one invoice line per budget): ${describeEmailBudgetSplit(outcome).join('; ')}${scaled}${review}`;
}

export function formatInvoiceDateNotes(result: InvoiceEnrichmentResult): string {
  if (result.extractedInvoiceDate) {
    return `\n\nInvoice Date (from document): ${result.extractedInvoiceDate}`;
  }

  const fallbackInvoiceDate = getFirstDayOfCurrentMonth();
  return `\n\nInvoice Date: Date was not extracted from the document and defaulted to the beginning of the current month (${fallbackInvoiceDate}).`;
}

/**
 * A due-date fallback means the printed date was not sent as Due_Date_Override. The invoice keeps the due date
 * Workday already had (its current override, or the one derived from the payment terms), except after a
 * payment-schedules fault, where no override is sent.
 */
export function formatDueDateNotes(
  result: InvoiceEnrichmentResult,
  appliedFallbacks: Array<{ field?: string; label?: string }> = [],
): string {
  const dueDate = normalizePrintedDate(result.extractedDueDate);
  if (!dueDate) {
    return result.extractedDueDate?.trim() ? '\n\nDue Date (from document): unreadable, not sent' : '';
  }
  const flipped = dayMonthYearReading(result.extractedInvoiceDate, dueDate);
  const flipNote = flipped
    ? ` The printed dates may be day/month/year: read that way, the invoice date is ${flipped.invoiceDate} and the due date is ${flipped.dueDate}. Check the invoice.`
    : '';
  const fallback = appliedFallbacks.find((f) => f.field === 'dueDate');
  if (!fallback) return `\n\nDue Date (from document): ${dueDate}${flipNote}`;
  const label = fallback.label ?? '';
  const reason = label === 'omitted due date'
    ? 'Workday rejected it, so the retry kept the invoice\'s current due date'
    : label.startsWith('omitted due date and the current override')
      ? 'Workday allows no due date override on an invoice with payment schedules, so the retry sent none'
      : label.startsWith('due date not applied') && label.includes('is earlier than')
        ? 'not sent because it is earlier than the invoice date'
        : label.startsWith('due date not applied') && label.includes('days after invoice date')
          ? `not sent because it is ${label.match(/more than \d+ days/)?.[0] ?? 'too far'} after the invoice date; check the year`
          : `not sent: ${label}`;
  return `\n\nDue Date (from document): ${dueDate} (${reason})${flipNote}`;
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
