import { buildEvalCase, purchaseOrderNumberOfLineKey, purchaseOrderNumbersOfCase } from '../lib/eval_cases.js';
import type { ScoredChange } from '../lib/invoice_score.js';
import type { AgentInvoiceSnapshot, ScoredFields } from '../lib/invoice_snapshots.js';

const agentFields: ScoredFields = {
  supplier: 'Supplier_ID=S-1',
  lines: [{ amount: 100, purchaseOrderLine: 'Purchase_Order_Line_ID=PO-1-1', costCenter: 'Cost_Center_Reference_ID=CC1', otherWorktags: [] }],
};
const apFields: ScoredFields = { ...agentFields, lines: [{ ...agentFields.lines[0], costCenter: 'Cost_Center_Reference_ID=CC2' }] };

const snapshot: AgentInvoiceSnapshot = {
  workdayInvoiceWid: 'w',
  writeSeq: 1,
  source: 'create',
  fields: agentFields,
  conversationId: 'conv-1',
  s3Keys: ['new-invoices/r/0-invoice.pdf'],
  attachmentKinds: ['supplier_invoice'],
  releaseSha: 'sha',
  createdAt: new Date(),
};

const costCenter: ScoredChange = { field: 'line.costCenter', line: 0, before: 'CC1', after: 'CC2', category: 'material', agentOwned: true };
const memo: ScoredChange = { field: 'memo', before: 'a', after: 'b', category: 'convention', agentOwned: true };
const ocrOnly: ScoredChange = { field: 'supplier', before: 'S-1', after: 'S-9', category: 'material', agentOwned: false };

const createdAt = new Date('2026-10-13T15:00:00Z');
const entryReadAt = new Date('2026-10-14T15:00:00Z');

describe('buildEvalCase', () => {
  it('labels the case with what the agent submitted and what AP saved', () => {
    expect(buildEvalCase({
      workdayInvoiceWid: 'w', workdayInvoiceNumber: 'SUPIN-1', origin: 'create', terminal: false, entryReadAt,
      entryFields: apFields, entryDiff: [costCenter, memo, ocrOnly], outcome: 'submitted_edited',
    }, { ...snapshot, createdAt, clusteringMode: 'on' })).toEqual({
      schemaVersion: 2,
      workdayInvoiceWid: 'w',
      workdayInvoiceNumber: 'SUPIN-1',
      origin: 'create',
      releaseSha: 'sha',
      conversationId: 'conv-1',
      outcome: 'submitted_edited',
      agentWrittenAt: '2026-10-13T15:00:00.000Z',
      entryReadAt: '2026-10-14T15:00:00.000Z',
      documents: [],
      inputs: {
        s3Keys: ['new-invoices/r/0-invoice.pdf'],
        attachmentKinds: ['supplier_invoice'],
        clusteringMode: 'on',
        purchaseOrderLines: ['Purchase_Order_Line_ID=PO-1-1'],
      },
      agent: agentFields,
      expected: apFields,
      misses: [costCenter],
      conventionChanges: [memo],
      entryDiff: [costCenter, memo, ocrOnly],
    });
  });

  it('carries the late diff so AP edits after submit are kept with the case', () => {
    const late: ScoredChange = { field: 'line.fund', line: 0, before: 'F1', after: 'F2', category: 'material', agentOwned: true };
    const evalCase = buildEvalCase({
      workdayInvoiceWid: 'w', terminal: true, entryFields: apFields, entryDiff: [costCenter], lateDiff: [late],
    }, snapshot);
    expect(evalCase?.lateDiff).toEqual([late]);
  });

  it('skips invoices with nothing to learn from', () => {
    expect(buildEvalCase({ workdayInvoiceWid: 'w', terminal: false, entryFields: apFields, entryDiff: [memo, ocrOnly] }, snapshot)).toBeUndefined();
    expect(buildEvalCase({ workdayInvoiceWid: 'w', terminal: false, entryDiff: [costCenter] }, snapshot)).toBeUndefined();
    expect(buildEvalCase({ workdayInvoiceWid: 'w', terminal: false, entryFields: apFields, entryDiff: [costCenter] }, undefined)).toBeUndefined();
  });

  it('includes clean and convention-only invoices when asked', () => {
    const clean = buildEvalCase({ workdayInvoiceWid: 'w', terminal: false, entryFields: agentFields, entryDiff: [], outcome: 'submitted_clean' }, snapshot, { includeClean: true });
    expect(clean?.misses).toEqual([]);
    expect(clean?.outcome).toBe('submitted_clean');
    const conventionOnly = buildEvalCase({ workdayInvoiceWid: 'w', terminal: false, entryFields: apFields, entryDiff: [memo, ocrOnly] }, snapshot, { includeClean: true });
    expect(conventionOnly?.conventionChanges).toEqual([memo]);
    expect(conventionOnly?.misses).toEqual([]);
  });
});

describe('purchase order numbers', () => {
  it('derives the PO from a PO line key', () => {
    expect(purchaseOrderNumberOfLineKey('Purchase_Order_Line_ID=PO-123456-2')).toBe('PO-123456');
    expect(purchaseOrderNumberOfLineKey('PO-000009-10')).toBe('PO-000009');
    expect(purchaseOrderNumberOfLineKey('Purchase_Order_Line_ID=POL-002')).toBeUndefined();
  });

  it('lists each PO of a case once', () => {
    expect(purchaseOrderNumbersOfCase({ inputs: { s3Keys: [], attachmentKinds: [], purchaseOrderLines: ['Purchase_Order_Line_ID=PO-1-1', 'Purchase_Order_Line_ID=PO-1-2', 'x'] } })).toEqual(['PO-1']);
  });
});
