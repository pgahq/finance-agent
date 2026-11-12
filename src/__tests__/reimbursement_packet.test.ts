jest.mock('@pga/logger', () => ({ debug: jest.fn() }));
jest.mock('../lib/database.js', () => ({
  findDocumentsContainingWords: jest.fn(),
  findSuppliersByNameWord: jest.fn(),
}));
jest.mock('../lib/ai.js', () => ({ getAiResponse: jest.fn() }));
jest.mock('../lib/models.js', () => ({
  ...jest.requireActual('../lib/models.js'),
  getOcrModel: jest.fn(() => 'ocr-model'),
}));
jest.mock('../lib/invoice_ocr.js', () => ({
  convertOfficeAttachmentsForModel: jest.fn(async (attachments: unknown[]) => attachments),
  attachmentContentParts: jest.fn(() => [{ type: 'file', data: 'pdf', mediaType: 'application/pdf' }]),
}));

import { findDocumentsContainingWords } from '../lib/database.js';
import { getAiResponse } from '../lib/ai.js';
import { reimbursementFormMathPrompt, type ReimbursementFormMath } from '../prompts/reimbursement_packet_prompt.js';
import { defaultModel } from '../lib/models.js';
import { attachmentContentParts } from '../lib/invoice_ocr.js';
import { parseCanonicalChargeAmount } from '../lib/invoice_lines.js';
import {
  applyReimbursementToEnrichment,
  decideReimbursement,
  formMathResult,
  hasReimbursementSignal,
  packetDisagreement,
  parseFormAmountToPay,
  readReimbursementPacket,
  reimbursementDescription,
  reimbursementNote,
  reimbursementOcr,
  reimbursementSlackLines,
  type AppliedReimbursement,
  type FormMathSummary,
  type ReimbursementPacket,
} from '../lib/reimbursement_packet.js';

const findDocuments = findDocumentsContainingWords as jest.Mock;
const aiResponse = getAiResponse as jest.Mock;

const payeeDocument = {
  workday_id: 'wid-ellery',
  content: 'Company Name: MORGAN T ELLERY\nSupplier ID: S-000123\nStatus: Active',
  metadata: { supplierName: 'MORGAN T ELLERY', supplierId: 'S-000123' },
};

const packet = (overrides: Partial<ReimbursementPacket> = {}): ReimbursementPacket => ({
  kind: 'reimbursement',
  confidence: 0.95,
  payeeName: 'MORGAN T ELLERY',
  payeeSupplierId: null,
  formAmountToPay: '$1,000.00',
  formAmountLabel: 'Amount to Pay',
  emailAmount: null,
  emailAmountIsCap: null,
  formDate: '11/02/2026',
  expenseKind: 'hotel',
  purpose: '2026 Sample Marathon Team',
  evidence: ['Expense Reimbursement Form', 'Amount to Pay $1,000.00'],
  ...overrides,
});

const db = { query: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
  findDocuments.mockResolvedValue([payeeDocument]);
  db.query.mockResolvedValue([]);
});

describe('hasReimbursementSignal', () => {
  it('fires on reimbursement wording in the subject, body, or file names', () => {
    expect(hasReimbursementSignal({ subject: 'Hotel reimbursement for Morgan' } as never, [])).toBe(true);
    expect(hasReimbursementSignal({ plainTextBody: 'Please pay the Amount to Pay on the form' } as never, [])).toBe(true);
    expect(hasReimbursementSignal(undefined, ['Expense Reimbursement Form.pdf'])).toBe(true);
  });

  it('does not fire on reimbursable expenses printed on a supplier invoice', () => {
    expect(hasReimbursementSignal({ plainTextBody: 'Reimbursable expenses are itemized on the invoice.' } as never, [])).toBe(false);
  });

  it('does not fire on an ordinary invoice email', () => {
    expect(hasReimbursementSignal({ subject: 'Invoice 1234', plainTextBody: 'Attached is our invoice.' } as never, ['invoice.pdf'])).toBe(false);
  });
});

describe('readReimbursementPacket', () => {
  const attachments = [{ fileName: 'packet.pdf', contentType: 'application/pdf' }] as never;

  it('skips the model read when nothing mentions reimbursement', async () => {
    const read = await readReimbursementPacket(attachments, { subject: 'Invoice', plainTextBody: 'Attached' } as never);
    expect(read).toBeUndefined();
    expect(aiResponse).not.toHaveBeenCalled();
  });

  it('skips the model read when no document can be read', async () => {
    (attachmentContentParts as jest.Mock).mockReturnValueOnce([]);
    const read = await readReimbursementPacket(attachments, { subject: 'Reimbursement' } as never);
    expect(read).toBeUndefined();
    expect(aiResponse).not.toHaveBeenCalled();
  });

  it('returns the packet the model read', async () => {
    aiResponse.mockResolvedValue(packet());
    const read = await readReimbursementPacket(attachments, { subject: 'Hotel reimbursement' } as never);
    expect(read?.formAmountToPay).toBe('$1,000.00');
    expect(aiResponse.mock.calls[0][0].messages[0].content[0].text).toContain('Subject: Hotel reimbursement');
  });

  it('throws on an unexpected shape so a packet is never silently booked as an invoice', async () => {
    aiResponse.mockResolvedValue({ kind: 'maybe' });
    await expect(readReimbursementPacket(attachments, { subject: 'Reimbursement' } as never))
      .rejects.toThrow('unexpected shape');
    expect(aiResponse).toHaveBeenCalledTimes(2);
  });

  it('retries a failed read once before giving up', async () => {
    aiResponse.mockReset().mockRejectedValueOnce(new Error('gateway timeout')).mockResolvedValue(packet());
    const read = await readReimbursementPacket(attachments, { subject: 'Reimbursement' } as never);
    expect(read?.kind).toBe('reimbursement');
    expect(aiResponse).toHaveBeenCalledTimes(3);
  });

  it('throws the last failure when both attempts fail', async () => {
    aiResponse.mockReset().mockRejectedValue(new Error('gateway timeout'));
    await expect(readReimbursementPacket(attachments, { subject: 'Reimbursement' } as never))
      .rejects.toThrow('gateway timeout');
  });

  it('reads a reimbursement a second time and confirms it when the reads agree', async () => {
    aiResponse.mockReset().mockResolvedValue(packet());
    const read = await readReimbursementPacket(attachments, { subject: 'Reimbursement' } as never);
    expect(aiResponse).toHaveBeenCalledTimes(2);
    expect(read).not.toHaveProperty('unconfirmed');
    expect(aiResponse.mock.calls[0][0]).not.toHaveProperty('model');
    expect(aiResponse.mock.calls[1][0]).toMatchObject({ model: expect.anything(), temperature: null });
  });

  it('marks the read unconfirmed when the second read picks a different amount', async () => {
    aiResponse.mockReset()
      .mockResolvedValueOnce(packet())
      .mockResolvedValueOnce(packet({ formAmountToPay: '$1,100.00' }));
    const read = await readReimbursementPacket(attachments, { subject: 'Reimbursement' } as never);
    expect(read?.unconfirmed).toBe("the form's Amount to Pay");
  });

  it('confirms a packet whose first read has a parenthesized, padded form amount and whose second read is plain', async () => {
    const email = { emailAmount: '$1,335.93', emailAmountIsCap: false };
    aiResponse.mockReset()
      .mockResolvedValueOnce(packet({ ...email, formAmountToPay: paddedParenthesized }))
      .mockResolvedValueOnce(packet({ ...email, formAmountToPay: '$1,335.93' }));
    const read = await readReimbursementPacket(attachments, { subject: 'Reimbursement' } as never);
    expect(read).not.toHaveProperty('unconfirmed');
    expect(await decideReimbursement(db as never, read)).toMatchObject({ outcome: 'apply', reimbursement: { amount: 1335.93 } });
  });

  it('marks the read unconfirmed when the second read says it is not a reimbursement', async () => {
    aiResponse.mockReset()
      .mockResolvedValueOnce(packet())
      .mockResolvedValueOnce(packet({ kind: 'supplier_invoice' }));
    const read = await readReimbursementPacket(attachments, { subject: 'Reimbursement' } as never);
    expect(read?.unconfirmed).toBe('whether it is a reimbursement');
  });

  it('does not read a supplier invoice a second time', async () => {
    aiResponse.mockReset().mockResolvedValue(packet({ kind: 'supplier_invoice' }));
    const read = await readReimbursementPacket(attachments, { subject: 'Reimbursement' } as never);
    expect(read?.kind).toBe('supplier_invoice');
    expect(aiResponse).toHaveBeenCalledTimes(1);
  });
});

