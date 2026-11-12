import type { InvoiceEnrichmentResult } from '../prompts/enrich_invoice_prompt.js';
import { budgetSplitCents, type LineTotalCharges } from './invoice_lines.js';
import { budgetSplitOptions, buildEmailWorktags } from './email_worktags.js';
import type { EmailCompanyMatch } from './reference_ids.js';

export const EMAIL_CODING_OVERRIDES_PO_ENV_VAR = 'EMAIL_CODING_OVERRIDES_PO_SUPPLIER_WIDS';

/**
 * Workday supplier WIDs whose invoices are coded from the email's budget splits instead of a printed PO.
 * Everywhere else a PO keeps its own coding. The list is an SSM parameter, so a missing or empty value
 * (and any other supplier) leaves the PO in charge.
 */
export function emailCodingOverridesPoSupplierWids(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set((env[EMAIL_CODING_OVERRIDES_PO_ENV_VAR] ?? '').split(/[\s,]+/).map(normalizeWid).filter(Boolean));
}

function normalizeWid(wid: string | null | undefined): string {
  return (wid ?? '').trim().toLowerCase();
}

export interface EmailCodingOverPurchaseOrderInput {
  invoiceSupplierWorkdayId?: string | null;
  /** An AP Intercom note named the PO, which is AP's explicit choice and always wins. */
  purchaseOrderFromNote?: boolean;
  /** The requester's email names a PO other than the one printed on the invoice, so the requester chose it. */
  purchaseOrderNamedInEmail?: boolean;
  result: Pick<InvoiceEnrichmentResult, 'emailWorktags' | 'emailBudgetSplits' | 'extractedAmountDue' | 'extractedFreightAmount' | 'extractedTaxAmount'>;
  emailCompany?: EmailCompanyMatch;
  env?: NodeJS.ProcessEnv;
}

/**
 * Decides, before any line is built, whether the email's budget splits replace the printed PO for this invoice.
 * All of these must hold: the invoice's resolved supplier is on the supplier list, the PO was not chosen by an
 * AP note or named in the requester's email, and the email gives two or more budget splits that can be applied,
 * meaning each budget has coding and the shares reconcile to the invoice amounts. Anything else keeps the PO.
 * Only the invoice's own supplier is matched, so the invoice's supplier never changes when the PO is set aside.
 */
export function emailCodingOverPurchaseOrder(input: EmailCodingOverPurchaseOrderInput): boolean {
  if (input.purchaseOrderFromNote || input.purchaseOrderNamedInEmail) return false;
  const suppliers = emailCodingOverridesPoSupplierWids(input.env);
  const invoiceSupplierWid = normalizeWid(input.invoiceSupplierWorkdayId);
  if (!invoiceSupplierWid || !suppliers.has(invoiceSupplierWid)) return false;

  const charges: LineTotalCharges = {
    amountDue: input.result.extractedAmountDue ?? undefined,
    freightAmount: input.result.extractedFreightAmount ?? undefined,
    taxAmount: input.result.extractedTaxAmount ?? undefined,
  };
  const options = budgetSplitOptions({ charges });
  if (options.budgetSplitBlockedReason || options.budgetSplitBaseCents == null) return false;
  const emailWorktags = buildEmailWorktags(input.result, input.emailCompany, options);
  const splits = emailWorktags?.budgetSplits;
  if (!splits || splits.length < 2) return false;
  if (splits.some(split => !split.costCenterId && !split.spendCategoryReferenceId)) return false;
  const shares = budgetSplitCents(splits, options.budgetSplitBaseCents, options.budgetSplitGrossCents);
  return Boolean(shares.cents);
}

export function formatPurchaseOrderSkippedNotes(purchaseOrderNumber: string): string {
  return `\n\nPurchase order: ${purchaseOrderNumber} on the invoice was not used. The email gives budget coding and this supplier's invoices are coded from the email; the invoice is not linked to a PO.`;
}
