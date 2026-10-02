import type { FieldChange, ScoredFieldName } from './invoice_snapshots.js';

/** Supplier invoice states the scorer acts on. Anything that is not Draft and not terminal is treated as entered. */
export type StatusClass = 'draft' | 'entry' | 'approved' | 'paid' | 'denied' | 'canceled' | 'not_found';

export interface InvoiceStatusRow {
  workdayID: string;
  invoiceStatusAsText?: string;
  isCanceled?: unknown;
  invoiceIsPaid?: unknown;
  invoiceIsPartiallyPaid?: unknown;
  cancelReason?: string;
  holdReason?: string;
}

export interface StatusConfig {
  draft: string[];
  approved: string[];
  denied: string[];
  canceled: string[];
}

function listFromEnv(value: string | undefined, fallback: string[]): string[] {
  const parsed = (value ?? '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  return parsed.length ? parsed : fallback.map((item) => item.toLowerCase());
}

/**
 * Status text values are tenant configuration, so each list can be overridden without a release
 * (comma-separated `SCORE_*_STATUSES`).
 */
export function statusConfigFromEnv(env: NodeJS.ProcessEnv = process.env): StatusConfig {
  return {
    draft: listFromEnv(env.SCORE_DRAFT_STATUSES, ['Draft']),
    approved: listFromEnv(env.SCORE_APPROVED_STATUSES, ['Approved']),
    denied: listFromEnv(env.SCORE_DENIED_STATUSES, ['Denied']),
    canceled: listFromEnv(env.SCORE_CANCELED_STATUSES, ['Canceled', 'Cancelled']),
  };
}

export function isTruthyFlag(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

export function classifyStatus(row: InvoiceStatusRow | undefined, config: StatusConfig = statusConfigFromEnv()): StatusClass {
  if (!row) return 'not_found';
  const status = (row.invoiceStatusAsText ?? '').trim().toLowerCase();
  if (isTruthyFlag(row.isCanceled) || config.canceled.includes(status)) return 'canceled';
  if (isTruthyFlag(row.invoiceIsPaid) || isTruthyFlag(row.invoiceIsPartiallyPaid)) return 'paid';
  if (config.denied.includes(status)) return 'denied';
  if (config.approved.includes(status)) return 'approved';
  if (config.draft.includes(status)) return 'draft';
  return 'entry';
}

export function isTerminalStatus(statusClass: StatusClass): boolean {
  return statusClass !== 'draft' && statusClass !== 'entry';
}

/** A change here means the agent got the coding or extraction wrong. */
export const MATERIAL_FIELDS: ReadonlySet<ScoredFieldName> = new Set<ScoredFieldName>([
  'supplier',
  'company',
  'invoiceDate',
  'controlTotal',
  'line.amount',
  'line.purchaseOrderLine',
  'line.spendCategory',
  'line.costCenter',
  'line.fund',
  'line.lineOfBusiness',
  'line.otherWorktags',
  'line.added',
  'line.removed',
]);

/** A change here may be a house convention rather than an agent miss, so it is reported apart. */
export const CONVENTION_FIELDS: ReadonlySet<ScoredFieldName> = new Set<ScoredFieldName>([
  'memo',
  'suppliersInvoiceNumber',
  'line.memo',
  'line.itemDescription',
]);

export type ChangeCategory = 'material' | 'convention';

export interface ScoredChange extends FieldChange {
  category: ChangeCategory;
  /** False when the enrich agent left this field as OCR had it, so AP fixed OCR, not the agent. */
  agentOwned: boolean;
}

export function categoryOf(field: ScoredFieldName): ChangeCategory {
  return MATERIAL_FIELDS.has(field) ? 'material' : 'convention';
}

/**
 * Tags each AP change with its category and whether the agent owned the field. For an enrich invoice,
 * the agent only owns the fields it changed from the OCR baseline; line fields count as owned when
 * the agent changed that field on any line.
 */
export function scoreChanges(changes: FieldChange[], agentChangedFields?: Iterable<ScoredFieldName>): ScoredChange[] {
  const owned = agentChangedFields ? new Set(agentChangedFields) : undefined;
  return changes.map((change) => ({
    ...change,
    category: categoryOf(change.field),
    agentOwned: isAgentOwned(change.field, owned),
  }));
}

function isAgentOwned(field: ScoredFieldName, owned: Set<ScoredFieldName> | undefined): boolean {
  if (!owned) return true;
  if (field === 'line.added' || field === 'line.removed') {
    return owned.has('line.added') || owned.has('line.removed') || owned.has('line.amount');
  }
  return owned.has(field);
}

export function countsAgainstAgent(change: ScoredChange): boolean {
  return change.category === 'material' && change.agentOwned;
}

export type Outcome =
  | 'submitted_clean'
  | 'submitted_edited'
  | 'canceled'
  | 'deleted'
  | 'denied'
  | 'stuck_draft'
  | 'lost_to_refresh';

/** Final status recorded when a sandbox refresh removed an invoice the agent wrote there. */
export const LOST_TO_REFRESH_STATUS = 'Lost to tenant refresh';

/**
 * UTC weekday (0 = Sunday … 6 = Saturday) when the Workday tenant is overwritten with a copy of
 * production. Only the implementation tenant is refreshed, so only dev sets `SCORE_TENANT_REFRESH_WEEKDAY`.
 */
export function tenantRefreshWeekday(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const value = env.SCORE_TENANT_REFRESH_WEEKDAY?.trim();
  return value && /^[0-6]$/.test(value) ? Number(value) : undefined;
}

/** Start (00:00 UTC) of the most recent refresh day on or before `now`. */
export function lastTenantRefresh(now: Date, weekday: number): Date {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysBack = (start.getUTCDay() - weekday + 7) % 7;
  return new Date(start.getTime() - daysBack * 86_400_000);
}

export function entryOutcome(changes: ScoredChange[]): Outcome {
  return changes.some(countsAgainstAgent) ? 'submitted_edited' : 'submitted_clean';
}

export type CancelAttribution = 'agent' | 'business' | 'unattributed';

export type CancelBasis =
  | 'ap_label'
  | 'agent_reason'
  | 'agent_tag'
  | 'business_reason'
  | 'duplicate_reason'
  | 'replacement'
  | 'duplicate'
  | 'wrong_document'
  | 'per_pdf_without_clustering'
  | 'supplier_void_or_credit'
  | 'early_draft_cancel'
  | 'no_signal';

export interface CancelReasonMapping {
  business: string[];
  duplicate: string[];
  agent: string[];
  agentTags: string[];
}

/**
 * `CANCEL_REASON_ATTRIBUTION` JSON, for example
 * `{"business":["INVOICE_CANCEL_REASON-3-3"],"duplicate":[],"agent":[],"agentTags":["FINAGENT-agent-error"]}`.
 * Entries match a cancel reason's name or reference ID. No existing cancel reason points at the agent,
 * so `agent` starts empty. Invalid JSON is ignored.
 */
export function cancelReasonMappingFromEnv(env: NodeJS.ProcessEnv = process.env): CancelReasonMapping {
  const empty: CancelReasonMapping = { business: [], duplicate: [], agent: [], agentTags: [] };
  const raw = env.CANCEL_REASON_ATTRIBUTION?.trim();
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw) as Partial<Record<keyof CancelReasonMapping, unknown>>;
    const list = (value: unknown) => (Array.isArray(value) ? value : [])
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim().toLowerCase());
    return {
      business: list(parsed.business),
      duplicate: list(parsed.duplicate),
      agent: list(parsed.agent),
      agentTags: list(parsed.agentTags),
    };
  } catch {
    return empty;
  }
}

