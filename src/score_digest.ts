import { debug } from '@pga/logger';
import type { DatabaseConnection } from './lib/database.js';
import { withHandler, type ProcessingContext } from './lib/handlers.js';
import { classifyStatus, statusConfigFromEnv, tenantRefreshWeekday, type StatusClass } from './lib/invoice_score.js';
import { escapeWqlLiteral, rowToInvoiceScore, type InvoiceScore } from './lib/invoice_scores.js';
import { buildDailyInvoiceMessages, buildDigestBlocks, digestWindow, summarizeDay, summarizeScores, type DigestWindow } from './lib/score_digest.js';
import {
  addCentralDays,
  centralDayStart,
  dailyTouchTrend,
  touchCalloutBlocks,
  touchPeriod,
  weeklyTouchTrend,
} from './lib/score_touches.js';
import { refreshTouchDaily } from './lib/touch_reporting.js';
import { notifyResult, postSlackBlocks, type SlackBlock } from './lib/slack.js';
import { executeWorkdayQuery, getWorkQueueTagWIDs } from './lib/workday.js';

const AGENT_MODIFIED_TAG_REF_ID = process.env.WORKDAY_AGENT_MODIFIED_TAG_REF_ID || 'FINAGENT-invoice-modified';
const UNATTRIBUTED_CANCEL_LIMIT = 10;
export const DAILY_MESSAGE_GAP_MS = 1100;

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
      WHERE GREATEST(s.entry_read_at, s.final_read_at, s.updated_at) >= $1
         OR (s.terminal = false AND s.outcome = 'stuck_draft')
      ORDER BY GREATEST(s.entry_read_at, s.final_read_at, s.updated_at), s.workday_invoice_wid`,
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

/** Scores AP entered since `since`, for the touch trend. */
export async function loadEnteredScores(db: DatabaseConnection, since: Date): Promise<InvoiceScore[]> {
  const rows = await db.query(
    'SELECT * FROM agent_invoice_scores WHERE entry_read_at >= $1 ORDER BY entry_read_at, workday_invoice_wid',
    [since]
  ) as Array<Record<string, unknown>>;
  return rows.map(rowToInvoiceScore);
}

export const DAILY_TREND_DAYS = 14;
export const WEEKLY_TREND_WEEKS = 8;

async function postAudit(blocks: SlackBlock[]): Promise<boolean> {
  return postSlackBlocks(blocks, process.env.AUDIT_SLACK_WEBHOOK_URL, 'AUDIT_SLACK_WEBHOOK_URL');
}

/** When each audit post last went out in full; created here so the invoice Lambdas' cold start stays out of it. */
export const CREATE_AUDIT_POSTS_TABLE = `
  CREATE TABLE IF NOT EXISTS agent_invoice_audit_posts (
    mode VARCHAR(16) PRIMARY KEY,
    posted_through TIMESTAMP NOT NULL
  );
