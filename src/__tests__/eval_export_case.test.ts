/* eslint-disable @typescript-eslint/require-await -- stubs implement async interfaces */
import { fakeS3 } from './eval_fake_s3.js';
import { agentWriteAtEntry, buildExportedCase, buildSelectionQuery, enrichBaselineFor } from '../eval/export_case.js';
import { assertReadOnlySql } from '../eval/readonly_db.js';
import type { ScoredChange } from '../lib/invoice_score.js';
import type { InvoiceScore } from '../lib/invoice_scores.js';
import type { AgentInvoiceSnapshot, ScoredFields } from '../lib/invoice_snapshots.js';

const wid = 'c'.repeat(32);
const agentFields: ScoredFields = {
  supplier: 'Supplier_ID=S-1',
  lines: [{ amount: 100, purchaseOrderLine: 'Purchase_Order_Line_ID=PO-123456-1', costCenter: 'Cost_Center_Reference_ID=CC1', otherWorktags: [] }],
};
const apFields: ScoredFields = { ...agentFields, lines: [{ ...agentFields.lines[0], costCenter: 'Cost_Center_Reference_ID=CC2' }] };
const miss: ScoredChange = { field: 'line.costCenter', line: 0, before: 'CC1', after: 'CC2', category: 'material', agentOwned: true };

const snapshot = (overrides: Partial<AgentInvoiceSnapshot>): AgentInvoiceSnapshot => ({
  workdayInvoiceWid: wid,
  writeSeq: 1,
  source: 'create',
  fields: agentFields,
  createdAt: new Date('2026-10-13T15:00:00Z'),
  ...overrides,
});

const score = (overrides: Partial<InvoiceScore> = {}): InvoiceScore => ({
  workdayInvoiceWid: wid,
  workdayInvoiceNumber: 'SUPIN-467195',
  terminal: false,
  entryReadAt: new Date('2026-10-14T15:00:00Z'),
  entryFields: apFields,
  entryDiff: [miss],
  outcome: 'submitted_edited',
  ...overrides,
});

describe('agentWriteAtEntry and enrichBaselineFor', () => {
  it('takes the last agent write before AP\'s entry read', () => {
    const snapshots = [
      snapshot({ writeSeq: 1 }),
      snapshot({ writeSeq: 2, source: 'resend_update', createdAt: new Date('2026-10-14T10:00:00Z') }),
      snapshot({ writeSeq: 3, source: 'resend_update', createdAt: new Date('2026-10-15T10:00:00Z') }),
    ];
    expect(agentWriteAtEntry(snapshots, new Date('2026-10-14T15:00:00Z'))?.writeSeq).toBe(2);
  });

  it('finds the baseline saved before the enrich write', () => {
    const baseline = snapshot({ writeSeq: 1, source: 'enrich_baseline' });
    const write = snapshot({ writeSeq: 2, source: 'enrich' });
    expect(enrichBaselineFor([baseline, write], write)).toBe(baseline);
    expect(enrichBaselineFor([write], write)).toBeUndefined();
  });
});

