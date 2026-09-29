import {
  claimInvoiceCluster,
  createInvoiceClusterPlan,
  finishInvoiceCluster,
  markInvoiceClusterUndispatched,
  releaseInvoiceCluster,
} from '../lib/invoice_cluster_plans.js';
import type { DatabaseConnection } from '../lib/database.js';

function mockDb(rows: unknown[] = []) {
  const query = jest.fn<Promise<unknown[]>, [string, unknown[]?]>().mockResolvedValue(rows);
  const db: DatabaseConnection = { query, close: jest.fn<Promise<void>, []>().mockResolvedValue(undefined) };
  return { db, query };
}

describe('invoice cluster plans', () => {
  it('records every cluster as a pending row', async () => {
    const { db, query } = mockDb();
    await createInvoiceClusterPlan(db, 'plan-1', '123', [['invoice.pdf', 'support.pdf'], ['second.pdf']]);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('VALUES ($1, $2, $3, $4::jsonb), ($5, $6, $7, $8::jsonb)');
    expect(sql).toContain('ON CONFLICT (plan_id, cluster_index) DO NOTHING');
    expect(params).toEqual(['plan-1', 0, '123', '["invoice.pdf","support.pdf"]', 'plan-1', 1, '123', '["second.pdf"]']);
  });

  it('claims pending, failed, or stale processing rows only', async () => {
    const claimed = mockDb([{ cluster_index: 1 }]);
    await expect(claimInvoiceCluster(claimed.db, 'plan-1', 1)).resolves.toBe(true);
    const [sql, params] = claimed.query.mock.calls[0];
    expect(sql).toContain("status IN ('pending', 'failed')");
    expect(sql).toContain("status = 'processing' AND claimed_at < CURRENT_TIMESTAMP - make_interval(mins => $3)");
    expect(params).toEqual(['plan-1', 1, 15]);

    const done = mockDb([]);
    await expect(claimInvoiceCluster(done.db, 'plan-1', 1)).resolves.toBe(false);
  });

  it('finishes a cluster with its status and Workday invoice', async () => {
    const { db, query } = mockDb();
    await finishInvoiceCluster(db, 'plan-1', 0, 'done', 'invoice-wid');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('SET status = $3'), ['plan-1', 0, 'done', 'invoice-wid']);
  });

  it('marks an undispatched cluster failed only while it is still pending', async () => {
    const { db, query } = mockDb();
    await markInvoiceClusterUndispatched(db, 'plan-1', 1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("AND status = 'pending'"), ['plan-1', 1]);
  });

  it('returns a processing cluster to pending when this run did no work', async () => {
    const { db, query } = mockDb();
    await releaseInvoiceCluster(db, 'plan-1', 1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("SET status = 'pending', claimed_at = NULL"), ['plan-1', 1]);
  });
});
