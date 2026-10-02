jest.mock('@pga/logger', () => ({ debug: jest.fn() }));
jest.mock('../lib/workday.js', () => ({ getSupplierInvoice: jest.fn() }));

import type { DatabaseConnection } from '../lib/database.js';
import {
  diffScoredFields,
  extractScoredFields,
  getLatestAgentWriteSnapshot,
  recordAgentInvoiceSnapshot,
  referenceKey,
  snapshotAgentWrite,
  snapshotEnrichBaseline,
  type ScoredFields,
} from '../lib/invoice_snapshots.js';
import { getSupplierInvoice } from '../lib/workday.js';

const ref = (...ids: Array<[string, string]>) => ({ ID: ids.map(([type, value]) => ({ $attributes: { type }, $value: value })) });

function mockDb(responses: unknown[][] = []) {
  const query = jest.fn<Promise<unknown[]>, [string, unknown[]?]>();
  for (const rows of responses) query.mockResolvedValueOnce(rows);
  query.mockResolvedValue([]);
  const db: DatabaseConnection = { query, close: jest.fn<Promise<void>, []>().mockResolvedValue(undefined) };
  return { db, query };
}

const invoice = {
  Invoice_Number: 'SUPIN-1001',
  Supplier_Reference: ref(['WID', 'sup-wid'], ['Supplier_ID', 'S-000123']),
  Company_Reference: ref(['WID', 'co-wid'], ['Company_Reference_ID', '912']),
  Suppliers_Invoice_Number: 'INV-77',
  Invoice_Date: '2026-09-01-07:00',
  Control_Amount_Total: '150.5',
  Memo: 'AC 1033562. Services',
  Work_Queue_Information_Data: { Work_Queue_Notes: 'FINANCE AGENT: notes are not scored' },
  Invoice_Line_Replacement_Data: [
    {
      Line_Order: '2',
      Extended_Amount: '50',
      Item_Description: 'Freight',
      Spend_Category_Reference: ref(['Spend_Category_ID', 'SC-2']),
      Worktags_Reference: [ref(['WID', 'cc-wid'], ['Cost_Center_Reference_ID', 'CC100'])],
    },
    {
      Line_Order: '1',
      Extended_Amount: { $value: '100.5' },
      Memo: 'Line memo',
      Item_Description: 'Ryan Poland - Project Management',
      Purchase_Order_Line_Reference: ref(['WID', 'pol-wid'], ['Purchase_Order_Line_ID', 'PO-123456-1']),
      Spend_Category_Reference: ref(['Spend_Category_ID', 'SC-1']),
      Worktags_Reference: [
        ref(['Cost_Center_Reference_ID', 'CC200']),
        ref(['Fund_ID', 'FUND-General']),
        ref(['Organization_Reference_ID', 'LOB-Golf']),
        ref(['Organization_Reference_ID', 'VENU-Frisco']),
      ],
    },
  ],
};

describe('referenceKey', () => {
  it('prefers a readable reference ID over the WID', () => {
    expect(referenceKey(ref(['WID', 'abc'], ['Supplier_ID', 'S-1']))).toBe('Supplier_ID=S-1');
    expect(referenceKey(ref(['WID', 'abc']))).toBe('WID=abc');
    expect(referenceKey(undefined)).toBeUndefined();
  });
});

