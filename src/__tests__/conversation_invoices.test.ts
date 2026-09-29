import {
  getConversationSupplierInvoice,
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
