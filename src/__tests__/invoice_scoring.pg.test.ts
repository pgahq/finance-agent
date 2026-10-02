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
  CREATE_AGENT_INVOICE_SCORES_TABLE,
  CREATE_AGENT_INVOICE_SNAPSHOTS_INDEXES,
  CREATE_AGENT_INVOICE_SNAPSHOTS_TABLE,
  CREATE_CANCEL_LABELS_TABLE,
  type DatabaseConnection,
} from '../lib/database.js';
import type { ProcessingContext } from '../lib/handlers.js';
import { getInvoiceScore, listPendingScoreInvoices } from '../lib/invoice_scores.js';
import { getAgentInvoiceSnapshots, snapshotAgentWrite, snapshotEnrichBaseline } from '../lib/invoice_snapshots.js';
import { buildDigestBlocks, digestWindow, summarizeScores } from '../lib/score_digest.js';
import * as workday from '../lib/workday.js';
import { loadDigestScores, loadUnlabeledCancels } from '../score_digest.js';
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
    await pool.query('DROP TABLE IF EXISTS agent_invoice_snapshots, agent_invoice_scores, cancel_labels');
    await pool.query(CREATE_AGENT_INVOICE_SNAPSHOTS_TABLE);
    for (const sql of CREATE_AGENT_INVOICE_SNAPSHOTS_INDEXES) await pool.query(sql);
    await pool.query(CREATE_AGENT_INVOICE_SCORES_TABLE);
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
    const pending = await listPendingScoreInvoices(db);
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
    expect((await listPendingScoreInvoices(db)).map((row) => row.workdayInvoiceWid)).not.toContain(created);
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

    const window = digestWindow(new Date(Date.now() + 1000));
    const summary = summarizeScores(await loadDigestScores(db, window.previousStart), window, await loadUnlabeledCancels(db));
    expect(summary.entered).toBe(1);
    expect(summary.cancels).toEqual({ agent: 1, business: 1, unattributed: 0, agentByBasis: { duplicate: 1 } });
    expect(summary.late).toEqual({ closed: 1, corrected: 1 });
    const text = buildDigestBlocks(summary).map((block) => (block.type === 'section' ? block.text.text : '')).join('\n');
    expect(text).toContain('• Cost center: 1 (100%)');
  });
});
