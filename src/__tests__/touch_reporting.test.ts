import type { DatabaseConnection } from '../lib/database.js';
import { TOUCH_BUCKETS } from '../lib/score_touches.js';
import {
  CREATE_AGENT_INVOICE_TOUCHES_VIEW,
  ensureTouchReporting,
  REFRESH_TOUCH_DAILY,
  refreshTouchDaily,
  TOUCH_ROLLUP_DAYS,
} from '../lib/touch_reporting.js';

function mockDb(responses: unknown[][]) {
  const query = jest.fn<Promise<unknown[]>, [string, unknown[]?]>();
  for (const rows of responses) query.mockResolvedValueOnce(rows);
  query.mockResolvedValue([]);
  return { db: { query, close: jest.fn() } as unknown as DatabaseConnection, query };
}

describe('touch reporting SQL', () => {
  it('uses the same bucket edges as the Slack posts', () => {
    const edges = TOUCH_BUCKETS.slice(1, -1).map((bucket) => bucket.max);
    expect(edges).toEqual([3, 10, 20]);
    expect(CREATE_AGENT_INVOICE_TOUCHES_VIEW).toContain('WHEN t.touches = 0 THEN');
    for (const edge of edges) expect(CREATE_AGENT_INVOICE_TOUCHES_VIEW).toContain(`WHEN t.touches <= ${edge} THEN`);
    expect(REFRESH_TOUCH_DAILY).toContain("t.touch_bucket = '21+'");
  });

  it('creates the table and view inside a locked transaction and rolls back on failure', async () => {
    const calls: string[] = [];
    await ensureTouchReporting(async (sql) => { calls.push(sql.trim().split('\n')[0].trim()); });
    expect(calls[0]).toBe('BEGIN');
    expect(calls[1]).toContain('pg_advisory_xact_lock');
    expect(calls[calls.length - 1]).toBe('COMMIT');

    const failed: string[] = [];
    await expect(ensureTouchReporting(async (sql) => {
      failed.push(sql.trim());
      if (sql.includes('CREATE OR REPLACE VIEW')) throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(failed[failed.length - 1]).toBe('ROLLBACK');
  });
});

describe('refreshTouchDaily', () => {
  it('recomputes the recent window when days are already stored', async () => {
    const { db, query } = mockDb([[{ stored: 20 }]]);
    await expect(refreshTouchDaily(db)).resolves.toBe(TOUCH_ROLLUP_DAYS);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]).toEqual([REFRESH_TOUCH_DAILY, [TOUCH_ROLLUP_DAYS - 1]]);
  });

  it('backfills from the earliest entered invoice on the first run', async () => {
    const { db, query } = mockDb([[{ stored: 0 }], [{ span: 40 }]]);
    await expect(refreshTouchDaily(db)).resolves.toBe(41);
    expect(query.mock.calls[2]).toEqual([REFRESH_TOUCH_DAILY, [40]]);
  });
});
