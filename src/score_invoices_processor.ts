import { debug } from '@pga/logger';
import { withProcessorHandler, type ProcessingContext } from './lib/handlers.js';
import { fetchConversationMessages, getIntercomConfig } from './lib/intercom.js';
import { jevModelName, jevMode, startJevBudget, type JevMode } from './lib/jev.js';
import { jevAttributeCancel, jevScoredChanges, jevSupplierVoidOrCredit } from './lib/jev_audit.js';
import {
  attributeCancel,
  cancelReasonMappingFromEnv,
  classifyStatus,
  DEFAULT_EARLY_CANCEL_HOURS,
  entryOutcome,
  isTerminalStatus,
  isTruthyFlag,
  lastTenantRefresh,
  LOST_TO_REFRESH_STATUS,
  mentionsSupplierVoidOrCredit,
  scoreChanges,
  statusConfigFromEnv,
  tenantRefreshWeekday,
  type CancelEvidence,
  type InvoiceStatusRow,
  type JevShadow,
  type StatusClass,
} from './lib/invoice_score.js';
import {
  countAgentInvoicesInConversation,
  findLiveInvoicesWithSuppliersInvoiceNumber,
  findOtherAgentInvoicesWithSameNumber,
  getCancelLabel,
  getInvoiceScore,
  isAgentWrittenInvoice,
  upsertInvoiceScore,
  type InvoiceScore,
} from './lib/invoice_scores.js';
import {
  AGENT_WRITE_SOURCES,
  diffScoredFields,
  extractScoredFields,
  getAgentInvoiceSnapshots,
  referenceDescriptor,
  referenceIdValues,
  referenceKey,
  referenceWid,
  type AgentInvoiceSnapshot,
  type ScoredFieldName,
  type ScoredFields,
} from './lib/invoice_snapshots.js';
import { notifyResult } from './lib/slack.js';
import { getSupplierInvoice, getSupplierInvoiceEditability } from './lib/workday.js';

export interface ScoreInvoiceItem {
  workdayInvoiceWid: string;
  /** Null when the invoice was missing from the status query (no longer in Workday). */
  status: InvoiceStatusRow | null;
}

export const DEFAULT_STUCK_DRAFT_DAYS = 14;

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function hoursBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 3_600_000;
}

function workQueueTagIds(invoice: unknown): string[] {
  const tags = (invoice as { Work_Queue_Information_Data?: { Work_Queue_Tags_Reference?: unknown } } | undefined)
    ?.Work_Queue_Information_Data?.Work_Queue_Tags_Reference;
  const ids: string[] = [];
  for (const tag of ([] as unknown[]).concat(tags ?? [])) {
    for (const id of ([] as unknown[]).concat((tag as { ID?: unknown })?.ID ?? [])) {
      const value = (id as { $value?: unknown })?.$value;
      if (value != null) ids.push(String(value));
    }
  }
  return ids;
}

/**
 * For an enrich invoice, the fields the agent changed from the OCR baseline it started from. Without a
 * baseline the agent's edits cannot be told apart from OCR values, so none count against the agent.
 */
function enrichAgentChangedFields(snapshots: AgentInvoiceSnapshot[], latest: AgentInvoiceSnapshot): ScoredFieldName[] | undefined {
  if (latest.source !== 'enrich') return undefined;
  const baseline = [...snapshots].reverse().find((snapshot) => snapshot.source === 'enrich_baseline' && snapshot.writeSeq < latest.writeSeq);
  if (!baseline) return [];
  return diffScoredFields(baseline.fields, latest.fields).map((change) => change.field);
}

/** A Jev bug or outage must never fail or change the official score, so every Jev call goes through here. */
async function tryJev<T>(label: string, run: () => Promise<T | undefined>): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    debug('Jev call failed; the rules stand', { label, error });
    return undefined;
  }
}

