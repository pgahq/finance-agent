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
   * The number this document generated first that a sibling already held, set when this document was given a
   * later candidate or a suffix: the first candidate for a later candidate, the last candidate for a suffix.
   */
  clashedNumber?: string;
  /**
   * The amount due (see generatedNumberAmountKey) stored for the invoice that holds `clashedNumber`. Lets the
   * note say plainly when this invoice looks like a resend of that one.
   */
  clashedAmountDue?: string | null;
  /** With `clashedNumber`: true when a -2, -3 suffix was needed, false when a later candidate was free. */
  suffixed?: boolean;
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

/**
 * Reserves the supplier invoice number for a document whose number the agent made up. A document that already
 * holds a number in this conversation and supplier keeps it, whatever this run generated, so a re-trigger never
 * moves an invoice to a new number. Otherwise the first free candidate is taken (the invoice-date number, then the
 * service-date number), else the first free -2, -3 ... suffix of the last candidate. The insert is atomic, so
 * parallel runs for sibling invoices never get the same number. A clash from a document that has a later
 * candidate marks the holder's row contested, so the holder can still move to its own alternate before it submits
 * (see settleGeneratedInvoiceNumber); a clash that goes straight to a suffix never moves the holder.
 */
export async function reserveGeneratedInvoiceNumber(
  db: DatabaseConnection,
  params: { conversationId: string; supplierWid: string; candidates: string[]; documentHash: string; amountDue?: string | null }
): Promise<GeneratedInvoiceNumberReservation> {
  const { conversationId, supplierWid, documentHash } = params;
  const candidates = [...new Set(params.candidates.filter(Boolean))];
  if (!candidates.length) throw new Error('Could not reserve a supplier invoice number: no candidate number was given');
  const amountDue = generatedNumberAmountKey(params.amountDue);
  // A reused number carries a clash only when another document of this conversation and supplier still holds the
  // number it was moved off, so the note never names a sibling that is not there (rows from before this order
  // existed, or a re-run that read a different date, have none).
  const findByDocument = async (): Promise<GeneratedInvoiceNumberReservation | undefined> => {
    const rows = (await db.query(
      `SELECT assigned_number, workday_invoice_wid
         FROM conversation_generated_invoice_numbers
        WHERE conversation_id = $1 AND supplier_wid = $2 AND document_hash = $3
        LIMIT 1`,
      [conversationId, supplierWid, documentHash]
    )) as GeneratedInvoiceNumberRow[];
    if (!rows.length) return undefined;
    const assignedNumber = rows[0].assigned_number;
    const reused: GeneratedInvoiceNumberReservation = { assignedNumber, reused: true, workdayInvoiceWid: rows[0].workday_invoice_wid };
    const lastCandidate = candidates[candidates.length - 1];
    const movedOffNumber = assignedNumber === candidates[0]
      ? undefined
      : candidates.includes(assignedNumber) ? candidates[0] : assignedNumber.startsWith(`${lastCandidate}-`) ? lastCandidate : undefined;
    if (!movedOffNumber) return reused;
    const holders = (await db.query(
      `SELECT assigned_number, amount_due FROM conversation_generated_invoice_numbers
        WHERE conversation_id = $1 AND supplier_wid = $2 AND assigned_number = $3 AND document_hash <> $4`,
      [conversationId, supplierWid, movedOffNumber, documentHash]
    )) as GeneratedInvoiceNumberRow[];
    return holders.length
      ? { ...reused, clashedNumber: movedOffNumber, clashedAmountDue: holders[0].amount_due ?? null, suffixed: movedOffNumber === lastCandidate && !candidates.includes(assignedNumber) }
      : reused;
  };
  const holderAmountDue = async (assignedNumber: string): Promise<string | null> => {
    const rows = (await db.query(
      `SELECT amount_due FROM conversation_generated_invoice_numbers
        WHERE conversation_id = $1 AND supplier_wid = $2 AND assigned_number = $3`,
      [conversationId, supplierWid, assignedNumber]
    )) as GeneratedInvoiceNumberRow[];
    return rows[0]?.amount_due ?? null;
  };
  // The conflict was either the number (a sibling holds it) or this document (a parallel run just reserved it).
  const tryReserve = async (
    assignedNumber: string,
    markContested: boolean
  ): Promise<{ reserved: true } | { reserved: false; raced?: GeneratedInvoiceNumberReservation }> => {
    const inserted = (await db.query(
      `INSERT INTO conversation_generated_invoice_numbers
         (conversation_id, supplier_wid, assigned_number, base_number, document_hash, amount_due)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING
       RETURNING assigned_number`,
      [conversationId, supplierWid, assignedNumber, candidates[0], documentHash, amountDue]
    )) as GeneratedInvoiceNumberRow[];
    if (inserted.length) return { reserved: true };
    const raced = await findByDocument();
    if (raced) return { reserved: false, raced };
    if (markContested) {
      await db.query(
        `UPDATE conversation_generated_invoice_numbers SET contested = TRUE
          WHERE conversation_id = $1 AND supplier_wid = $2 AND assigned_number = $3`,
        [conversationId, supplierWid, assignedNumber]
      );
    }
    return { reserved: false };
  };

  const existing = await findByDocument();
  if (existing) return existing;

  for (let index = 0; index < candidates.length; index += 1) {
    // Only a clasher with a later candidate of its own moves off the number, so only then may the holder move too.
    const result = await tryReserve(candidates[index], index < candidates.length - 1);
    if (result.reserved) {
      if (index === 0) return { assignedNumber: candidates[index], reused: false, workdayInvoiceWid: null };
      return {
        assignedNumber: candidates[index],
        reused: false,
        workdayInvoiceWid: null,
        clashedNumber: candidates[0],
        clashedAmountDue: await holderAmountDue(candidates[0]),
        suffixed: false,
      };
    }
    if (result.raced) return result.raced;
  }

  const suffixBase = candidates[candidates.length - 1];
  for (let attempt = 2; attempt <= MAX_GENERATED_NUMBER_SUFFIX; attempt += 1) {
    const candidate = `${suffixBase}-${attempt}`;
    const result = await tryReserve(candidate, false);
    if (result.reserved) {
      return {
        assignedNumber: candidate,
        reused: false,
        workdayInvoiceWid: null,
        clashedNumber: suffixBase,
        clashedAmountDue: await holderAmountDue(suffixBase),
        suffixed: true,
      };
    }
    if (result.raced) return result.raced;
  }
  throw new Error(`Could not reserve a supplier invoice number for ${suffixBase}: ${MAX_GENERATED_NUMBER_SUFFIX} suffixes are taken in this conversation`);
}