describe('extractScoredFields', () => {
  it('keeps only the whitelisted header and line fields, ordered by line', () => {
    expect(extractScoredFields(invoice)).toEqual({
      supplier: 'Supplier_ID=S-000123',
      company: 'Company_Reference_ID=912',
      suppliersInvoiceNumber: 'INV-77',
      invoiceDate: '2026-09-01',
      controlTotal: 150.5,
      memo: 'AC 1033562. Services',
      lines: [
        {
          lineOrder: 1,
          amount: 100.5,
          purchaseOrderLine: 'Purchase_Order_Line_ID=PO-123456-1',
          spendCategory: 'Spend_Category_ID=SC-1',
          costCenter: 'Cost_Center_Reference_ID=CC200',
          fund: 'Fund_ID=FUND-General',
          lineOfBusiness: 'Organization_Reference_ID=LOB-Golf',
          otherWorktags: ['Organization_Reference_ID=VENU-Frisco'],
          memo: 'Line memo',
          itemDescription: 'Ryan Poland - Project Management',
        },
        {
          lineOrder: 2,
          amount: 50,
          spendCategory: 'Spend_Category_ID=SC-2',
          costCenter: 'Cost_Center_Reference_ID=CC100',
          otherWorktags: [],
          itemDescription: 'Freight',
        },
      ],
    });
  });

  it('accepts a single line object and an empty invoice', () => {
    expect(extractScoredFields({ Invoice_Line_Replacement_Data: { Extended_Amount: '10' } }).lines).toEqual([
      { amount: 10, otherWorktags: [] },
    ]);
    expect(extractScoredFields(undefined)).toEqual({ lines: [] });
  });
});

describe('diffScoredFields', () => {
  const base: ScoredFields = extractScoredFields(invoice);

  it('reports no changes for the same read', () => {
    expect(diffScoredFields(base, extractScoredFields(invoice))).toEqual([]);
  });

  it('reports header and line field changes with before and after values', () => {
    const after: ScoredFields = {
      ...base,
      memo: 'Services',
      lines: [{ ...base.lines[0], costCenter: 'Cost_Center_Reference_ID=CC300' }, base.lines[1]],
    };
    expect(diffScoredFields(base, after)).toEqual([
      { field: 'memo', before: 'AC 1033562. Services', after: 'Services' },
      { field: 'line.costCenter', line: 0, before: 'Cost_Center_Reference_ID=CC200', after: 'Cost_Center_Reference_ID=CC300' },
    ]);
  });

  it('pairs reordered lines by amount instead of reporting every field as changed', () => {
    const reordered: ScoredFields = { ...base, lines: [base.lines[1], base.lines[0]] };
    expect(diffScoredFields(base, reordered)).toEqual([]);
  });

  it('reports lines AP removed or added when AP collapses lines into one', () => {
    const collapsed: ScoredFields = {
      ...base,
      lines: [{ amount: 150.5, otherWorktags: [], costCenter: 'Cost_Center_Reference_ID=CC200' }],
    };
    const changes = diffScoredFields(base, collapsed);
    expect(changes.filter((change) => change.field === 'line.removed')).toHaveLength(1);
    expect(changes.some((change) => change.field === 'line.amount' && change.after === 150.5)).toBe(true);
  });
});

describe('recordAgentInvoiceSnapshot', () => {
  it('inserts the next write sequence with the release and clustering stamp', async () => {
    const { db, query } = mockDb();
    await recordAgentInvoiceSnapshot(db, {
      workdayInvoiceWid: 'inv-wid',
      source: 'create',
      fields: { lines: [] },
      conversationId: 'conv-1',
      s3Keys: ['new-invoices/r/0-a.pdf'],
      attachmentKinds: ['supplier_invoice'],
      clusteringMode: 'on',
      releaseSha: 'abc123',
    });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('COALESCE((SELECT MAX(write_seq) FROM agent_invoice_snapshots WHERE workday_invoice_wid = $1::varchar), 0) + 1');
    expect(params).toEqual([
      'inv-wid', 'create', null, '{"lines":[]}', 'conv-1',
      '["new-invoices/r/0-a.pdf"]', '["supplier_invoice"]', 'abc123', 'on', null,
    ]);
  });
});

