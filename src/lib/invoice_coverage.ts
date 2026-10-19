import { debug } from '@pga/logger';
import type { DatabaseConnection } from './database.js';
import type { ProcessingContext } from './handlers.js';
import { escapeWqlLiteral } from './invoice_scores.js';
import { executeWorkdayQuery, getWorkQueueTagWIDs } from './workday.js';

/**
 * Agent coverage: of the supplier invoices created for PGA Corp companies in a period, the share the finance agent
 * created or enriched. An invoice counts as agent supported when it carries the agent's work queue tag or has a row in
 * `agent_invoice_snapshots` (AP can replace the tag; older invoices predate snapshots). `invoiceCreatedBy` cannot
 * identify agent invoices (it names the AP teammate who started the Intercom action), so it only splits the rest.
 */

export const AGENT_MODIFIED_TAG_REF_ID = process.env.WORKDAY_AGENT_MODIFIED_TAG_REF_ID || 'FINAGENT-invoice-modified';

/**
 * PGA Corp companies the KPI covers, as Workday company WIDs (Sections create their own supplier invoices and are out
 * of scope). WIDs are used directly because the company cache needs a grant that is not confirmed. Override with a
 * comma-separated `COVERAGE_COMPANY_WIDS`.
 */
export const DEFAULT_COVERAGE_COMPANY_WIDS = [
  'cab0b1d2505a01338fcd651982277bec', // The Professional Golfers Association of America
  'cab0b1d2505a01c495e8ac1a8227b9ed', // PGA Tournament Corporation, Inc.
  'cab0b1d2505a01a3c9d92c1a822736ed', // PGA Foundation Inc
  'cab0b1d2505a01f41fe1171a822720ed', // PGA Corporation
  'cab0b1d2505a01bbec0c611a82276ded', // PGA Golf Properties, Inc.
  'cab0b1d2505a01086d9d4a1a822757ed', // PGA Golf Enterprises
];

export function coverageCompanyWids(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = (env.COVERAGE_COMPANY_WIDS ?? '').split(',').map((wid) => wid.trim()).filter(Boolean);
  return configured.length ? configured : DEFAULT_COVERAGE_COMPANY_WIDS;
}

/** Days recomputed on each run, so cancels and late enrichments still land in recent days. */
export const COVERAGE_ROLLUP_DAYS = 15;
/** Days the first run (empty table) backfills. */
export const COVERAGE_BACKFILL_DAYS = 90;

export const COVERAGE_TOP_LIMIT = 5;
export const COVERAGE_LINK_LIMIT = 10;

export type CoverageCategory =
  | 'out_of_scope'
  | 'canceled'
  | 'agent_created'
  | 'agent_enriched'
  | 'agent_notes_only'
  | 'uncovered_ocr'
  | 'uncovered_manual'
  | 'uncovered_integration';

const AGENT_CATEGORIES: CoverageCategory[] = ['agent_created', 'agent_enriched', 'agent_notes_only'];
const UNCOVERED_CATEGORIES: CoverageCategory[] = ['uncovered_ocr', 'uncovered_manual', 'uncovered_integration'];

export interface CoverageRow {
  workdayInvoiceWid: string;
  workdayInvoiceNumber?: string;
  companyWid?: string;
  supplier?: string;
  creator?: string;
  hasAgentTag: boolean;
  isOcr: boolean;
  isCanceled: boolean;
  /** Central calendar day (YYYY-MM-DD) the invoice was created in Workday. */
  day: string;
}

