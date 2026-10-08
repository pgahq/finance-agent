import { buildEvalCase } from '../lib/eval_cases.js';
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

describe('buildEvalCase', () => {
  it('labels the case with what the agent submitted and what AP saved', () => {
    expect(buildEvalCase({
      workdayInvoiceWid: 'w', workdayInvoiceNumber: 'SUPIN-1', origin: 'create', terminal: false,
      entryFields: apFields, entryDiff: [costCenter, memo, ocrOnly], outcome: 'submitted_edited',
    }, snapshot)).toEqual({
      workdayInvoiceWid: 'w',
      workdayInvoiceNumber: 'SUPIN-1',
      origin: 'create',
      releaseSha: 'sha',
      conversationId: 'conv-1',
      inputs: {
        s3Keys: ['new-invoices/r/0-invoice.pdf'],
        attachmentKinds: ['supplier_invoice'],
        purchaseOrderLines: ['Purchase_Order_Line_ID=PO-1-1'],
      },
      agent: agentFields,
      expected: apFields,
      misses: [costCenter],
      conventionChanges: [memo],
    });
  });

  it('skips invoices with nothing to learn from', () => {
    expect(buildEvalCase({ workdayInvoiceWid: 'w', terminal: false, entryFields: apFields, entryDiff: [memo, ocrOnly] }, snapshot)).toBeUndefined();
    expect(buildEvalCase({ workdayInvoiceWid: 'w', terminal: false, entryDiff: [costCenter] }, snapshot)).toBeUndefined();
    expect(buildEvalCase({ workdayInvoiceWid: 'w', terminal: false, entryFields: apFields, entryDiff: [costCenter] }, undefined)).toBeUndefined();
  });
});