describe('getLatestAgentWriteSnapshot', () => {
  it('maps the latest agent write row and ignores enrich baselines in the query', async () => {
    const { db, query } = mockDb([[{
      workday_invoice_wid: 'inv-wid',
      write_seq: 2,
      source: 'resend_update',
      fields: { supplier: 'Supplier_ID=S-1', lines: [] },
      conversation_id: 'conv-1',
      s3_keys: null,
      attachment_kinds: ['supplier_invoice'],
      release_sha: 'abc',
      clustering_mode: 'on',
      pre_write_diff: null,
      created_at: new Date('2026-10-01T00:00:00Z'),
    }]]);
    const snapshot = await getLatestAgentWriteSnapshot(db, 'inv-wid');
    expect(query.mock.calls[0][1]).toEqual(['inv-wid', ['create', 'resend_update', 'enrich']]);
    expect(snapshot).toEqual(expect.objectContaining({
      writeSeq: 2,
      source: 'resend_update',
      fields: { supplier: 'Supplier_ID=S-1', lines: [] },
      attachmentKinds: ['supplier_invoice'],
    }));
  });
});

describe('snapshotAgentWrite', () => {
  const context = (db: DatabaseConnection) => ({ workdayConfig: {} as never, dbConnection: db });

  beforeEach(() => {
    (getSupplierInvoice as jest.Mock).mockReset();
  });

  it('records the provided invoice without another Workday read', async () => {
    const { db, query } = mockDb();
    await expect(snapshotAgentWrite(context(db), { workdayInvoiceWid: 'inv-wid', source: 'create', invoice })).resolves.toBe(true);
    expect(getSupplierInvoice).not.toHaveBeenCalled();
    expect(query.mock.calls[0][1]?.[2]).toBe('SUPIN-1001');
  });

  it('reads the invoice back and records what AP changed before an agent update overwrote it', async () => {
    const latestFields = extractScoredFields(invoice);
    const { db, query } = mockDb([[{
      workday_invoice_wid: 'inv-wid', write_seq: 1, source: 'create', fields: latestFields, created_at: new Date(),
    }]]);
    (getSupplierInvoice as jest.Mock).mockResolvedValue(invoice);
    const previousInvoice = { ...invoice, Memo: 'AP memo' };

    await expect(snapshotAgentWrite(context(db), {
      workdayInvoiceWid: 'inv-wid',
      source: 'resend_update',
      previousInvoice,
    })).resolves.toBe(true);

    expect(getSupplierInvoice).toHaveBeenCalledWith(expect.anything(), 'inv-wid');
    const insertParams = query.mock.calls[1][1] as unknown[];
    expect(insertParams[1]).toBe('resend_update');
    expect(JSON.parse(insertParams[9] as string)).toEqual([
      { field: 'memo', before: 'AC 1033562. Services', after: 'AP memo' },
    ]);
  });

  it('returns false instead of throwing when the insert fails', async () => {
    const { db, query } = mockDb();
    query.mockRejectedValue(new Error('db down'));
    await expect(snapshotAgentWrite(context(db), { workdayInvoiceWid: 'inv-wid', source: 'create', invoice })).resolves.toBe(false);
  });

  it('returns false when the Workday read fails', async () => {
    const { db } = mockDb();
    (getSupplierInvoice as jest.Mock).mockRejectedValue(new Error('soap down'));
    await expect(snapshotAgentWrite(context(db), { workdayInvoiceWid: 'inv-wid', source: 'enrich' })).resolves.toBe(false);
  });
});

describe('snapshotEnrichBaseline', () => {
  it('records the pre-enrich invoice as an enrich baseline and never throws', async () => {
    const { db, query } = mockDb();
    await expect(snapshotEnrichBaseline(db, { workdayInvoiceWid: 'inv-wid', invoice })).resolves.toBe(true);
    expect(query.mock.calls[0][1]?.[1]).toBe('enrich_baseline');

    query.mockRejectedValue(new Error('db down'));
    await expect(snapshotEnrichBaseline(db, { workdayInvoiceWid: 'inv-wid', invoice })).resolves.toBe(false);
  });
});