// The Dustin Hull packet (2026-11-12): the form field extracted as an accounting-format string while the page shows
// no parentheses, and the other read returned the plain amount.
const paddedParenthesized = `($${' '.repeat(70)}1,335.93)`;

describe('parseFormAmountToPay', () => {
  it('reads padded and parenthesized form amounts as the plain positive amount', () => {
    expect(parseFormAmountToPay(paddedParenthesized)).toBe(1335.93);
    expect(parseFormAmountToPay(`$${' '.repeat(70)}1,335.93`)).toBe(1335.93);
    expect(parseFormAmountToPay('($1,335.93)')).toBe(1335.93);
    expect(parseFormAmountToPay(' ( 1,335.93 ) ')).toBe(1335.93);
    expect(parseFormAmountToPay('$1,335.93')).toBe(1335.93);
    expect(parseFormAmountToPay('1,335.93 USD')).toBe(1335.93);
  });

  it('still rejects negatives, unbalanced or nested parentheses, split digits, and text', () => {
    for (const value of [
      '-$50.00', '($-50.00)', '(−$50.00)', '(1,335.93', '1,335.93)', '(($1,335.93))', '$1 335.93', '1, 335.93', '1 ,335.93',
      '$1 . 335.93', '()', 'see attached', '',
    ]) {
      expect(parseFormAmountToPay(value)).toBeUndefined();
    }
    expect(parseFormAmountToPay(null)).toBeUndefined();
  });

  it('leaves the shared parser strict, so a parenthesized supplier-invoice amount is still not read as positive', () => {
    expect(parseCanonicalChargeAmount('($1,335.93)')).toBeUndefined();
    expect(parseCanonicalChargeAmount('$(1,335.93)')).toBeUndefined();
  });
});

describe('packetDisagreement', () => {
  it('does not flag the form amount read with parentheses and padding against the plain amount', () => {
    const plain = packet({ formAmountToPay: '$1,335.93', emailAmount: '$1,335.93', emailAmountIsCap: false });
    const accounting = packet({ formAmountToPay: paddedParenthesized, emailAmount: '$1,335.93', emailAmountIsCap: false });
    expect(packetDisagreement(accounting, plain)).toBeUndefined();
    expect(packetDisagreement(plain, accounting)).toBeUndefined();
    expect(packetDisagreement(accounting, packet({ formAmountToPay: '$1,335.94', emailAmount: '$1,335.93', emailAmountIsCap: false })))
      .toBe("the form's Amount to Pay");
  });

  it('does not read parentheses as positive on the email amount', () => {
    expect(packetDisagreement(packet({ emailAmount: '($900.00)' }), packet({ emailAmount: '$900.00' }))).toBe("the email's amount");
  });

  it('ignores case and punctuation in names and the formatting of amounts', () => {
    expect(packetDisagreement(
      packet(),
      packet({ payeeName: 'Morgan T. Ellery', formAmountToPay: '1000', payeeSupplierId: null }),
    )).toBeUndefined();
  });

  it('treats a missing middle initial as the same person, but not a dropped name or a different one', () => {
    expect(packetDisagreement(packet({ payeeName: 'Morgan Ellery' }), packet({ payeeName: 'MORGAN T ELLERY' }))).toBeUndefined();
    expect(packetDisagreement(packet({ payeeName: 'Jane Doe' }), packet({ payeeName: 'Jane Doe Smith' }))).toBe('the payee');
    expect(packetDisagreement(packet({ payeeName: 'Morgan Ellery' }), packet({ payeeName: 'Morgan Ellory' }))).toBe('the payee');
  });

  it('flags a different form date, including the same date in another format only when it differs', () => {
    expect(packetDisagreement(packet({ formDate: '11/02/2026' }), packet({ formDate: 'Nov 2, 2026' }))).toBeUndefined();
    expect(packetDisagreement(packet({ formDate: '11/02/2026' }), packet({ formDate: '11/03/2026' }))).toBe('the form date');
    expect(packetDisagreement(packet({ formDate: '11/02/2026' }), packet({ formDate: null }))).toBe('the form date');
  });

  it('flags a different reading of whether the email amount is a limit', () => {
    const exact = packet({ emailAmount: '$1,000.00', emailAmountIsCap: false });
    expect(packetDisagreement(exact, packet({ emailAmount: '$1,000.00', emailAmountIsCap: true })))
      .toBe("whether the email's amount is a limit");
    expect(packetDisagreement(packet(), packet({ emailAmountIsCap: true }))).toBeUndefined();
  });

  it('flags a different payee, Supplier ID, or email amount', () => {
    expect(packetDisagreement(packet(), packet({ payeeName: 'Jordan Ellery' }))).toBe('the payee');
    expect(packetDisagreement(packet(), packet({ payeeSupplierId: 'S-000123' }))).toBe('the payee Supplier ID');
    expect(packetDisagreement(packet(), packet({ emailAmount: '$900.00' }))).toBe("the email's amount");
  });
});