export interface ClassifiedInvoice extends CoverageRow {
  category: CoverageCategory;
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

const centralDayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Chicago',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The Central calendar day (YYYY-MM-DD) containing `at`. */
export function centralDayKey(at: Date): string {
  return centralDayFormat.format(at);
}

/** `day` moved by `days` calendar days. */
export function shiftDayKey(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function assertDay(day: string): string {
  if (!DAY_KEY.test(day)) throw new Error(`Invalid coverage day: ${day}`);
  return day;
}

/**
 * WQL for the invoices created from `startDay` to `endDay` (Central, inclusive). `createdOn` is a date in the Workday
 * tenant's timezone, so the filter is padded by a day on each side and rows are placed by `createdDateTime`.
 */
export function buildCoverageQuery(startDay: string, endDay: string, companyWids?: string[]): string {
  const from = shiftDayKey(assertDay(startDay), -1);
  const to = shiftDayKey(assertDay(endDay), 1);
  const company = companyWids?.length
    ? `\n       AND company1 in (${companyWids.map((wid) => `'${escapeWqlLiteral(wid)}'`).join(', ')})`
    : '';
  const fields = companyWids
    ? 'workdayID, invoiceNumber, supplier, company1, OCRSupplierInvoice, workQueueTags, isCanceled, createdOn, createdDateTime, invoiceCreatedBy'
    : 'workdayID, company1, createdOn, createdDateTime';
  return `SELECT ${fields}
     FROM supplierInvoices (dataSourceFilter = supplierInvoicesFilter)
     WHERE createdOn >= '${from}' AND createdOn <= '${to}'${company}`;
}

type WqlRecord = Record<string, unknown>;

function reference(value: unknown): { id?: string; descriptor?: string } | undefined {
  const item: unknown = Array.isArray(value) ? (value as unknown[])[0] : value;
  if (!item || typeof item !== 'object') return undefined;
  const { id, descriptor } = item as { id?: unknown; descriptor?: unknown };
  return {
    ...(typeof id === 'string' ? { id } : {}),
    ...(typeof descriptor === 'string' ? { descriptor } : {}),
  };
}

function createdDay(record: WqlRecord): string | undefined {
  if (typeof record.createdDateTime === 'string') {
    const stamp = new Date(record.createdDateTime);
    if (!Number.isNaN(stamp.getTime())) return centralDayKey(stamp);
  }
  const on = typeof record.createdOn === 'string' ? record.createdOn.slice(0, 10) : undefined;
  return on && DAY_KEY.test(on) ? on : undefined;
}

function records(result: { data?: unknown[] } | undefined): WqlRecord[] {
  return ((result?.data ?? []) as WqlRecord[]).filter((row) => row && typeof row.workdayID === 'string');
}

/** Every PGA Corp supplier invoice created from `startDay` to `endDay` (Central, inclusive). */
export async function loadCoverageRows(
  context: Pick<ProcessingContext, 'workdayConfig'>,
  startDay: string,
  endDay: string
): Promise<CoverageRow[]> {
  const tagWids = new Set(await getWorkQueueTagWIDs(context, [AGENT_MODIFIED_TAG_REF_ID]));
  // A short page must fail loudly: undercounting the denominator would inflate the share.
  const result = await executeWorkdayQuery(
    context.workdayConfig,
    buildCoverageQuery(startDay, endDay, coverageCompanyWids()),
    { requireCompleteTotal: true }
  );
  const rows = new Map<string, CoverageRow>();
  for (const record of records(result)) {
    const day = createdDay(record);
    if (!day) {
      debug('Skipping an invoice with no creation date in the coverage query', { workdayID: record.workdayID });
      continue;
    }
    if (day < startDay || day > endDay) continue;
    const wid = record.workdayID as string;
    if (rows.has(wid)) continue;
    const tags = Array.isArray(record.workQueueTags) ? record.workQueueTags : [];
    const ocr = record.OCRSupplierInvoice;
    rows.set(wid, {
      workdayInvoiceWid: wid,
      ...(typeof record.invoiceNumber === 'string' ? { workdayInvoiceNumber: record.invoiceNumber } : {}),
      ...(reference(record.company1)?.id ? { companyWid: reference(record.company1)!.id } : {}),
      ...(reference(record.supplier)?.descriptor ? { supplier: reference(record.supplier)!.descriptor } : {}),
      ...(reference(record.invoiceCreatedBy)?.descriptor ? { creator: reference(record.invoiceCreatedBy)!.descriptor } : {}),
      hasAgentTag: tags.some((tag) => tagWids.has(reference(tag)?.id ?? '')),
      isOcr: Array.isArray(ocr) ? ocr.length > 0 : Boolean(ocr),
      isCanceled: record.isCanceled === true,
      day,
    });
  }
  return [...rows.values()];
}

/** Invoices created in the window for companies outside the KPI scope, so the digest can show the filter working. */
export async function countOutOfScopeInvoices(
  context: Pick<ProcessingContext, 'workdayConfig'>,
  startDay: string,
  endDay: string
): Promise<number> {
  const inScope = new Set(coverageCompanyWids());
  const result = await executeWorkdayQuery(
    context.workdayConfig,
    buildCoverageQuery(startDay, endDay),
    { requireCompleteTotal: true }
  );
  const wids = new Set<string>();
  for (const record of records(result)) {
    const day = createdDay(record);
    if (!day || day < startDay || day > endDay) continue;
    if (!inScope.has(reference(record.company1)?.id ?? '')) wids.add(record.workdayID as string);
  }
  return wids.size;
}

/** Snapshot sources (`create`, `resend_update`, `enrich_baseline`, `enrich`) per agent-written invoice WID. */
export async function loadSnapshotSources(db: DatabaseConnection, wids: string[]): Promise<Map<string, string[]>> {
  const sources = new Map<string, string[]>();
  if (!wids.length) return sources;
  const rows = await db.query(
    `SELECT workday_invoice_wid, array_agg(DISTINCT source) AS sources
       FROM agent_invoice_snapshots
      WHERE workday_invoice_wid = ANY($1::text[])
      GROUP BY workday_invoice_wid`,
    [wids]
  ) as Array<{ workday_invoice_wid: string; sources?: string[] | null }>;
  for (const row of rows) sources.set(row.workday_invoice_wid, row.sources ?? []);
  return sources;
}

const ENRICH_SOURCES = new Set(['enrich', 'enrich_baseline']);

/**
 * Labels each invoice, checking in this order: outside the scoped companies, canceled (kept out of the share), agent
 * supported (tag or snapshot), then how the rest got into Workday. An empty creator is not agent support by itself.
 */
export function classifyCoverage(
  rows: CoverageRow[],
  snapshotSources: ReadonlyMap<string, string[]>,
  companyWids: Iterable<string> = coverageCompanyWids()
): ClassifiedInvoice[] {
  const inScope = new Set(companyWids);
  return rows.map((row): ClassifiedInvoice => {
    const sources = snapshotSources.get(row.workdayInvoiceWid);
    let category: CoverageCategory;
    if (!row.companyWid || !inScope.has(row.companyWid)) category = 'out_of_scope';
    else if (row.isCanceled) category = 'canceled';
    else if (sources) {
      category = sources.length && sources.every((source) => ENRICH_SOURCES.has(source)) ? 'agent_enriched' : 'agent_created';
    } else if (row.hasAgentTag) category = 'agent_notes_only';
    else if (row.isOcr) category = 'uncovered_ocr';
    else if (row.creator) category = 'uncovered_manual';
    else category = 'uncovered_integration';
    return { ...row, category };
  });
}

export type CoverageCounts = Record<CoverageCategory, number>;

export interface CoverageTotals {
  counts: CoverageCounts;
  /** Invoices in the share: in scope and not canceled. */
  invoices: number;
  supported: number;
  /** supported / invoices; undefined when there were no invoices. */
  share?: number;
  /** The same share with integration-created invoices (no creator) left out of the denominator. */
  shareWithoutIntegrations?: number;
}

const ROUND = 10_000;
const ratio = (part: number, whole: number): number | undefined => (whole ? Math.round((part / whole) * ROUND) / ROUND : undefined);

export function coverageTotals(invoices: ClassifiedInvoice[]): CoverageTotals {
  const counts: CoverageCounts = {
    out_of_scope: 0,
    canceled: 0,
    agent_created: 0,
    agent_enriched: 0,
    agent_notes_only: 0,
    uncovered_ocr: 0,
    uncovered_manual: 0,
    uncovered_integration: 0,
  };
  for (const invoice of invoices) counts[invoice.category] += 1;
  const supported = AGENT_CATEGORIES.reduce((sum, category) => sum + counts[category], 0);
  const uncovered = UNCOVERED_CATEGORIES.reduce((sum, category) => sum + counts[category], 0);
  const share = ratio(supported, supported + uncovered);
  const shareWithoutIntegrations = ratio(supported, supported + uncovered - counts.uncovered_integration);
  return {
    counts,
    invoices: supported + uncovered,
    supported,
    ...(share !== undefined ? { share } : {}),
    ...(shareWithoutIntegrations !== undefined ? { shareWithoutIntegrations } : {}),
  };
}

export interface CoverageCreator {
  name: string;
  agent: number;
  byHand: number;
}

export interface CoverageLink {
  workdayInvoiceWid: string;
  workdayInvoiceNumber?: string;
  supplier?: string;
  creator?: string;
  category: CoverageCategory;
}

export interface CoverageSummary {
  totals: CoverageTotals;
  previous?: CoverageTotals;
  topSuppliers: Array<{ name: string; count: number }>;
  /** AP teammates who keyed invoices by hand, with how many of their invoices went through the agent. */
  creators: CoverageCreator[];
  links: CoverageLink[];
  /** Invoices created in the period for companies outside the scope. */
  outOfScope?: number;
}

const byCountThenName = <T extends { name: string }>(count: (item: T) => number) => (a: T, b: T) =>
  count(b) - count(a) || a.name.localeCompare(b.name);

/** One invoice per creator in turn, biggest groups first, so a single teammate's batch does not fill the list. */
function sampleUncovered(uncovered: ClassifiedInvoice[], limit: number): CoverageLink[] {
  const groups = new Map<string, ClassifiedInvoice[]>();
  for (const invoice of uncovered) {
    const key = invoice.creator ?? '';
    groups.set(key, [...(groups.get(key) ?? []), invoice]);
  }
  const ordered = [...groups.values()].sort((a, b) => b.length - a.length);
  const links: CoverageLink[] = [];
  for (let round = 0; links.length < limit && ordered.some((group) => group.length > round); round += 1) {
    for (const group of ordered) {
      if (links.length >= limit) break;
      const invoice = group[round];
      if (!invoice) continue;
      links.push({
        workdayInvoiceWid: invoice.workdayInvoiceWid,
        ...(invoice.workdayInvoiceNumber ? { workdayInvoiceNumber: invoice.workdayInvoiceNumber } : {}),
        ...(invoice.supplier ? { supplier: invoice.supplier } : {}),
        ...(invoice.creator ? { creator: invoice.creator } : {}),
        category: invoice.category,
      });
    }
  }
  return links;
}

/** The period's shares and counts, the period before for comparison, and where the agent was not used. */
export function summarizeCoverage(
  current: ClassifiedInvoice[],
  previous?: ClassifiedInvoice[],
  limits: { top?: number; links?: number } = {}
): CoverageSummary {
  const top = limits.top ?? COVERAGE_TOP_LIMIT;
  const uncovered = current.filter((invoice) => UNCOVERED_CATEGORIES.includes(invoice.category));

  const suppliers = new Map<string, number>();
  for (const invoice of uncovered) {
    const name = invoice.supplier ?? '(no supplier)';
    suppliers.set(name, (suppliers.get(name) ?? 0) + 1);
  }

  const creators = new Map<string, CoverageCreator>();
  for (const invoice of current) {
    if (!invoice.creator) continue;
    const entry = creators.get(invoice.creator) ?? { name: invoice.creator, agent: 0, byHand: 0 };
    if (AGENT_CATEGORIES.includes(invoice.category)) entry.agent += 1;
    else if (invoice.category === 'uncovered_manual') entry.byHand += 1;
    creators.set(invoice.creator, entry);
  }

  return {
    totals: coverageTotals(current),
    ...(previous ? { previous: coverageTotals(previous) } : {}),
    topSuppliers: [...suppliers.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort(byCountThenName((item) => item.count))
      .slice(0, top),
    creators: [...creators.values()]
      .filter((creator) => creator.byHand > 0)
      .sort(byCountThenName((item) => item.byHand))
      .slice(0, top),
    links: sampleUncovered(uncovered, limits.links ?? COVERAGE_LINK_LIMIT),
  };
}

/** Loads and classifies the invoices created from `startDay` to `endDay` (Central, inclusive). */
export async function loadCoverage(
  context: Pick<ProcessingContext, 'workdayConfig' | 'dbConnection'>,
  startDay: string,
  endDay: string
): Promise<ClassifiedInvoice[]> {
  const rows = await loadCoverageRows(context, startDay, endDay);
  const sources = await loadSnapshotSources(context.dbConnection, rows.map((row) => row.workdayInvoiceWid));
  return classifyCoverage(rows, sources);
}

/** The KPI for the week of Central days `start` to `end` (exclusive) against the week before it. */
export async function loadWeeklyCoverage(
  context: Pick<ProcessingContext, 'workdayConfig' | 'dbConnection'>,
  window: { start: Date; end: Date; previousStart: Date }
): Promise<CoverageSummary> {
  const firstDay = centralDayKey(window.previousStart);
  const weekStart = centralDayKey(window.start);
  const lastDay = centralDayKey(new Date(window.end.getTime() - 1));
  const invoices = await loadCoverage(context, firstDay, lastDay);
  const summary = summarizeCoverage(
    invoices.filter((invoice) => invoice.day >= weekStart),
    invoices.filter((invoice) => invoice.day < weekStart)
  );
  try {
    return { ...summary, outOfScope: await countOutOfScopeInvoices(context, weekStart, lastDay) };
  } catch (error) {
    debug('Could not count invoices outside the coverage scope; reporting coverage without that line', error);
    return summary;
  }
}

export interface CoverageDay {
  day: string;
  totals: CoverageTotals;
}

/** One entry per Central day from `startDay` to `endDay`, including days with no invoices. */
export function dailyCoverage(invoices: ClassifiedInvoice[], startDay: string, endDay: string): CoverageDay[] {
  const byDay = new Map<string, ClassifiedInvoice[]>();
  for (const invoice of invoices) byDay.set(invoice.day, [...(byDay.get(invoice.day) ?? []), invoice]);
  const days: CoverageDay[] = [];
  for (let day = startDay; day <= endDay; day = shiftDayKey(day, 1)) {
    days.push({ day, totals: coverageTotals(byDay.get(day) ?? []) });
  }
  return days;
}

const COVERAGE_DAILY_COLUMNS = [
  'created_day', 'invoices', 'agent_created', 'agent_enriched', 'agent_notes_only', 'uncovered_ocr',
  'uncovered_manual', 'uncovered_integration', 'canceled', 'coverage_share', 'coverage_share_without_integrations',
];

/** Multi-row upsert for `rows` days, with `COVERAGE_DAILY_COLUMNS` placeholders per row. */
export function buildUpsertCoverageDaily(rows: number): string {
  const width = COVERAGE_DAILY_COLUMNS.length;
  const values = Array.from({ length: rows }, (_, row) =>
    `(${COVERAGE_DAILY_COLUMNS.map((_, column) => `$${row * width + column + 1}`).join(', ')}, CURRENT_TIMESTAMP)`);
  const updates = COVERAGE_DAILY_COLUMNS.slice(1).map((column) => `${column} = EXCLUDED.${column}`);
  return `
  INSERT INTO agent_invoice_coverage_daily (${COVERAGE_DAILY_COLUMNS.join(', ')}, computed_at)
  VALUES ${values.join(', ')}
  ON CONFLICT (created_day) DO UPDATE SET ${updates.join(', ')}, computed_at = EXCLUDED.computed_at
`;
}

export function coverageDayParams(days: CoverageDay[]): unknown[] {
  return days.flatMap(({ day, totals }) => [
    day,
    totals.invoices,
    totals.counts.agent_created,
    totals.counts.agent_enriched,
    totals.counts.agent_notes_only,
    totals.counts.uncovered_ocr,
    totals.counts.uncovered_manual,
    totals.counts.uncovered_integration,
    totals.counts.canceled,
    totals.share ?? null,
    totals.shareWithoutIntegrations ?? null,
  ]);
}

/**
 * Recomputes recent days of `agent_invoice_coverage_daily` from Workday. The first run (empty table) backfills
 * `COVERAGE_BACKFILL_DAYS`. Returns the number of days written.
 */
export async function refreshCoverageDaily(
  context: Pick<ProcessingContext, 'workdayConfig' | 'dbConnection'>,
  now: Date = new Date(),
  recentDays = COVERAGE_ROLLUP_DAYS,
  backfillDays = COVERAGE_BACKFILL_DAYS
): Promise<number> {
  const db = context.dbConnection;
  const [{ stored }] = await db.query('SELECT count(*)::int AS stored FROM agent_invoice_coverage_daily') as Array<{ stored: number }>;
  const span = Number(stored) ? recentDays : backfillDays;
  const endDay = centralDayKey(now);
  const startDay = shiftDayKey(endDay, -(span - 1));
  const days = dailyCoverage(await loadCoverage(context, startDay, endDay), startDay, endDay);
  await db.query(buildUpsertCoverageDaily(days.length), coverageDayParams(days));
  return days.length;
}