interface SupplierThreadVerdict {
  /** The pattern's answer; `read_failed` when the conversation could not be read, undefined when there was nothing to read. */
  rule: boolean | 'read_failed' | undefined;
  jev?: { voided: boolean; probability: number };
}

async function supplierVoidOrCreditInThread(
  conversationId: string | undefined,
  sinceUnixSeconds: number,
  mode: JevMode
): Promise<SupplierThreadVerdict> {
  if (!conversationId || !process.env.INTERCOM_ACCESS_TOKEN) return { rule: undefined };
  let messages: Awaited<ReturnType<typeof fetchConversationMessages>>;
  try {
    messages = await fetchConversationMessages(getIntercomConfig(process.env), conversationId);
  } catch (error) {
    debug('Could not read the Intercom conversation for cancel evidence', { conversationId, error });
    return { rule: 'read_failed' };
  }
  const rule = mentionsSupplierVoidOrCredit(messages, sinceUnixSeconds);
  if (mode === 'off') return { rule };
  const jev = await tryJev('supplier void or credit', () => jevSupplierVoidOrCredit(messages, sinceUnixSeconds));
  return { rule, ...(jev ? { jev } : {}) };
}

async function gatherCancelEvidence(
  context: ProcessingContext,
  input: {
    score: InvoiceScore;
    snapshots: AgentInvoiceSnapshot[];
    latest: AgentInvoiceSnapshot;
    status: InvoiceStatusRow | null;
    current: unknown;
    currentFields?: ScoredFields;
    now: Date;
    mode: JevMode;
  }
): Promise<{ evidence: CancelEvidence; jevVoid?: NonNullable<JevShadow['supplierVoidOrCredit']> }> {
  const { score, snapshots, latest, status, current, currentFields, now, mode } = input;
  const db = context.dbConnection;
  const firstWrite = snapshots.find((snapshot) => AGENT_WRITE_SOURCES.includes(snapshot.source)) ?? latest;
  // Get_Supplier_Invoices returns the cancel reason on the invoice; the optional WQL field is a fallback.
  const cancelReasonRef = (current as { Invoice_Cancel_Reason_Reference?: unknown } | undefined)?.Invoice_Cancel_Reason_Reference;
  const cancelReasonIds = referenceIdValues(cancelReasonRef);
  const cancelReason = referenceDescriptor(cancelReasonRef)
    ?? status?.cancelReason
    ?? referenceKey(cancelReasonRef)?.split('=').pop();
  const evidence: CancelEvidence = {
    canceledWhileDraft: !score.entryReadAt,
    hoursFromLastAgentWrite: Math.round(hoursBetween(latest.createdAt, now) * 10) / 10,
    ...(cancelReason ? { cancelReason } : {}),
    ...(cancelReasonIds.length ? { cancelReasonIds } : {}),
    ...(latest.attachmentKinds?.[0] ? { primaryAttachmentKind: latest.attachmentKinds[0] } : {}),
    ...(latest.clusteringMode ? { clusteringMode: latest.clusteringMode } : {}),
  };

  const label = await getCancelLabel(db, score.workdayInvoiceWid);
  if (label) evidence.apLabel = label;

  const tags = workQueueTagIds(current);
  if (tags.length) evidence.workQueueTags = tags;

  if (currentFields) {
    evidence.apEditedBeforeCancel = diffScoredFields(latest.fields, currentFields).length > 0;
  }

  if (latest.conversationId) {
    evidence.agentInvoicesInConversation = await countAgentInvoicesInConversation(db, latest.conversationId);
  }

  const { supplier, suppliersInvoiceNumber } = latest.fields;
  if (supplier && suppliersInvoiceNumber) {
    for (const other of await findOtherAgentInvoicesWithSameNumber(db, score.workdayInvoiceWid, supplier, suppliersInvoiceNumber)) {
      const editability = await getSupplierInvoiceEditability(context, other.workdayInvoiceWid).catch((error: unknown) => {
        debug('Could not check a possible duplicate; scoring the cancel without it', { workdayInvoiceWid: other.workdayInvoiceWid, error });
        evidence.duplicateCheckFailed = true;
        return undefined;
      });
      if (editability?.found && !editability.isCanceled) {
        evidence.duplicate = other;
        break;
      }
    }
  }

  // A replacement must be for the same supplier, so skip the lookup when the canceled invoice could not be read.
  const supplierWid = referenceWid((current as { Supplier_Reference?: unknown } | undefined)?.Supplier_Reference);
  if (!evidence.duplicate && suppliersInvoiceNumber && supplierWid) {
    try {
      const live = await findLiveInvoicesWithSuppliersInvoiceNumber(context.workdayConfig, suppliersInvoiceNumber);
      for (const candidate of live) {
        if (candidate.workdayID === score.workdayInvoiceWid || candidate.supplierId !== supplierWid) continue;
        if (await isAgentWrittenInvoice(db, candidate.workdayID)) continue;
        // Only a replacement Workday returns counts; an unreadable one proves nothing.
        const replacementInvoice: unknown = await (getSupplierInvoice(context, candidate.workdayID) as Promise<unknown>).catch(() => undefined);
        if (!replacementInvoice) continue;
        evidence.replacement = {
          workdayInvoiceWid: candidate.workdayID,
          ...(candidate.invoiceNumber ? { workdayInvoiceNumber: candidate.invoiceNumber } : {}),
          diff: diffScoredFields(latest.fields, extractScoredFields(replacementInvoice)),
        };
        break;
      }
    } catch (error) {
      debug('Replacement lookup failed; scoring the cancel without it', { workdayInvoiceWid: score.workdayInvoiceWid, error });
      evidence.replacementLookupFailed = true;
    }
  }

  const thread = await supplierVoidOrCreditInThread(latest.conversationId, Math.floor(firstWrite.createdAt.getTime() / 1000), mode);
  if (thread.rule === 'read_failed') {
    evidence.conversationReadFailed = true;
  } else {
    const voided = mode === 'on' && thread.jev ? thread.jev.voided : thread.rule;
    if (voided !== undefined) evidence.supplierVoidOrCreditInThread = voided;
  }
  const jevVoid = thread.jev && typeof thread.rule === 'boolean'
    ? { jev: thread.jev.voided, probability: thread.jev.probability, rule: thread.rule }
    : undefined;

  return { evidence, ...(jevVoid ? { jevVoid } : {}) };
}