// A grid-style expense form (fictional): categories run across as columns, line items run down as rows, and the
// TOTALS row prints each column total and the grand total. The look copies it; the code does the adding.
const gridLook = (overrides: Partial<ReimbursementFormMath> = {}): ReimbursementFormMath => ({
  grandTotal: '$1,500.30',
  grandTotalLabel: 'TOTALS',
  columns: [
    { label: 'Airfare', total: '$0.00', entries: [] },
    { label: 'Ground', total: '$310.40', entries: ['$0.00', '$95.10', '$80.00', '$135.30'] },
    { label: 'Hotel', total: '$1,150.20', entries: ['$1,150.20', '$0.00'] },
    { label: 'Meals', total: '$39.70', entries: ['$0.00', '$39.70'] },
  ],
  ...overrides,
});
const withColumn = (label: string, overrides: Partial<ReimbursementFormMath['columns'][number]>) =>
  gridLook({ columns: gridLook().columns.map((column) => (column.label === label ? { ...column, ...overrides } : column)) });

const totalsPacket = (overrides: Partial<ReimbursementPacket> = {}) =>
  packet({ formAmountToPay: '$1,500.30', formAmountLabel: 'TOTALS', purpose: '2026 Sample Annual Meeting', expenseKind: 'hotel', ...overrides });
const missingTotalPacket = (overrides: Partial<ReimbursementPacket> = {}) =>
  totalsPacket({ formAmountToPay: null, formAmountLabel: null, ...overrides });
// One read cites a label that is not on the form and a total the form does not print.
const inventedPacket = (overrides: Partial<ReimbursementPacket> = {}) =>
  totalsPacket({ formAmountToPay: '$171.25', formAmountLabel: 'TOTAL AMT DUE TO PAYEE', evidence: ['TOTAL AMT DUE TO PAYEE $171.25'], ...overrides });
const otherPacket = (overrides: Partial<ReimbursementPacket> = {}) => totalsPacket({ formAmountToPay: '$1,520.85', ...overrides });

