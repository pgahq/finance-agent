import { debug } from '@pga/logger';
import type { DatabaseConnection } from './database.js';
import { asArray, extractLineOfBusinessId } from './related_worktags.js';
import { getSupplierInvoice, type WorkdayConfig } from './workday.js';

export type SnapshotSource = 'create' | 'resend_update' | 'enrich' | 'enrich_baseline';

/** Snapshot sources that record a finance-agent write (an enrich baseline is the invoice before the agent touched it). */
export const AGENT_WRITE_SOURCES: readonly SnapshotSource[] = ['create', 'resend_update', 'enrich'];

export interface ScoredLine {
  lineOrder?: number;
  amount?: number;
  purchaseOrderLine?: string;
  spendCategory?: string;
  costCenter?: string;
  fund?: string;
  lineOfBusiness?: string;
  otherWorktags: string[];
  memo?: string;
  itemDescription?: string;
}

export interface ScoredFields {
  supplier?: string;
  company?: string;
  suppliersInvoiceNumber?: string;
  invoiceDate?: string;
  controlTotal?: number;
  memo?: string;
  lines: ScoredLine[];
}

export const HEADER_FIELDS = ['supplier', 'company', 'suppliersInvoiceNumber', 'invoiceDate', 'controlTotal', 'memo'] as const;
export const LINE_FIELDS = [
  'amount',
  'purchaseOrderLine',
  'spendCategory',
  'costCenter',
  'fund',
  'lineOfBusiness',
  'otherWorktags',
  'memo',
  'itemDescription',
] as const;

export type HeaderField = typeof HEADER_FIELDS[number];
export type LineField = typeof LINE_FIELDS[number];
export type ScoredFieldName = HeaderField | `line.${LineField}` | 'line.added' | 'line.removed';

export interface FieldChange {
  field: ScoredFieldName;
  /** Index into the later read's lines (the earlier read's index for a removed line). */
  line?: number;
  before?: unknown;
  after?: unknown;
}

export interface AgentInvoiceSnapshot {
  workdayInvoiceWid: string;
  writeSeq: number;
  source: SnapshotSource;
  workdayInvoiceNumber?: string;
  fields: ScoredFields;
  conversationId?: string;
  s3Keys?: string[];
  attachmentKinds?: string[];
  releaseSha?: string;
  clusteringMode?: string;
  preWriteDiff?: FieldChange[];
  createdAt: Date;
}

function scalar(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value) && '$value' in (value as Record<string, unknown>)) {
    return (value as Record<string, unknown>).$value;
  }
  return value;
}

function text(value: unknown): string | undefined {
  const raw = scalar(Array.isArray(value) ? value[0] : value);
  if (raw == null) return undefined;
  const trimmed = String(raw).trim();
  return trimmed ? trimmed : undefined;
}

