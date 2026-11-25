jest.mock('@pga/logger', () => ({ debug: jest.fn() }));
jest.mock('../lib/ai.js', () => ({ getAiResponse: jest.fn() }));
jest.mock('../lib/invoice_ocr.js', () => ({
  ...jest.requireActual('../lib/invoice_ocr.js'),
  extractInvoiceDocuments: jest.fn(),
}));
jest.mock('../lib/database.js', () => ({
  getDatabaseConnection: jest.fn(),
  getDocumentsByType: jest.fn(),
  getDocumentsByWorkdayIds: jest.fn(),
}));

import { getDatabaseConnection, getDocumentsByType } from '../lib/database.js';
import { getAiResponse } from '../lib/ai.js';
import { extractInvoiceDocuments } from '../lib/invoice_ocr.js';
import { buildEmailWorktags } from '../lib/email_worktags.js';
import { enrichInvoiceFromAttachments, formatEmailWorktagNotes } from '../lib/invoice_enrichment.js';

const eventDocument = (workday_id: string, name: string) => ({ workday_id, content: `Event Name: ${name}`, metadata: { workdayId: workday_id, name } });

// Fictional cache shaped like the real one (see event_match.test.ts).
const CACHE = [
  eventDocument('wid-qx-25', '25QX-Lakeside_Junior_Skills_Series_Season'),
  eventDocument('wid-zb-27', '27ZB-Lakeside_Jr_Skills_Series'),
  eventDocument('wid-zb-26', '26ZB-Lakeside_Jr_Skills_Series'),
  eventDocument('wid-main-2025', '2025 Lakeside Junior Skills Series'),
  eventDocument('wid-main-2026', '2026 Lakeside Junior Skills Series'),
];
const MAIN_2026 = 'wid-main-2026';
const SECTION_2026 = 'wid-zb-26';

const MEALS = [
  ['Classic Club Box Lunch', 20, '14.99'],
  ['Turkey Box Lunch', 20, '12.99'],
  ['Roast Beef Box Lunch', 40, '17.99'],
  ['Italian Box Lunch', 60, '14.99'],
  ['Tuna Box Lunch', 60, '12.99'],
  ['Chicken Box Lunch', 60, '12.99'],
  ['Gluten Free Box Lunch', 8, '14.99'],
  ['Veggie Box Lunch', 5, '14.99'],
] as const;

const ocr = (invoiceDate: string | null = '2026-11-13') => ({
  printedSupplier: { supplierName: 'Maple Row Deli', address: null, phone: null, email: null, taxId: null, website: null, industry: null, contactPerson: null, memo: null, remitToAddress: null },
  printedBillTo: { companyName: 'Example Buyer Inc', address: null, phone: null, email: null },
  extractedOtherCharges: null,
  extractedPaymentTerms: null,
  extractedInvoiceDate: invoiceDate,
  extractedInvoiceLines: MEALS.map(([description, quantity, unitCost]) => ({
    description, quantity, unitCost, totalPrice: (quantity * Number(unitCost)).toFixed(2), hasDiscount: false, tableNumber: 1,
  })),
});

const event = (extracted: string | null, workdayId: string | null) => ({ extracted, workdayId });

const matching = (eventCoding: ReturnType<typeof event> | null, splitEvent?: ReturnType<typeof event> | null) => ({
  supplier: { status: 'matching', confidence: 0.9, extractedInformation: {}, resolvedSupplier: null, potentialDuplicateSuppliers: null, recommendation: { action: 'update_invoice', reason: 'ok' }, reason: 'ok' },
  companyVerification: { status: 'matching', confidence: 0.9, extractedInformation: {}, recommended: null, reason: 'ok' },
  emailSummary: null,
  extractedPaymentTerms: null,
  emailWorktags: {
    event: eventCoding,
    lineOfBusiness: { extracted: 'Skills League', referenceId: 'LOB-Skills_League' },
    fund: null,
    costCenter: { extracted: 'Skills League', name: 'CC-Skills League', code: 'CC-Skills_League' },
    spendCategory: { extracted: 'Host Site Fee', name: 'Host Site Fee', referenceId: 'SC-Host_Site_Fee' },
    company: null,
  },
  emailBudgetSplits: splitEvent === undefined ? null : [
    { label: 'Budget A', amount: '$100', percent: null, equalShare: null, event: splitEvent, lineOfBusiness: null, fund: null, costCenter: null, spendCategory: null, company: null },
    { label: 'Budget B', amount: '$200', percent: null, equalShare: null, event: null, lineOfBusiness: null, fund: null, costCenter: null, spendCategory: null, company: null },
  ],
});

const existingSupplier = { descriptor: 'Maple Row Deli', id: 'wid-supplier' };
const email = (text: string, adminNote?: string) => ({
  emailFrom: 'ap-requester@example.com',
  subject: 'Box lunch invoice',
  plainTextBody: adminNote ? `${text}\n\n${adminNote}` : text,
  ...(adminNote ? { adminConversationParts: adminNote } : {}),
});

async function enrich(modelResult: ReturnType<typeof matching>, emailContext = email('Event: 26 Lakeside Jr. Skills Series'), invoiceDate: string | null = '2026-11-13') {
  (extractInvoiceDocuments as jest.Mock).mockResolvedValue(ocr(invoiceDate));
  (getAiResponse as jest.Mock).mockResolvedValue(modelResult);
  return enrichInvoiceFromAttachments({} as never, [], existingSupplier, undefined, emailContext);
}