describe('formMathResult', () => {
  it('accepts a total whose column totals and line items add up in cents', () => {
    expect(formMathResult(gridLook())).toEqual({
      total: 1500.3,
      totalText: '$1,500.30',
      summary: {
        label: 'TOTALS',
        columns: [
          { label: 'Airfare', total: '$0.00' },
          { label: 'Ground', total: '$310.40' },
          { label: 'Hotel', total: '$1,150.20' },
          { label: 'Meals', total: '$39.70' },
        ],
      },
    });
    expect(formMathResult(gridLook({ grandTotal: '($   1,500.30)' }))).toMatchObject({ total: 1500.3 });
    expect(formMathResult({
      grandTotal: '$0.30',
      grandTotalLabel: 'TOTALS',
      columns: [{ label: 'a', total: '$0.30', entries: ['$0.10', '$0.20'] }],
    })).toMatchObject({ total: 0.3 });
  });

  it('accepts a form with one amount per category', () => {
    expect(formMathResult({
      grandTotal: '$1,403.95',
      grandTotalLabel: 'TOTALS',
      columns: [
        { label: 'SC - ground transportation', total: '$440.80', entries: ['$440.80'] },
        { label: 'SC-Lodging', total: '$963.15', entries: ['$963.15'] },
      ],
    })).toMatchObject({ total: 1403.95 });
  });

  it.each(['TOTALS', 'Total:', 'Sum of All Columns', 'TOTALS - Sum of All Columns', 'Grand Total', 'Amount to Pay', 'Total Reimbursement', 'Total to be reimbursed'])(
    'accepts "%s" as the label of the form total', (grandTotalLabel) => {
      expect(formMathResult(gridLook({ grandTotalLabel }))).toMatchObject({ total: 1500.3 });
    });

  it.each([
    'TOTAL AMT DUE TO PAYEE', 'Subtotal', 'Total Lodging', 'Hotel', 'Reimbursable expenses',
    'Not a total reimbursement', 'Total Reimbursement estimate', 'Hotel total / Sum of All Columns', 'Sum of All Columns excluding meals',
  ])(
    'rejects "%s" as the label of the form total', (grandTotalLabel) => {
      expect(formMathResult(gridLook({ grandTotalLabel }))).toEqual({
        failure: `the form total was read beside "${grandTotalLabel}", which is not a payable-total label`,
      });
    });

  it('says when the form shows no total, so a packet with none can stop as one that prints no Amount to Pay', () => {
    expect(formMathResult(gridLook({ grandTotal: null, grandTotalLabel: null }))).toEqual({ failure: 'the form shows no total to check', noTotal: true });
    expect(formMathResult(gridLook({ grandTotal: '  ' }))).toMatchObject({ noTotal: true });
  });

  it.each([
    ['a total that is not a dollar amount', gridLook({ grandTotal: 'see receipts' }), "the form's total could not be read as a dollar amount"],
    ['a negative total', gridLook({ grandTotal: '-$5.00' }), "the form's total could not be read as a dollar amount"],
    ['a zero total', gridLook({ grandTotal: '$0.00' }), "the form's total is zero"],
    ['no label for the total', gridLook({ grandTotalLabel: null }), 'no label was read for the form total'],
    ['no columns', gridLook({ columns: [] }), 'the form lists no expense columns to check the total against'],
    ['a column with no label', withColumn('Meals', { label: ' ' }), 'a column has no label'],
    ['a column with no total', withColumn('Meals', { total: null }), 'the column "Meals" has no printed total'],
    ['a column total that cannot be read', withColumn('Meals', { total: 'n/a' }), 'the total of column "Meals" could not be read as a dollar amount'],
    ['a credit in parentheses', withColumn('Meals', { entries: ['$0.00', '($39.70)'] }), 'an amount in column "Meals" could not be read as a dollar amount'],
    ['a mileage count among the entries', withColumn('Ground', { entries: ['$0.00', '$95.10', '$80.00', '$135.30', '83.5 mi'] }), 'an amount in column "Ground" could not be read as a dollar amount'],
    ['line items that do not add up', withColumn('Ground', { entries: ['$0.00', '$95.10', '$80.00', '$35.30'] }), 'the line items in column "Ground" do not add up to its total'],
    ['a column left empty that has a total', withColumn('Meals', { entries: [] }), 'the line items in column "Meals" do not add up to its total'],
    ['column totals that do not add up to the total', gridLook({ grandTotal: '$1,520.85' }), 'the column totals do not add up to the form total'],
    ['a column missing from the list', gridLook({ columns: gridLook().columns.filter((column) => column.label !== 'Meals') }), 'the column totals do not add up to the form total'],
  ])('rejects %s', (_name, look, failure) => {
    expect(formMathResult(look)).toEqual({ failure });
  });

  it.each(['TOTALS', 'Sum of All Columns', 'Subtotal', 'Amount to Pay'])(
    'rejects the aggregate "%s" listed as a column, even when it makes the columns add up', (label) => {
      const look = gridLook({
        columns: [...gridLook().columns.filter((column) => column.label === 'Airfare'), { label, total: '$1,500.30', entries: ['$1,500.30'] }],
      });
      expect(formMathResult(look)).toEqual({ failure: `the column "${label}" is a total, not an expense category` });
    });

  it('rejects a column listed twice, even when the duplicate makes the columns add up', () => {
    const look = gridLook({
      columns: [
        { label: 'Hotel', total: '$750.15', entries: ['$750.15'] },
        { label: 'hotel ', total: '$750.15', entries: ['$750.15'] },
      ],
      grandTotal: '$1,500.30',
    });
    expect(formMathResult(look)).toEqual({ failure: 'the column "hotel" is listed more than once' });
  });

  it('rejects, rather than trims, a look with more columns, line items, or text than a form holds', () => {
    const oversized = { failure: 'the look returned more columns, line items, or text than a form holds' };
    const column = (index: number) => ({ label: `Category ${index}`, total: '$0.00', entries: [] });
    expect(formMathResult(gridLook({ columns: Array.from({ length: 13 }, (_value, index) => column(index)) }))).toEqual(oversized);
    expect(formMathResult(withColumn('Meals', { entries: Array.from({ length: 61 }, () => '$0.00') }))).toEqual(oversized);
    expect(formMathResult(withColumn('Meals', { label: 'M'.repeat(81) }))).toEqual(oversized);
    expect(formMathResult(gridLook({ grandTotalLabel: `TOTALS${' '.repeat(80)}` }))).toEqual(oversized);
    expect(formMathResult(withColumn('Meals', { label: 'M'.repeat(80), entries: ['$0.00', '$39.70'] }))).toMatchObject({ total: 1500.3 });
  });

  it('keeps control characters and newlines out of the labels that reach the note and the alert', () => {
    const noisy = withColumn('Meals', { label: 'Meals\n\u0007 | <b>and tips' });
    const result = formMathResult(gridLook({ grandTotalLabel: 'TOTALS\u0000', columns: noisy.columns }));
    expect(result).toMatchObject({ summary: { label: 'TOTALS' } });
    expect((result as { summary: FormMathSummary }).summary.columns.map((column) => column.label)).toContain('Meals | <b>and tips');
    expect(formMathResult(withColumn('Meals', { label: 'Meals\nTOTALS', total: 'n/a' }))).toEqual({
      failure: 'the column "Meals TOTALS" is a total, not an expense category',
    });
  });

  it('never puts an amount in a failure reason, because the reason reaches the Slack alert', () => {
    const failures = [
      gridLook({ grandTotal: '$1,520.85' }),
      withColumn('Ground', { entries: ['$1.00'] }),
      gridLook({ grandTotal: '$9,999.99', grandTotalLabel: 'Hotel' }),
    ].map((look) => (formMathResult(look) as { failure: string }).failure);
    for (const failure of failures) expect(failure).not.toMatch(/\d/);
  });
});

// A different table that also adds up, as a model builds from receipts when it cannot read the form.
const otherGridLook = (): ReimbursementFormMath => gridLook({
  grandTotal: '$188.55',
  columns: [
    { label: 'Ground', total: '$169.30', entries: ['$12.00', '$60.25', '$55.05', '$42.00'] },
    { label: 'Meals', total: '$19.25', entries: ['$19.25'] },
  ],
});
const noTotalLook = (): ReimbursementFormMath => gridLook({ grandTotal: null, grandTotalLabel: null, columns: [] });
const brokenLook = (): ReimbursementFormMath => withColumn('Ground', { entries: ['$0.00', '$95.10', '$80.00'] });

