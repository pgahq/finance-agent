import {
  acquireConversationInvoiceClaim,
  getConversationSupplierInvoice,
  recordGeneratedInvoiceNumberInvoice,
  reserveGeneratedInvoiceNumber,
  releaseConversationInvoiceClaim,
  upsertConversationSupplierInvoice,
} from '../lib/conversation_invoices.js';
import type { DatabaseConnection } from '../lib/database.js';

function mockDb(rows: unknown[] = []) {
  const query = jest.fn<Promise<unknown[]>, [string, unknown[]?]>().mockResolvedValue(rows);
  const db: DatabaseConnection = { query, close: jest.fn<Promise<void>, []>().mockResolvedValue(undefined) };
  return { db, query };
}

describe('getConversationSupplierInvoice', () => {
  it('returns the mapped row for a conversation and invoice number', async () => {
    const { db, query } = mockDb([{
      conversation_id: '123',
      supplier_invoice_number: 'INV-100',
      supplier_wid: 'supplier-wid',
      workday_invoice_wid: 'invoice-wid',
      workday_invoice_number: 'SUPIN-1',
      last_processed_received_at: '1704067200',
    }]);

    await expect(getConversationSupplierInvoice(db, '123', 'INV-100')).resolves.toEqual({
      conversationId: '123',
      supplierInvoiceNumber: 'INV-100',
      supplierWid: 'supplier-wid',
      workdayInvoiceWid: 'invoice-wid',
      workdayInvoiceNumber: 'SUPIN-1',
      lastProcessedReceivedAt: 1704067200,
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM conversation_supplier_invoices'), ['123', 'INV-100']);
  });

  it('returns undefined when nothing was recorded', async () => {
    const { db } = mockDb([]);
    await expect(getConversationSupplierInvoice(db, '123', 'INV-100')).resolves.toBeUndefined();
  });
});

describe('upsertConversationSupplierInvoice', () => {
  it('upserts on conversation and invoice number', async () => {
    const { db, query } = mockDb([]);
    await upsertConversationSupplierInvoice(db, {
      conversationId: '123',
      supplierInvoiceNumber: 'INV-100',
      supplierWid: 'supplier-wid',
      workdayInvoiceWid: 'invoice-wid',
      workdayInvoiceNumber: 'SUPIN-1',
      lastProcessedReceivedAt: 1704153600,
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (conversation_id, supplier_invoice_number)'),
      ['123', 'INV-100', 'supplier-wid', 'invoice-wid', 'SUPIN-1', 1704153600]
    );
    expect(query.mock.calls[0][0]).toContain(
      'last_processed_received_at = GREATEST(conversation_supplier_invoices.last_processed_received_at, EXCLUDED.last_processed_received_at)'
    );
  });
});

describe('conversation invoice claims', () => {
  it('acquires a free or expired claim and reports a live one as held', async () => {
    const acquired = mockDb([{ claim_token: 'token-1' }]);
    await expect(acquireConversationInvoiceClaim(acquired.db, '123', 'INV-100', 'token-1')).resolves.toBe(true);
    const [sql, params] = acquired.query.mock.calls[0];
    expect(sql).toContain('ON CONFLICT (conversation_id, supplier_invoice_number)');
    expect(sql).toContain('WHERE conversation_invoice_claims.claimed_at < CURRENT_TIMESTAMP - make_interval(mins => $4)');
    expect(params).toEqual(['123', 'INV-100', 'token-1', 15]);

    const held = mockDb([]);
    await expect(acquireConversationInvoiceClaim(held.db, '123', 'INV-100', 'token-2')).resolves.toBe(false);
  });

  it('releases only the caller\'s own claim', async () => {
    const { db, query } = mockDb([]);
    await releaseConversationInvoiceClaim(db, '123', 'INV-100', 'token-1');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('AND claim_token = $3'), ['123', 'INV-100', 'token-1']);
  });
});

describe('reserveGeneratedInvoiceNumber', () => {
  const params = { conversationId: '123', supplierWid: 'supplier-wid', baseNumber: 'ABCD031126', documentHash: 'h'.repeat(64) };

  it('returns the number an earlier run gave the same document without inserting', async () => {
    const { db, query } = mockDb([{ assigned_number: 'ABCD031126-2', workday_invoice_wid: 'invoice-wid' }]);

    await expect(reserveGeneratedInvoiceNumber(db, params)).resolves.toEqual({
      assignedNumber: 'ABCD031126-2',
      reused: true,
      workdayInvoiceWid: 'invoice-wid',
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('document_hash = $3'), ['123', 'supplier-wid', params.documentHash]);
  });

  it('takes the base number when it is free', async () => {
    const query = jest.fn<Promise<unknown[]>, [string, unknown[]?]>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ assigned_number: 'ABCD031126' }]);
    const db: DatabaseConnection = { query, close: jest.fn() };

    await expect(reserveGeneratedInvoiceNumber(db, params)).resolves.toEqual({
      assignedNumber: 'ABCD031126',
      reused: false,
      workdayInvoiceWid: null,
    });
    expect(query.mock.calls[1][0]).toContain('ON CONFLICT DO NOTHING');
    expect(query.mock.calls[1][1]).toEqual(['123', 'supplier-wid', 'ABCD031126', 'ABCD031126', params.documentHash]);
  });

  it('walks to -2 and -3 while siblings hold the earlier numbers', async () => {
    const query = jest.fn<Promise<unknown[]>, [string, unknown[]?]>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ assigned_number: 'ABCD031126-3' }]);
    const db: DatabaseConnection = { query, close: jest.fn() };

    await expect(reserveGeneratedInvoiceNumber(db, params)).resolves.toMatchObject({ assignedNumber: 'ABCD031126-3', reused: false });
    const inserted = query.mock.calls.filter(([sql]) => sql.includes('INSERT')).map(([, values]) => values?.[2]);
    expect(inserted).toEqual(['ABCD031126', 'ABCD031126-2', 'ABCD031126-3']);
  });

  it('returns the number a parallel run reserved for the same document', async () => {
    const query = jest.fn<Promise<unknown[]>, [string, unknown[]?]>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ assigned_number: 'ABCD031126', workday_invoice_wid: null }]);
    const db: DatabaseConnection = { query, close: jest.fn() };

    await expect(reserveGeneratedInvoiceNumber(db, params)).resolves.toEqual({
      assignedNumber: 'ABCD031126',
      reused: true,
      workdayInvoiceWid: null,
    });
  });

  it('gives up instead of looping forever when every suffix is taken', async () => {
    const { db } = mockDb([]);
    await expect(reserveGeneratedInvoiceNumber(db, params)).rejects.toThrow('suffixes are taken');
  });
});

describe('recordGeneratedInvoiceNumberInvoice', () => {
  it('stores the Workday invoice on the reserved number', async () => {
    const { db, query } = mockDb([]);
    await recordGeneratedInvoiceNumberInvoice(db, {
      conversationId: '123',
      supplierWid: 'supplier-wid',
      assignedNumber: 'ABCD031126-2',
      workdayInvoiceWid: 'invoice-wid',
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE conversation_generated_invoice_numbers'),
      ['123', 'supplier-wid', 'ABCD031126-2', 'invoice-wid']
    );
  });
});
