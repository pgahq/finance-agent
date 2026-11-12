// Runs the real packet read (GPT-5.4, then the Haiku confirming read; no mocks) on fictional packets that put the
// "invoice the person for the form amount, never the folio" rule at risk. It is skipped unless
// RUN_LIVE_REIMBURSEMENT_EVAL=1 and AI_GATEWAY_API_KEY are set, so CI never calls the model:
//   RUN_LIVE_REIMBURSEMENT_EVAL=1 npx jest --ci src/__tests__/reimbursement_packet.live.test.ts
// RUNS (default 3) sets how many times each packet is read. Each packet must come out the same every time, and the
// two reads must agree, because a disagreement sends a real packet to manual entry.
import { readReimbursementPacket, type ReimbursementRead } from '../lib/reimbursement_packet.js';
import { parseCanonicalChargeAmount } from '../lib/invoice_lines.js';
import {
  folioTotal,
  gridExpenseFormPdf,
  gridFormTotals,
  reimbursementPacketPdf,
  vendorInvoicePdf,
  type FolioOptions,
  type FormOptions,
  type GridFormOptions,
} from './fixtures/reimbursement_packets.js';

const live = process.env.RUN_LIVE_REIMBURSEMENT_EVAL === '1' && process.env.AI_GATEWAY_API_KEY ? describe : describe.skip;
const RUNS = Number(process.env.RUNS) || 3;

type Email = { emailFrom?: string; subject?: string; plainTextBody?: string };

async function read(pdf: Buffer, fileName: string, email?: Email): Promise<ReimbursementRead | undefined> {
  return readReimbursementPacket(
    [{ id: '1', fileName, contentType: 'application/pdf', presignedUrl: 'https://example.invalid/packet.pdf', expiresAt: new Date(), s3Key: 'packet', buffer: pdf }],
    email
  );
}

const cents = (value: string | null | undefined) => {
  const amount = parseCanonicalChargeAmount(value);
  return amount === undefined ? null : Math.round(amount * 100);
};

const form = (overrides: Partial<FormOptions> = {}): FormOptions => ({
  title: 'Sample Marathon Team REIMBURSEMENT REQUEST',
  payee: 'Jordan P Reyes',
  line: 'Hotel room - Sample Courtyard 11/4/26',
  amount: '$1,000.00',
  date: '11/5/26',
  ...overrides,
});

const folio = (overrides: Partial<FolioOptions> = {}): FolioOptions => ({
  guest: 'Taylor Reyes',
  hotel: 'Sample Courtyard Hotel',
  nights: 6,
  nightly: 324,
  taxPerNight: 52.57,
  zeroBalance: true,
  ...overrides,
});

const gridForm = (overrides: Partial<GridFormOptions> = {}): GridFormOptions => ({
  title: 'SAMPLE ASSOCIATION EXPENSE REPORT',
  payee: 'Jordan P Reyes',
  date: '11/5/2026',
  columns: ['Airfare', 'Ground', 'Hotel', 'Meals'],
  lines: [
    { description: 'Parking at home airport', column: 1, amount: 64.2 },
    { description: 'Ride share to hotel', column: 1, amount: 41.35 },
    { description: 'Ride share to airport', column: 1, amount: 38.9 },
    { description: 'Sample Courtyard hotel, room and tax', column: 2, amount: 812.44 },
    { description: 'Lunch', column: 3, amount: 17.85 },
  ],
  ...overrides,
});