describe('a total the reads did not both give', () => {
  const attachments = [{ fileName: 'packet.pdf', contentType: 'application/pdf' }] as never;
  const email = { subject: 'Expense report' } as never;
  const read = () => readReimbursementPacket(attachments, email);
  // The packet reads and the form looks are answered from separate queues, so parallel looks cannot swap answers.
  const script = (packetReads: unknown[], looks: unknown[] = []) => {
    aiResponse.mockReset().mockImplementation(async ({ prompt }: { prompt: string }) => {
      const next = (prompt === reimbursementFormMathPrompt ? looks : packetReads).shift();
      if (next instanceof Error) throw next;
      return next;
    });
  };
  const lookCalls = () => aiResponse.mock.calls.map((call) => call[0] as { prompt: string; model?: unknown; temperature?: unknown; messages: { content: { text?: string }[] }[] })
    .filter((call) => call.prompt === reimbursementFormMathPrompt);

  it('books the form total the arithmetic confirms when both reads got it wrong (invented label and a different total)', async () => {
    script([inventedPacket(), otherPacket()], [gridLook(), gridLook()]);
    const result = await read();
    expect(aiResponse).toHaveBeenCalledTimes(4);
    expect(result).not.toHaveProperty('unconfirmed');
    expect(result?.formAmountToPay).toBe('$1,500.30');
    const decision = await decideReimbursement(db as never, result);
    expect(decision).toMatchObject({ outcome: 'apply', reimbursement: { amount: 1500.3, amountLabel: '$1,500.30' } });
    expect(JSON.stringify(decision)).not.toMatch(/171\.25|1,520\.85/);
  });

  it('looks only on the document-reading model, with the documents and no email text', async () => {
    script([inventedPacket(), otherPacket()], [gridLook(), gridLook()]);
    await read();
    const calls = lookCalls();
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.model).toBe('ocr-model');
      expect(call.temperature).toBeNull();
      expect(call.messages[0].content[0].text).not.toContain('Subject:');
    }
    expect(aiResponse.mock.calls.map((call) => call[0].model)).not.toContain(defaultModel);
  });

  it.each([
    ['the first read found none', [missingTotalPacket(), totalsPacket()]],
    ['the second read found none', [totalsPacket(), missingTotalPacket()]],
    ['neither read found one', [missingTotalPacket(), missingTotalPacket()]],
    ['both reads found the same zero', [totalsPacket({ formAmountToPay: '$0.00' }), totalsPacket({ formAmountToPay: '$0.00' })]],
    ['both reads found the same unreadable figure', [totalsPacket({ formAmountToPay: 'TBD' }), totalsPacket({ formAmountToPay: 'TBD' })]],
  ])('checks the form arithmetic when %s', async (_name, pair) => {
    script(pair, [gridLook(), gridLook()]);
    const result = await read();
    expect(result).toMatchObject({ formAmountToPay: '$1,500.30', confirmedByFormMath: { label: 'TOTALS' } });
    expect(result).not.toHaveProperty('unconfirmed');
  });

  it('takes no look when both reads found the same readable total', async () => {
    script([totalsPacket(), totalsPacket({ formAmountToPay: '1500.30' })]);
    const result = await read();
    expect(aiResponse).toHaveBeenCalledTimes(2);
    expect(result).not.toHaveProperty('confirmedByFormMath');
    expect(result).not.toHaveProperty('unconfirmed');
  });

  it('takes no look when the reads also disagree on another fact, and hides the total they did not agree on', async () => {
    script([inventedPacket(), otherPacket({ payeeName: 'JORDAN P REYES' })]);
    const result = await read();
    expect(aiResponse).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ unconfirmed: 'the payee', notConfirmed: ['payeeName', 'formAmount'] });
    const decision = await decideReimbursement(db as never, result);
    expect(decision).toEqual({
      outcome: 'manual_entry',
      manual: { reason: 'two reads of the packet disagreed on the payee', notConfirmed: ['payeeName', 'formAmount'] },
    });
  });

  it('still shows the payee and total the reads agreed on when they disagree on something else', async () => {
    script([totalsPacket(), totalsPacket({ formDate: '11/09/2026' })]);
    const result = await read();
    expect(result).toMatchObject({ unconfirmed: 'the form date', notConfirmed: [] });
    expect(await decideReimbursement(db as never, result)).toEqual({
      outcome: 'manual_entry',
      manual: { reason: 'two reads of the packet disagreed on the form date', payeeName: 'MORGAN T ELLERY', formAmount: '$1,500.30' },
    });
  });

  it('hides the email amount the reads disagreed on', async () => {
    script([totalsPacket({ emailAmount: '$900.00', emailAmountIsCap: false }), totalsPacket({ emailAmount: '$950.00', emailAmountIsCap: false })]);
    const decision = await decideReimbursement(db as never, await read());
    expect(decision).toEqual({
      outcome: 'manual_entry',
      manual: {
        reason: "two reads of the packet disagreed on the email's amount",
        payeeName: 'MORGAN T ELLERY',
        formAmount: '$1,500.30',
        notConfirmed: ['emailAmount'],
      },
    });
  });

  it('takes a third look when one of the first two does not add up, and books when it agrees with the one that did', async () => {
    script([inventedPacket(), otherPacket()], [brokenLook(), gridLook(), gridLook()]);
    const result = await read();
    expect(lookCalls()).toHaveLength(3);
    expect(result).toMatchObject({ formAmountToPay: '$1,500.30', confirmedByFormMath: expect.anything() });
  });

  it('does not book a table that adds up on one look alone, such as one built from receipts', async () => {
    script([inventedPacket(), otherPacket()], [otherGridLook(), brokenLook(), gridLook()]);
    const result = await read();
    expect(lookCalls()).toHaveLength(3);
    expect(result).toMatchObject({
      unconfirmed: "the form's Amount to Pay",
      unconfirmedDetail: 'the line items in column "Ground" do not add up to its total; no two looks at the form both passed and read the same total',
    });
    expect(result).not.toHaveProperty('confirmedByFormMath');
  });

  it('stops when two looks add up but read different totals', async () => {
    script([inventedPacket(), otherPacket()], [gridLook(), otherGridLook()]);
    const result = await read();
    expect(lookCalls()).toHaveLength(2);
    expect(result).toMatchObject({ unconfirmed: "the form's Amount to Pay", unconfirmedDetail: 'no two looks at the form both passed and read the same total' });
  });

  it('keeps looking one at a time, up to four looks, until two passing looks agree', async () => {
    script([inventedPacket(), otherPacket()], [gridLook(), brokenLook(), brokenLook(), gridLook()]);
    expect(await read()).toMatchObject({ formAmountToPay: '$1,500.30', confirmedByFormMath: expect.anything() });
    expect(lookCalls()).toHaveLength(4);

    script([inventedPacket(), otherPacket()], [brokenLook(), brokenLook(), gridLook(), gridLook()]);
    expect(await read()).toMatchObject({ formAmountToPay: '$1,500.30' });
    expect(lookCalls()).toHaveLength(4);
  });

  it('gives up after four looks', async () => {
    script([inventedPacket(), otherPacket()], [gridLook(), brokenLook(), brokenLook(), brokenLook(), gridLook()]);
    expect(await read()).toMatchObject({ unconfirmed: "the form's Amount to Pay", notConfirmed: ['formAmount'] });
    expect(lookCalls()).toHaveLength(4);
  });

  it('stops as soon as passing looks read different totals', async () => {
    script([inventedPacket(), otherPacket()], [gridLook(), brokenLook(), otherGridLook(), gridLook()]);
    expect(await read()).toMatchObject({ unconfirmed: "the form's Amount to Pay", notConfirmed: ['formAmount'] });
    expect(lookCalls()).toHaveLength(3);
  });

  it('stops without showing either read when neither look adds up, and says why without any amount', async () => {
    script([inventedPacket(), otherPacket()], [brokenLook(), gridLook({ grandTotal: '$1,520.85' }), brokenLook(), brokenLook()]);
    const result = await read();
    expect(lookCalls()).toHaveLength(4);
    expect(result).toMatchObject({
      unconfirmed: "the form's Amount to Pay",
      unconfirmedDetail: 'the line items in column "Ground" do not add up to its total; the column totals do not add up to the form total',
      notConfirmed: ['formAmount'],
    });
    const decision = await decideReimbursement(db as never, result);
    expect(decision).toEqual({
      outcome: 'manual_entry',
      manual: {
        reason: "the reads of the packet did not give one confirmed Amount to Pay, and the form's own totals could not confirm it (the line items in column \"Ground\" do not add up to its total; the column totals do not add up to the form total)",
        payeeName: 'MORGAN T ELLERY',
        notConfirmed: ['formAmount'],
      },
    });
    expect(JSON.stringify(decision)).not.toMatch(/171\.25|1,520\.85|1,500\.30/);
  });

  it('stops when the looks could not be completed', async () => {
    script([inventedPacket(), otherPacket()], Array.from({ length: 8 }, () => new Error('gateway timeout')));
    const result = await read();
    expect(lookCalls()).toHaveLength(4);
    expect(aiResponse).toHaveBeenCalledTimes(6);
    expect(result).toMatchObject({ unconfirmed: "the form's Amount to Pay", unconfirmedDetail: 'a look at the form could not be completed' });
  });

  it('stops as a form with no Amount to Pay when neither read nor any look found a total', async () => {
    script([missingTotalPacket(), missingTotalPacket()], [noTotalLook(), noTotalLook()]);
    const result = await read();
    expect(result).not.toHaveProperty('unconfirmed');
    expect(await decideReimbursement(db as never, result)).toMatchObject({
      outcome: 'manual_entry',
      manual: { reason: 'the reimbursement form prints no Amount to Pay' },
    });
  });

  it('stops, rather than reporting no total, when a read found one and the looks found none', async () => {
    script([inventedPacket(), missingTotalPacket()], [noTotalLook(), noTotalLook()]);
    expect(await read()).toMatchObject({ unconfirmed: "the form's Amount to Pay", unconfirmedDetail: 'the form shows no total to check' });
  });

  it('does not keep looking once the run is aborted', async () => {
    const controller = new AbortController();
    aiResponse.mockReset()
      .mockResolvedValueOnce(inventedPacket())
      .mockResolvedValueOnce(otherPacket())
      .mockImplementation(async () => {
        controller.abort();
        throw new Error('aborted');
      });
    await expect(readReimbursementPacket(attachments, email, controller.signal)).rejects.toThrow();
    expect(lookCalls().length).toBeLessThanOrEqual(2);
  });

  it('keeps the email amount as a check on the confirmed total', async () => {
    script([
      inventedPacket({ emailAmount: '$1,520.85', emailAmountIsCap: false }),
      otherPacket({ emailAmount: '$1,520.85', emailAmountIsCap: false }),
    ], [gridLook(), gridLook()]);
    expect(await decideReimbursement(db as never, await read())).toMatchObject({
      outcome: 'manual_entry',
      manual: { reason: "the form's Amount to Pay $1,500.30 and the email's $1,520.85 disagree" },
    });
  });

  it('notes what was checked so AP sees it in the invoice note and the Slack post', async () => {
    script([inventedPacket(), otherPacket()], [gridLook(), gridLook()]);
    const decision = await decideReimbursement(db as never, await read());
    if (decision.outcome !== 'apply') throw new Error('expected apply');
    const note = reimbursementNote(decision.reimbursement);
    expect(note).toContain('invoiced to S-000123 MORGAN T ELLERY for $1,500.30, the TOTALS on the reimbursement form.');
    expect(note).toContain("The reads of the form did not agree on this total, so it was checked against the form's own arithmetic");
    expect(note).toContain('the column totals (Airfare $0.00, Ground $310.40, Hotel $1,150.20, Meals $39.70) add up to it');
    expect(note).toContain("each column's line items add up to its column total");
    const lines = reimbursementSlackLines(decision.reimbursement).join('\n');
    expect(lines).toContain("Amount: $1,500.30 from the form's TOTALS");
    expect(lines).toContain('Check the total first');
  });

  it('does not mark a booking where both reads found the total', async () => {
    script([totalsPacket(), totalsPacket()]);
    const decision = await decideReimbursement(db as never, await read());
    if (decision.outcome !== 'apply') throw new Error('expected apply');
    expect(decision.reimbursement).not.toHaveProperty('confirmedByFormMath');
    expect(reimbursementNote(decision.reimbursement)).toContain('the TOTALS on the reimbursement form.');
    expect(reimbursementNote(decision.reimbursement)).not.toContain('arithmetic');
    expect(reimbursementSlackLines(decision.reimbursement).join('\n')).not.toContain('Check the total first');
  });

  it('says Amount to Pay, not an invented label, when two reads agree on a total under a label the form does not print', async () => {
    script([inventedPacket({ formAmountToPay: '$1,500.30' }), inventedPacket({ formAmountToPay: '$1,500.30' })]);
    const decision = await decideReimbursement(db as never, await read());
    if (decision.outcome !== 'apply') throw new Error('expected apply');
    expect(decision.reimbursement).not.toHaveProperty('totalLabel');
    expect(reimbursementNote(decision.reimbursement)).toContain('the Amount to Pay on the reimbursement form.');
    expect(JSON.stringify(decision)).not.toContain('TOTAL AMT DUE');
  });

  it('does not leave a total the reads did not agree on on the unconfirmed read', async () => {
    script([inventedPacket(), otherPacket()], [brokenLook(), brokenLook(), brokenLook(), brokenLook()]);
    expect(await read()).toMatchObject({ formAmountToPay: null, formAmountLabel: null, unconfirmed: "the form's Amount to Pay" });
    script([inventedPacket(), otherPacket({ payeeName: 'JORDAN P REYES' })]);
    expect(await read()).toMatchObject({ formAmountToPay: null, formAmountLabel: null, unconfirmed: 'the payee' });
    script([totalsPacket(), totalsPacket({ formDate: '11/09/2026' })]);
    expect(await read()).toMatchObject({ formAmountToPay: '$1,500.30', unconfirmed: 'the form date' });
  });

  it('shows the confirmed total, not a guess, when the packet then stops for another reason', async () => {
    script([inventedPacket({ confidence: 0.5 }), otherPacket()], [gridLook(), gridLook()]);
    expect(await decideReimbursement(db as never, await read())).toMatchObject({
      outcome: 'manual_entry',
      manual: { formAmount: '$1,500.30' },
    });
  });
});

