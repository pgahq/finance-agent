import {
  getConversationSupplierInvoice,
  upsertConversationSupplierInvoice,
} from '../lib/conversation_invoices.js';

function mockDb(rows: unknown[] = []) {
  return { query: jest.fn().mockResolvedValue(rows), close: jest.fn() };
}

describe('getConversationSupplierInvoice', () => {
  it('returns the mapped row for a conversation and invoice number', async () => {
    const db = mockDb([{
      conversation_id: '123',
      supplier_invoice_number: 'INV-100',
      supplier_wid: 'supplier-wid',
      workday_invoice_wid: 'invoice-wid',
      workday_invoice_number: 'SUPIN-1',
      last_processed_received_at: '1704067200',
    }]);

    await expect(getConversationSupplierInvoice(db as never, '123', 'INV-100')).resolves.toEqual({
      conversationId: '123',
      supplierInvoiceNumber: 'INV-100',
      supplierWid: 'supplier-wid',
      workdayInvoiceWid: 'invoice-wid',
      workdayInvoiceNumber: 'SUPIN-1',
      lastProcessedReceivedAt: 1704067200,
    });
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('FROM conversation_supplier_invoices'), ['123', 'INV-100']);
  });

  it('returns undefined when nothing was recorded', async () => {
    const db = mockDb([]);
    await expect(getConversationSupplierInvoice(db as never, '123', 'INV-100')).resolves.toBeUndefined();
  });
});

describe('upsertConversationSupplierInvoice', () => {
  it('upserts on conversation and invoice number', async () => {
    const db = mockDb([]);
    await upsertConversationSupplierInvoice(db as never, {
      conversationId: '123',
      supplierInvoiceNumber: 'INV-100',
      supplierWid: 'supplier-wid',
      workdayInvoiceWid: 'invoice-wid',
      workdayInvoiceNumber: 'SUPIN-1',
      lastProcessedReceivedAt: 1704153600,
    });

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (conversation_id, supplier_invoice_number)'),
      ['123', 'INV-100', 'supplier-wid', 'invoice-wid', 'SUPIN-1', 1704153600]
    );
  });
});