export interface CancelEvidence {
  /** AP's label from cancel_labels, which overrides every rule. */
  apLabel?: 'agent' | 'business';
  /** The cancel reason's name when Workday returned one, else its reference ID. */
  cancelReason?: string;
  /** Every ID on the cancel reason reference (for example `INVOICE_CANCEL_REASON-3-3` and its WID). */
  cancelReasonIds?: string[];
  workQueueTags?: string[];
  /** A live invoice with the same supplier invoice number that the agent did not create. */
  replacement?: { workdayInvoiceWid: string; workdayInvoiceNumber?: string; diff?: FieldChange[] };
  /** A live invoice with the same supplier and invoice number that the agent also created. */
  duplicate?: { workdayInvoiceWid: string; workdayInvoiceNumber?: string };
  primaryAttachmentKind?: string;
  clusteringMode?: string;
  agentInvoicesInConversation?: number;
  supplierVoidOrCreditInThread?: boolean;
  /** The invoice was canceled without AP ever submitting it. */
  canceledWhileDraft?: boolean;
  hoursFromLastAgentWrite?: number;
  /** AP changed scored fields before canceling. */
  apEditedBeforeCancel?: boolean;
}

export interface CancelAttributionResult {
  attribution: CancelAttribution;
  basis: CancelBasis;
}