describe('enrichInvoiceFromAttachments event rule', () => {
  beforeEach(() => {
    (getDatabaseConnection as jest.Mock).mockReset().mockResolvedValue({});
    (getDocumentsByType as jest.Mock).mockReset().mockResolvedValue(CACHE);
    (getAiResponse as jest.Mock).mockReset();
  });

  it('puts the main event on every line when the model picked the section copy for an abbreviated name (SUPIN-477701 shape)', async () => {
    const result = await enrich(matching(event('26 Lakeside Jr. Skills Series', SECTION_2026)));

    expect(result.extractedInvoiceLines).toHaveLength(8);
    expect(result.emailWorktags?.event).toMatchObject({ extracted: '26 Lakeside Jr. Skills Series', workdayId: MAIN_2026, name: '2026 Lakeside Junior Skills Series' });
    // applyEmailWorktags copies this one WID onto every invoice line.
    expect(buildEmailWorktags(result)?.eventWid).toBe(MAIN_2026);
    expect(formatEmailWorktagNotes(result)).toContain('Event: 26 Lakeside Jr. Skills Series (resolved: 2026 Lakeside Junior Skills Series)');
    expect(getDocumentsByType).toHaveBeenCalledWith({}, 'event');
  });

  it('keeps the section copy when the email names that section', async () => {
    const result = await enrich(matching(event('26ZB Lakeside Jr. Skills Series', SECTION_2026)), email('Event: 26ZB Lakeside Jr. Skills Series'));

    expect(buildEmailWorktags(result)?.eventWid).toBe(SECTION_2026);
    expect(formatEmailWorktagNotes(result)).toContain('(resolved: 26ZB-Lakeside_Jr_Skills_Series)');
  });

  it('does not apply an event for another year than the email names', async () => {
    const result = await enrich(matching(event('2024 Lakeside Junior Skills Series', 'wid-main-2025')));

    expect(buildEmailWorktags(result)?.eventWid).toBeNull();
    expect(formatEmailWorktagNotes(result)).toContain('Event: 2024 Lakeside Junior Skills Series (no Workday match found)');
  });

  it('uses the invoice date year when the email names no year, and says when several events fit', async () => {
    const withYear = await enrich(matching(event('Lakeside Jr Skills Series', 'wid-main-2025')), email('Event: Lakeside Jr Skills Series'), '2026-11-13');
    expect(buildEmailWorktags(withYear)?.eventWid).toBe(MAIN_2026);

    const noYear = await enrich(matching(event('Lakeside Jr Skills Series', 'wid-main-2025')), email('Event: Lakeside Jr Skills Series'), null);
    expect(buildEmailWorktags(noYear)?.eventWid).toBeNull();
    expect(formatEmailWorktagNotes(noYear)).toContain('Event: Lakeside Jr Skills Series (not applied; several events fit: 2025 Lakeside Junior Skills Series, 2026 Lakeside Junior Skills Series)');
  });

  it('checks an event on a budget split the same way', async () => {
    const result = await enrich(matching(null, event('26 Lakeside Jr. Skills Series', SECTION_2026)));

    expect(result.emailBudgetSplits?.[0].event).toMatchObject({ workdayId: MAIN_2026 });
    expect(result.emailBudgetSplits?.[1].event).toBeNull();
  });

  it('leaves the event unresolved when the tool had no recommendation and several events fit', async () => {
    const result = await enrich(matching(event('Lakeside Jr Skills Series', null)), email('Event: Lakeside Jr Skills Series'), null);

    expect(buildEmailWorktags(result)?.eventWid).toBeNull();
    expect(formatEmailWorktagNotes(result)).toContain('not applied; several events fit');
  });

  it('resolves each budget split\'s event on its own', async () => {
    const modelResult = matching(event('26 Lakeside Jr. Skills Series', SECTION_2026), event('26ZB Lakeside Jr. Skills Series', 'wid-zb-27'));
    const result = await enrich(modelResult, email('Event: 26 Lakeside Jr. Skills Series; Budget A: 26ZB Lakeside Jr. Skills Series'));

    expect(result.emailWorktags?.event).toMatchObject({ workdayId: MAIN_2026 });
    expect(result.emailBudgetSplits?.[0].event).toMatchObject({ workdayId: SECTION_2026 });
  });

  it('ignores cache rows with no usable name', async () => {
    (getDocumentsByType as jest.Mock).mockResolvedValue([
      ...CACHE,
      { workday_id: 'wid-blank', content: '', metadata: {} },
      { workday_id: 'wid-no-prefix', content: '2026 Harbor Open Championship', metadata: null },
    ]);

    const result = await enrich(matching(event('26 Lakeside Jr. Skills Series', SECTION_2026)));

    expect(buildEmailWorktags(result)?.eventWid).toBe(MAIN_2026);
  });

  it('reads an event named only in an Intercom admin note', async () => {
    const note = 'AP note: code this to the 26 Lakeside Jr. Skills Series.';
    const result = await enrich(matching(event('26 Lakeside Jr. Skills Series', null)), email('Please see the attached invoice.', note));

    const prompt = JSON.stringify((getAiResponse as jest.Mock).mock.calls[0][0].messages);
    expect(prompt).toContain(note);
    expect(buildEmailWorktags(result)?.eventWid).toBe(MAIN_2026);
  });

  it('keeps the model\'s event and skips the lookup when the email names no event', async () => {
    const result = await enrich(matching(null));

    expect(getDocumentsByType).not.toHaveBeenCalled();
    expect(result.emailWorktags?.event).toBeNull();
  });

  it('keeps the model\'s event when the event cache cannot be read', async () => {
    (getDocumentsByType as jest.Mock).mockRejectedValue(new Error('db down'));

    const result = await enrich(matching(event('26 Lakeside Jr. Skills Series', SECTION_2026)));

    expect(result.emailWorktags?.event).toEqual({ extracted: '26 Lakeside Jr. Skills Series', workdayId: SECTION_2026 });
  });
});