/**
 * Lets the invoice that took the default number move to its own alternate (the service-date number) when a
 * sibling clashed with it since, so a batch of same-date invoices ends up with service-date numbers instead of one
 * invoice-date number among them. Best effort: it moves only a reservation no invoice has been created from, and
 * only when the alternate is free and no -2, -3 suffix of the current number exists (that suffix would be left
 * without its base); a sibling that takes a suffix between the check and the update can still strand it. A sibling that arrives after the invoice is submitted cannot change it.
 * `sameAmountSibling` says whether another invoice that generated the same default number has the same amount due,
 * so the note can ask AP to rule out a resend without naming the number this invoice just left.
 */
export async function settleGeneratedInvoiceNumber(
  db: DatabaseConnection,
  params: {
    conversationId: string;
    supplierWid: string;
    documentHash: string;
    assignedNumber: string;
    alternateNumber: string;
    amountDue?: string | null;
  }
): Promise<{ assignedNumber: string; moved: boolean; sameAmountSibling?: boolean }> {
  const { conversationId, supplierWid, documentHash, assignedNumber, alternateNumber } = params;
  const unchanged = { assignedNumber, moved: false };
  if (assignedNumber === alternateNumber) return unchanged;
  try {
    const moved = (await db.query(
      `UPDATE conversation_generated_invoice_numbers
          SET assigned_number = $5, contested = FALSE, updated_at = CURRENT_TIMESTAMP
        WHERE conversation_id = $1 AND supplier_wid = $2 AND document_hash = $3 AND assigned_number = $4
          AND contested AND workday_invoice_wid IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM conversation_generated_invoice_numbers
             WHERE conversation_id = $1 AND supplier_wid = $2 AND assigned_number = $5
          )
          AND NOT EXISTS (
            SELECT 1 FROM conversation_generated_invoice_numbers
             WHERE conversation_id = $1 AND supplier_wid = $2 AND assigned_number LIKE $4 || '-%'
          )
        RETURNING assigned_number`,
      [conversationId, supplierWid, documentHash, assignedNumber, alternateNumber]
    )) as GeneratedInvoiceNumberRow[];
    if (!moved.length) return unchanged;
    const amountDue = generatedNumberAmountKey(params.amountDue);
    const siblings = amountDue
      ? (await db.query(
        `SELECT assigned_number FROM conversation_generated_invoice_numbers
          WHERE conversation_id = $1 AND supplier_wid = $2 AND base_number = $3 AND document_hash <> $4 AND amount_due = $5
          LIMIT 1`,
        [conversationId, supplierWid, assignedNumber, documentHash, amountDue]
      )) as GeneratedInvoiceNumberRow[]
      : [];
    return { assignedNumber: alternateNumber, moved: true, sameAmountSibling: siblings.length > 0 };
  } catch (error) {
    // A sibling took the alternate between the check and the update (unique violation): keep the current number.
    if ((error as { code?: string } | undefined)?.code === '23505') return unchanged;
    throw error;
  }
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
