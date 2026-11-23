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
                   last_processed_received_at = GREATEST(conversation_supplier_invoices.last_processed_received_at, EXCLUDED.last_processed_received_at),
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

/**
 * Longer than the CreateInvoiceProcessor Lambda timeout (300s, guarded by template.test.ts), so a claim
 * can only be taken over after its owner was stopped and can no longer write.
 */
export const CONVERSATION_INVOICE_CLAIM_TTL_MINUTES = 15;

/**
 * Claims a conversation invoice before any Workday create or update. Returns false when another run
 * holds a live claim; a claim older than the TTL is taken over.
 */
export async function acquireConversationInvoiceClaim(
  db: DatabaseConnection,
  conversationId: string,
  supplierInvoiceNumber: string,
  claimToken: string
): Promise<boolean> {
  const rows = await db.query(
    `INSERT INTO conversation_invoice_claims (conversation_id, supplier_invoice_number, claim_token, claimed_at)
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
     ON CONFLICT (conversation_id, supplier_invoice_number)
     DO UPDATE SET claim_token = EXCLUDED.claim_token, claimed_at = CURRENT_TIMESTAMP
      WHERE conversation_invoice_claims.claimed_at < CURRENT_TIMESTAMP - make_interval(mins => $4)
     RETURNING claim_token`,
    [conversationId, supplierInvoiceNumber, claimToken, CONVERSATION_INVOICE_CLAIM_TTL_MINUTES]
  );
  return rows.length > 0;
}

export async function releaseConversationInvoiceClaim(
  db: DatabaseConnection,
  conversationId: string,
  supplierInvoiceNumber: string,
  claimToken: string
): Promise<void> {
  await db.query(
    `DELETE FROM conversation_invoice_claims
      WHERE conversation_id = $1 AND supplier_invoice_number = $2 AND claim_token = $3`,
    [conversationId, supplierInvoiceNumber, claimToken]
  );
}

export interface GeneratedInvoiceNumberReservation {
  assignedNumber: string;
  /** True when this document already held the number from an earlier run. */
  reused: boolean;
  /** The Workday invoice an earlier run created from this document under the number, if it recorded one. */
  workdayInvoiceWid: string | null;
  /**
   * The amount due (see generatedNumberAmountKey) stored for the invoice that holds the base number, set only
   * when this document was suffixed. Lets the note say plainly when the suffixed invoice looks like a resend.
   */
  baseAmountDue?: string | null;
}

interface GeneratedInvoiceNumberRow {
  assigned_number: string;
  workday_invoice_wid: string | null;
  supplier_wid?: string;
  amount_due?: string | null;
}

/** A comparable form of the printed amount due ("$1,350.00" and "1350" are the same), or null when unreadable. */
export function generatedNumberAmountKey(amountDue: string | null | undefined): string | null {
  if (!amountDue) return null;
  const parsed = Number(amountDue.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) && /\d/.test(amountDue) ? parsed.toFixed(2) : null;
}

/**
 * Invoices an earlier run created from this same document under another supplier of the conversation. Workday's
 * duplicate-number check is per supplier, so a re-trigger that resolves a different supplier (default to real
 * once a W-9 arrives) would not see the earlier invoice by number; the document hash does.
 */
export async function findGeneratedInvoicesForDocument(
  db: DatabaseConnection,
  params: { conversationId: string; supplierWid: string; documentHash: string }
): Promise<Array<{ supplierWid: string; assignedNumber: string; workdayInvoiceWid: string }>> {
  const rows = (await db.query(
    `SELECT supplier_wid, assigned_number, workday_invoice_wid
       FROM conversation_generated_invoice_numbers
      WHERE conversation_id = $1 AND document_hash = $2 AND supplier_wid <> $3 AND workday_invoice_wid IS NOT NULL`,
    [params.conversationId, params.documentHash, params.supplierWid]
  )) as GeneratedInvoiceNumberRow[];
  return rows.map((row) => ({
    supplierWid: row.supplier_wid ?? '',
    assignedNumber: row.assigned_number,
    workdayInvoiceWid: row.workday_invoice_wid ?? '',
  }));
}

