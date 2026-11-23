/**
 * Runs the generated-invoice-number reservation against a real Postgres. Skipped unless GENERATED_NUMBERS_PG_URL is set, for example:
 * GENERATED_NUMBERS_PG_URL=postgres://postgres:postgres@localhost:5432/gen_nums npx jest conversation_generated_numbers.pg
 */
import { Pool } from 'pg';
import { CREATE_CONVERSATION_GENERATED_INVOICE_NUMBERS_TABLE, type DatabaseConnection } from '../lib/database.js';
import { recordGeneratedInvoiceNumberInvoice, reserveGeneratedInvoiceNumber } from '../lib/conversation_invoices.js';

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

  const reserve = (documentHash: string, overrides: Partial<{ conversationId: string; supplierWid: string; baseNumber: string }> = {}) =>
    reserveGeneratedInvoiceNumber(db, {
      conversationId: 'conv-1',
      supplierWid: 'supplier-1',
      baseNumber: 'ABCD031126',
      documentHash: documentHash.padEnd(64, '0'),
      ...overrides,
    });

  it('gives parallel siblings with the same base distinct numbers', async () => {
    const results = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((hash) => reserve(hash)));
    expect(results.map((result) => result.assignedNumber).sort())
      .toEqual(['ABCD031126', 'ABCD031126-2', 'ABCD031126-3', 'ABCD031126-4', 'ABCD031126-5']);
    expect(results.every((result) => !result.reused)).toBe(true);
  });

  it('returns the same number for the same document, even when this run generated another base', async () => {
    await reserve('a');
    const second = await reserve('b');
    expect(second.assignedNumber).toBe('ABCD031126-2');

    const again = await reserve('b', { baseNumber: 'ABCD031726' });
    expect(again).toEqual({ assignedNumber: 'ABCD031126-2', reused: true, workdayInvoiceWid: null });
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