describe('packetDisagreement and a total the reads did not both give', () => {
  it('does not count a total one read found and the other missed, but does count two different totals', () => {
    expect(packetDisagreement(missingTotalPacket(), totalsPacket())).toBeUndefined();
    expect(packetDisagreement(totalsPacket(), missingTotalPacket({ formAmountToPay: '  ' }))).toBeUndefined();
    expect(packetDisagreement(inventedPacket(), otherPacket())).toBe("the form's Amount to Pay");
    expect(packetDisagreement(missingTotalPacket(), totalsPacket({ payeeName: 'Jordan Ellery' }))).toBe('the payee');
  });
});

describe('decideReimbursement', () => {
  it('is not a reimbursement without a packet or for a supplier invoice', async () => {
    expect(await decideReimbursement(db as never, undefined)).toEqual({ outcome: 'not_reimbursement' });
    expect(await decideReimbursement(db as never, packet({ kind: 'supplier_invoice' }))).toEqual({ outcome: 'not_reimbursement' });
  });

  it('invoices the payee for the form Amount to Pay, matched by name', async () => {
    const decision = await decideReimbursement(db as never, packet(), { defaultSupplierWid: 'wid-default' });
    expect(decision).toEqual({
      outcome: 'apply',
      reimbursement: {
        payee: {
          workdayId: 'wid-ellery',
          supplierName: 'MORGAN T ELLERY',
          supplierId: 'S-000123',
          nameOnForm: 'MORGAN T ELLERY',
          matchedBy: 'name',
        },
        amount: 1000,
        amountLabel: '$1,000.00',
        totalLabel: 'Amount to Pay',
        invoiceDate: '2026-11-02',
        description: 'Hotel reimbursement - 2026 Sample Marathon Team',
      },
    });
  });

  it('matches by a printed Supplier ID when the cached name agrees', async () => {
    db.query.mockResolvedValue([{ workday_id: 'wid-ellery', metadata: payeeDocument.metadata }]);
    const decision = await decideReimbursement(db as never, packet({ payeeSupplierId: 'Supplier ID: s-000123' }));
    expect(decision).toMatchObject({ outcome: 'apply', reimbursement: { payee: { workdayId: 'wid-ellery', matchedBy: 'supplier_id' } } });
    expect(findDocuments).not.toHaveBeenCalled();
  });

  it('stops when the printed Supplier ID belongs to a different name', async () => {
    db.query.mockResolvedValue([{ workday_id: 'wid-other', metadata: { supplierId: 'S-000123', supplierName: 'HARBOR VIEW HOTEL LLC' } }]);
    const decision = await decideReimbursement(db as never, packet({ payeeSupplierId: 'S-000123' }));
    expect(decision).toMatchObject({ outcome: 'manual_entry', manual: { reason: expect.stringContaining('does not match MORGAN T ELLERY') } });
  });

  it('stops when the printed Supplier ID is not cached', async () => {
    const decision = await decideReimbursement(db as never, packet({ payeeSupplierId: 'S-000123' }));
    expect(decision).toMatchObject({ outcome: 'manual_entry', manual: { reason: 'Supplier ID S-000123 is not in the supplier cache' } });
  });

  it('stops when the payee is the default supplier', async () => {
    db.query.mockResolvedValue([{ workday_id: 'wid-default', metadata: payeeDocument.metadata }]);
    const decision = await decideReimbursement(db as never, packet({ payeeSupplierId: 'S-000123' }), { defaultSupplierWid: 'wid-default' });
    expect(decision).toMatchObject({ outcome: 'manual_entry', manual: { reason: expect.stringContaining('default supplier') } });
  });

  it('stops when no cached supplier matches the payee name', async () => {
    findDocuments.mockResolvedValue([]);
    const decision = await decideReimbursement(db as never, packet());
    expect(decision).toMatchObject({ outcome: 'manual_entry', manual: { payeeName: 'MORGAN T ELLERY', formAmount: '$1,000.00' } });
  });

  it('stops when two suppliers match the payee name', async () => {
    findDocuments.mockResolvedValue([payeeDocument, { ...payeeDocument, workday_id: 'wid-ellery-2', metadata: { ...payeeDocument.metadata, supplierId: 'S-000124' } }]);
    const decision = await decideReimbursement(db as never, packet());
    expect(decision.outcome).toBe('manual_entry');
  });

  it('stops when two reads of the packet disagreed', async () => {
    const decision = await decideReimbursement(db as never, { ...packet(), unconfirmed: 'the payee' });
    expect(decision).toMatchObject({ outcome: 'manual_entry', manual: { reason: 'two reads of the packet disagreed on the payee' } });
  });

  it('stops when the form has no readable date, since the draft would have no number', async () => {
    for (const formDate of [null, 'last Tuesday']) {
      const decision = await decideReimbursement(db as never, packet({ formDate }));
      expect(decision).toMatchObject({ outcome: 'manual_entry', manual: { reason: expect.stringContaining('no readable date') } });
    }
  });

  it('stops when the packet names no payee', async () => {
    const decision = await decideReimbursement(db as never, packet({ payeeName: null }));
    expect(decision).toMatchObject({ outcome: 'manual_entry', manual: { reason: 'the packet does not name the person to pay' } });
  });

  it('stops when the read is not confident', async () => {
    const decision = await decideReimbursement(db as never, packet({ confidence: 0.5 }));
    expect(decision.outcome).toBe('manual_entry');
  });

  describe('approved amount', () => {
    const reason = async (overrides: Partial<ReimbursementPacket>) => {
      const decision = await decideReimbursement(db as never, packet(overrides));
      return decision.outcome === 'manual_entry' ? decision.manual.reason : decision.outcome;
    };

    it('stops when the form prints no Amount to Pay, even if the email states one', async () => {
      expect(await reason({ formAmountToPay: null, emailAmount: '$900.00' })).toBe('the reimbursement form prints no Amount to Pay');
    });

    it('stops on an unreadable, zero, or negative form amount', async () => {
      expect(await reason({ formAmountToPay: 'see attached' })).toContain('could not be read');
      expect(await reason({ formAmountToPay: '$0.00' })).toContain('zero');
      expect(await reason({ formAmountToPay: '-$50.00' })).toContain('could not be read');
    });

    it('books a form amount printed with accounting parentheses and padding as a positive amount', async () => {
      const decision = await decideReimbursement(
        db as never,
        packet({ formAmountToPay: paddedParenthesized, emailAmount: '$1,335.93', emailAmountIsCap: false }),
      );
      expect(decision).toMatchObject({ outcome: 'apply', reimbursement: { amount: 1335.93, amountLabel: '$1,335.93' } });
    });

    it('still stops on a negative or parenthesized zero form amount', async () => {
      expect(await reason({ formAmountToPay: `-$${' '.repeat(70)}50.00` })).toContain('could not be read');
      expect(await reason({ formAmountToPay: '($0.00)' })).toContain('zero');
    });

    it('stops on a parenthesized email amount rather than reading it as positive', async () => {
      expect(await reason({ emailAmount: '($1,000.00)', emailAmountIsCap: false })).toContain('could not be read');
    });

    it('still stops when a parenthesized form amount differs from the email', async () => {
      expect(await reason({ formAmountToPay: paddedParenthesized, emailAmount: '$1,300.00', emailAmountIsCap: false })).toContain('disagree');
    });

    it('shows the amounts without padding when it stops', async () => {
      const decision = await decideReimbursement(db as never, packet({ formAmountToPay: `see   attached${' '.repeat(70)}form`, emailAmount: ' $900.00 ' }));
      expect(decision).toMatchObject({ outcome: 'manual_entry', manual: { formAmount: 'see attached form', emailAmount: '$900.00' } });
    });

    it('accepts an email amount equal to the form amount', async () => {
      expect(await reason({ emailAmount: '$1000', emailAmountIsCap: false })).toBe('apply');
    });

    it('stops when the email and form disagree', async () => {
      expect(await reason({ emailAmount: '$950.00', emailAmountIsCap: false })).toContain('disagree');
    });

    it('treats an email amount of unknown wording as exact', async () => {
      expect(await reason({ emailAmount: '$1,200.00', emailAmountIsCap: null })).toContain('disagree');
    });

    it('accepts a form amount within an email limit and records the limit', async () => {
      const decision = await decideReimbursement(db as never, packet({ formAmountToPay: '$850.00', emailAmount: '$1,000.00', emailAmountIsCap: true }));
      expect(decision).toMatchObject({ outcome: 'apply', reimbursement: { amount: 850, emailCap: 1000 } });
    });

    it('stops when the form amount is above the email limit', async () => {
      expect(await reason({ formAmountToPay: '$1,100.00', emailAmount: '$1,000.00', emailAmountIsCap: true })).toContain('above the email\'s limit');
    });

    it('stops on an unreadable email amount', async () => {
      expect(await reason({ emailAmount: 'about a thousand', emailAmountIsCap: true })).toContain('could not be read');
    });
  });
});

