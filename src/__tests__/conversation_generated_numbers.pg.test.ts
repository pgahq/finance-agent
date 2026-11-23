/**
 * Runs the generated-invoice-number reservation against a real Postgres. Skipped unless GENERATED_NUMBERS_PG_URL is set, for example:
 * GENERATED_NUMBERS_PG_URL=postgres://postgres:postgres@localhost:5432/gen_nums npx jest conversation_generated_numbers.pg
 */
import { Pool } from 'pg';
import { CREATE_CONVERSATION_GENERATED_INVOICE_NUMBERS_TABLE, type DatabaseConnection } from '../lib/database.js';
import { findGeneratedInvoicesForDocument, recordGeneratedInvoiceNumberInvoice, reserveGeneratedInvoiceNumber, settleGeneratedInvoiceNumber } from '../lib/conversation_invoices.js';

const url = process.env.GENERATED_NUMBERS_PG_URL;
const describeWithPostgres = url ? describe : describe.skip;

describeWithPostgres('generated invoice number reservation (Postgres)', () => {
  let pool: Pool;
  let db: DatabaseConnection;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    db = {
      query: async (sql: string, params?: unknown[]) => (await pool.query(sql, params)).rows,
      close: async () => undefined,
    } as DatabaseConnection;
    await pool.query(CREATE_CONVERSATION_GENERATED_INVOICE_NUMBERS_TABLE);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE conversation_generated_invoice_numbers');
  });

  afterAll(async () => {
    await pool.end();
  });

  const reserve = (documentHash: string, overrides: Partial<{ conversationId: string; supplierWid: string; candidates: string[]; amountDue: string }> = {}) =>
    reserveGeneratedInvoiceNumber(db, {
      conversationId: 'conv-1',
      supplierWid: 'supplier-1',
      candidates: ['ABCD031126'],
      documentHash: documentHash.padEnd(64, '0'),
      ...overrides,
    });

  it('gives parallel siblings with the same number distinct numbers', async () => {
    const results = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((hash) => reserve(hash)));
    expect(results.map((result) => result.assignedNumber).sort())
      .toEqual(['ABCD031126', 'ABCD031126-2', 'ABCD031126-3', 'ABCD031126-4', 'ABCD031126-5']);
    expect(results.every((result) => !result.reused)).toBe(true);
  });

  it('gives parallel same-date siblings one invoice-date number and service-date numbers, then settles the holder', async () => {
    const days = ['11', '12', '13', '14', '15'];
    const results = await Promise.all(days.map((day, index) => reserve('abcde'[index], { candidates: ['ABCD031726', `ABCD03${day}26`] })));
    const holderIndex = results.findIndex((result) => result.assignedNumber === 'ABCD031726');
    expect(holderIndex).toBeGreaterThanOrEqual(0);
    expect(results.filter((result) => result.assignedNumber === 'ABCD031726')).toHaveLength(1);

    const settled = await settleGeneratedInvoiceNumber(db, {
      conversationId: 'conv-1',
      supplierWid: 'supplier-1',
      documentHash: 'abcde'[holderIndex].padEnd(64, '0'),
      assignedNumber: 'ABCD031726',
      alternateNumber: `ABCD03${days[holderIndex]}26`,
    });
    expect(settled).toEqual({ assignedNumber: `ABCD03${days[holderIndex]}26`, moved: true, sameAmountSibling: false });
    const rows = await pool.query('SELECT assigned_number FROM conversation_generated_invoice_numbers ORDER BY assigned_number');
    expect(rows.rows.map((row) => row.assigned_number)).toEqual(days.map((day) => `ABCD03${day}26`));
  });

  it('tells a settled holder whether a sibling that generated the same number has the same amount due', async () => {
    await reserve('a', { candidates: ['ABCD031726', 'ABCD031126'], amountDue: '$1,350.00' });
    await reserve('b', { candidates: ['ABCD031726', 'ABCD031226'], amountDue: '1350' });

    const settled = await settleGeneratedInvoiceNumber(db, {
      conversationId: 'conv-1',
      supplierWid: 'supplier-1',
      documentHash: 'a'.padEnd(64, '0'),
      assignedNumber: 'ABCD031726',
      alternateNumber: 'ABCD031126',
      amountDue: '$1,350.00',
    });
    expect(settled).toEqual({ assignedNumber: 'ABCD031126', moved: true, sameAmountSibling: true });
  });

  it('returns the same number for the same document, even when this run generated other candidates', async () => {
    await reserve('a');
    const second = await reserve('b');
    expect(second.assignedNumber).toBe('ABCD031126-2');

    const again = await reserve('b', { candidates: ['ABCD031726', 'ABCD031126'] });
    expect(again).toMatchObject({ assignedNumber: 'ABCD031126-2', reused: true, workdayInvoiceWid: null, clashedNumber: 'ABCD031126', suffixed: true });
  });

  it('returns the amount due of the clashed holder when a sibling is suffixed', async () => {
    await reserve('a', { amountDue: '$1,350.00' });
    const second = await reserve('b', { amountDue: '$1,350.00' });
    expect(second).toMatchObject({ assignedNumber: 'ABCD031126-2', clashedNumber: 'ABCD031126', clashedAmountDue: '1350.00' });
  });

  it('finds the document under another supplier only once an invoice is recorded for it', async () => {
    const first = await reserve('a', { supplierWid: 'default-supplier' });
    const lookup = () => findGeneratedInvoicesForDocument(db, { conversationId: 'conv-1', supplierWid: 'supplier-1', documentHash: 'a'.padEnd(64, '0') });
    await expect(lookup()).resolves.toEqual([]);

    await recordGeneratedInvoiceNumberInvoice(db, {
      conversationId: 'conv-1', supplierWid: 'default-supplier', assignedNumber: first.assignedNumber, workdayInvoiceWid: 'invoice-wid',
    });
    await expect(lookup()).resolves.toEqual([
      { supplierWid: 'default-supplier', assignedNumber: 'ABCD031126', workdayInvoiceWid: 'invoice-wid' },
    ]);
  });

  it('reserves one number when the same document arrives in parallel', async () => {
    const results = await Promise.all([reserve('a'), reserve('a'), reserve('a')]);
    expect(new Set(results.map((result) => result.assignedNumber)).size).toBe(1);
    const rows = await pool.query('SELECT * FROM conversation_generated_invoice_numbers');
    expect(rows.rows).toHaveLength(1);
  });

  it('keeps conversations and suppliers separate', async () => {
    await reserve('a');
    expect((await reserve('b', { conversationId: 'conv-2' })).assignedNumber).toBe('ABCD031126');
    expect((await reserve('c', { supplierWid: 'supplier-2' })).assignedNumber).toBe('ABCD031126');
  });

  it('records the Workday invoice and returns it on the next reservation', async () => {
    const first = await reserve('a');
    await recordGeneratedInvoiceNumberInvoice(db, {
      conversationId: 'conv-1',
      supplierWid: 'supplier-1',
      assignedNumber: first.assignedNumber,
      workdayInvoiceWid: 'invoice-wid',
    });
    expect(await reserve('a')).toEqual({ assignedNumber: 'ABCD031126', reused: true, workdayInvoiceWid: 'invoice-wid' });
  });
});