live('reimbursement packet read on fictional packets (live)', () => {
  // The form prints no "Amount to Pay": the total is the TOTALS row under "Sum of All Columns". When the reads miss it,
  // the form's own arithmetic must confirm it, never a guess. The rotated, shaded case is the closest a generated PDF
  // gets to a scanned form; a real scan still needs a manual check.
  it.each([
    ['upright', gridForm()],
    ['sideways and shaded', gridForm({ rotated: true, shaded: true })],
  ])('books the TOTALS row total of a grid expense form (%s), or stops with no amount shown', async (_name, form) => {
    const pdf = await gridExpenseFormPdf(form, folio());
    const expected = Math.round(gridFormTotals(form).grand * 100);
    for (let run = 0; run < RUNS; run++) {
      const packet = await read(pdf, 'expense report.pdf', { subject: 'Expense report' });
      expect(packet?.kind).toBe('reimbursement');
      if (packet?.unconfirmed) {
        expect(packet.notConfirmed).toContain('formAmount');
      } else {
        expect(cents(packet?.formAmountToPay)).toBe(expected);
      }
    }
  }, 600000);

  it('books the form amount and payee, not the folio, when the folio totals more', async () => {
    const pdf = await reimbursementPacketPdf(form(), folio());
    expect(folioTotal(folio())).toBeGreaterThan(1000);
    for (let run = 0; run < RUNS; run++) {
      const packet = await read(pdf, 'expense reimbursement form.pdf');
      expect(packet?.kind).toBe('reimbursement');
      expect(packet?.payeeName).toMatch(/jordan.*reyes/i);
      expect(cents(packet?.formAmountToPay)).toBe(100000);
      expect(packet?.unconfirmed).toBeUndefined();
    }
  }, 300000);

  it('reads a smaller form amount below a folio that totals more', async () => {
    const pdf = await reimbursementPacketPdf(form({ payee: 'Avery Lindqvist', amount: '$487.50', line: 'Hotel - 2 nights 11/2 - 11/4' }), folio({ nights: 3 }));
    for (let run = 0; run < RUNS; run++) {
      const packet = await read(pdf, 'Avery reimbursement.pdf');
      expect(packet?.kind).toBe('reimbursement');
      expect(packet?.payeeName).toMatch(/avery.*lindqvist/i);
      expect(cents(packet?.formAmountToPay)).toBe(48750);
      expect(packet?.unconfirmed).toBeUndefined();
    }
  }, 300000);

  it('reads the amount from a form that labels it Total Reimbursement', async () => {
    const pdf = await reimbursementPacketPdf(form({ title: 'Expense Report', amount: undefined, total: 'Total Reimbursement $212.40', line: 'Parking and tolls 11/3/26' }), undefined);
    for (let run = 0; run < RUNS; run++) {
      const packet = await read(pdf, 'expense report.pdf');
      expect(packet?.kind).toBe('reimbursement');
      expect(cents(packet?.formAmountToPay)).toBe(21240);
      expect(packet?.unconfirmed).toBeUndefined();
    }
  }, 300000);

  it('returns no form amount when the form leaves Amount to Pay blank, so the packet goes to manual entry', async () => {
    const pdf = await reimbursementPacketPdf(form({ amount: undefined, total: undefined }), folio());
    for (let run = 0; run < RUNS; run++) {
      const packet = await read(pdf, 'expense reimbursement form.pdf');
      expect(packet?.kind).toBe('reimbursement');
      expect(cents(packet?.formAmountToPay)).toBeNull();
    }
  }, 300000);

  it('keeps an email limit separate from the amount when only a folio is attached', async () => {
    const pdf = await reimbursementPacketPdf(undefined, folio({ nights: 2, guest: 'Morgan Ellery' }));
    const email = { emailFrom: 'ap-requests@example.com', subject: 'Hotel reimbursement', plainTextBody: 'Please reimburse Morgan Ellery for the hotel, up to $500.00. The folio is attached.' };
    for (let run = 0; run < RUNS; run++) {
      const packet = await read(pdf, 'folio.pdf', email);
      expect(packet?.kind).toBe('reimbursement');
      expect(cents(packet?.formAmountToPay)).toBeNull();
      expect(cents(packet?.emailAmount)).toBe(50000);
      expect(packet?.emailAmountIsCap).toBe(true);
    }
  }, 300000);

  it('does not call a vendor invoice a reimbursement because the email mentions one', async () => {
    const pdf = await vendorInvoicePdf('Sample Event Rentals LLC', 'INV-1042', 5000);
    const email = { subject: 'INV-1042', plainTextBody: 'Attached is our invoice. The $500 deposit was reimbursed last month and is already deducted.' };
    for (let run = 0; run < RUNS; run++) {
      const packet = await read(pdf, 'INV-1042.pdf', email);
      expect(packet?.kind).toBe('supplier_invoice');
    }
  }, 300000);
});