`;
export const MAX_DAILY_CATCH_UP_DAYS = 7;

async function lastPostedThrough(db: DatabaseConnection, mode: string): Promise<Date | undefined> {
  await db.query(CREATE_AUDIT_POSTS_TABLE);
  const rows = await db.query('SELECT posted_through FROM agent_invoice_audit_posts WHERE mode = $1', [mode]) as Array<{ posted_through?: unknown }>;
  const value = rows[0]?.posted_through;
  if (value == null) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

async function recordPostedThrough(db: DatabaseConnection, mode: string, at: Date): Promise<void> {
  await db.query(
    `INSERT INTO agent_invoice_audit_posts (mode, posted_through) VALUES ($1, $2)
     ON CONFLICT (mode) DO UPDATE SET posted_through = EXCLUDED.posted_through`,
    [mode, at]
  );
}

async function postDailySummary(context: ProcessingContext, now: Date): Promise<void> {
  const db = context.dbConnection;
  const today = centralDayStart(now);
  // Invoice messages cover everything scored since the last full post (processors can finish after it, and a run can
  // fail), at most a week back; the first post covers today. The touch lead covers the Central day.
  const lastPosted = await lastPostedThrough(db, 'daily');
  const floor = addCentralDays(today, -MAX_DAILY_CATCH_UP_DAYS);
  const since = !lastPosted ? today : lastPosted > floor ? lastPosted : floor;
  const summary = summarizeDay(await loadDigestScores(db, since), since, now);
  if (!summary.lines.length && !summary.lostToRefresh) {
    debug('No agent invoices scored since the last daily post; skipping it', { since });
    await recordPostedThrough(db, 'daily', now);
    return;
  }
  const trendScores = await loadEnteredScores(context.dbConnection, addCentralDays(today, -DAILY_TREND_DAYS));
  const callout = touchCalloutBlocks({
    periodName: 'today',
    previousName: 'yesterday',
    current: touchPeriod(trendScores, 'today', today, addCentralDays(today, 1)),
    previous: touchPeriod(trendScores, 'yesterday', addCentralDays(today, -1), today),
    trend: dailyTouchTrend(trendScores, now, DAILY_TREND_DAYS),
  });
  const messages = [callout, ...buildDailyInvoiceMessages(summary)];
  for (const [index, blocks] of messages.entries()) {
    // Incoming webhooks allow about one message per second.
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, DAILY_MESSAGE_GAP_MS));
    if (!(await postAudit(blocks))) {
      throw new Error(`Daily audit post stopped at message ${index + 1} of ${messages.length}; the rest were not sent`);
    }
  }
  await recordPostedThrough(db, 'daily', now);
  debug('Posted daily agent invoice audit messages', { scored: summary.lines.length, messages: messages.length });
}

// Audit posts to the audit channel only (AUDIT_SLACK_WEBHOOK_URL): `{ "mode": "daily" }` after each scoring
// run, and the weekly digest otherwise.
/**
 * Keeps the stored daily touch rollup current. A failure never blocks the post (Slack reads scores directly);
 * the handler fails the run afterwards so the error alert says the stored report is stale.
 */
async function refreshTouchRollup(context: ProcessingContext): Promise<Error | undefined> {
  try {
    const days = await refreshTouchDaily(context.dbConnection);
    debug('Refreshed agent_invoice_touch_daily', { days });
    return undefined;
  } catch (error) {
    debug('Could not refresh agent_invoice_touch_daily; posting without it', error);
    return new Error(`Posted the audit, but agent_invoice_touch_daily could not be refreshed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const handler = withHandler(async (context, event?: { mode?: string }) => {
  const startTime = Date.now();
  try {
    const rollupError = await refreshTouchRollup(context);
    if (event?.mode === 'daily') {
      await postDailySummary(context, new Date());
    } else {
      await postWeeklyDigest(context);
    }
    if (rollupError) throw rollupError;
  } catch (error) {
    await notifyResult('score_digest', 'error', Date.now() - startTime, undefined, error);
    throw error;
  }
});

async function postWeeklyDigest(context: ProcessingContext): Promise<void> {
  const window = digestWindow(new Date());
  const summary = summarizeScores(
    await loadDigestScores(context.dbConnection, window.previousStart),
    window,
    await loadUnlabeledCancels(context.dbConnection)
  );
  const trendScores = await loadEnteredScores(context.dbConnection, addCentralDays(window.end, -7 * WEEKLY_TREND_WEEKS));
  summary.touches = {
    periodName: 'last week',
    previousName: 'the week before',
    current: touchPeriod(trendScores, 'last week', window.start, window.end),
    previous: touchPeriod(trendScores, 'the week before', window.previousStart, window.start),
    trend: weeklyTouchTrend(trendScores, window.end, WEEKLY_TREND_WEEKS),
  };
  // A refreshed sandbox holds production's agent invoices, which would all look like pre-snapshot work.
  if (tenantRefreshWeekday() === undefined) {
    try {
      summary.backlog = await backlogOutcomes(context, window);
    } catch (error) {
      debug('Could not count pre-snapshot agent invoices; posting the digest without them', error);
      summary.backlogUnavailable = true;
    }
  }

  if (!(await postAudit(buildDigestBlocks(summary)))) throw new Error('Could not post the weekly audit digest');
  debug('Posted agent invoice audit digest', { entered: summary.entered, canceled: summary.cancels });
}
