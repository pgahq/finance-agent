jest.mock('../lib/workday.js', () => ({ executeWorkdayQuery: jest.fn() }));

import type { DatabaseConnection } from '../lib/database.js';
import {
  fetchInvoiceStatuses,
  findLiveInvoicesWithSuppliersInvoiceNumber,
  listPendingScoreInvoices,
  rowToInvoiceScore,
  STATUS_BATCH_SIZE,
  upsertInvoiceScore,
} from '../lib/invoice_scores.js';
import { executeWorkdayQuery } from '../lib/workday.js';

function mockDb(rows: unknown[] = []) {
  const query = jest.fn<Promise<unknown[]>, [string, unknown[]?]>().mockResolvedValue(rows);
  const db: DatabaseConnection = { query, close: jest.fn<Promise<void>, []>().mockResolvedValue(undefined) };
  return { db, query };
}

beforeEach(() => jest.clearAllMocks());

describe('score rows', () => {
  it('maps a stored row back to a score and drops empty columns', () => {
    expect(rowToInvoiceScore({
      workday_invoice_wid: 'w',
      workday_invoice_number: null,
      origin: 'create',
      entry_read_at: '2026-10-01T00:00:00Z',
      entry_diff: '[{"field":"memo","category":"convention","agentOwned":true}]',
      outcome: 'submitted_clean',
      terminal: false,
    })).toEqual({
      workdayInvoiceWid: 'w',
      origin: 'create',
      entryReadAt: new Date('2026-10-01T00:00:00Z'),
      entryDiff: [{ field: 'memo', category: 'convention', agentOwned: true }],
      outcome: 'submitted_clean',
      terminal: false,
    });
  });

  it('reads unknown stored enum values as unset', () => {
    const score = rowToInvoiceScore({ workday_invoice_wid: 'w', origin: 'import', outcome: 'mystery', cancel_basis: 'guess', terminal: 't' });
    expect(score.origin).toBeUndefined();
    expect(score.outcome).toBeUndefined();
    expect(score.cancelBasis).toBeUndefined();
    expect(score.terminal).toBe(true);
  });

  it('upserts every column keyed by the invoice WID and never reopens a terminal score', async () => {
    const { db, query } = mockDb();
    await upsertInvoiceScore(db, { workdayInvoiceWid: 'w', outcome: 'canceled', cancelAttribution: 'agent', terminal: true });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('ON CONFLICT (workday_invoice_wid) DO UPDATE');
    expect(sql).toContain('WHERE agent_invoice_scores.terminal = false');
    expect(params?.[0]).toBe('w');
    expect(params?.[11]).toBe('canceled');
    expect(params?.[13]).toBe('agent');
    expect(params?.[19]).toBe(true);
  });

  it('lists non-terminal agent invoices with their last write time', async () => {
    const { db, query } = mockDb([{ workday_invoice_wid: 'w', last_write_at: new Date('2026-10-01T00:00:00Z'), entry_read_at: null, final_read_at: null, outcome: null }]);
    await expect(listPendingScoreInvoices(db, 100)).resolves.toEqual([
      { workdayInvoiceWid: 'w', lastWriteAt: new Date('2026-10-01T00:00:00Z') },
    ]);
    expect(query.mock.calls[0][1]).toEqual([['create', 'resend_update', 'enrich'], 100]);
    expect(query.mock.calls[0][0]).toContain('ORDER BY last_write_at DESC');
  });
});

describe('fetchInvoiceStatuses', () => {
  it('batches WIDs and reads the optional cancel and hold reason fields', async () => {
    const wids = Array.from({ length: STATUS_BATCH_SIZE + 1 }, (_, index) => `wid-${index}`);
    (executeWorkdayQuery as jest.Mock)
      .mockResolvedValueOnce({ data: [{ workdayID: 'wid-0', invoiceStatusAsText: 'Draft', isCanceled: true, reason: { descriptor: 'Supplier Voided', id: 'r1' } }] })
      .mockResolvedValueOnce({ data: [] });

    const statuses = await fetchInvoiceStatuses({} as never, wids, {
      SCORE_CANCEL_REASON_WQL_FIELD: 'reason',
      SCORE_HOLD_REASON_WQL_FIELD: 'holdReason',
    });

    expect(executeWorkdayQuery).toHaveBeenCalledTimes(2);
    expect((executeWorkdayQuery as jest.Mock).mock.calls[0][1]).toContain(', reason, holdReason');
    expect((executeWorkdayQuery as jest.Mock).mock.calls[1][1]).toContain(`workdayID in ('wid-${STATUS_BATCH_SIZE}')`);
    expect(statuses.get('wid-0')).toEqual(expect.objectContaining({ invoiceStatusAsText: 'Draft', isCanceled: true, cancelReason: 'Supplier Voided' }));
    expect(statuses.has('wid-1')).toBe(false);
  });

  it('refuses a configured field that is not a plain WQL alias', async () => {
    await expect(fetchInvoiceStatuses({} as never, ['w'], { SCORE_CANCEL_REASON_WQL_FIELD: 'reason FROM x' }))
      .rejects.toThrow('SCORE_CANCEL_REASON_WQL_FIELD must be a WQL field alias');
    await expect(findLiveInvoicesWithSuppliersInvoiceNumber({} as never, 'INV-1', { SCORE_SUPPLIERS_INVOICE_NUMBER_WQL_FIELD: "num = '' OR 1" }))
      .rejects.toThrow('SCORE_SUPPLIERS_INVOICE_NUMBER_WQL_FIELD must be a WQL field alias');
    expect(executeWorkdayQuery).not.toHaveBeenCalled();
  });

  it('leaves the extra fields out until they are configured', async () => {
    (executeWorkdayQuery as jest.Mock).mockResolvedValue({ data: [] });
    await fetchInvoiceStatuses({} as never, ['w'], {});
    expect((executeWorkdayQuery as jest.Mock).mock.calls[0][1]).toContain('invoiceIsPartiallyPaid\n');
  });
});

describe('findLiveInvoicesWithSuppliersInvoiceNumber', () => {
  it('returns nothing and skips Workday when the field is not configured', async () => {
    await expect(findLiveInvoicesWithSuppliersInvoiceNumber({} as never, 'INV-1', {})).resolves.toEqual([]);
    expect(executeWorkdayQuery).not.toHaveBeenCalled();
  });

  it('escapes the number and maps supplier IDs', async () => {
    (executeWorkdayQuery as jest.Mock).mockResolvedValue({ data: [{ workdayID: 'x', invoiceNumber: 'SUPIN-2', supplier: { id: 'sup-wid' } }] });
    await expect(findLiveInvoicesWithSuppliersInvoiceNumber({} as never, "O'Brien-1", { SCORE_SUPPLIERS_INVOICE_NUMBER_WQL_FIELD: 'num' }))
      .resolves.toEqual([{ workdayID: 'x', invoiceNumber: 'SUPIN-2', supplierId: 'sup-wid' }]);
    expect((executeWorkdayQuery as jest.Mock).mock.calls[0][1]).toContain("num = 'O''Brien-1' AND isCanceled = false");
  });
});