describe('reimbursementDescription', () => {
  it('names the kind and the purpose', () => {
    expect(reimbursementDescription({ expenseKind: 'airfare', purpose: 'Spring Clinic' })).toBe('Airfare reimbursement - Spring Clinic');
  });

  it('falls back to a generic label and strips markup characters', () => {
    expect(reimbursementDescription({ expenseKind: null, purpose: null })).toBe('Expense reimbursement');
    expect(reimbursementDescription({ expenseKind: 'hotel', purpose: 'Team <b>A</b> | trip' })).toBe('Hotel reimbursement - Team b A /b trip');
  });
});

describe('applied reimbursement outputs', () => {
  const applied: AppliedReimbursement = {
    payee: { workdayId: 'wid-ellery', supplierName: 'MORGAN T ELLERY', supplierId: 'S-000123', nameOnForm: 'Morgan Ellery', matchedBy: 'name' },
    amount: 1000,
    amountLabel: '$1,000.00',
    invoiceDate: '2026-11-02',
    description: 'Hotel reimbursement - 2026 Sample Marathon Team',
  };

  it('builds one line at the approved amount and no folio charges', () => {
    const ocr = reimbursementOcr(applied);
    expect(ocr.extractedAmountDue).toBe('$1,000.00');
    expect(ocr.extractedInvoiceDate).toBe('2026-11-02');
    expect(ocr.extractedInvoiceLines).toEqual([expect.objectContaining({
      description: 'Hotel reimbursement - 2026 Sample Marathon Team',
      totalPrice: '$1,000.00',
    })]);
    expect(ocr).toMatchObject({
      extractedTaxAmount: null,
      extractedFreightAmount: null,
      extractedPartialPayment: null,
      extractedPriorPayments: null,
      extractedPurchaseOrderNumber: null,
      extractedSuppliersInvoiceNumber: null,
    });
  });

  it('pins the payee over the matching model and clears its balance and PO reading', () => {
    const result = applyReimbursementToEnrichment({
      supplier: {
        status: 'found',
        confidence: 0.9,
        extractedInformation: { supplierName: 'Harbor View Hotel' },
        resolvedSupplier: { workdayId: 'wid-hotel', supplierName: 'HARBOR VIEW HOTEL LLC', confidence: 0.9, reason: 'folio' },
        potentialDuplicateSuppliers: null,
        recommendation: { action: 'update_invoice', reason: 'folio' },
        reason: 'folio',
      },
      emailBalanceDue: { amount: '$10.00', phrase: 'remaining' },
      extractedPurchaseOrderNumber: 'PO-1',
      emailWorktags: { company: null },
    } as never, applied);
    expect(result.supplier.resolvedSupplier).toMatchObject({ workdayId: 'wid-ellery', supplierName: 'MORGAN T ELLERY' });
    expect(result.supplier.extractedInformation?.supplierName).toBe('MORGAN T ELLERY');
    expect(result.supplier.reason).toContain('The merchant on receipts or folios was not used as the supplier.');
    expect(result.emailBalanceDue).toBeNull();
    expect(result.extractedPurchaseOrderNumber).toBeNull();
    expect(result.emailWorktags).toEqual({ company: null });
  });

  it('states only what was submitted in the note and Slack lines', () => {
    expect(reimbursementNote(applied)).toBe(
      'Reimbursement packet: invoiced to S-000123 MORGAN T ELLERY for $1,000.00, the Amount to Pay on the reimbursement form. Receipts and folios in the packet are supporting documents only; their rooms, taxes, and totals were not booked.'
    );
    expect(reimbursementNote({ ...applied, emailCap: 1200 })).toContain("The email's limit of $1,200.00 was not exceeded.");
    expect(reimbursementSlackLines(applied)).toEqual([
      'Payee: MORGAN T ELLERY (S-000123), matched by name',
      "Amount: $1,000.00 from the form's Amount to Pay",
      'Receipts and folios were not booked as invoice lines.',
    ]);
  });
});