describe('buildExportedCase', () => {
  it('pins create documents from the snapshot keys, in place, and records the PO lines', async () => {
    const s3 = fakeS3([{ key: 'new-invoices/r1/0-invoice.pdf', versionId: 'v1', lastModified: '2026-10-13T14:59:00Z' }]);
    const exported = await buildExportedCase(score(), [snapshot({ s3Keys: ['new-invoices/r1/0-invoice.pdf'], attachmentKinds: ['supplier_invoice'], conversationId: 'conv' })], { includeClean: false }, { s3, bucket: 'finance-agent-1' });
    expect(exported.evalCase?.documents).toEqual([
      expect.objectContaining({ bucket: 'finance-agent-1', key: 'new-invoices/r1/0-invoice.pdf', versionId: 'v1', etag: '"etag-v1"', status: 'pinned' }),
    ]);
    expect(exported.evalCase?.origin).toBe('create');
    expect(exported.notes.join(' ')).toContain('PO lines not captured');
  });

  it('adds the PO responses, the as-of Intercom context, and the messages when the sources are given', async () => {
    const s3 = fakeS3([{ key: 'new-invoices/r1/0-invoice.pdf', versionId: 'v1', lastModified: '2026-10-13T14:59:00Z' }]);
    const asOf: number[] = [];
    const exported = await buildExportedCase(score(), [snapshot({ s3Keys: ['new-invoices/r1/0-invoice.pdf'], conversationId: 'conv' })], { includeClean: false }, {
      s3,
      bucket: 'b',
      now: () => new Date('2026-10-20T00:00:00Z'),
      purchaseOrder: async (documentNumber) => ({ doc: documentNumber }),
      intercom: {
        emailContext: async (_id, at, fileName) => {
          asOf.push(at);
          return { emailContext: { subject: `for ${fileName}` }, conversationCreatedAt: '2026-10-10' };
        },
        messages: async () => [{ body: 'hello' }],
      },
    });
    expect(asOf).toEqual([Math.floor(new Date('2026-10-13T15:00:00Z').getTime() / 1000)]);
    expect(exported.evalCase?.inputs).toMatchObject({
      emailContext: { subject: 'for invoice.pdf' },
      conversationCreatedAt: '2026-10-10',
      emailMessages: [{ body: 'hello' }],
      purchaseOrders: [{ documentNumber: 'PO-123456', response: { doc: 'PO-123456' }, asOfExport: true, capturedAt: '2026-10-20T00:00:00.000Z' }],
    });
  });

  it('finds enrich attachments by listing the prefix, and adds the baseline and the OCR email', async () => {
    const s3 = fakeS3([{ key: `attachments/${wid}/inv.pdf`, versionId: 'e1', lastModified: '2026-10-13T14:59:00Z', metadata: { 'attachment-id': `${wid}-0` } }]);
    const baselineFields: ScoredFields = { supplier: 'Supplier_ID=S-OCR', lines: [] };
    const exported = await buildExportedCase(
      score({ origin: 'enrich' }),
      [snapshot({ writeSeq: 1, source: 'enrich_baseline', fields: baselineFields }), snapshot({ writeSeq: 2, source: 'enrich' })],
      { includeClean: false },
      { s3, bucket: 'b', ocrEmails: new Map([[wid, { subject: 'Invoice attached', plainTextBody: 'see pdf' }]]) }
    );
    expect(exported.evalCase?.origin).toBe('enrich');
    expect(exported.evalCase?.documents[0]).toMatchObject({ key: `attachments/${wid}/inv.pdf`, versionId: 'e1', source: 'attachments_prefix', workdayAttachmentRef: { attachmentId: `${wid}-0` } });
    expect(exported.evalCase?.inputs.baseline).toBe(baselineFields);
    expect(exported.evalCase?.inputs.ocrEmail).toEqual({ subject: 'Invoice attached', plainTextBody: 'see pdf' });
  });

  it('says so when Workday has no OCR email, or no baseline was saved', async () => {
    const exported = await buildExportedCase(score({ origin: 'enrich' }), [snapshot({ source: 'enrich' })], { includeClean: false }, { ocrEmails: new Map() });
    expect(exported.notes.join(' ')).toContain('no enrich baseline');
    expect(exported.notes.join(' ')).toContain('no inbound email');
  });

  it('notes an invoice exported without S3, and a conversation that could not be read', async () => {
    const exported = await buildExportedCase(score(), [snapshot({ conversationId: 'conv' })], { includeClean: false }, {
      intercom: { emailContext: async () => { throw new Error('404'); }, messages: async () => [] },
    });
    expect(exported.notes.join(' ')).toContain('exported without S3 access');
    expect(exported.notes.join(' ')).toContain('could not read conversation conv: 404');
  });

  it('skips with a reason when there is nothing to export', async () => {
    expect((await buildExportedCase(score(), [], { includeClean: false }, {})).skipReason).toContain('no agent write snapshot');
    expect((await buildExportedCase(score({ entryFields: undefined }), [snapshot({})], { includeClean: false }, {})).skipReason).toContain('not entered');
    expect((await buildExportedCase(score({ entryDiff: [] }), [snapshot({})], { includeClean: false }, {})).skipReason).toContain('--include-clean');
    expect((await buildExportedCase(score({ entryDiff: [] }), [snapshot({})], { includeClean: true }, {})).evalCase).toBeDefined();
  });
});

