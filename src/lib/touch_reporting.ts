import type { DatabaseConnection } from './database.js';

/**
 * Reporting surfaces for touches, kept in SQL so a report can read them without the app:
 * `agent_invoice_touches` (one row per invoice AP submitted) and `agent_invoice_touch_daily`
 * (one row per Central calendar day). The bucket edges match `TOUCH_BUCKETS` in `score_touches.ts`, and
 * `date_trunc('week', entry_day)` gives the same Monday weeks as the weekly Slack trend.
 */

const AGENT_OWNED_COUNT = (column: string) => `(
      SELECT count(*) FROM jsonb_array_elements(COALESCE(s.${column}, '[]'::jsonb)) AS change
       WHERE COALESCE((change->>'agentOwned')::boolean, true)
    )`;

export const CREATE_AGENT_INVOICE_TOUCHES_VIEW = `
  CREATE OR REPLACE VIEW agent_invoice_touches AS
  SELECT s.workday_invoice_wid,
         s.workday_invoice_number,
         s.origin,
         s.release_sha,
         s.clustering_mode,
         s.outcome,
         s.entry_status,
         s.final_status,
         s.entry_read_at,
         (s.entry_read_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago')::date AS entry_day,
         t.touches,
         CASE
           WHEN t.touches = 0 THEN '0'
           WHEN t.touches <= 3 THEN '1-3'
           WHEN t.touches <= 10 THEN '4-10'
           WHEN t.touches <= 20 THEN '11-20'
           ELSE '21+'
         END AS touch_bucket
    FROM agent_invoice_scores s
    CROSS JOIN LATERAL (
      SELECT ${AGENT_OWNED_COUNT('entry_diff')} + ${AGENT_OWNED_COUNT('late_diff')} AS touches
    ) t
   WHERE s.entry_read_at IS NOT NULL
     AND s.outcome IN ('submitted_clean', 'submitted_edited', 'denied');
`;

export const CREATE_AGENT_INVOICE_TOUCH_DAILY_TABLE = `
  CREATE TABLE IF NOT EXISTS agent_invoice_touch_daily (
    entry_day DATE PRIMARY KEY,
    invoices INTEGER NOT NULL,
    touches_0 INTEGER NOT NULL,
    touches_1_3 INTEGER NOT NULL,
    touches_4_10 INTEGER NOT NULL,
    touches_11_20 INTEGER NOT NULL,
    touches_21_plus INTEGER NOT NULL,
    total_touches INTEGER NOT NULL,
    zero_touch_share NUMERIC(5, 4),
    computed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`;

/**
 * Creates the daily table and, only when it is missing, the view, under a lock so concurrent cold starts do not
 * collide. An existing view is left alone (no per-cold-start ACCESS EXCLUSIVE lock); Postgres can only append
 * columns with CREATE OR REPLACE, so changing the view means dropping it in a migration first.
 */
export async function ensureTouchReporting(
  query: (sql: string, params?: unknown[]) => Promise<unknown>
): Promise<void> {
  await query('BEGIN');
  try {
    await query(`SELECT pg_advisory_xact_lock(hashtext('finance-agent:agent_invoice_touches'))`);
    await query(CREATE_AGENT_INVOICE_TOUCH_DAILY_TABLE);
    const existing = await query(`SELECT to_regclass('agent_invoice_touches') IS NOT NULL AS present`) as { rows?: Array<{ present?: boolean }> };
    if (!existing.rows?.[0]?.present) await query(CREATE_AGENT_INVOICE_TOUCHES_VIEW);
    await query('COMMIT');
  } catch (error) {
    await query('ROLLBACK');
    throw error;
  }
}

/** Days recomputed on each run, so late corrections still land in recent days; older days stay as stored. */
export const TOUCH_ROLLUP_DAYS = 15;

const CENTRAL_TODAY = `(CURRENT_TIMESTAMP AT TIME ZONE 'America/Chicago')::date`;

export const REFRESH_TOUCH_DAILY = `
  INSERT INTO agent_invoice_touch_daily
    (entry_day, invoices, touches_0, touches_1_3, touches_4_10, touches_11_20, touches_21_plus,
     total_touches, zero_touch_share, computed_at)
  SELECT d.day::date,
         count(t.workday_invoice_wid),
         count(*) FILTER (WHERE t.touch_bucket = '0'),
         count(*) FILTER (WHERE t.touch_bucket = '1-3'),
         count(*) FILTER (WHERE t.touch_bucket = '4-10'),
         count(*) FILTER (WHERE t.touch_bucket = '11-20'),
         count(*) FILTER (WHERE t.touch_bucket = '21+'),
         COALESCE(sum(t.touches), 0),
         CASE WHEN count(t.workday_invoice_wid) = 0 THEN NULL
              ELSE round(count(*) FILTER (WHERE t.touch_bucket = '0')::numeric / count(t.workday_invoice_wid), 4)
         END,
         CURRENT_TIMESTAMP
    FROM generate_series(${CENTRAL_TODAY} - $1::int, ${CENTRAL_TODAY}, interval '1 day') AS d(day)
    LEFT JOIN agent_invoice_touches t ON t.entry_day = d.day::date
   GROUP BY d.day
  ON CONFLICT (entry_day) DO UPDATE SET
    invoices = EXCLUDED.invoices,
    touches_0 = EXCLUDED.touches_0,
    touches_1_3 = EXCLUDED.touches_1_3,
    touches_4_10 = EXCLUDED.touches_4_10,
    touches_11_20 = EXCLUDED.touches_11_20,
    touches_21_plus = EXCLUDED.touches_21_plus,
    total_touches = EXCLUDED.total_touches,
    zero_touch_share = EXCLUDED.zero_touch_share,
    computed_at = EXCLUDED.computed_at
`;

/**
 * Recomputes recent days of `agent_invoice_touch_daily`. The first run (empty table) backfills from the
 * earliest entered invoice. Returns the number of days written.
 */
export async function refreshTouchDaily(db: DatabaseConnection, recentDays = TOUCH_ROLLUP_DAYS): Promise<number> {
  const [{ stored }] = await db.query('SELECT count(*)::int AS stored FROM agent_invoice_touch_daily') as Array<{ stored: number }>;
  let lookback = recentDays - 1;
  if (!Number(stored)) {
    const [{ span }] = await db.query(
      `SELECT COALESCE(${CENTRAL_TODAY} - min(entry_day), 0)::int AS span FROM agent_invoice_touches`
    ) as Array<{ span: number }>;
    lookback = Math.max(lookback, Number(span) || 0);
  }
  await db.query(REFRESH_TOUCH_DAILY, [lookback]);
  return lookback + 1;
}
