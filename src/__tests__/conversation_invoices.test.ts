import {
  acquireConversationInvoiceClaim,
  findGeneratedInvoicesForDocument,
  generatedNumberAmountKey,
  getConversationSupplierInvoice,
  recordGeneratedInvoiceNumberInvoice,
  reserveGeneratedInvoiceNumber,
  releaseConversationInvoiceClaim,
  settleGeneratedInvoiceNumber,
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

interface FakeNumberRow {
  conversation_id: string;
  supplier_wid: string;
  assigned_number: string;
  base_number: string;
  document_hash: string;
  amount_due: string | null;
  contested: boolean;
  workday_invoice_wid: string | null;
}

/** An in-memory stand-in for conversation_generated_invoice_numbers that understands the statements the module sends. */
function generatedNumbersDb(onQuery?: (sql: string) => void) {
  const rows: FakeNumberRow[] = [];
  const query = jest.fn(async (sql: string, values: unknown[] = []) => {
    onQuery?.(sql);
    if (sql.includes('INSERT INTO conversation_generated_invoice_numbers')) {
      const [conversation, supplier, assigned, base, hash, amount] = values as [string, string, string, string, string, string | null];
      const clash = rows.some((row) => row.conversation_id === conversation && row.supplier_wid === supplier
        && (row.assigned_number === assigned || row.document_hash === hash));
      if (clash) return [];
      rows.push({ conversation_id: conversation, supplier_wid: supplier, assigned_number: assigned, base_number: base, document_hash: hash, amount_due: amount, contested: false, workday_invoice_wid: null });
      return [{ assigned_number: assigned }];
    }
    if (sql.includes('SET contested = TRUE')) {
      const [conversation, supplier, assigned] = values as string[];
      for (const row of rows) {
        if (row.conversation_id === conversation && row.supplier_wid === supplier && row.assigned_number === assigned) row.contested = true;
      }
      return [];
    }
    if (sql.includes('SET assigned_number = $5')) {
      const [conversation, supplier, hash, assigned, alternate] = values as string[];
      const row = rows.find((candidate) => candidate.conversation_id === conversation && candidate.supplier_wid === supplier
        && candidate.document_hash === hash && candidate.assigned_number === assigned && candidate.contested && !candidate.workday_invoice_wid);
      const taken = rows.some((candidate) => candidate.conversation_id === conversation && candidate.supplier_wid === supplier && candidate.assigned_number === alternate);
      if (!row || taken) return [];
      row.assigned_number = alternate;
      row.contested = false;
      return [{ assigned_number: alternate }];
    }
    if (sql.includes('SELECT amount_due')) {
      const [conversation, supplier, assigned] = values as string[];
      return rows.filter((row) => row.conversation_id === conversation && row.supplier_wid === supplier && row.assigned_number === assigned)
        .map((row) => ({ amount_due: row.amount_due }));
    }
    if (sql.includes('document_hash = $3')) {
      const [conversation, supplier, hash] = values as string[];
      return rows.filter((row) => row.conversation_id === conversation && row.supplier_wid === supplier && row.document_hash === hash)
        .map((row) => ({ assigned_number: row.assigned_number, workday_invoice_wid: row.workday_invoice_wid }));
    }
    throw new Error(`Unexpected statement: ${sql}`);
  });
  const db: DatabaseConnection = { query: query as unknown as DatabaseConnection['query'], close: jest.fn<Promise<void>, []>().mockResolvedValue(undefined) };
  return { db, rows, query };
}

describe('reserveGeneratedInvoiceNumber', () => {
  const base = { conversationId: '123', supplierWid: 'supplier-wid' };
  const invoiceDateNumber = 'ABCD031726';
  const serviceDateNumber = 'ABCD031126';
  const candidates = [invoiceDateNumber, serviceDateNumber];
  const hash = (letter: string) => letter.repeat(64);

  it('returns the number an earlier run gave the same document without inserting', async () => {
    const { db, query, rows } = generatedNumbersDb();
    rows.push({ ...base, conversation_id: '123', supplier_wid: 'supplier-wid', assigned_number: 'ABCD031126-2', base_number: invoiceDateNumber, document_hash: hash('a'), amount_due: null, contested: false, workday_invoice_wid: 'invoice-wid' });

    await expect(reserveGeneratedInvoiceNumber(db, { ...base, candidates, documentHash: hash('a') })).resolves.toEqual({
      assignedNumber: 'ABCD031126-2',
      reused: true,
      workdayInvoiceWid: 'invoice-wid',
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('takes the invoice-date number when it is free', async () => {
    const { db, rows } = generatedNumbersDb();

    await expect(reserveGeneratedInvoiceNumber(db, { ...base, candidates, documentHash: hash('a'), amountDue: '$1,350.00' })).resolves.toEqual({
      assignedNumber: invoiceDateNumber,
      reused: false,
      workdayInvoiceWid: null,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ assigned_number: invoiceDateNumber, base_number: invoiceDateNumber, amount_due: '1350.00', contested: false });
  });

  it('gives a sibling with the same invoice date its service-date number and marks the holder contested', async () => {
    const { db, rows } = generatedNumbersDb();
    await reserveGeneratedInvoiceNumber(db, { ...base, candidates, documentHash: hash('a'), amountDue: '$1,350.00' });

    await expect(reserveGeneratedInvoiceNumber(db, { ...base, candidates: [invoiceDateNumber, 'ABCD031226'], documentHash: hash('b'), amountDue: '1350' })).resolves.toEqual({
      assignedNumber: 'ABCD031226',
      reused: false,
      workdayInvoiceWid: null,
      clashedNumber: invoiceDateNumber,
      clashedAmountDue: '1350.00',
    });
    expect(rows.find((row) => row.assigned_number === invoiceDateNumber)?.contested).toBe(true);
  });

  it('walks to the suffixes of the last candidate once both numbers are taken', async () => {
    const { db } = generatedNumbersDb();
    await reserveGeneratedInvoiceNumber(db, { ...base, candidates, documentHash: hash('a') });
    await reserveGeneratedInvoiceNumber(db, { ...base, candidates, documentHash: hash('b') });

    await expect(reserveGeneratedInvoiceNumber(db, { ...base, candidates, documentHash: hash('c'), amountDue: '10' })).resolves.toMatchObject({
      assignedNumber: `${serviceDateNumber}-2`,
      clashedNumber: serviceDateNumber,
    });
    await expect(reserveGeneratedInvoiceNumber(db, { ...base, candidates, documentHash: hash('d') })).resolves.toMatchObject({
      assignedNumber: `${serviceDateNumber}-3`,
    });
  });

  it('suffixes the only candidate when there is no service-date number', async () => {
    const { db } = generatedNumbersDb();
    await reserveGeneratedInvoiceNumber(db, { ...base, candidates: [invoiceDateNumber], documentHash: hash('a') });

    await expect(reserveGeneratedInvoiceNumber(db, { ...base, candidates: [invoiceDateNumber], documentHash: hash('b') })).resolves.toMatchObject({
      assignedNumber: `${invoiceDateNumber}-2`,
      clashedNumber: invoiceDateNumber,
    });
  });

  it('suffixes when the service-date number is another invoice date number in the batch', async () => {
    const { db } = generatedNumbersDb();
    await reserveGeneratedInvoiceNumber(db, { ...base, candidates: [serviceDateNumber], documentHash: hash('a') });

    await expect(reserveGeneratedInvoiceNumber(db, { ...base, candidates: [invoiceDateNumber, serviceDateNumber], documentHash: hash('b') })).resolves.toMatchObject({
      assignedNumber: invoiceDateNumber,
    });
    await expect(reserveGeneratedInvoiceNumber(db, { ...base, candidates: [invoiceDateNumber, serviceDateNumber], documentHash: hash('c') })).resolves.toMatchObject({
      assignedNumber: `${serviceDateNumber}-2`,
    });
  });

  it('keeps the same number when the same document runs again, whatever candidates it now generates', async () => {
    const { db } = generatedNumbersDb();
    await reserveGeneratedInvoiceNumber(db, { ...base, candidates, documentHash: hash('a') });
    const second = await reserveGeneratedInvoiceNumber(db, { ...base, candidates, documentHash: hash('b') });

    await expect(reserveGeneratedInvoiceNumber(db, { ...base, candidates, documentHash: hash('b') })).resolves.toEqual({
      assignedNumber: second.assignedNumber,
      reused: true,
      workdayInvoiceWid: null,
    });
    await expect(reserveGeneratedInvoiceNumber(db, { ...base, candidates: ['ZZZZ010126'], documentHash: hash('a') })).resolves.toMatchObject({
      assignedNumber: invoiceDateNumber,
      reused: true,
    });
  });

  it('keeps conversations and suppliers separate', async () => {
    const { db } = generatedNumbersDb();
    await reserveGeneratedInvoiceNumber(db, { ...base, candidates, documentHash: hash('a') });

    await expect(reserveGeneratedInvoiceNumber(db, { ...base, conversationId: '456', candidates, documentHash: hash('b') })).resolves.toMatchObject({ assignedNumber: invoiceDateNumber });
    await expect(reserveGeneratedInvoiceNumber(db, { ...base, supplierWid: 'other-supplier', candidates, documentHash: hash('c') })).resolves.toMatchObject({ assignedNumber: invoiceDateNumber });
  });

  it('returns the number a parallel run reserved for the same document', async () => {
    const { db, rows } = generatedNumbersDb();
    // The sibling run inserts this document's row between this run's lookup and its insert.
    let lookups = 0;
    const racing: DatabaseConnection = {
      close: db.close,
      query: (async (sql: string, values?: unknown[]) => {
        if (sql.includes('document_hash = $3') && ++lookups === 1) return [];
        if (sql.includes('INSERT INTO') && !rows.length) {
          rows.push({ conversation_id: '123', supplier_wid: 'supplier-wid', assigned_number: invoiceDateNumber, base_number: invoiceDateNumber, document_hash: hash('a'), amount_due: null, contested: false, workday_invoice_wid: null });
        }
        return db.query(sql, values);
      }) as DatabaseConnection['query'],
    };

    await expect(reserveGeneratedInvoiceNumber(racing, { ...base, candidates, documentHash: hash('a') })).resolves.toEqual({
      assignedNumber: invoiceDateNumber,
      reused: true,
      workdayInvoiceWid: null,
    });
  });

  it('gives up instead of looping forever when every suffix is taken', async () => {
    const { db } = generatedNumbersDb();
    await reserveGeneratedInvoiceNumber(db, { ...base, candidates: [invoiceDateNumber], documentHash: hash('0') });
    for (let attempt = 2; attempt <= 50; attempt += 1) {
      await reserveGeneratedInvoiceNumber(db, { ...base, candidates: [invoiceDateNumber], documentHash: String(attempt).padStart(64, '0') });
    }
    await expect(reserveGeneratedInvoiceNumber(db, { ...base, candidates: [invoiceDateNumber], documentHash: hash('z') })).rejects.toThrow('suffixes are taken');
  });

  it('refuses an empty candidate list', async () => {
    const { db } = generatedNumbersDb();
    await expect(reserveGeneratedInvoiceNumber(db, { ...base, candidates: [], documentHash: hash('a') })).rejects.toThrow('no candidate number');
  });
});

describe('settleGeneratedInvoiceNumber', () => {
  const base = { conversationId: '123', supplierWid: 'supplier-wid' };
  const invoiceDateNumber = 'ABCD031726';
  const hash = (letter: string) => letter.repeat(64);
  const settle = (db: DatabaseConnection, documentHash: string, alternateNumber: string) =>
    settleGeneratedInvoiceNumber(db, { ...base, documentHash, assignedNumber: invoiceDateNumber, alternateNumber });

  it('keeps the invoice-date number when no sibling clashed with it', async () => {
    const { db } = generatedNumbersDb();
    await reserveGeneratedInvoiceNumber(db, { ...base, candidates: [invoiceDateNumber, 'ABCD031126'], documentHash: hash('a') });

    await expect(settle(db, hash('a'), 'ABCD031126')).resolves.toEqual({ assignedNumber: invoiceDateNumber, moved: false });
  });

  it('moves the holder to its service-date number once a sibling clashed, freeing the invoice-date number', async () => {
    const { db, rows } = generatedNumbersDb();
    await reserveGeneratedInvoiceNumber(db, { ...base, candidates: [invoiceDateNumber, 'ABCD031126'], documentHash: hash('a') });
    await reserveGeneratedInvoiceNumber(db, { ...base, candidates: [invoiceDateNumber, 'ABCD031226'], documentHash: hash('b') });

    await expect(settle(db, hash('a'), 'ABCD031126')).resolves.toEqual({ assignedNumber: 'ABCD031126', moved: true });
    expect(rows.map((row) => row.assigned_number).sort()).toEqual(['ABCD031126', 'ABCD031226']);
    await expect(reserveGeneratedInvoiceNumber(db, { ...base, candidates: [invoiceDateNumber], documentHash: hash('a') })).resolves.toMatchObject({ assignedNumber: 'ABCD031126', reused: true });
  });

  it('keeps the number when the service-date number is already taken (a copy of the same invoice)', async () => {
    const { db } = generatedNumbersDb();
    await reserveGeneratedInvoiceNumber(db, { ...base, candidates: [invoiceDateNumber, 'ABCD031126'], documentHash: hash('a') });
    await reserveGeneratedInvoiceNumber(db, { ...base, candidates: [invoiceDateNumber, 'ABCD031126'], documentHash: hash('b') });

    await expect(settle(db, hash('a'), 'ABCD031126')).resolves.toEqual({ assignedNumber: invoiceDateNumber, moved: false });
  });

  it('never moves a number an invoice was already created under', async () => {
    const { db, rows } = generatedNumbersDb();
    await reserveGeneratedInvoiceNumber(db, { ...base, candidates: [invoiceDateNumber, 'ABCD031126'], documentHash: hash('a') });
    await reserveGeneratedInvoiceNumber(db, { ...base, candidates: [invoiceDateNumber, 'ABCD031226'], documentHash: hash('b') });
    rows[0].workday_invoice_wid = 'invoice-wid';

    await expect(settle(db, hash('a'), 'ABCD031126')).resolves.toEqual({ assignedNumber: invoiceDateNumber, moved: false });
  });

  it('keeps the number when a sibling takes the alternate between the check and the update', async () => {
    const { db } = generatedNumbersDb();
    const racing: DatabaseConnection = {
      close: db.close,
      query: (async () => { throw Object.assign(new Error('duplicate key'), { code: '23505' }); }) as DatabaseConnection['query'],
    };

    await expect(settle(racing, hash('a'), 'ABCD031126')).resolves.toEqual({ assignedNumber: invoiceDateNumber, moved: false });
  });

  it('does nothing when the alternate is the number already held', async () => {
    const { db, query } = generatedNumbersDb();
    await expect(settleGeneratedInvoiceNumber(db, { ...base, documentHash: hash('a'), assignedNumber: invoiceDateNumber, alternateNumber: invoiceDateNumber }))
      .resolves.toEqual({ assignedNumber: invoiceDateNumber, moved: false });
    expect(query).not.toHaveBeenCalled();
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

describe('generated number amount and other-supplier lookups', () => {
  const params = { documentHash: 'h'.repeat(64) };

  it('normalizes printed amounts and ignores unreadable ones', () => {
    expect(generatedNumberAmountKey('$1,350.00')).toBe('1350.00');
    expect(generatedNumberAmountKey('1350')).toBe('1350.00');
    expect(generatedNumberAmountKey('see invoice')).toBeNull();
    expect(generatedNumberAmountKey(null)).toBeNull();
  });

  it('finds invoices an earlier run created from the document under another supplier', async () => {
    const { db, query } = mockDb([{ supplier_wid: 'default-supplier', assigned_number: 'ABCD031126', workday_invoice_wid: 'invoice-wid' }]);

    await expect(findGeneratedInvoicesForDocument(db, { conversationId: '123', supplierWid: 'supplier-wid', documentHash: params.documentHash }))
      .resolves.toEqual([{ supplierWid: 'default-supplier', assignedNumber: 'ABCD031126', workdayInvoiceWid: 'invoice-wid' }]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('supplier_wid <> $3'), ['123', params.documentHash, 'supplier-wid']);
  });
});
