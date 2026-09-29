import type { DatabaseConnection } from './database.js';
import { CONVERSATION_INVOICE_CLAIM_TTL_MINUTES } from './conversation_invoices.js';

export type InvoiceClusterPlanStatus = 'pending' | 'processing' | 'done' | 'failed';

/** Records every cluster of a grouped request as pending before anything is dispatched or written. */
export async function createInvoiceClusterPlan(
  db: DatabaseConnection,
  planId: string,
  conversationId: string | undefined,
  clusters: string[][]
): Promise<void> {
  const values: unknown[] = [];
  const tuples = clusters.map((fileNames, index) => {
    values.push(planId, index, conversationId ?? null, JSON.stringify(fileNames));
    const base = index * 4;
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::jsonb)`;
  });
  await db.query(
    `INSERT INTO invoice_cluster_plans (plan_id, cluster_index, conversation_id, file_names)
     VALUES ${tuples.join(', ')}
     ON CONFLICT (plan_id, cluster_index) DO NOTHING`,
    values
  );
}

/**
 * Moves a cluster to processing. Returns false when it is already done or another run is processing
 * it (a processing claim older than the TTL can be taken over), so a duplicate delivery never submits
 * the cluster twice.
 */
export async function claimInvoiceCluster(
  db: DatabaseConnection,
  planId: string,
  clusterIndex: number
): Promise<boolean> {
  const rows = await db.query(
    `UPDATE invoice_cluster_plans
        SET status = 'processing', claimed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE plan_id = $1 AND cluster_index = $2
        AND (status IN ('pending', 'failed')
             OR (status = 'processing' AND claimed_at < CURRENT_TIMESTAMP - make_interval(mins => $3)))
      RETURNING cluster_index`,
    [planId, clusterIndex, CONVERSATION_INVOICE_CLAIM_TTL_MINUTES]
  );
  return rows.length > 0;
}

export async function finishInvoiceCluster(
  db: DatabaseConnection,
  planId: string,
  clusterIndex: number,
  status: Extract<InvoiceClusterPlanStatus, 'done' | 'failed'>,
  workdayInvoiceWid?: string
): Promise<void> {
  await db.query(
    `UPDATE invoice_cluster_plans
        SET status = $3, workday_invoice_wid = COALESCE($4, workday_invoice_wid), updated_at = CURRENT_TIMESTAMP
      WHERE plan_id = $1 AND cluster_index = $2`,
    [planId, clusterIndex, status, workdayInvoiceWid ?? null]
  );
}

/** Marks a cluster whose dispatch failed, unless a run has already claimed it. */
export async function markInvoiceClusterUndispatched(
  db: DatabaseConnection,
  planId: string,
  clusterIndex: number
): Promise<void> {
  await db.query(
    `UPDATE invoice_cluster_plans
        SET status = 'failed', updated_at = CURRENT_TIMESTAMP
      WHERE plan_id = $1 AND cluster_index = $2 AND status = 'pending'`,
    [planId, clusterIndex]
  );
}

/** Returns a claimed cluster to pending when this run did no work on it (another run owns the invoice). */
export async function releaseInvoiceCluster(
  db: DatabaseConnection,
  planId: string,
  clusterIndex: number
): Promise<void> {
  await db.query(
    `UPDATE invoice_cluster_plans
        SET status = 'pending', claimed_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE plan_id = $1 AND cluster_index = $2 AND status = 'processing'`,
    [planId, clusterIndex]
  );
}
