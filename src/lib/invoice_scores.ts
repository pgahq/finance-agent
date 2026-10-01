import type { DatabaseConnection } from './database.js';
import type { CancelAttribution, CancelBasis, CancelEvidence, InvoiceStatusRow, Outcome, ScoredChange } from './invoice_score.js';
import { AGENT_WRITE_SOURCES, type ScoredFields } from './invoice_snapshots.js';
import { executeWorkdayQuery, type WorkdayConfig } from './workday.js';

export interface InvoiceScore {
  workdayInvoiceWid: string;
  workdayInvoiceNumber?: string;
  /** Which agent path first wrote the invoice: `create` (new invoice) or `enrich` (Workday OCR invoice). */
  origin?: 'create' | 'enrich';
  conversationId?: string;
  entryStatus?: string;
  entryReadAt?: Date;
  entryFields?: ScoredFields;
  entryDiff?: ScoredChange[];
  finalStatus?: string;
  finalReadAt?: Date;
  lateDiff?: ScoredChange[];
  outcome?: Outcome;
  cancelReason?: string;
  cancelAttribution?: CancelAttribution;
  cancelBasis?: CancelBasis;
  cancelEvidence?: CancelEvidence;
  holdReason?: string;
  releaseSha?: string;
  clusteringMode?: string;
  terminal: boolean;
  updatedAt?: Date;
}

function parseJson<T>(value: unknown): T | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return undefined;
    }
  }
  return value as T;
}

