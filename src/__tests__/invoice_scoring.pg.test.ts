/**
 * Runs the scoring SQL against a real Postgres. Skipped unless SCORING_PG_URL is set, for example:
 * SCORING_PG_URL=postgres://postgres:postgres@localhost:5432/scoring_smoke npx jest invoice_scoring.pg
 */
jest.mock('@pga/logger', () => ({ debug: jest.fn() }));
jest.mock('../lib/workday.js', () => ({
  getSupplierInvoice: jest.fn(),
  getSupplierInvoiceEditability: jest.fn(),
  executeWorkdayQuery: jest.fn(),
}));

import { Pool } from 'pg';
import {
  CREATE_AGENT_INVOICE_SCORES_INDEXES,
  CREATE_AGENT_INVOICE_SCORES_TABLE,
  CREATE_AGENT_INVOICE_SNAPSHOTS_INDEXES,
  CREATE_AGENT_INVOICE_SNAPSHOTS_TABLE,
  CREATE_CANCEL_LABELS_TABLE,
  type DatabaseConnection,
} from '../lib/database.js';
import type { ProcessingContext } from '../lib/handlers.js';
import { findOtherAgentInvoicesWithSameNumber, getInvoiceScore, listPendingScoreInvoices, recordStatusChecks, upsertInvoiceScore } from '../lib/invoice_scores.js';
import { ensureTouchReporting, refreshTouchDaily } from '../lib/touch_reporting.js';
import { getAgentInvoiceSnapshots, snapshotAgentWrite, snapshotEnrichBaseline } from '../lib/invoice_snapshots.js';
import { buildDigestBlocks, digestWindow, summarizeScores } from '../lib/score_digest.js';
import * as workday from '../lib/workday.js';
import { CREATE_AUDIT_POSTS_TABLE, loadDigestScores, loadUnlabeledCancels } from '../score_digest.js';
import { scoreInvoice } from '../score_invoices_processor.js';

const url = process.env.SCORING_PG_URL;
const describeWithPostgres = url ? describe : describe.skip;

const ref = (type: string, value: string) => ({ ID: [{ $attributes: { type: 'WID' }, $value: `${value}-wid` }, { $attributes: { type }, $value: value }] });
function invoice(overrides: { costCenter?: string; fund?: string; memo?: string } = {}) {
  return {
    Invoice_Number: 'SUPIN-100',
    Supplier_Reference: ref('Supplier_ID', 'S-1'),
    Company_Reference: ref('Company_Reference_ID', '912'),
    Suppliers_Invoice_Number: 'INV-42',
    Control_Amount_Total: '250.00',
    Memo: overrides.memo ?? 'AC 1033562. Services',
    Invoice_Line_Replacement_Data: [{
      Line_Order: '1',
      Extended_Amount: '250.00',
      Worktags_Reference: [ref('Cost_Center_Reference_ID', overrides.costCenter ?? 'CC1'), ref('Fund_ID', overrides.fund ?? 'FUND-1')],
    }],
  };
}