function amount(value: unknown): number | undefined {
  const raw = scalar(Array.isArray(value) ? value[0] : value);
  if (raw == null || raw === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : undefined;
}

interface ReferenceId {
  type?: string;
  value: string;
}

function referenceIds(reference: unknown): ReferenceId[] {
  return asArray(reference).flatMap((ref) => {
    if (!ref || typeof ref !== 'object') return [];
    return asArray((ref as { ID?: unknown }).ID).flatMap((id): ReferenceId[] => {
      if (id && typeof id === 'object') {
        const record = id as { $attributes?: { type?: string }; $value?: unknown; type?: string; value?: unknown };
        const value = record.$value ?? record.value;
        if (value == null || value === '') return [];
        return [{ type: record.$attributes?.type ?? record.type, value: String(value) }];
      }
      return typeof id === 'string' && id ? [{ value: id }] : [];
    });
  });
}

/** Stable key for a Workday reference: its first non-WID ID (readable in reports), else the WID. */
export function referenceKey(reference: unknown): string | undefined {
  const ids = referenceIds(reference);
  const preferred = ids.find((id) => id.type && id.type !== 'WID') ?? ids[0];
  if (!preferred) return undefined;
  return preferred.type ? `${preferred.type}=${preferred.value}` : preferred.value;
}

/** The WID of a Workday reference, when the response carried one. */
export function referenceWid(reference: unknown): string | undefined {
  return referenceIds(reference).find((id) => id.type === 'WID')?.value;
}

function worktagHasType(worktag: unknown, type: string): boolean {
  return referenceIds(worktag).some((id) => id.type === type);
}

function extractLine(line: Record<string, unknown>): ScoredLine {
  let costCenter: string | undefined;
  let fund: string | undefined;
  let lineOfBusiness: string | undefined;
  const otherWorktags: string[] = [];
  for (const worktag of asArray(line.Worktags_Reference)) {
    const key = referenceKey(worktag);
    if (!key) continue;
    if (!costCenter && worktagHasType(worktag, 'Cost_Center_Reference_ID')) {
      costCenter = key;
    } else if (!fund && worktagHasType(worktag, 'Fund_ID')) {
      fund = key;
    } else if (!lineOfBusiness && extractLineOfBusinessId([worktag])) {
      lineOfBusiness = key;
    } else {
      otherWorktags.push(key);
    }
  }
  const lineOrder = amount(line.Line_Order);
  return {
    ...(lineOrder != null ? { lineOrder } : {}),
    ...withDefined('amount', amount(line.Extended_Amount)),
    ...withDefined('purchaseOrderLine', referenceKey(line.Purchase_Order_Line_Reference)),
    ...withDefined('spendCategory', referenceKey(line.Spend_Category_Reference)),
    ...withDefined('costCenter', costCenter),
    ...withDefined('fund', fund),
    ...withDefined('lineOfBusiness', lineOfBusiness),
    otherWorktags: [...new Set(otherWorktags)].sort(),
    ...withDefined('memo', text(line.Memo)),
    ...withDefined('itemDescription', text(line.Item_Description)),
  };
}

function withDefined<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/**
 * Whitelist of the fields the agent is responsible for entering, normalized from a Get_Supplier_Invoices
 * Supplier_Invoice_Data object. Notes, assignee, tags, attachments, the conversation URL field, and
 * Workday-computed tax are left out on purpose: they are process steps, not coding.
 */
export function extractScoredFields(invoice: unknown): ScoredFields {
  const data = (invoice && typeof invoice === 'object' ? invoice : {}) as Record<string, unknown>;
  const invoiceDate = text(data.Invoice_Date)?.slice(0, 10);
  const lines = asArray(data.Invoice_Line_Replacement_Data)
    .filter((line): line is Record<string, unknown> => Boolean(line) && typeof line === 'object')
    .map(extractLine)
    .sort((a, b) => (a.lineOrder ?? Number.MAX_SAFE_INTEGER) - (b.lineOrder ?? Number.MAX_SAFE_INTEGER));
  return {
    ...withDefined('supplier', referenceKey(data.Supplier_Reference)),
    ...withDefined('company', referenceKey(data.Company_Reference)),
    ...withDefined('suppliersInvoiceNumber', text(data.Suppliers_Invoice_Number)),
    ...withDefined('invoiceDate', invoiceDate),
    ...withDefined('controlTotal', amount(data.Control_Amount_Total)),
    ...withDefined('memo', text(data.Memo)),
    lines,
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    const left = asArray(a as unknown[]).map(String);
    const right = asArray(b as unknown[]).map(String);
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  return (a ?? null) === (b ?? null);
}

/**
 * Pair lines between two reads: same position and amount first, then the same amount anywhere
 * (keeps order), then whatever is left by position. Unpaired lines are added or removed.
 */
function pairLines(before: ScoredLine[], after: ScoredLine[]): { pairs: Array<[number, number]>; removed: number[]; added: number[] } {
  const usedBefore = new Set<number>();
  const usedAfter = new Set<number>();
  const pairs: Array<[number, number]> = [];
  const take = (b: number, a: number) => {
    usedBefore.add(b);
    usedAfter.add(a);
    pairs.push([b, a]);
  };

  for (let i = 0; i < Math.min(before.length, after.length); i++) {
    if (before[i].amount === after[i].amount) take(i, i);
  }
  for (let b = 0; b < before.length; b++) {
    if (usedBefore.has(b)) continue;
    const a = after.findIndex((line, index) => !usedAfter.has(index) && line.amount === before[b].amount);
    if (a >= 0) take(b, a);
  }
  const leftBefore = before.map((_, index) => index).filter((index) => !usedBefore.has(index));
  const leftAfter = after.map((_, index) => index).filter((index) => !usedAfter.has(index));
  const positional = Math.min(leftBefore.length, leftAfter.length);
  for (let i = 0; i < positional; i++) take(leftBefore[i], leftAfter[i]);

  return {
    pairs: pairs.sort((x, y) => x[1] - y[1]),
    removed: leftBefore.slice(positional),
    added: leftAfter.slice(positional),
  };
}

/** Field-level changes from one read of the scored fields to a later one. */
export function diffScoredFields(before: ScoredFields, after: ScoredFields): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of HEADER_FIELDS) {
    if (!sameValue(before[field], after[field])) {
      changes.push({ field, before: before[field], after: after[field] });
    }
  }

  const beforeLines = before.lines ?? [];
  const afterLines = after.lines ?? [];
  const { pairs, removed, added } = pairLines(beforeLines, afterLines);
  for (const [b, a] of pairs) {
    for (const field of LINE_FIELDS) {
      const left = beforeLines[b][field];
      const right = afterLines[a][field];
      if (!sameValue(left, right)) {
        changes.push({ field: `line.${field}`, line: a, before: left, after: right });
      }
    }
  }
  for (const index of removed) {
    changes.push({ field: 'line.removed', line: index, before: beforeLines[index] });
  }
  for (const index of added) {
    changes.push({ field: 'line.added', line: index, after: afterLines[index] });
  }
  return changes;
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

function rowToSnapshot(row: Record<string, unknown>): AgentInvoiceSnapshot {
  return {
    workdayInvoiceWid: String(row.workday_invoice_wid),
    writeSeq: Number(row.write_seq),
    source: row.source as SnapshotSource,
    ...(row.workday_invoice_number ? { workdayInvoiceNumber: String(row.workday_invoice_number) } : {}),
    fields: parseJson<ScoredFields>(row.fields) ?? { lines: [] },
    ...(row.conversation_id ? { conversationId: String(row.conversation_id) } : {}),
    ...withDefined('s3Keys', parseJson<string[]>(row.s3_keys)),
    ...withDefined('attachmentKinds', parseJson<string[]>(row.attachment_kinds)),
    ...(row.release_sha ? { releaseSha: String(row.release_sha) } : {}),
    ...(row.clustering_mode ? { clusteringMode: String(row.clustering_mode) } : {}),
    ...withDefined('preWriteDiff', parseJson<FieldChange[]>(row.pre_write_diff)),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
  };
}

const SNAPSHOT_COLUMNS = `workday_invoice_wid, write_seq, source, workday_invoice_number, fields, conversation_id,
  s3_keys, attachment_kinds, release_sha, clustering_mode, pre_write_diff, created_at`;

export interface RecordSnapshotInput {
  workdayInvoiceWid: string;
  source: SnapshotSource;
  fields: ScoredFields;
  workdayInvoiceNumber?: string;
  conversationId?: string;
  s3Keys?: string[];
  attachmentKinds?: string[];
  clusteringMode?: string;
  preWriteDiff?: FieldChange[];
  releaseSha?: string;
}

/** Inserts the next write_seq for the invoice. Concurrent writes to one invoice are already serialized upstream. */
export async function recordAgentInvoiceSnapshot(db: DatabaseConnection, input: RecordSnapshotInput): Promise<void> {
  await db.query(
    `INSERT INTO agent_invoice_snapshots
       (workday_invoice_wid, write_seq, source, workday_invoice_number, fields, conversation_id,
        s3_keys, attachment_kinds, release_sha, clustering_mode, pre_write_diff)
     VALUES ($1::varchar,
       COALESCE((SELECT MAX(write_seq) FROM agent_invoice_snapshots WHERE workday_invoice_wid = $1::varchar), 0) + 1,
       $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      input.workdayInvoiceWid,
      input.source,
      input.workdayInvoiceNumber ?? null,
      JSON.stringify(input.fields),
      input.conversationId ?? null,
      input.s3Keys?.length ? JSON.stringify(input.s3Keys) : null,
      input.attachmentKinds?.length ? JSON.stringify(input.attachmentKinds) : null,
      input.releaseSha ?? process.env.RELEASE_SHA ?? null,
      input.clusteringMode ?? null,
      input.preWriteDiff ? JSON.stringify(input.preWriteDiff) : null,
    ]
  );
}

export async function getAgentInvoiceSnapshots(db: DatabaseConnection, workdayInvoiceWid: string): Promise<AgentInvoiceSnapshot[]> {
  const rows = await db.query(
    `SELECT ${SNAPSHOT_COLUMNS} FROM agent_invoice_snapshots WHERE workday_invoice_wid = $1 ORDER BY write_seq`,
    [workdayInvoiceWid]
  ) as Array<Record<string, unknown>>;
  return rows.map(rowToSnapshot);
}

export async function getLatestAgentWriteSnapshot(
  db: DatabaseConnection,
  workdayInvoiceWid: string
): Promise<AgentInvoiceSnapshot | undefined> {
  const rows = await db.query(
    `SELECT ${SNAPSHOT_COLUMNS} FROM agent_invoice_snapshots
      WHERE workday_invoice_wid = $1 AND source = ANY($2::text[])
      ORDER BY write_seq DESC LIMIT 1`,
    [workdayInvoiceWid, [...AGENT_WRITE_SOURCES]]
  ) as Array<Record<string, unknown>>;
  return rows[0] ? rowToSnapshot(rows[0]) : undefined;
}

export interface SnapshotAgentWriteInput extends Omit<RecordSnapshotInput, 'fields' | 'preWriteDiff'> {
  /** The invoice as Workday returned it after the write; read again when omitted. */
  invoice?: unknown;
  /** The live invoice read just before an update, so AP edits the update overwrites are kept. */
  previousInvoice?: unknown;
}

/**
 * Records a snapshot for an agent write and never throws: a missed snapshot only costs that invoice its
 * score, so the caller reports `snapshotSync: failed` instead of failing the invoice.
 * Returns false when the snapshot was not saved.
 */
export async function snapshotAgentWrite(
  context: { workdayConfig: WorkdayConfig; dbConnection: DatabaseConnection },
  input: SnapshotAgentWriteInput
): Promise<boolean> {
  try {
    const { invoice: providedInvoice, previousInvoice, ...rest } = input;
    let preWriteDiff: FieldChange[] | undefined;
    if (previousInvoice !== undefined) {
      const latest = await getLatestAgentWriteSnapshot(context.dbConnection, input.workdayInvoiceWid);
      if (latest) preWriteDiff = diffScoredFields(latest.fields, extractScoredFields(previousInvoice));
    }
    const invoice: unknown = providedInvoice ?? await getSupplierInvoice(context, input.workdayInvoiceWid) as unknown;
    const invoiceNumber = rest.workdayInvoiceNumber
      ?? (typeof (invoice as { Invoice_Number?: unknown })?.Invoice_Number === 'string'
        ? (invoice as { Invoice_Number: string }).Invoice_Number
        : undefined);
    await recordAgentInvoiceSnapshot(context.dbConnection, {
      ...rest,
      ...(invoiceNumber ? { workdayInvoiceNumber: invoiceNumber } : {}),
      fields: extractScoredFields(invoice),
      ...(preWriteDiff ? { preWriteDiff } : {}),
    });
    return true;
  } catch (error) {
    debug('Failed to record agent invoice snapshot', { workdayInvoiceWid: input.workdayInvoiceWid, source: input.source, error });
    return false;
  }
}

/** Records the invoice as it stood before an agent enrich write. Never throws. */
export async function snapshotEnrichBaseline(
  db: DatabaseConnection,
  input: Omit<RecordSnapshotInput, 'fields' | 'source'> & { invoice: unknown }
): Promise<boolean> {
  try {
    const { invoice, ...rest } = input;
    await recordAgentInvoiceSnapshot(db, { ...rest, source: 'enrich_baseline', fields: extractScoredFields(invoice) });
    return true;
  } catch (error) {
    debug('Failed to record enrich baseline snapshot', { workdayInvoiceWid: input.workdayInvoiceWid, error });
    return false;
  }
}