function optionalDate(value: unknown): Date | undefined {
  if (value == null) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function optionalString<T extends string = string>(value: unknown): T | undefined {
  return value == null || value === '' ? undefined : (String(value) as T);
}

export function rowToInvoiceScore(row: Record<string, unknown>): InvoiceScore {
  const score: InvoiceScore = {
    workdayInvoiceWid: String(row.workday_invoice_wid),
    workdayInvoiceNumber: optionalString(row.workday_invoice_number),
    origin: optionalString<'create' | 'enrich'>(row.origin),
    conversationId: optionalString(row.conversation_id),
    entryStatus: optionalString(row.entry_status),
    entryReadAt: optionalDate(row.entry_read_at),
    entryFields: parseJson<ScoredFields>(row.entry_fields),
    entryDiff: parseJson<ScoredChange[]>(row.entry_diff),
    finalStatus: optionalString(row.final_status),
    finalReadAt: optionalDate(row.final_read_at),
    lateDiff: parseJson<ScoredChange[]>(row.late_diff),
    outcome: optionalString<Outcome>(row.outcome),
    cancelReason: optionalString(row.cancel_reason),
    cancelAttribution: optionalString<CancelAttribution>(row.cancel_attribution),
    cancelBasis: optionalString<CancelBasis>(row.cancel_basis),
    cancelEvidence: parseJson<CancelEvidence>(row.cancel_evidence),
    holdReason: optionalString(row.hold_reason),
    releaseSha: optionalString(row.release_sha),
    clusteringMode: optionalString(row.clustering_mode),
    terminal: row.terminal === true || row.terminal === 't' || row.terminal === 'true',
    updatedAt: optionalDate(row.updated_at),
  };
  return Object.fromEntries(Object.entries(score).filter(([, value]) => value !== undefined)) as unknown as InvoiceScore;
}

export async function getInvoiceScore(db: DatabaseConnection, workdayInvoiceWid: string): Promise<InvoiceScore | undefined> {
  const rows = await db.query('SELECT * FROM agent_invoice_scores WHERE workday_invoice_wid = $1', [workdayInvoiceWid]) as Array<Record<string, unknown>>;
  return rows[0] ? rowToInvoiceScore(rows[0]) : undefined;
}

const json = (value: unknown) => (value === undefined ? null : JSON.stringify(value));

export async function upsertInvoiceScore(db: DatabaseConnection, score: InvoiceScore): Promise<void> {
  await db.query(
    `INSERT INTO agent_invoice_scores
       (workday_invoice_wid, workday_invoice_number, origin, conversation_id, entry_status, entry_read_at,
        entry_fields, entry_diff, final_status, final_read_at, late_diff, outcome, cancel_reason,
        cancel_attribution, cancel_basis, cancel_evidence, hold_reason, release_sha, clustering_mode, terminal, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, CURRENT_TIMESTAMP)
     ON CONFLICT (workday_invoice_wid) DO UPDATE SET
       workday_invoice_number = EXCLUDED.workday_invoice_number,
       origin = EXCLUDED.origin,
       conversation_id = EXCLUDED.conversation_id,
       entry_status = EXCLUDED.entry_status,
       entry_read_at = EXCLUDED.entry_read_at,
       entry_fields = EXCLUDED.entry_fields,
       entry_diff = EXCLUDED.entry_diff,
       final_status = EXCLUDED.final_status,
       final_read_at = EXCLUDED.final_read_at,
       late_diff = EXCLUDED.late_diff,
       outcome = EXCLUDED.outcome,
       cancel_reason = EXCLUDED.cancel_reason,
       cancel_attribution = EXCLUDED.cancel_attribution,
       cancel_basis = EXCLUDED.cancel_basis,
       cancel_evidence = EXCLUDED.cancel_evidence,
       hold_reason = EXCLUDED.hold_reason,
       release_sha = EXCLUDED.release_sha,
       clustering_mode = EXCLUDED.clustering_mode,
       terminal = EXCLUDED.terminal,
       updated_at = CURRENT_TIMESTAMP`,
    [
      score.workdayInvoiceWid,
      score.workdayInvoiceNumber ?? null,
      score.origin ?? null,
      score.conversationId ?? null,
      score.entryStatus ?? null,
      score.entryReadAt ?? null,
      json(score.entryFields),
      json(score.entryDiff),
      score.finalStatus ?? null,
      score.finalReadAt ?? null,
      json(score.lateDiff),
      score.outcome ?? null,
      score.cancelReason ?? null,
      score.cancelAttribution ?? null,
      score.cancelBasis ?? null,
      json(score.cancelEvidence),
      score.holdReason ?? null,
      score.releaseSha ?? null,
      score.clusteringMode ?? null,
      score.terminal,
    ]
  );
}

export interface PendingScoreRow {
  workdayInvoiceWid: string;
  lastWriteAt: Date;
  entryReadAt?: Date;
  finalReadAt?: Date;
  outcome?: Outcome;
}

/** Agent-written invoices that have not reached a terminal score yet. */
export async function listPendingScoreInvoices(db: DatabaseConnection): Promise<PendingScoreRow[]> {
  const rows = await db.query(
    `SELECT s.workday_invoice_wid, MAX(s.created_at) AS last_write_at,
            sc.entry_read_at, sc.final_read_at, sc.outcome
       FROM agent_invoice_snapshots s
       LEFT JOIN agent_invoice_scores sc ON sc.workday_invoice_wid = s.workday_invoice_wid
      WHERE s.source = ANY($1::text[]) AND COALESCE(sc.terminal, false) = false
      GROUP BY s.workday_invoice_wid, sc.entry_read_at, sc.final_read_at, sc.outcome`,
    [[...AGENT_WRITE_SOURCES]]
  );
  return rows.map((row: Record<string, unknown>) => ({
    workdayInvoiceWid: String(row.workday_invoice_wid),
    lastWriteAt: optionalDate(row.last_write_at) ?? new Date(0),
    ...(optionalDate(row.entry_read_at) ? { entryReadAt: optionalDate(row.entry_read_at) } : {}),
    ...(optionalDate(row.final_read_at) ? { finalReadAt: optionalDate(row.final_read_at) } : {}),
    ...(row.outcome ? { outcome: String(row.outcome) as Outcome } : {}),
  }));
}

export async function getCancelLabel(db: DatabaseConnection, workdayInvoiceWid: string): Promise<'agent' | 'business' | undefined> {
  const rows = await db.query('SELECT attribution FROM cancel_labels WHERE workday_invoice_wid = $1', [workdayInvoiceWid]) as Array<{ attribution?: unknown }>;
  const attribution = rows[0]?.attribution;
  return attribution === 'agent' || attribution === 'business' ? attribution : undefined;
}

export async function countAgentInvoicesInConversation(db: DatabaseConnection, conversationId: string): Promise<number> {
  const rows = await db.query(
    `SELECT COUNT(DISTINCT workday_invoice_wid) AS count FROM agent_invoice_snapshots
      WHERE conversation_id = $1 AND source = ANY($2::text[])`,
    [conversationId, [...AGENT_WRITE_SOURCES]]
  ) as Array<{ count?: unknown }>;
  return Number(rows[0]?.count ?? 0);
}

/** Other agent-written invoices whose latest snapshot has the same supplier and supplier invoice number. */
export async function findOtherAgentInvoicesWithSameNumber(
  db: DatabaseConnection,
  workdayInvoiceWid: string,
  supplier: string,
  suppliersInvoiceNumber: string
): Promise<Array<{ workdayInvoiceWid: string; workdayInvoiceNumber?: string }>> {
  const rows = await db.query(
    `SELECT DISTINCT ON (workday_invoice_wid) workday_invoice_wid, workday_invoice_number
       FROM agent_invoice_snapshots
      WHERE workday_invoice_wid <> $1 AND source = ANY($2::text[])
        AND fields->>'supplier' = $3 AND fields->>'suppliersInvoiceNumber' = $4
      ORDER BY workday_invoice_wid, write_seq DESC`,
    [workdayInvoiceWid, [...AGENT_WRITE_SOURCES], supplier, suppliersInvoiceNumber]
  );
  return rows.map((row: Record<string, unknown>) => ({
    workdayInvoiceWid: String(row.workday_invoice_wid),
    ...(row.workday_invoice_number ? { workdayInvoiceNumber: String(row.workday_invoice_number) } : {}),
  }));
}

export async function isAgentWrittenInvoice(db: DatabaseConnection, workdayInvoiceWid: string): Promise<boolean> {
  const rows = await db.query(
    'SELECT 1 FROM agent_invoice_snapshots WHERE workday_invoice_wid = $1 AND source = ANY($2::text[]) LIMIT 1',
    [workdayInvoiceWid, [...AGENT_WRITE_SOURCES]]
  );
  return rows.length > 0;
}

export function escapeWqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/** WQL reference fields come back as `{ descriptor, id }`; plain values pass through. */
function wqlText(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'object') {
    const record = value as { descriptor?: unknown; id?: unknown };
    const text = record.descriptor ?? record.id;
    return text == null ? undefined : String(text);
  }
  const text = String(value).trim();
  return text || undefined;
}