describeWithPostgres('agent invoice scoring against Postgres', () => {
  const pool = new Pool({ connectionString: url });
  const db: DatabaseConnection = {
    query: async (sql: string, params?: unknown[]) => (await pool.query(sql, params)).rows,
    close: async () => pool.end(),
  };
  const context = { dbConnection: db, workdayConfig: {} } as unknown as ProcessingContext;
  const [created, duplicate, enriched] = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)];

  beforeAll(async () => {
    await pool.query('DROP VIEW IF EXISTS agent_invoice_touches');
    await pool.query('DROP TABLE IF EXISTS agent_invoice_snapshots, agent_invoice_scores, cancel_labels, agent_invoice_touch_daily, agent_invoice_status_checks, agent_invoice_audit_posts');
    await pool.query(CREATE_AGENT_INVOICE_SNAPSHOTS_TABLE);
    for (const sql of CREATE_AGENT_INVOICE_SNAPSHOTS_INDEXES) await pool.query(sql);
    await pool.query(CREATE_AGENT_INVOICE_SCORES_TABLE);
    for (const sql of CREATE_AGENT_INVOICE_SCORES_INDEXES) await pool.query(sql);
    await pool.query(CREATE_CANCEL_LABELS_TABLE);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('stores create, resend, and enrich snapshots with the AP edits a resend overwrote', async () => {
    const shared = { conversationId: 'conv-1', s3Keys: ['new-invoices/r/0-invoice.pdf'], attachmentKinds: ['supplier_invoice'], clusteringMode: 'off', releaseSha: 'sha-1' };
    expect(await snapshotAgentWrite(context, { workdayInvoiceWid: created, source: 'create', invoice: invoice(), ...shared })).toBe(true);
    expect(await snapshotAgentWrite(context, { workdayInvoiceWid: duplicate, source: 'create', invoice: invoice(), ...shared })).toBe(true);
    expect(await snapshotAgentWrite(context, {
      workdayInvoiceWid: created,
      source: 'resend_update',
      previousInvoice: invoice({ memo: 'AP memo' }),
      invoice: invoice(),
      ...shared,
    })).toBe(true);
    expect(await snapshotEnrichBaseline(db, { workdayInvoiceWid: enriched, invoice: invoice({ costCenter: 'CC0' }) })).toBe(true);
    expect(await snapshotAgentWrite(context, { workdayInvoiceWid: enriched, source: 'enrich', invoice: invoice() })).toBe(true);

    const snapshots = await getAgentInvoiceSnapshots(db, created);
    expect(snapshots.map((snapshot) => [snapshot.writeSeq, snapshot.source])).toEqual([[1, 'create'], [2, 'resend_update']]);
    expect(snapshots[1].preWriteDiff).toEqual([{ field: 'memo', before: 'AC 1033562. Services', after: 'AP memo' }]);
    expect(snapshots[0]).toEqual(expect.objectContaining({ workdayInvoiceNumber: 'SUPIN-100', releaseSha: 'sha-1', s3Keys: shared.s3Keys }));
    expect(snapshots[0].fields.lines[0].costCenter).toBe('Cost_Center_Reference_ID=CC1');
  });

  it('lists every agent invoice as pending until it is terminal', async () => {
    const pending = await listPendingScoreInvoices(db, 100);
    expect(pending.map((row) => row.workdayInvoiceWid).sort()).toEqual([created, duplicate, enriched]);
  });

  it('scores entry and then the final read, and round-trips the stored score', async () => {
    (workday.getSupplierInvoice as jest.Mock).mockResolvedValueOnce(invoice({ costCenter: 'CC9', memo: 'Services' }));
    const entry = await scoreInvoice(context, { workdayInvoiceWid: created, status: { workdayID: created, invoiceStatusAsText: 'In Progress' } });
    expect(entry?.outcome).toBe('submitted_edited');
    const stored = await getInvoiceScore(db, created);
    expect(stored?.entryDiff?.map((change) => [change.field, change.category])).toEqual([['memo', 'convention'], ['line.costCenter', 'material']]);
    expect(stored?.entryReadAt).toBeInstanceOf(Date);

    (workday.getSupplierInvoice as jest.Mock).mockResolvedValueOnce(invoice({ costCenter: 'CC9', fund: 'FUND-2', memo: 'Services' }));
    const final = await scoreInvoice(context, { workdayInvoiceWid: created, status: { workdayID: created, invoiceStatusAsText: 'Approved' } });
    expect(final?.terminal).toBe(true);
    expect((await getInvoiceScore(db, created))?.lateDiff?.map((change) => change.field)).toEqual(['line.fund']);
    expect((await listPendingScoreInvoices(db, 100)).map((row) => row.workdayInvoiceWid)).not.toContain(created);
  });

  it('finds the live agent duplicate with the JSONB lookup and attributes the cancel to the agent', async () => {
    (workday.getSupplierInvoice as jest.Mock).mockResolvedValueOnce(invoice());
    (workday.getSupplierInvoiceEditability as jest.Mock).mockResolvedValue({ found: true, editable: false, isCanceled: false });
    const score = await scoreInvoice(context, { workdayInvoiceWid: duplicate, status: { workdayID: duplicate, invoiceStatusAsText: 'Canceled', isCanceled: true } });
    expect(score).toEqual(expect.objectContaining({ outcome: 'canceled', cancelAttribution: 'agent', cancelBasis: 'duplicate' }));
    expect(score?.cancelEvidence?.agentInvoicesInConversation).toBe(2);
    expect(workday.getSupplierInvoiceEditability).toHaveBeenCalledWith(context, created);
  });

  it('applies an AP cancel label and reads the week back for the digest', async () => {
    await pool.query("INSERT INTO cancel_labels (workday_invoice_wid, attribution, labeled_by) VALUES ($1, 'business', 'ap@pgahq.com')", [enriched]);
    const score = await scoreInvoice(context, { workdayInvoiceWid: enriched, status: null });
    expect(score).toEqual(expect.objectContaining({ outcome: 'deleted', cancelAttribution: 'business', cancelBasis: 'ap_label', origin: 'enrich' }));

    // The digest reports the last complete week, so ask as of next week to cover rows written today.
    const window = digestWindow(new Date(Date.now() + 7 * 86_400_000));
    const summary = summarizeScores(await loadDigestScores(db, window.previousStart), window, await loadUnlabeledCancels(db));
    expect(summary.entered).toBe(1);
    expect(summary.cancels).toEqual({ agent: 1, business: 1, unattributed: 0, agentByBasis: { duplicate: 1 } });
    expect(summary.late).toEqual({ closed: 1, corrected: 1 });
    const text = buildDigestBlocks(summary).map((block) => (block.type === 'section' ? block.text.text : '')).join('\n');
    expect(text).toContain('• Cost center: 1 (100%)');
  });

  it('stores touches per invoice and a daily rollup a report can read', async () => {
    const run = (sql: string, params?: unknown[]) => pool.query(sql, params);
    await ensureTouchReporting(run);
    await ensureTouchReporting(run);

    const change = (agentOwned: boolean) => ({ field: 'line.fund', line: 0, before: 'a', after: 'b', category: 'material', agentOwned });
    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
    await upsertInvoiceScore(db, {
      workdayInvoiceWid: 'd'.repeat(32), workdayInvoiceNumber: 'SUPIN-ZERO', terminal: false, entryReadAt: daysAgo(3),
      outcome: 'submitted_clean', entryDiff: [change(false) as never], releaseSha: 'sha-1',
    });
    await upsertInvoiceScore(db, {
      workdayInvoiceWid: 'e'.repeat(32), workdayInvoiceNumber: 'SUPIN-MANY', terminal: false, entryReadAt: daysAgo(3),
      outcome: 'submitted_edited', entryDiff: Array.from({ length: 25 }, () => change(true) as never), releaseSha: 'sha-1',
    });

    const { rows: invoices } = await pool.query(
      'SELECT workday_invoice_number, touches::int, touch_bucket FROM agent_invoice_touches ORDER BY workday_invoice_number'
    );
    expect(invoices).toEqual([
      { workday_invoice_number: 'SUPIN-100', touches: 3, touch_bucket: '1-3' },
      { workday_invoice_number: 'SUPIN-MANY', touches: 25, touch_bucket: '21+' },
      { workday_invoice_number: 'SUPIN-ZERO', touches: 0, touch_bucket: '0' },
    ]);

    expect(await refreshTouchDaily(db)).toBe(15);
    const { rows: days } = await pool.query(`
      SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'America/Chicago')::date - entry_day AS age, invoices, touches_0, touches_1_3,
             touches_21_plus, total_touches, zero_touch_share::text
        FROM agent_invoice_touch_daily ORDER BY entry_day`);
    expect(days).toHaveLength(15);
    const byAge = new Map(days.map((row) => [Number(row.age), row]));
    expect(byAge.get(3)).toEqual(expect.objectContaining({ invoices: 2, touches_0: 1, touches_21_plus: 1, total_touches: 25, zero_touch_share: '0.5000' }));
    expect(byAge.get(1)).toEqual(expect.objectContaining({ invoices: 0, total_touches: 0, zero_touch_share: null }));
    const created = days.find((row) => Number(row.touches_1_3) === 1);
    expect(created).toEqual(expect.objectContaining({ invoices: 1, total_touches: 3, zero_touch_share: '0.0000' }));

    const weekly = await pool.query(`
      SELECT sum(invoices)::int AS invoices, sum(touches_0)::int AS zero
        FROM agent_invoice_touch_daily WHERE entry_day > (CURRENT_TIMESTAMP AT TIME ZONE 'America/Chicago')::date - 7`);
    expect(weekly.rows[0]).toEqual({ invoices: 3, zero: 1 });

    expect(await refreshTouchDaily(db)).toBe(15);
  });

  it('matches duplicates on each invoice latest write only', async () => {
    const stale = 'f'.repeat(32);
    await snapshotAgentWrite(context, { workdayInvoiceWid: stale, source: 'create', invoice: invoice() });
    await snapshotAgentWrite(context, { workdayInvoiceWid: stale, source: 'resend_update', invoice: { ...invoice(), Suppliers_Invoice_Number: 'INV-43' } });
    const matches = await findOtherAgentInvoicesWithSameNumber(db, 'none', 'Supplier_ID=S-1', 'INV-42');
    expect(matches.map((match) => match.workdayInvoiceWid).sort()).toEqual([created, duplicate, enriched]);
  });

  it('reads pending statuses least recently checked first', async () => {
    for (const wid of ['1'.repeat(32), '2'.repeat(32)]) {
      await snapshotAgentWrite(context, { workdayInvoiceWid: wid, source: 'create', invoice: invoice() });
    }
    const pending = (await listPendingScoreInvoices(db, 100)).map((row) => row.workdayInvoiceWid);
    expect(pending.length).toBeGreaterThan(1);
    await recordStatusChecks(db, [pending[0]], new Date());
    await recordStatusChecks(db, [pending[0]], new Date());
    const next = (await listPendingScoreInvoices(db, 100)).map((row) => row.workdayInvoiceWid);
    expect(next[next.length - 1]).toBe(pending[0]);
    expect((await listPendingScoreInvoices(db, 1))[0].workdayInvoiceWid).not.toBe(pending[0]);
  });

  it('keeps an existing touch view instead of replacing it on every cold start', async () => {
    const run = (sql: string, params?: unknown[]) => pool.query(sql, params);
    await ensureTouchReporting(run);
    const { rows } = await pool.query("SELECT to_regclass('agent_invoice_touches') IS NOT NULL AS present");
    expect(rows[0].present).toBe(true);
  });

  it('stores when the daily audit post last went out', async () => {
    await pool.query(CREATE_AUDIT_POSTS_TABLE);
    await pool.query(CREATE_AUDIT_POSTS_TABLE);
    await pool.query(
      `INSERT INTO agent_invoice_audit_posts (mode, posted_through) VALUES ('daily', $1)
       ON CONFLICT (mode) DO UPDATE SET posted_through = EXCLUDED.posted_through`,
      [new Date('2026-10-07T14:20:00Z')]
    );
    const { rows } = await pool.query("SELECT posted_through FROM agent_invoice_audit_posts WHERE mode = 'daily'");
    expect(rows).toHaveLength(1);
  });

  it('never reopens a terminal score', async () => {
    await upsertInvoiceScore(db, { workdayInvoiceWid: created, terminal: false, outcome: 'submitted_edited' });
    expect(await getInvoiceScore(db, created)).toEqual(expect.objectContaining({ terminal: true, finalStatus: 'Approved' }));
  });
});