export const DEFAULT_EARLY_CANCEL_HOURS = 72;

function matches(list: string[], value: string | undefined): boolean {
  return Boolean(value) && list.includes(value!.trim().toLowerCase());
}

/** A mapped cancel reason matches on its name or any of its reference IDs. */
function matchesReason(list: string[], evidence: CancelEvidence): boolean {
  return [evidence.cancelReason, ...(evidence.cancelReasonIds ?? [])].some((value) => matches(list, value));
}

/**
 * Decides whether a canceled agent invoice was the agent's fault. No cancel reason points at the
 * agent today, so most decisions come from the facts below; anything unproven stays unattributed.
 */
export function attributeCancel(
  evidence: CancelEvidence,
  mapping: CancelReasonMapping,
  earlyCancelHours = DEFAULT_EARLY_CANCEL_HOURS
): CancelAttributionResult {
  if (evidence.apLabel) return { attribution: evidence.apLabel, basis: 'ap_label' };
  if (matchesReason(mapping.agent, evidence)) return { attribution: 'agent', basis: 'agent_reason' };
  if ((evidence.workQueueTags ?? []).some((tag) => matches(mapping.agentTags, tag))) {
    return { attribution: 'agent', basis: 'agent_tag' };
  }
  if (matchesReason(mapping.business, evidence)) return { attribution: 'business', basis: 'business_reason' };
  if (matchesReason(mapping.duplicate, evidence)) return { attribution: 'agent', basis: 'duplicate_reason' };
  if (evidence.replacement) return { attribution: 'agent', basis: 'replacement' };
  if (evidence.duplicate) return { attribution: 'agent', basis: 'duplicate' };
  if (evidence.primaryAttachmentKind === 'supporting' || evidence.primaryAttachmentKind === 'unrelated') {
    return { attribution: 'agent', basis: 'wrong_document' };
  }
  // Without clustering every PDF became its own invoice, so a cancel among several invoices from one
  // conversation most likely removed a backup document that should never have been an invoice.
  if (evidence.clusteringMode && evidence.clusteringMode !== 'on' && (evidence.agentInvoicesInConversation ?? 0) > 1) {
    return { attribution: 'agent', basis: 'per_pdf_without_clustering' };
  }
  if (evidence.supplierVoidOrCreditInThread) return { attribution: 'business', basis: 'supplier_void_or_credit' };
  if (
    evidence.canceledWhileDraft
    && !evidence.apEditedBeforeCancel
    && evidence.hoursFromLastAgentWrite != null
    && evidence.hoursFromLastAgentWrite <= earlyCancelHours
  ) {
    return { attribution: 'unattributed', basis: 'early_draft_cancel' };
  }
  return { attribution: 'unattributed', basis: 'no_signal' };
}

const SUPPLIER_VOID_OR_CREDIT_PATTERN =
  /\b(void(ed|ing)?|credit (memo|note)|issued (a|you a) credit|please disregard|disregard (this|the|that|our) invoice|(cancel(l)?ed|cancel(l)?ing|withdraw(n)?) (this|the|that|our) invoice)\b/i;

/** True when a supplier message after the agent's write says the invoice was voided or credited. */
export function mentionsSupplierVoidOrCredit(messages: Array<{ createdAt?: number; body?: string }>, afterUnixSeconds?: number): boolean {
  return messages.some((message) =>
    (afterUnixSeconds == null || message.createdAt == null || message.createdAt >= afterUnixSeconds)
    && SUPPLIER_VOID_OR_CREDIT_PATTERN.test(message.body ?? '')
  );
}
