import type { DatabaseConnection } from './database.js';

export interface ConversationSupplierInvoice {
  conversationId: string;
  supplierInvoiceNumber: string;
  supplierWid: string | null;
  workdayInvoiceWid: string;
  workdayInvoiceNumber: string | null;
  lastProcessedReceivedAt: number | null;
}

interface ConversationSupplierInvoiceRow {
  conversation_id: string;
  supplier_invoice_number: string;
  supplier_wid: string | null;
  workday_invoice_wid: string;
  workday_invoice_number: string | null;
  last_processed_received_at: string | number | null;
}

function toConversationSupplierInvoice(row: ConversationSupplierInvoiceRow): ConversationSupplierInvoice {
  return {
    conversationId: row.conversation_id,
    supplierInvoiceNumber: row.supplier_invoice_number,
    supplierWid: row.supplier_wid,
    workdayInvoiceWid: row.workday_invoice_wid,
    workdayInvoiceNumber: row.workday_invoice_number,
    lastProcessedReceivedAt:
      row.last_processed_received_at == null ? null : Number(row.last_processed_received_at),
  };
}

export async function getConversationSupplierInvoice(
  db: DatabaseConnection,
  conversationId: string,
  supplierInvoiceNumber: string
): Promise<ConversationSupplierInvoice | undefined> {
  const rows = (await db.query(
    `SELECT conversation_id, supplier_invoice_number, supplier_wid, workday_invoice_wid,
            workday_invoice_number, last_processed_received_at
       FROM conversation_supplier_invoices
      WHERE conversation_id = $1 AND supplier_invoice_number = $2
      LIMIT 1`,
    [conversationId, supplierInvoiceNumber]
  )) as ConversationSupplierInvoiceRow[];
  return rows.length ? toConversationSupplierInvoice(rows[0]) : undefined;
}

export async function upsertConversationSupplierInvoice(
  db: DatabaseConnection,
  invoice: ConversationSupplierInvoice
): Promise<void> {
  await db.query(
    `INSERT INTO conversation_supplier_invoices
       (conversation_id, supplier_invoice_number, supplier_wid, workday_invoice_wid,
        workday_invoice_number, last_processed_received_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
     ON CONFLICT (conversation_id, supplier_invoice_number)
     DO UPDATE SET supplier_wid = EXCLUDED.supplier_wid,
                   workday_invoice_wid = EXCLUDED.workday_invoice_wid,
                   workday_invoice_number = EXCLUDED.workday_invoice_number,
                   last_processed_received_at = EXCLUDED.last_processed_received_at,
                   updated_at = CURRENT_TIMESTAMP`,
    [
      invoice.conversationId,
      invoice.supplierInvoiceNumber,
      invoice.supplierWid,
      invoice.workdayInvoiceWid,
      invoice.workdayInvoiceNumber,
      invoice.lastProcessedReceivedAt,
    ]
  );
}
