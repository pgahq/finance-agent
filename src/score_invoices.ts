import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { debug } from '@pga/logger';
import { withHandler } from './lib/handlers.js';
import { classifyStatus, statusConfigFromEnv, type InvoiceStatusRow, type StatusClass } from './lib/invoice_score.js';
import { fetchInvoiceStatuses, listPendingScoreInvoices, type PendingScoreRow } from './lib/invoice_scores.js';
import { notifyResult } from './lib/slack.js';
import { DEFAULT_STUCK_DRAFT_DAYS, type ScoreInvoiceItem } from './score_invoices_processor.js';

export const PROCESSOR_BATCH_SIZE = 20;

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
  try {
    const pending = await listPendingScoreInvoices(context.dbConnection);
    const statuses = await fetchInvoiceStatuses(context.workdayConfig, pending.map((row) => row.workdayInvoiceWid));
    const items = selectInvoicesToScore(pending, statuses, now, stuckDraftDays);
    debug('Agent invoices to score', { pending: pending.length, toScore: items.length });

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