describe('buildSelectionQuery', () => {
  it('defaults to materially corrected invoices', () => {
    const { sql, params } = buildSelectionQuery({});
    expect(sql).toBe('SELECT * FROM agent_invoice_scores WHERE entry_read_at IS NOT NULL AND outcome = ANY($1::text[]) ORDER BY entry_read_at, workday_invoice_wid');
    expect(params).toEqual([['submitted_edited']]);
  });

  it('adds clean outcomes, a window, an origin, and a limit', () => {
    const { sql, params } = buildSelectionQuery({ outcomes: ['submitted_edited', 'submitted_clean'], since: '2026-10-12', until: '2026-10-19', origin: 'enrich', limit: 10 });
    expect(sql).toContain("outcome = ANY($1::text[]) AND entry_read_at >= ($2::timestamptz AT TIME ZONE 'UTC') AND entry_read_at < ($3::timestamptz AT TIME ZONE 'UTC') AND origin = $4");
    expect(sql.endsWith('LIMIT 10')).toBe(true);
    expect(params).toEqual([['submitted_edited', 'submitted_clean'], '2026-10-12', '2026-10-19', 'enrich']);
  });

  it('selects named invoices by Workday number, WID, or supplier invoice number, and skips the outcome filter', () => {
    const { sql, params } = buildSelectionQuery({ invoiceNumbers: ['SUPIN-467195', 'SUPIN-466263'], wids: [wid], suppliersInvoiceNumbers: ['INV-9'] });
    expect(sql).toContain('(workday_invoice_wid = ANY($1::text[]) OR workday_invoice_number = ANY($2::text[]) OR entry_fields->>\'suppliersInvoiceNumber\' = ANY($3::text[]))');
    expect(sql).not.toContain('outcome');
    expect(params).toEqual([[wid], ['SUPIN-467195', 'SUPIN-466263'], ['INV-9']]);
  });

  it('never interpolates a value into the SQL', () => {
    const { sql } = buildSelectionQuery({ invoiceNumbers: ["x'; DROP TABLE agent_invoice_scores; --"], since: "2026'--" });
    expect(sql).not.toContain('DROP');
    expect(sql).not.toContain("2026'");
    expect(() => assertReadOnlySql(sql)).not.toThrow();
  });
});

describe('assertReadOnlySql', () => {
  it('allows the selects the exporter and replay run', () => {
    expect(() => assertReadOnlySql('SELECT * FROM agent_invoice_snapshots WHERE workday_invoice_wid = $1 ORDER BY write_seq')).not.toThrow();
    expect(() => assertReadOnlySql("SELECT created_at, updated_at FROM documents WHERE content LIKE '%delete%'")).not.toThrow();
    expect(() => assertReadOnlySql('WITH x AS (SELECT 1) SELECT * FROM x')).not.toThrow();
  });

  it('refuses writes, DDL, multiple statements, and data-modifying CTEs', () => {
    for (const sql of [
      'DELETE FROM documents',
      'INSERT INTO agent_invoice_snapshots VALUES (1)',
      'UPDATE documents SET content = 1',
      'CREATE TABLE x (a int)',
      'CREATE EXTENSION IF NOT EXISTS vector;',
      'SELECT 1; DROP TABLE documents',
      'WITH d AS (DELETE FROM documents RETURNING *) SELECT * FROM d',
      'TRUNCATE documents',
    ]) {
      expect(() => assertReadOnlySql(sql)).toThrow('read-only');
    }
  });
});
