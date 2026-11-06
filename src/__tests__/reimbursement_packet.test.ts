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
import { attachmentContentParts } from '../lib/invoice_ocr.js';
import {
  applyReimbursementToEnrichment,
  decideReimbursement,
  hasReimbursementSignal,
  isReimbursementPacketsEnabled,
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
    aiResponse.mockRejectedValueOnce(new Error('gateway timeout')).mockResolvedValueOnce(packet());
    const read = await readReimbursementPacket(attachments, { subject: 'Reimbursement' } as never);
    expect(read?.kind).toBe('reimbursement');
    expect(aiResponse).toHaveBeenCalledTimes(2);
  });

  it('throws the last failure when both attempts fail', async () => {
    aiResponse.mockRejectedValue(new Error('gateway timeout'));
    await expect(readReimbursementPacket(attachments, { subject: 'Reimbursement' } as never))
      .rejects.toThrow('gateway timeout');
  });

  it('is off only when the switch says false', async () => {
    aiResponse.mockResolvedValue(packet());
    process.env.REIMBURSEMENT_PACKETS_ENABLED = 'false';
    try {
      expect(await readReimbursementPacket(attachments, { subject: 'Reimbursement' } as never)).toBeUndefined();
      expect(aiResponse).not.toHaveBeenCalled();
      expect(isReimbursementPacketsEnabled({ REIMBURSEMENT_PACKETS_ENABLED: ' False ' })).toBe(false);
      expect(isReimbursementPacketsEnabled({ REIMBURSEMENT_PACKETS_ENABLED: '' })).toBe(true);
      expect(isReimbursementPacketsEnabled({})).toBe(true);
      expect(isReimbursementPacketsEnabled({ REIMBURSEMENT_PACKETS_ENABLED: 'true' })).toBe(true);
    } finally {
      delete process.env.REIMBURSEMENT_PACKETS_ENABLED;
    }
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
