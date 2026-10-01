import { debug } from '@pga/logger';
import type { DatabaseConnection } from './lib/database.js';
import { withHandler, type ProcessingContext } from './lib/handlers.js';
import { classifyStatus, statusConfigFromEnv, type StatusClass } from './lib/invoice_score.js';
import { escapeWqlLiteral, rowToInvoiceScore, type InvoiceScore } from './lib/invoice_scores.js';
import { buildDigestBlocks, digestWindow, summarizeScores, type DigestWindow } from './lib/score_digest.js';
import { notifyResult, postSlackBlocks } from './lib/slack.js';
import { executeWorkdayQuery, getWorkQueueTagWIDs } from './lib/workday.js';

const AGENT_MODIFIED_TAG_REF_ID = process.env.WORKDAY_AGENT_MODIFIED_TAG_REF_ID || 'FINAGENT-invoice-modified';
const UNATTRIBUTED_CANCEL_LIMIT = 10;

const BACKLOG_STATE_LABELS: Record<StatusClass, string> = {
  draft: 'in Draft',
  entry: 'submitted',
  approved: 'approved',
  paid: 'paid',
  denied: 'denied',
  canceled: 'canceled',
  not_found: 'not found',
};

/**
 * Outcome-only counts for agent-tagged invoices received in the window that have no snapshot
 * (written before snapshots shipped, or a snapshot that failed to save).
 */
export async function backlogOutcomes(context: ProcessingContext, window: DigestWindow): Promise<Partial<Record<string, number>>> {
  const tagWids = await getWorkQueueTagWIDs(context, [AGENT_MODIFIED_TAG_REF_ID]);
  if (!tagWids.length) return {};
  const since = window.start.toISOString().split('T')[0];
  const result = await executeWorkdayQuery(
    context.workdayConfig,
    `SELECT workdayID, invoiceStatusAsText, isCanceled, invoiceIsPaid, invoiceIsPartiallyPaid
     FROM supplierInvoices (dataSourceFilter = supplierInvoicesFilter)
     WHERE workQueueTags in (${tagWids.map((wid) => `'${escapeWqlLiteral(wid)}'`).join(', ')})
       AND invoiceReceivedDate >= '${since}'`
  );
  const rows = ((result.data ?? []) as Array<Record<string, unknown>>).filter((row) => typeof row.workdayID === 'string');
  if (!rows.length) return {};
  const snapshotted = new Set(
    (await context.dbConnection.query(
      'SELECT DISTINCT workday_invoice_wid FROM agent_invoice_snapshots WHERE workday_invoice_wid = ANY($1::text[])',
      [rows.map((row) => row.workdayID as string)]
    ) as Array<{ workday_invoice_wid: string }>).map((row) => row.workday_invoice_wid)
  );
  const config = statusConfigFromEnv();
  const counts: Partial<Record<string, number>> = {};
  for (const row of rows) {
    if (snapshotted.has(row.workdayID as string)) continue;
    const label = BACKLOG_STATE_LABELS[classifyStatus({ ...row, workdayID: row.workdayID as string }, config)];
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
}

/** Scores touched since `since`, plus open stuck Drafts, with any AP cancel label applied. */
export async function loadDigestScores(db: DatabaseConnection, since: Date): Promise<InvoiceScore[]> {
  const rows = await db.query(
    `SELECT s.*, l.attribution AS label_attribution
       FROM agent_invoice_scores s
       LEFT JOIN cancel_labels l ON l.workday_invoice_wid = s.workday_invoice_wid
      WHERE COALESCE(s.entry_read_at, s.final_read_at, s.updated_at) >= $1
         OR (s.terminal = false AND s.outcome = 'stuck_draft')`,
    [since]
  ) as Array<Record<string, unknown>>;
  return rows.map(withCancelLabel);
}

/** The most recent unattributed cancels AP has not labeled yet. */
export async function loadUnlabeledCancels(db: DatabaseConnection, limit = UNATTRIBUTED_CANCEL_LIMIT): Promise<InvoiceScore[]> {
  const rows = await db.query(
    `SELECT s.* FROM agent_invoice_scores s
       LEFT JOIN cancel_labels l ON l.workday_invoice_wid = s.workday_invoice_wid
      WHERE s.terminal = true AND s.cancel_attribution = 'unattributed' AND l.workday_invoice_wid IS NULL
      ORDER BY s.final_read_at DESC
      LIMIT $1`,
    [limit]
  ) as Array<Record<string, unknown>>;
  return rows.map(rowToInvoiceScore);
}

/** AP labels added after a cancel was scored still count in the digest. */
function withCancelLabel(row: Record<string, unknown>): InvoiceScore {
  const score = rowToInvoiceScore(row);
  const label = row.label_attribution;
  if ((label === 'agent' || label === 'business') && (score.outcome === 'canceled' || score.outcome === 'deleted')) {
    return { ...score, cancelAttribution: label, cancelBasis: 'ap_label' };
  }
  return score;
}

// Weekly digest - posts to the audit channel only (AUDIT_SLACK_WEBHOOK_URL)
export const handler = withHandler(async (context) => {
  const startTime = Date.now();
  try {
    const window = digestWindow(new Date());
    const summary = summarizeScores(
      await loadDigestScores(context.dbConnection, window.previousStart),
      window,
      await loadUnlabeledCancels(context.dbConnection)
    );
    try {
      summary.backlog = await backlogOutcomes(context, window);
    } catch (error) {
      debug('Could not count pre-snapshot agent invoices; posting the digest without them', error);
    }

    await postSlackBlocks(buildDigestBlocks(summary), process.env.AUDIT_SLACK_WEBHOOK_URL, 'AUDIT_SLACK_WEBHOOK_URL');
    debug('Posted agent invoice audit digest', { entered: summary.entered, canceled: summary.cancels });
  } catch (error) {
    await notifyResult('score_digest', 'error', Date.now() - startTime, undefined, error);
    throw error;
  }
});
