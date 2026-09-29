import {
  acquireConversationInvoiceClaim,
  getConversationSupplierInvoice,
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
