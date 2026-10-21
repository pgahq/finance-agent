import type { InvoiceEnrichmentResult } from '../prompts/enrich_invoice_prompt.js';
import { expectedAmountDueCents, expectedMerchandiseCents, type EmailBudgetSplit, type EmailWorktags, type LineTotalCharges } from './invoice_lines.js';
import type { DatabaseConnection } from './database.js';
import {
  companyReferenceIdForWorkdayId,
  costCenterCodeExcludingCompany,
  resolveBudgetSplitCompanies,
  type BudgetCompanyResolution,
  type EmailCompanyMatch,
} from './reference_ids.js';

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
  /** Each budget's company after `resolveBudgetSplitCompanies`, in the order of the email's budgets. */
  budgetCompanies?: Array<BudgetCompanyResolution | undefined>;
  /**
   * Company_Reference_ID of the company the header will be submitted under, or null when it is not known.
   * Left undefined only by callers that have no header company, which falls back to the email's company.
   */
  headerCompanyReferenceId?: string | null;
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
  const splits: EmailBudgetSplit[] = rawSplits.map((split, index) => {
    const company = options.budgetCompanies?.[index];
    const coding = lineCoding(split, emailCompany);
    return {
      label: split.label,
      amount: split.amount,
      percent: split.percent,
      equalShare: split.equalShare,
      ...coding,
      // A budget's cost center can be its own company's code too.
      costCenterId: costCenterCodeExcludingCompany(coding.costCenterId, company?.referenceId ? { referenceId: company.referenceId } : undefined),
      companyReferenceId: company?.referenceId ?? null,
      companyName: company?.name ?? null,
      companyUnverified: company?.unverified ?? null,
    };
  });

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
      companyReferenceId: options.headerCompanyReferenceId !== undefined ? options.headerCompanyReferenceId : emailCompany?.referenceId ?? null,
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

/**
 * For an email that splits the cost, verifies the company each budget names and finds the Company_Reference_ID of the
 * company the header is submitted under, so a budget is compared with the company that is really on the invoice.
 */
export async function budgetCompanyOptions(args: {
  db: DatabaseConnection;
  result: Pick<InvoiceEnrichmentResult, 'emailBudgetSplits'>;
  emailBody?: string;
  codingText?: string;
  apNotes?: string;
  emailCompany?: EmailCompanyMatch;
  /** The submitted header company: a WID or a Company_Reference_ID, as `companyReferenceType` says. */
  headerCompanyId?: string;
  companyReferenceType?: 'WID' | 'Company_Reference_ID';
}): Promise<Pick<EmailWorktagOptions, 'budgetCompanies' | 'headerCompanyReferenceId'>> {
  const splits = (args.result.emailBudgetSplits ?? []).filter(split => split != null);
  if (splits.length < 2) return {};

  const budgetCompanies = await resolveBudgetSplitCompanies({
    db: args.db,
    emailBody: args.emailBody,
    codingText: args.codingText,
    apNotes: args.apNotes,
    splits,
  });
  if (!budgetCompanies.some(Boolean)) return { budgetCompanies };

  const headerCompanyReferenceId = args.companyReferenceType === 'Company_Reference_ID'
    ? args.headerCompanyId
    : (args.emailCompany?.workdayId && args.emailCompany.workdayId === args.headerCompanyId ? args.emailCompany.referenceId : undefined)
      ?? await companyReferenceIdForWorkdayId(args.db, args.headerCompanyId);
  return { budgetCompanies, headerCompanyReferenceId: headerCompanyReferenceId ?? null };
}
