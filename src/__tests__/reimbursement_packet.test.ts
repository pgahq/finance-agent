jest.mock('@pga/logger', () => ({ debug: jest.fn() }));
jest.mock('../lib/database.js', () => ({
  findDocumentsContainingWords: jest.fn(),
  findSuppliersByNameWord: jest.fn(),
}));
jest.mock('../lib/ai.js', () => ({ getAiResponse: jest.fn() }));
jest.mock('../lib/invoice_ocr.js', () => ({
  convertOfficeAttachmentsForModel: jest.fn(async (attachments: unknown[]) => attachments),
  attachmentContentParts: jest.fn(() => [{ type: 'file', data: 'pdf', mediaType: 'application/pdf' }]),
}));

import { findDocumentsContainingWords } from '../lib/database.js';
import { getAiResponse } from '../lib/ai.js';
import type { ReimbursementFormTotal } from '../prompts/reimbursement_packet_prompt.js';
import { attachmentContentParts } from '../lib/invoice_ocr.js';
import { parseCanonicalChargeAmount } from '../lib/invoice_lines.js';
import {
  applyReimbursementToEnrichment,
  decideReimbursement,
  formAmountGap,
  formTotalFailure,
  hasReimbursementSignal,
  packetDisagreement,
  parseFormAmountToPay,
  readReimbursementPacket,
  reimbursementDescription,
  reimbursementNote,
  reimbursementOcr,
  reimbursementSlackLines,
  type AppliedReimbursement,
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

// The Ellis packet shape (2026-11-12): one read found no Amount to Pay, the other read the TOTALS row. The form's
// category lines are entered separately in Workday and add up to that total.
const formLook = (overrides: Partial<ReimbursementFormTotal> = {}): ReimbursementFormTotal => ({
  amountToPay: '$1,403.95',
  totalsLabel: 'TOTALS',
  categoryLines: [
    { label: 'SC - ground transportation', amount: '$440.80' },
    { label: 'SC-Lodging', amount: '$963.15' },
  ],
  ...overrides,
});
const totalsPacket = (overrides: Partial<ReimbursementPacket> = {}) =>
  packet({ formAmountToPay: '$1,403.95', purpose: '110th Annual Meeting', expenseKind: 'hotel', ...overrides });
const missingTotalPacket = (overrides: Partial<ReimbursementPacket> = {}) => totalsPacket({ formAmountToPay: null, ...overrides });

describe('a form total only one read found', () => {
  const attachments = [{ fileName: 'packet.pdf', contentType: 'application/pdf' }] as never;
  const email = { subject: 'Expense report' } as never;
  const read = () => readReimbursementPacket(attachments, email);

  it('books the form total when a focused look matches it and the category lines add up', async () => {
    aiResponse.mockReset()
      .mockResolvedValueOnce(missingTotalPacket())
      .mockResolvedValueOnce(totalsPacket())
      .mockResolvedValueOnce(formLook());
    const result = await read();
    expect(aiResponse).toHaveBeenCalledTimes(3);
    expect(aiResponse.mock.calls[2][0]).toMatchObject({ model: expect.anything(), temperature: null });
    expect(result).not.toHaveProperty('unconfirmed');
    expect(await decideReimbursement(db as never, result)).toMatchObject({
      outcome: 'apply',
      reimbursement: { amount: 1403.95, amountLabel: '$1,403.95' },
    });
  });

  it('books it the same way when the second read is the one that found no total', async () => {
    aiResponse.mockReset()
      .mockResolvedValueOnce(totalsPacket())
      .mockResolvedValueOnce(missingTotalPacket())
      .mockResolvedValueOnce(formLook());
    const result = await read();
    expect(result?.formAmountToPay).toBe('$1,403.95');
    expect(result).not.toHaveProperty('unconfirmed');
  });

  it('books the total, not a category line', async () => {
    aiResponse.mockReset()
      .mockResolvedValueOnce(missingTotalPacket())
      .mockResolvedValueOnce(totalsPacket())
      .mockResolvedValueOnce(formLook());
    const decision = await decideReimbursement(db as never, await read());
    expect(decision).toMatchObject({ outcome: 'apply', reimbursement: { amount: 1403.95 } });
    expect(JSON.stringify(decision)).not.toContain('963.15');
  });

  it.each([
    ['finds no total', formLook({ amountToPay: null, totalsLabel: null }), 'a focused look at the form found no Amount to Pay'],
    ['finds a different total', formLook({ amountToPay: '$963.15' }), 'a focused look at the form found $963.15'],
    ['finds category lines that do not add up', formLook({ categoryLines: [{ label: 'SC-Lodging', amount: '$963.15' }] }), "the form's category lines add up to $963.15, not $1,403.95"],
    ['finds no category lines', formLook({ categoryLines: [] }), 'the form lists no category lines to check the total against'],
  ])('stops for manual entry when the focused look %s', async (_name, look, reason) => {
    aiResponse.mockReset()
      .mockResolvedValueOnce(missingTotalPacket())
      .mockResolvedValueOnce(totalsPacket())
      .mockResolvedValueOnce(look);
    const result = await read();
    expect(result?.unconfirmed).toContain('one read found $1,403.95 and the other found none');
    expect(result?.unconfirmed).toContain(reason);
    const decision = await decideReimbursement(db as never, result);
    expect(decision).toMatchObject({ outcome: 'manual_entry', manual: { reason: expect.stringContaining('disagreed on') } });
  });

  it('stops for manual entry when the focused look cannot be completed', async () => {
    aiResponse.mockReset()
      .mockResolvedValueOnce(missingTotalPacket())
      .mockResolvedValueOnce(totalsPacket())
      .mockRejectedValue(new Error('gateway timeout'));
    const result = await read();
    expect(aiResponse).toHaveBeenCalledTimes(4);
    expect(result?.unconfirmed).toContain('the focused look at the form could not be completed');
  });

  it('does not take a focused look when the reads also disagree on another fact', async () => {
    aiResponse.mockReset()
      .mockResolvedValueOnce(missingTotalPacket())
      .mockResolvedValueOnce(totalsPacket({ formDate: '11/09/2026' }));
    const result = await read();
    expect(aiResponse).toHaveBeenCalledTimes(2);
    expect(result?.unconfirmed).toBe('the form date');
  });

  it('does not take a focused look when both reads found the same total or two different totals', async () => {
    aiResponse.mockReset().mockResolvedValue(totalsPacket());
    expect((await read())?.unconfirmed).toBeUndefined();
    expect(aiResponse).toHaveBeenCalledTimes(2);

    aiResponse.mockReset()
      .mockResolvedValueOnce(totalsPacket())
      .mockResolvedValueOnce(totalsPacket({ formAmountToPay: '$963.15' }));
    expect((await read())?.unconfirmed).toBe("the form's Amount to Pay");
    expect(aiResponse).toHaveBeenCalledTimes(2);
  });

  it('does not take a focused look when neither read found a total', async () => {
    aiResponse.mockReset().mockResolvedValue(missingTotalPacket());
    const result = await read();
    expect(aiResponse).toHaveBeenCalledTimes(2);
    expect(await decideReimbursement(db as never, result)).toMatchObject({
      outcome: 'manual_entry',
      manual: { reason: 'the reimbursement form prints no Amount to Pay' },
    });
  });
});

describe('formAmountGap', () => {
  it('finds the total one read has when the other is blank, in either order', () => {
    expect(formAmountGap(missingTotalPacket(), totalsPacket())).toEqual({ found: '$1,403.95' });
    expect(formAmountGap(totalsPacket(), missingTotalPacket({ formAmountToPay: '  ' }))).toEqual({ found: '$1,403.95' });
  });

  it('is not a gap when both or neither read has a total, or the one found is unreadable, zero, or negative', () => {
    expect(formAmountGap(totalsPacket(), totalsPacket({ formAmountToPay: '$1.00' }))).toBeUndefined();
    expect(formAmountGap(missingTotalPacket(), missingTotalPacket())).toBeUndefined();
    expect(formAmountGap(missingTotalPacket(), totalsPacket({ formAmountToPay: 'TBD' }))).toBeUndefined();
    expect(formAmountGap(missingTotalPacket(), totalsPacket({ formAmountToPay: '$0.00' }))).toBeUndefined();
    expect(formAmountGap(missingTotalPacket(), totalsPacket({ formAmountToPay: '-$5.00' }))).toBeUndefined();
  });

  it('is not flagged by packetDisagreement, but a different non-blank total still is', () => {
    expect(packetDisagreement(missingTotalPacket(), totalsPacket())).toBeUndefined();
    expect(packetDisagreement(totalsPacket(), missingTotalPacket())).toBeUndefined();
    expect(packetDisagreement(missingTotalPacket(), totalsPacket({ formAmountToPay: '$0.00' }))).toBe("the form's Amount to Pay");
    expect(packetDisagreement(missingTotalPacket(), totalsPacket({ payeeName: 'Jordan Ellery' }))).toBe('the payee');
  });
});

describe('formTotalFailure', () => {
  it('accepts a matching total whose category lines add up in cents', () => {
    expect(formTotalFailure(1403.95, formLook())).toBeUndefined();
    expect(formTotalFailure(1403.95, formLook({ amountToPay: '($    1,403.95)' }))).toBeUndefined();
    expect(formTotalFailure(0.3, formLook({
      amountToPay: '$0.30',
      categoryLines: [{ label: 'a', amount: '$0.10' }, { label: 'b', amount: '$0.20' }],
    }))).toBeUndefined();
  });

  it('rejects a total that is not a dollar amount', () => {
    expect(formTotalFailure(1403.95, formLook({ amountToPay: 'see receipts' }))).toContain('is not a dollar amount');
  });

  it('rejects a category line that cannot be read, including a credit in parentheses', () => {
    expect(formTotalFailure(1403.95, formLook({
      categoryLines: [{ label: 'Lodging', amount: '$1,500.00' }, { label: 'Advance', amount: '($96.05)' }],
    }))).toContain('"Advance" has an amount "($96.05)" that could not be read');
    expect(formTotalFailure(1403.95, formLook({ categoryLines: [{ label: 'Meals', amount: 'n/a' }] }))).toContain('could not be read');
  });

  it('rejects the totals row listed as a category line, which doubles the sum', () => {
    expect(formTotalFailure(1403.95, formLook({
      categoryLines: [...formLook().categoryLines, { label: 'TOTALS', amount: '$1,403.95' }],
    }))).toContain('add up to $2,807.90');
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