// A conversation has a handful of invoices, so this only bounds a runaway loop.
const MAX_GENERATED_NUMBER_SUFFIX = 50;

function suffixedNumber(base: string, attempt: number): string {
  return attempt === 1 ? base : `${base}-${attempt}`;
}

/**
 * Reserves the supplier invoice number for a document whose number the agent made up. A document that already
 * holds a number in this conversation and supplier keeps it, whatever base this run generated, so a re-trigger
 * never moves an invoice to a new number. Otherwise the base is taken when free, else the first free -2, -3 ...
 * suffix. The insert is atomic, so parallel runs for sibling invoices never get the same number.
 */
export async function reserveGeneratedInvoiceNumber(
  db: DatabaseConnection,
  params: { conversationId: string; supplierWid: string; baseNumber: string; documentHash: string; amountDue?: string | null }
): Promise<GeneratedInvoiceNumberReservation> {
  const { conversationId, supplierWid, baseNumber, documentHash } = params;
  const amountDue = generatedNumberAmountKey(params.amountDue);
  const findByDocument = async (): Promise<GeneratedInvoiceNumberReservation | undefined> => {
    const rows = (await db.query(
      `SELECT assigned_number, workday_invoice_wid
         FROM conversation_generated_invoice_numbers
        WHERE conversation_id = $1 AND supplier_wid = $2 AND document_hash = $3
        LIMIT 1`,
      [conversationId, supplierWid, documentHash]
    )) as GeneratedInvoiceNumberRow[];
    return rows.length
      ? { assignedNumber: rows[0].assigned_number, reused: true, workdayInvoiceWid: rows[0].workday_invoice_wid }
      : undefined;
  };

  const existing = await findByDocument();
  if (existing) return existing;

  for (let attempt = 1; attempt <= MAX_GENERATED_NUMBER_SUFFIX; attempt += 1) {
    const candidate = suffixedNumber(baseNumber, attempt);
    const inserted = (await db.query(
      `INSERT INTO conversation_generated_invoice_numbers
         (conversation_id, supplier_wid, assigned_number, base_number, document_hash, amount_due)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING
       RETURNING assigned_number`,
      [conversationId, supplierWid, candidate, baseNumber, documentHash, amountDue]
    )) as GeneratedInvoiceNumberRow[];
    if (inserted.length) {
      if (attempt === 1) return { assignedNumber: candidate, reused: false, workdayInvoiceWid: null };
      const baseRows = (await db.query(
        `SELECT amount_due FROM conversation_generated_invoice_numbers
          WHERE conversation_id = $1 AND supplier_wid = $2 AND assigned_number = $3`,
        [conversationId, supplierWid, baseNumber]
      )) as GeneratedInvoiceNumberRow[];
      return { assignedNumber: candidate, reused: false, workdayInvoiceWid: null, baseAmountDue: baseRows[0]?.amount_due ?? null };
    }
    // The conflict was either the number (a sibling holds it) or this document (a parallel run just reserved it).
    const raced = await findByDocument();
    if (raced) return raced;
  }
  throw new Error(`Could not reserve a supplier invoice number for ${baseNumber}: ${MAX_GENERATED_NUMBER_SUFFIX} suffixes are taken in this conversation`);
}

/** Records the Workday invoice created under a reserved number so a re-trigger can tell it already exists. */
export async function recordGeneratedInvoiceNumberInvoice(
  db: DatabaseConnection,
  params: { conversationId: string; supplierWid: string; assignedNumber: string; workdayInvoiceWid: string }
): Promise<void> {
  await db.query(
    `UPDATE conversation_generated_invoice_numbers
        SET workday_invoice_wid = $4, updated_at = CURRENT_TIMESTAMP
      WHERE conversation_id = $1 AND supplier_wid = $2 AND assigned_number = $3`,
    [params.conversationId, params.supplierWid, params.assignedNumber, params.workdayInvoiceWid]
  );
}
