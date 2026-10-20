import type { InvoiceEnrichmentResult } from '../prompts/enrich_invoice_prompt.js';
import { expectedAmountDueCents, expectedMerchandiseCents, type EmailBudgetSplit, type EmailWorktags, type LineTotalCharges } from './invoice_lines.js';
import { costCenterCodeExcludingCompany, type EmailCompanyMatch } from './reference_ids.js';

type EmailCoding = {
  costCenter?: { code?: string | null } | null;
  event?: { workdayId?: string | null } | null;
  lineOfBusiness?: { referenceId?: string | null } | null;
  fund?: { referenceId?: string | null } | null;
  spendCategory?: { referenceId?: string | null } | null;
};

function lineCoding(coding: EmailCoding, emailCompany?: EmailCompanyMatch) {
  return {
    costCenterId: costCenterCodeExcludingCompany(coding.costCenter?.code, emailCompany),
    eventWid: coding.event?.workdayId ?? null,
    lobReferenceId: coding.lineOfBusiness?.referenceId ?? null,
    fundReferenceId: coding.fund?.referenceId ?? null,
    spendCategoryReferenceId: coding.spendCategory?.referenceId ?? null,
  };
}

export interface EmailWorktagOptions {
  /** Merchandise total the email's budgets must cover (amount due less header freight and tax). */
  budgetSplitBaseCents?: number | null;
  /** Amount due, which the email's budgets may total instead when they include header freight and tax. */
  budgetSplitGrossCents?: number | null;
  /** Why a budget split must not apply to this invoice, when the caller already knows. */
  budgetSplitBlockedReason?: string | null;
}

// Builds the line coding that email text supplies. An email that divides the cost across several budgets
// carries each budget's own coding in budgetSplits; the invoice-wide fields hold only what every budget shares.
export function buildEmailWorktags(
  result: Pick<InvoiceEnrichmentResult, 'emailWorktags' | 'emailBudgetSplits'>,
  emailCompany?: EmailCompanyMatch,
  options: EmailWorktagOptions = {}
): EmailWorktags | undefined {
  const rawSplits = (result.emailBudgetSplits ?? []).filter(split => split != null);
  if (!result.emailWorktags && rawSplits.length === 0) return undefined;

  const shared = lineCoding(result.emailWorktags ?? {}, emailCompany);
  const splits: EmailBudgetSplit[] = rawSplits.map(split => ({
    label: split.label,
    amount: split.amount,
    percent: split.percent,
    equalShare: split.equalShare,
    ...lineCoding(split, emailCompany),
    companyReferenceId: split.company?.referenceId ?? null,
    companyName: split.company?.name ?? null,
  }));

  // One budget is not a split: its coding is the invoice's coding.
  if (splits.length === 1) {
    const [only] = splits;
    return {
      costCenterId: only.costCenterId ?? shared.costCenterId,
      eventWid: only.eventWid ?? shared.eventWid,
      lobReferenceId: only.lobReferenceId ?? shared.lobReferenceId,
      fundReferenceId: only.fundReferenceId ?? shared.fundReferenceId,
      spendCategoryReferenceId: only.spendCategoryReferenceId ?? shared.spendCategoryReferenceId,
    };
  }

  return {
    ...shared,
    ...(splits.length > 1 ? {
      budgetSplits: splits,
      budgetSplitBaseCents: options.budgetSplitBaseCents ?? null,
      budgetSplitGrossCents: options.budgetSplitGrossCents ?? null,
      companyReferenceId: emailCompany?.referenceId ?? null,
      budgetSplitBlockedReason: options.budgetSplitBlockedReason ?? null,
    } : {}),
  };
}

// A budget split must cover exactly the merchandise total (or the amount due, scaled to it), so it needs readable header charges and goods lines.
export function budgetSplitOptions(args: {
  charges: LineTotalCharges;
  freightAsLines?: boolean;
  chargeWithheld?: boolean;
}): EmailWorktagOptions {
  if (args.freightAsLines) return { budgetSplitBlockedReason: 'the invoice is an all-freight bill' };
  if (args.chargeWithheld) return { budgetSplitBlockedReason: 'a freight or tax amount on the invoice could not be read' };
  const baseCents = expectedMerchandiseCents(args.charges);
  if (baseCents == null) return { budgetSplitBlockedReason: 'the invoice amount due could not be read' };
  return { budgetSplitBaseCents: baseCents, budgetSplitGrossCents: expectedAmountDueCents(args.charges) ?? null };
}