export const STATUS_BATCH_SIZE = 50;

/**
 * Status for each WID, batched. A WID missing from the result is not in Workday any more.
 * `SCORE_CANCEL_REASON_WQL_FIELD` and `SCORE_HOLD_REASON_WQL_FIELD` name optional extra fields;
 * they stay unset until the tenant's field names are confirmed.
 */
export async function fetchInvoiceStatuses(
  config: WorkdayConfig,
  workdayInvoiceWids: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<Map<string, InvoiceStatusRow>> {
  const cancelReasonField = env.SCORE_CANCEL_REASON_WQL_FIELD?.trim();
  const holdReasonField = env.SCORE_HOLD_REASON_WQL_FIELD?.trim();
  const extraFields = [cancelReasonField, holdReasonField].filter((field): field is string => Boolean(field));
  const statuses = new Map<string, InvoiceStatusRow>();
  for (let start = 0; start < workdayInvoiceWids.length; start += STATUS_BATCH_SIZE) {
    const batch = workdayInvoiceWids.slice(start, start + STATUS_BATCH_SIZE);
    const result = await executeWorkdayQuery(
      config,
      `SELECT workdayID, invoiceStatusAsText, isCanceled, invoiceIsPaid, invoiceIsPartiallyPaid${extraFields.map((field) => `, ${field}`).join('')}
       FROM supplierInvoices (dataSourceFilter = supplierInvoicesFilter)
       WHERE workdayID in (${batch.map((wid) => `'${escapeWqlLiteral(wid)}'`).join(', ')})`
    );
    for (const row of (result.data ?? []) as Array<Record<string, unknown>>) {
      const workdayID = typeof row.workdayID === 'string' ? row.workdayID : undefined;
      if (!workdayID) continue;
      const cancelReason = cancelReasonField ? wqlText(row[cancelReasonField]) : undefined;
      const holdReason = holdReasonField ? wqlText(row[holdReasonField]) : undefined;
      statuses.set(workdayID, {
        workdayID,
        ...(typeof row.invoiceStatusAsText === 'string' ? { invoiceStatusAsText: row.invoiceStatusAsText } : {}),
        isCanceled: row.isCanceled,
        invoiceIsPaid: row.invoiceIsPaid,
        invoiceIsPartiallyPaid: row.invoiceIsPartiallyPaid,
        ...(cancelReason ? { cancelReason } : {}),
        ...(holdReason ? { holdReason } : {}),
      });
    }
  }
  return statuses;
}

/**
 * Live invoices with the same supplier invoice number, found through `SCORE_SUPPLIERS_INVOICE_NUMBER_WQL_FIELD`.
 * Returns nothing when that field is not configured.
 */
export async function findLiveInvoicesWithSuppliersInvoiceNumber(
  config: WorkdayConfig,
  suppliersInvoiceNumber: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<Array<{ workdayID: string; invoiceNumber?: string; supplierId?: string }>> {
  const field = env.SCORE_SUPPLIERS_INVOICE_NUMBER_WQL_FIELD?.trim();
  if (!field) return [];
  const result = await executeWorkdayQuery(
    config,
    `SELECT workdayID, invoiceNumber, supplier
     FROM supplierInvoices (dataSourceFilter = supplierInvoicesFilter)
     WHERE ${field} = '${escapeWqlLiteral(suppliersInvoiceNumber)}' AND isCanceled = false`
  );
  return ((result.data ?? []) as Array<Record<string, unknown>>)
    .filter((row) => typeof row.workdayID === 'string')
    .map((row) => {
      const supplier = row.supplier as { id?: unknown } | undefined;
      return {
        workdayID: row.workdayID as string,
        ...(typeof row.invoiceNumber === 'string' ? { invoiceNumber: row.invoiceNumber } : {}),
        ...(supplier && typeof supplier === 'object' && supplier.id != null ? { supplierId: String(supplier.id) } : {}),
      };
    });
}
