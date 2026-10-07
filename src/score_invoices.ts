import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { debug } from '@pga/logger';
import { withHandler } from './lib/handlers.js';
import { classifyStatus, statusConfigFromEnv, tenantRefreshWeekday, type InvoiceStatusRow, type StatusClass } from './lib/invoice_score.js';
import { fetchInvoiceStatuses, listPendingScoreInvoices, type PendingScoreRow } from './lib/invoice_scores.js';
import { notifyResult } from './lib/slack.js';
import { DEFAULT_STUCK_DRAFT_DAYS, type ScoreInvoiceItem } from './score_invoices_processor.js';

export const PROCESSOR_BATCH_SIZE = 20;
/** Invoices past this many wait for the next run, which selects them again because they still need scoring. */
export const DEFAULT_MAX_INVOICES_PER_RUN = 500;
/** Status is read for at most this many pending invoices per dispatched slot, newest writes first. */
export const STATUS_READS_PER_INVOICE = 2;

/** True when the invoice reached a stage it has not been scored for yet. */
export function needsScoring(row: PendingScoreRow, statusClass: StatusClass, now: Date, stuckDraftDays: number): boolean {
  switch (statusClass) {
    case 'draft':
      return row.outcome !== 'stuck_draft' && now.getTime() - row.lastWriteAt.getTime() >= stuckDraftDays * 86_400_000;
    case 'entry':
      return !row.entryReadAt;
    case 'approved':
    case 'paid':
    case 'denied':
      return !row.finalReadAt;
    default:
      return true;
  }
}

export function selectInvoicesToScore(
  pending: PendingScoreRow[],
  statuses: Map<string, InvoiceStatusRow>,
  now: Date,
  stuckDraftDays: number
): ScoreInvoiceItem[] {
  const config = statusConfigFromEnv();
  return pending.flatMap((row) => {
    const status = statuses.get(row.workdayInvoiceWid) ?? null;
    return needsScoring(row, classifyStatus(status ?? undefined, config), now, stuckDraftDays)
      ? [{ workdayInvoiceWid: row.workdayInvoiceWid, status }]
      : [];
  });
}

// Query function - scheduled daily
export const handler = withHandler(async (context) => {
  const startTime = Date.now();
  const now = new Date();
  const stuckDraftDays = Number(process.env.SCORE_STUCK_DRAFT_DAYS) > 0 ? Number(process.env.SCORE_STUCK_DRAFT_DAYS) : DEFAULT_STUCK_DRAFT_DAYS;
  if (tenantRefreshWeekday() === now.getUTCDay()) {
    debug('Skipping agent invoice scoring on the tenant refresh day');
    return;
  }
  try {
    const configuredMax = Number(process.env.SCORE_MAX_INVOICES_PER_RUN);
    const maxPerRun = Number.isSafeInteger(configuredMax) && configuredMax > 0 ? configuredMax : DEFAULT_MAX_INVOICES_PER_RUN;
    const maxPending = maxPerRun * STATUS_READS_PER_INVOICE;
    const pending = await listPendingScoreInvoices(context.dbConnection, maxPending);
    if (pending.length >= maxPending) debug('Pending agent invoices reached the per-run status read limit', { maxPending });
    const statuses = await fetchInvoiceStatuses(context.workdayConfig, pending.map((row) => row.workdayInvoiceWid));
    const selected = selectInvoicesToScore(pending, statuses, now, stuckDraftDays);
    const items = selected.slice(0, maxPerRun);
    debug('Agent invoices to score', { pending: pending.length, toScore: selected.length, dispatched: items.length });

    const lambda = new LambdaClient({ region: process.env.AWS_REGION });
    const processorFunctionName = `${process.env.AWS_STACK_NAME}-ScoreInvoicesProcessor`;
    for (let start = 0; start < items.length; start += PROCESSOR_BATCH_SIZE) {
      await lambda.send(new InvokeCommand({
        FunctionName: processorFunctionName,
        InvocationType: 'Event',
        Payload: JSON.stringify({ data: items.slice(start, start + PROCESSOR_BATCH_SIZE) }),
      }));
    }
  } catch (error) {
    await notifyResult('score_invoices', 'error', Date.now() - startTime, undefined, error);
    throw error;
  }
});
