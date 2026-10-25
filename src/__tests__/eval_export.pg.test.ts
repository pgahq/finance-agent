/**
 * Runs the exporter's selection SQL and the read-only connection against a real Postgres. Skipped unless SCORING_PG_URL is
 * set, for example: SCORING_PG_URL=postgres://postgres:postgres@localhost:5432/eval_smoke npx jest eval_export.pg
 */
/* eslint-disable @typescript-eslint/require-await -- stubs implement async interfaces */
jest.mock('@pga/logger', () => ({ debug: jest.fn() }));

import { Pool } from 'pg';
import {
  CREATE_AGENT_INVOICE_SCORES_TABLE,
  CREATE_AGENT_INVOICE_SNAPSHOTS_TABLE,
} from '../lib/database.js';
import { rowToInvoiceScore } from '../lib/invoice_scores.js';
import { getAgentInvoiceSnapshots, recordAgentInvoiceSnapshot } from '../lib/invoice_snapshots.js';
import { buildExportedCase, buildSelectionQuery } from '../eval/export_case.js';
import { createReadOnlyConnection } from '../eval/readonly_db.js';

const url = process.env.SCORING_PG_URL;
const describePg = url ? describe : describe.skip;

describePg('exporter against Postgres', () => {
  const pool = new Pool({ connectionString: url });
  const parsed = url ? new URL(url) : undefined;
  const readOnly = parsed && createReadOnlyConnection({
    host: parsed.hostname,
    port: Number(parsed.port || 5432),
    database: parsed.pathname.slice(1),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  });
  const writer = { query: async (sql: string, params?: unknown[]) => (await pool.query(sql, params)).rows as unknown[], close: async () => undefined };

  const fields = (costCenter: string) => ({
    supplier: 'Supplier_ID=S-1',
    suppliersInvoiceNumber: 'INV-9',
    lines: [{ amount: 10, purchaseOrderLine: 'Purchase_Order_Line_ID=PO-000123-1', costCenter, otherWorktags: [] }],
  });
  const miss = [{ field: 'line.costCenter', line: 0, before: 'CC1', after: 'CC2', category: 'material', agentOwned: true }];

  beforeAll(async () => {
    await pool.query('DROP TABLE IF EXISTS agent_invoice_scores; DROP TABLE IF EXISTS agent_invoice_snapshots;');
    await pool.query(CREATE_AGENT_INVOICE_SNAPSHOTS_TABLE);
    await pool.query(CREATE_AGENT_INVOICE_SCORES_TABLE);
    const rows: Array<[string, string, string, string, unknown]> = [
      ['wid-edited', 'SUPIN-1', 'submitted_edited', '2026-10-14 15:00:00', miss],
      ['wid-clean', 'SUPIN-2', 'submitted_clean', '2026-10-15 15:00:00', []],
      ['wid-late', 'SUPIN-3', 'submitted_edited', '2026-10-20 15:00:00', miss],
    ];
    for (const [wid, number, outcome, readAt, diff] of rows) {
      await pool.query(
        `INSERT INTO agent_invoice_scores (workday_invoice_wid, workday_invoice_number, origin, conversation_id, entry_status, entry_read_at, entry_fields, entry_diff, late_diff, outcome, terminal)
         VALUES ($1, $2, 'create', 'conv', 'In Progress', $3, $4, $5, $6, $7, false)`,
        [wid, number, readAt, JSON.stringify(fields('Cost_Center_Reference_ID=CC2')), JSON.stringify(diff), JSON.stringify(diff), outcome]
      );
      await recordAgentInvoiceSnapshot(writer, { workdayInvoiceWid: wid, source: 'create', fields: fields('Cost_Center_Reference_ID=CC1'), s3Keys: ['new-invoices/r/0-a.pdf'], attachmentKinds: ['supplier_invoice'], releaseSha: 'abc' });
    }
    await pool.query("UPDATE agent_invoice_snapshots SET created_at = '2026-10-13 15:00:00'");
  });

  afterAll(async () => {
    await pool.query('DROP TABLE IF EXISTS agent_invoice_scores; DROP TABLE IF EXISTS agent_invoice_snapshots;');
    await readOnly?.close();
    await pool.end();
  });

  const select = async (args: Parameters<typeof buildSelectionQuery>[0]) => {
    const { sql, params } = buildSelectionQuery(args);
    return (await readOnly!.query(sql, params) as Array<Record<string, unknown>>).map((row) => row.workday_invoice_number);
  };

  it('selects materially corrected invoices by default and clean ones when asked', async () => {
    expect(await select({})).toEqual(['SUPIN-1', 'SUPIN-3']);
    expect(await select({ outcomes: ['submitted_edited', 'submitted_clean'] })).toEqual(['SUPIN-1', 'SUPIN-2', 'SUPIN-3']);
  });

  it('selects named invoices by Workday number, WID, and supplier invoice number, whatever their outcome', async () => {
    expect(await select({ invoiceNumbers: ['SUPIN-2', 'SUPIN-1'] })).toEqual(['SUPIN-1', 'SUPIN-2']);
    expect(await select({ wids: ['wid-late'] })).toEqual(['SUPIN-3']);
    expect(await select({ suppliersInvoiceNumbers: ['INV-9'] })).toEqual(['SUPIN-1', 'SUPIN-2', 'SUPIN-3']);
  });

  it('reads the AP entry-read window in UTC whatever offset the bound is written in', async () => {
    expect(await select({ outcomes: ['submitted_edited', 'submitted_clean'], since: '2026-10-14T10:00:00-05:00', until: '2026-10-15T10:00:00-05:00' })).toEqual(['SUPIN-1']);
    expect(await select({ outcomes: ['submitted_edited', 'submitted_clean'], since: '2026-10-15', until: '2026-10-16' })).toEqual(['SUPIN-2']);
  });

  it('builds an exportable case from the rows', async () => {
    const [row] = await readOnly!.query('SELECT * FROM agent_invoice_scores WHERE workday_invoice_wid = $1', ['wid-edited']) as Array<Record<string, unknown>>;
    const score = rowToInvoiceScore(row);
    const snapshots = await getAgentInvoiceSnapshots(readOnly!, 'wid-edited');
    const exported = await buildExportedCase(score, snapshots, { includeClean: false }, {});
    expect(exported.evalCase).toMatchObject({
      workdayInvoiceNumber: 'SUPIN-1',
      releaseSha: 'abc',
      outcome: 'submitted_edited',
      inputs: { s3Keys: ['new-invoices/r/0-a.pdf'], purchaseOrderLines: ['Purchase_Order_Line_ID=PO-000123-1'] },
    });
    expect(exported.evalCase?.lateDiff).toHaveLength(1);
  });

  it('cannot write: the statement filter and the read-only session both refuse', async () => {
    await expect(readOnly!.query("DELETE FROM agent_invoice_scores")).rejects.toThrow('read-only');
    const session = new Pool({ connectionString: url, options: '-c default_transaction_read_only=on' });
    await expect(session.query("DELETE FROM agent_invoice_scores")).rejects.toThrow('read-only transaction');
    await session.end();
    expect((await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM agent_invoice_scores')).rows[0].n).toBe(3);
  });
});