function removedByTenantRefresh(latest: AgentInvoiceSnapshot, now: Date): boolean {
  const weekday = tenantRefreshWeekday();
  return weekday !== undefined && latest.createdAt.getTime() < lastTenantRefresh(now, weekday).getTime();
}

function applyEntry(
  score: InvoiceScore,
  input: { snapshots: AgentInvoiceSnapshot[]; latest: AgentInvoiceSnapshot; currentFields: ScoredFields; statusText?: string; now: Date }
): void {
  const { snapshots, latest, currentFields, statusText, now } = input;
  const changes = scoreChanges(diffScoredFields(latest.fields, currentFields), enrichAgentChangedFields(snapshots, latest));
  score.entryStatus = statusText;
  score.entryReadAt = now;
  score.entryFields = currentFields;
  score.entryDiff = changes;
  score.outcome = entryOutcome(changes);
}

/**
 * Scores one agent-written invoice for the stage it reached. Each stage is written once, so a rerun
 * on the same status changes nothing.
 */
export async function scoreInvoice(
  context: ProcessingContext,
  item: ScoreInvoiceItem,
  now: Date = new Date()
): Promise<InvoiceScore | undefined> {
  const db = context.dbConnection;
  const snapshots = await getAgentInvoiceSnapshots(db, item.workdayInvoiceWid);
  const writes = snapshots.filter((snapshot) => AGENT_WRITE_SOURCES.includes(snapshot.source));
  const latest = writes[writes.length - 1];
  if (!latest) return undefined;

  const existing = await getInvoiceScore(db, item.workdayInvoiceWid);
  if (existing?.terminal) return existing;

  const score: InvoiceScore = existing ?? { workdayInvoiceWid: item.workdayInvoiceWid, terminal: false };
  score.origin = writes[0].source === 'enrich' ? 'enrich' : 'create';
  score.workdayInvoiceNumber = latest.workdayInvoiceNumber ?? score.workdayInvoiceNumber;
  score.conversationId = latest.conversationId ?? score.conversationId;
  score.releaseSha = latest.releaseSha ?? score.releaseSha;
  score.clusteringMode = latest.clusteringMode ?? score.clusteringMode;

  const mode = jevMode();
  const shadow: JevShadow = { ...(existing?.jevShadow ?? {}), model: jevModelName() };
  const shadowBefore = JSON.stringify(shadow);

  const statusConfig = statusConfigFromEnv();
  let statusClass: StatusClass = classifyStatus(item.status ?? undefined, statusConfig);
  const statusText = item.status?.invoiceStatusAsText;
  if (statusClass === 'entry' && !statusConfig.entry.includes((statusText ?? '').trim().toLowerCase())) {
    debug('Unrecognized Workday invoice status; scoring it as entered by AP', { workdayInvoiceWid: item.workdayInvoiceWid, status: statusText });
  }
  let current: unknown;
  let invoiceReadFailed = false;
  if (statusClass !== 'not_found') {
    try {
      current = await getSupplierInvoice(context, item.workdayInvoiceWid);
    } catch (error) {
      if (statusClass !== 'canceled') throw error;
      invoiceReadFailed = true;
      debug('Could not read the canceled invoice; scoring the cancel without its fields', { workdayInvoiceWid: item.workdayInvoiceWid, error });
    }
  }
  if (!current && statusClass !== 'canceled') statusClass = 'not_found';
  const currentFields = current ? extractScoredFields(current) : undefined;

  const holdReason = item.status?.holdReason
    ?? (isTruthyFlag((current as { On_Hold?: unknown } | undefined)?.On_Hold) ? 'On hold' : undefined);
  if (holdReason) score.holdReason = holdReason;

  if (statusClass === 'draft') {
    const stuckDays = positiveNumber(process.env.SCORE_STUCK_DRAFT_DAYS, DEFAULT_STUCK_DRAFT_DAYS);
    if (hoursBetween(latest.createdAt, now) < stuckDays * 24) return undefined;
    score.outcome = 'stuck_draft';
  } else if (statusClass === 'not_found' && removedByTenantRefresh(latest, now)) {
    // The sandbox was overwritten with production data, so the invoice vanished without anyone canceling it.
    if (!score.entryReadAt) score.outcome = 'lost_to_refresh';
    score.finalStatus = LOST_TO_REFRESH_STATUS;
    score.finalReadAt = now;
    score.terminal = true;
  } else if (statusClass === 'canceled' || statusClass === 'not_found') {
    const { evidence, jevVoid } = await gatherCancelEvidence(context, {
      score, snapshots, latest, status: item.status, current, currentFields, now, mode,
    });
    if (invoiceReadFailed) evidence.invoiceReadFailed = true;
    const ruleAttribution = attributeCancel(
      evidence,
      cancelReasonMappingFromEnv(),
      positiveNumber(process.env.SCORE_EARLY_CANCEL_HOURS, DEFAULT_EARLY_CANCEL_HOURS)
    );
    let attribution = ruleAttribution;
    if (mode !== 'off') {
      if (jevVoid) shadow.supplierVoidOrCredit = jevVoid;
      const jevEvidence = jevVoid ? { ...evidence, supplierVoidOrCreditInThread: jevVoid.jev } : evidence;
      const decision = await tryJev('cancel attribution', () => jevAttributeCancel(jevEvidence, ruleAttribution));
      if (decision) {
        shadow.cancel = { ...decision.result, ...(decision.confidence !== undefined ? { confidence: decision.confidence } : {}) };
        if (mode === 'on') attribution = decision.result;
      }
    }
    score.outcome = statusClass === 'canceled' ? 'canceled' : 'deleted';
    score.cancelReason = evidence.cancelReason;
    score.cancelAttribution = attribution.attribution;
    score.cancelBasis = attribution.basis;
    score.cancelEvidence = evidence;
    score.finalStatus = statusText ?? (statusClass === 'canceled' ? 'Canceled' : 'Not found');
    score.finalReadAt = now;
    score.terminal = true;
  } else {
    // Draft straight to a terminal state between two runs: the one read serves as both entry and final.
    const enteredThisRun = !score.entryReadAt;
    if (enteredThisRun) {
      applyEntry(score, { snapshots, latest, currentFields: currentFields!, statusText, now });
      if (mode !== 'off') {
        const jevChanges = await tryJev('entry diff', () => jevScoredChanges(latest.fields, currentFields!, {
          agentChangedFields: enrichAgentChangedFields(snapshots, latest),
          supplier: latest.fields.supplier,
        }));
        if (jevChanges) {
          shadow.entryDiff = jevChanges;
          shadow.entryOutcome = entryOutcome(jevChanges);
          if (mode === 'on') {
            score.entryDiff = jevChanges;
            score.outcome = shadow.entryOutcome;
          }
        }
      }
    }
    if (isTerminalStatus(statusClass)) {
      const late = !enteredThisRun && score.entryFields
        ? scoreChanges(diffScoredFields(score.entryFields, currentFields!), enrichAgentChangedFields(snapshots, latest))
        : [];
      score.lateDiff = late;
      if (mode !== 'off' && !enteredThisRun && score.entryFields) {
        const jevLate = await tryJev('late diff', () => jevScoredChanges(score.entryFields!, currentFields!, {
          agentChangedFields: enrichAgentChangedFields(snapshots, latest),
          supplier: latest.fields.supplier,
        }));
        if (jevLate) {
          shadow.lateDiff = jevLate;
          if (mode === 'on') score.lateDiff = jevLate;
        }
      }
      score.finalStatus = statusText;
      score.finalReadAt = now;
      score.terminal = true;
      if (statusClass === 'denied') score.outcome = 'denied';
    }
  }

  if (mode !== 'off' && JSON.stringify(shadow) !== shadowBefore) score.jevShadow = shadow;
  await upsertInvoiceScore(db, score);
  debug('Scored agent invoice', {
    workdayInvoiceWid: score.workdayInvoiceWid,
    workdayInvoiceNumber: score.workdayInvoiceNumber,
    status: statusText,
    outcome: score.outcome,
    terminal: score.terminal,
    entryFields: score.entryDiff?.filter((change) => change.agentOwned).map((change) => change.field),
    lateFields: score.lateDiff?.filter((change) => change.agentOwned).map((change) => change.field),
    ...(score.cancelAttribution ? { cancel: `${score.cancelAttribution}/${score.cancelBasis}` } : {}),
  });
  return score;
}

// Processor function - invoked by score_invoices with a batch of invoices whose state changed
export const processor = withProcessorHandler<ScoreInvoiceItem>(async (context, items) => {
  const failures: Array<{ workdayInvoiceWid: string; message: string }> = [];
  let scored = 0;
  startJevBudget();
  for (const item of items ?? []) {
    try {
      if (await scoreInvoice(context, item)) scored += 1;
    } catch (error) {
      debug('Failed to score invoice', { workdayInvoiceWid: item.workdayInvoiceWid, error });
      failures.push({ workdayInvoiceWid: item.workdayInvoiceWid, message: error instanceof Error ? error.message : String(error) });
    }
  }
  debug('Scored agent invoices', { received: items?.length ?? 0, scored, failed: failures.length });
  if (failures.length) {
    const error = new Error(`Could not score ${failures.length} of ${items.length} invoices`);
    await notifyResult('score_invoices_processor', 'error', undefined, { failures }, error);
    throw error;
  }
});
