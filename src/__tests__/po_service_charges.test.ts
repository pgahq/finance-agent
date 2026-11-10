import { placeChargesOnPoServiceLines } from '../lib/header_charges.js';
import {
  buildFinalInvoiceLines,
  prepareInvoiceCharges,
  reconcileSubmittedCharges,
  splitFreightLines,
  unlinkedPoRowsNote,
  unlinkRowsOutsideTheirPoLine,
  type FinalInvoiceLine,
} from '../lib/invoice_lines.js';
import { lineSubtotalReviewNote, lineSubtotalShortfallCents, reviewAmountDueGapCents } from '../lib/partial_payment.js';
import { isPoServiceLine, uniqueServiceLineMatches } from '../lib/po_service_lines.js';
import { getAiResponse } from '../lib/ai.js';
import { invoiceOcrPrompt } from '../prompts/invoice_ocr_prompt.js';
import { mergeInvoiceLinesPrompt } from '../prompts/merge_invoice_lines_prompt.js';
import {
  DELIVERY_LINE,
  ENVIRONMENTAL_LINE,
  GOODS_LINE,
  PICKUP_LINE,
  SURCHARGE_LINE,
  supin472110DeliveryRow,
  supin472110DieselRows,
  supin472110Header,
  supin472110PickupRow,
  supin472110PoLines,
  supin472110ProductionHeader,
  supin472110ProductionRows,
  supin472110Rows,
  supin472110TowerRows,
} from './fixtures/supin_472110.js';

jest.mock('@pga/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));
jest.mock('../lib/ai.js', () => ({
  getAiResponse: jest.fn(),
}));

const mockGetAiResponse = getAiResponse as jest.MockedFunction<typeof getAiResponse>;
const poLines = supin472110PoLines as any[];
const amountDue = supin472110Header.extractedAmountDue;
const tax = supin472110Header.extractedTaxAmount;

describe('SUPIN-472110 fixture', () => {
  it('prints eleven rows that add to the Sales/Misc and rental subtotals', () => {
    const cents = (rows: Array<{ totalPrice?: string | null }>) =>
      rows.reduce((total, row) => total + Math.round(Number(String(row.totalPrice).replace(/[$,]/g, '')) * 100), 0);
    expect(supin472110Rows).toHaveLength(11);
    expect(cents(supin472110TowerRows)).toBe(134800);
    expect(cents(supin472110Rows) - cents(supin472110DieselRows)).toBe(185150);
    expect(cents(supin472110Rows) + 15695).toBe(213291);
  });

  it('is the shape production OCR returned: eight rows, one freight amount, and the surcharge as a tax row', () => {
    expect(supin472110ProductionRows).toHaveLength(8);
    expect(supin472110ProductionHeader.extractedFreightAmount).toBe('$456.32');
    expect(supin472110ProductionHeader.extractedOtherCharges).toEqual([{ label: 'PROPERTY TAX SURCHARGE [DRSURAZ/MCI]', amount: '$20.22' }]);
  });
});

describe('uniqueServiceLineMatches', () => {
  it('matches delivery, pickup, surcharge, and environmental rows to their service lines', () => {
    const matches = uniqueServiceLineMatches(supin472110Rows.map(row => row.description), poLines);
    expect(Object.fromEntries(matches)).toEqual({
      4: SURCHARGE_LINE,
      5: ENVIRONMENTAL_LINE,
      9: DELIVERY_LINE,
      10: PICKUP_LINE,
    });
  });

  it('never matches a goods line ordered by quantity', () => {
    expect(isPoServiceLine(poLines[0])).toBe(false);
    expect(uniqueServiceLineMatches(['LIGHT TOWER,4-7KW LED VERT MAST'], poLines).size).toBe(0);
  });

  it('skips a description that fits two service lines, or a line two descriptions fit', () => {
    const twoDeliveries = [
      ...poLines,
      { ...poLines[3], purchaseOrderLineId: 'ORDER_SERVICE_LINE-3-99999', lineOrder: 6 },
    ];
    expect(uniqueServiceLineMatches(['DELIVERY CHARGE'], twoDeliveries).size).toBe(0);
    expect(uniqueServiceLineMatches(['DELIVERY CHARGE', 'DELIVERY CHARGE - second truck'], poLines).size).toBe(0);
  });

  it('leaves a short or generic description alone and skips lines already fully invoiced', () => {
    expect(uniqueServiceLineMatches(['Fee', 'CHARGE'], poLines).size).toBe(0);
    const consumed = poLines.map(line => (line.purchaseOrderLineId === DELIVERY_LINE ? { ...line, availableForInvoicing: false } : line));
    expect(uniqueServiceLineMatches(['DELIVERY CHARGE'], consumed).size).toBe(0);
  });
});

describe('placeChargesOnPoServiceLines', () => {
  const place = (overrides: Record<string, unknown> = {}) => placeChargesOnPoServiceLines({
    lines: supin472110Rows,
    otherCharges: null,
    freightAmount: null,
    freightLabel: null,
    taxAmount: tax,
    poLines,
    ...overrides,
  });

  it('pins the delivery, pickup, surcharge, and environmental rows to their PO service lines', () => {
    const placed = place();
    const pinned = Object.fromEntries(placed.lines.filter(line => line.pinnedPurchaseOrderLineId).map(line => [line.description, line.pinnedPurchaseOrderLineId]));
    expect(pinned).toEqual({
      'PROPERTY TAX SURCHARGE [DRSURAZ/MCI]': SURCHARGE_LINE,
      'ENVIRONMENTAL SERVICE CHARGE [ENV/MCI]': ENVIRONMENTAL_LINE,
      'DELIVERY CHARGE': DELIVERY_LINE,
      'PICKUP CHARGE': PICKUP_LINE,
    });
    expect(placed.lines).toHaveLength(11);
    expect(placed.addedLines).toBe(0);
  });

  it('keeps pinned delivery out of header freight, so lines + tax equal the amount due with no freight', () => {
    const { lines } = place();
    const { merchandiseLines, freightLines, freightAmountFromLines } = splitFreightLines(lines);
    expect(freightLines).toEqual([]);
    expect(freightAmountFromLines).toBeUndefined();
    expect(merchandiseLines).toHaveLength(11);
    const charges = prepareInvoiceCharges(lines, { amountDue, tax }, { allowFreightAsLines: true, removeDuplicates: true });
    expect(charges.freightAsLines).toBe(false);
    expect(charges.lines).toHaveLength(11);
    expect(reconcileSubmittedCharges(charges.lines, { amountDue, freight: undefined, tax }, { removeDuplicates: false }).unreconciled).toBeUndefined();
  });

  it('without the PO, an unpinned delivery row still goes to header freight as before', () => {
    const { lines } = place({ poLines: undefined });
    expect(lines.some(line => line.pinnedPurchaseOrderLineId)).toBe(false);
    const { freightLines, freightAmountFromLines } = splitFreightLines(lines);
    expect(freightLines.map(line => line.description)).toEqual(['DELIVERY CHARGE']);
    expect(freightAmountFromLines).toBe(228.16);
  });

  it('turns a printed other charge that names a service line into a row on it, and keeps it out of header tax', () => {
    const placed = place({
      lines: supin472110ProductionRows,
      otherCharges: supin472110ProductionHeader.extractedOtherCharges,
      freightAmount: '$456.32',
      freightLabel: 'DELIVERY CHARGE and PICKUP CHARGE',
    });
    expect(placed.otherCharges).toEqual([]);
    expect(placed.addedLines).toBe(1);
    expect(placed.lines[placed.lines.length - 1]).toMatchObject({
      description: 'PROPERTY TAX SURCHARGE [DRSURAZ/MCI]',
      quantity: 1,
      totalPrice: '$20.22',
      pinnedPurchaseOrderLineId: SURCHARGE_LINE,
    });
    expect(placed.placed.map(item => item.purchaseOrderLineId)).toEqual([ENVIRONMENTAL_LINE, SURCHARGE_LINE]);
  });

  it('leaves a combined freight amount on the header when no row names the service lines', () => {
    const placed = place({
      lines: supin472110ProductionRows,
      otherCharges: null,
      freightAmount: '$456.32',
      freightLabel: 'DELIVERY CHARGE and PICKUP CHARGE',
    });
    expect(placed.freightAmount).toBe('$456.32');
    expect(placed.freightLabel).toBe('DELIVERY CHARGE and PICKUP CHARGE');
  });

  it('drops header freight that is the same delivery and pickup rows read twice', () => {
    const placed = place({
      lines: [...supin472110TowerRows, supin472110DeliveryRow, supin472110PickupRow],
      freightAmount: '$228.16',
      freightLabel: 'Delivery',
    });
    expect(placed.freightAmount).toBeNull();
    expect(placed.freightLabel).toBeNull();
  });

  it('drops combined header freight when only delivery matches a PO line and pickup stays an unplaced row', () => {
    const placed = place({
      lines: [...supin472110TowerRows, supin472110DeliveryRow, supin472110PickupRow],
      poLines: poLines.filter(line => line.purchaseOrderLineId !== PICKUP_LINE),
      freightAmount: '$456.32',
      freightLabel: 'DELIVERY CHARGE and PICKUP CHARGE',
    });
    expect(placed.placed.map(item => item.purchaseOrderLineId)).toEqual([DELIVERY_LINE]);
    expect(placed.freightAmount).toBeNull();
    expect(placed.freightLabel).toBeNull();
  });

  it('keeps header freight that matches none of the freight rows even when one row is placed', () => {
    const placed = place({
      lines: [...supin472110TowerRows, supin472110DeliveryRow, supin472110PickupRow],
      poLines: poLines.filter(line => line.purchaseOrderLineId !== PICKUP_LINE),
      freightAmount: '$300.00',
      freightLabel: 'Freight',
    });
    expect(placed.freightAmount).toBe('$300.00');
  });

  it('does not place a charge that restates the header tax or a credit row', () => {
    const credit = { ...supin472110DeliveryRow, totalPrice: '-$228.16' };
    const placed = place({
      lines: [credit],
      otherCharges: [{ label: 'Environmental Service Charge', amount: tax }],
    });
    expect(placed.lines).toEqual([credit]);
    expect(placed.otherCharges).toEqual([{ label: 'Environmental Service Charge', amount: tax }]);
  });

  it('is a no-op without PO lines', () => {
    const placed = place({ poLines: undefined, otherCharges: supin472110ProductionHeader.extractedOtherCharges });
    expect(placed.lines).toBe(supin472110Rows);
    expect(placed.otherCharges).toEqual(supin472110ProductionHeader.extractedOtherCharges);
  });
});

describe('amount due explains the Agreement Subtotal gap', () => {
  const subtotal = supin472110Header.extractedLineSubtotal;
  const gap = (lines: typeof supin472110Rows, charges: { freight?: string | null; otherCharges?: Array<{ label: string; amount: string }> | null }) =>
    reviewAmountDueGapCents({ lines, amountDue, tax, taxLabel: 'Tax', ...charges });

  it('the production read looks like a $352.08 row that was not read until the amount due is counted', () => {
    expect(lineSubtotalReviewNote(supin472110ProductionRows, subtotal)).toContain('The $352.08 difference may be a row that was not read.');
    expect(lineSubtotalShortfallCents(supin472110ProductionRows, subtotal)).toBe(35208);
  });

  it('suppresses the note when rows, header freight, the printed surcharge, and tax reach the amount due', () => {
    const dueGap = gap(supin472110ProductionRows, {
      freight: supin472110ProductionHeader.extractedFreightAmount,
      otherCharges: supin472110ProductionHeader.extractedOtherCharges,
    });
    expect(dueGap).toBe(0);
    expect(lineSubtotalReviewNote(supin472110ProductionRows, subtotal, dueGap)).toBeUndefined();
  });

  it('suppresses the note for the eleven printed rows, whose fuel rows sit outside the subtotal', () => {
    const dueGap = gap(supin472110Rows, {});
    expect(dueGap).toBe(0);
    expect(lineSubtotalReviewNote(supin472110Rows, subtotal, dueGap)).toBeUndefined();
  });

  it('counts the surcharge once when it is billed as a row on its PO line instead of an other charge', () => {
    const placed = placeChargesOnPoServiceLines({
      lines: supin472110ProductionRows,
      otherCharges: supin472110ProductionHeader.extractedOtherCharges,
      freightAmount: supin472110ProductionHeader.extractedFreightAmount,
      freightLabel: supin472110ProductionHeader.extractedFreightLabel,
      taxAmount: tax,
      poLines,
    });
    expect(placed.otherCharges).toEqual([]);
    expect(gap(placed.lines as typeof supin472110Rows, { freight: placed.freightAmount, otherCharges: placed.otherCharges })).toBe(0);
  });
});

describe('buildFinalInvoiceLines for SUPIN-472110', () => {
  const merged = (description: string, extendedAmount: number, purchaseOrderLineId: string | null, extra: Record<string, unknown> = {}) => ({
    lineOrder: 0,
    description,
    memo: null,
    quantity: 1,
    unitCost: extendedAmount,
    extendedAmount,
    costCenterId: 'CC-Member_Championships',
    fundId: 'FUND-General_Fund_Unrestricted',
    spendCategoryId: 'SC-Equipment_Rental',
    lineOfBusinessId: 'LOB-Member_Championships',
    eventId: null,
    shipToAddressId: null,
    purchaseOrderLineId,
    hasDiscount: false,
    ...extra,
  });
  const placedRows = placeChargesOnPoServiceLines({
    lines: supin472110Rows,
    otherCharges: null,
    freightAmount: null,
    freightLabel: null,
    taxAmount: tax,
    poLines,
  }).lines;

  // The merge as production returned it: every row that is not the environmental charge went on the goods line.
  const productionMerge = () => placedRows.map((row, index) => {
    const amount = Number(String(row.totalPrice).replace(/[$,]/g, ''));
    return merged(row.description, amount, index === 5 ? ENVIRONMENTAL_LINE : GOODS_LINE, { lineOrder: index + 1 });
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('links delivery, pickup, and the surcharge to their service lines and leaves fuel unlinked', async () => {
    mockGetAiResponse.mockResolvedValue({ lines: productionMerge() } as any);

    const built = await buildFinalInvoiceLines(
      placedRows,
      poLines,
      undefined,
      {},
      undefined,
      undefined,
      true,
      { invoiceDate: '2026-10-27', servicePeriod: '10/19/26 09:00 AM - 10/26/26 09:35 AM' }
    );

    const byDescription = (description: string) => built.lines.filter(line => line.description === description);
    expect(built.lines.slice(0, 4).map(line => line.purchaseOrderLineId)).toEqual([GOODS_LINE, GOODS_LINE, GOODS_LINE, GOODS_LINE]);
    expect(byDescription('PROPERTY TAX SURCHARGE [DRSURAZ/MCI]')[0]).toMatchObject({ purchaseOrderLineId: SURCHARGE_LINE, pinnedPurchaseOrderLineId: SURCHARGE_LINE });
    expect(byDescription('ENVIRONMENTAL SERVICE CHARGE [ENV/MCI]')[0]).toMatchObject({ purchaseOrderLineId: ENVIRONMENTAL_LINE });
    expect(byDescription('DELIVERY CHARGE')[0]).toMatchObject({ purchaseOrderLineId: DELIVERY_LINE, pinnedPurchaseOrderLineId: DELIVERY_LINE, extendedAmount: 228.16 });
    expect(byDescription('PICKUP CHARGE')[0]).toMatchObject({ purchaseOrderLineId: PICKUP_LINE, pinnedPurchaseOrderLineId: PICKUP_LINE, extendedAmount: 228.16 });
    const diesel = built.lines.filter(line => /DIESEL/.test(line.description));
    expect(diesel.map(line => line.purchaseOrderLineId)).toEqual([null, null, null]);
    expect(diesel.every(line => line.costCenterId === 'CC-Member_Championships' && line.spendCategoryId === 'SC-Equipment_Rental')).toBe(true);
    expect(built.unlinkedPoRows).toHaveLength(3);
    expect(unlinkedPoRowsNote(built.unlinkedPoRows)).toBe(
      '"DIESEL FUEL [DSL/MCI]", "DYED DIESEL [DYEDDSL/MCI]", "DIESEL FUEL [DSL/MCI]" are not linked to a PO line: no line on the PO describes them, and the rows on the PO line chosen for them bill more than its amount.'
    );
  });

  it('reports rows the model left unlinked while the PO has open lines, and none when the PO has no open line', async () => {
    mockGetAiResponse.mockResolvedValue({ lines: [merged('Setup fee', 50, null, { lineOrder: 1 })] } as any);
    const row = { description: 'Setup fee', quantity: 1, unitCost: '$50.00', totalPrice: '$50.00' };

    const open = await buildFinalInvoiceLines([row], poLines, undefined, {}, undefined, undefined, true, { invoiceDate: '2026-10-27', servicePeriod: null });
    expect(open.modelUnlinkedPoRows).toEqual([{ lineOrder: 1, description: 'Setup fee' }]);

    const none = await buildFinalInvoiceLines([row], [], undefined, {}, undefined, undefined, true, { invoiceDate: '2026-10-27', servicePeriod: null });
    expect(none.modelUnlinkedPoRows).toBeUndefined();
  });

  it('keeps the pinned links even when the merge returns no PO line at all', async () => {
    mockGetAiResponse.mockResolvedValue({ lines: placedRows.map((row, index) => merged(row.description, Number(String(row.totalPrice).replace(/[$,]/g, '')), null, { lineOrder: index + 1 })) } as any);

    const built = await buildFinalInvoiceLines(placedRows, poLines, undefined, {}, undefined, undefined, true, { invoiceDate: '2026-10-27', servicePeriod: null });

    expect(built.lines.filter(line => line.pinnedPurchaseOrderLineId).map(line => line.purchaseOrderLineId).sort()).toEqual(
      [DELIVERY_LINE, ENVIRONMENTAL_LINE, PICKUP_LINE, SURCHARGE_LINE].sort()
    );
    expect(built.unlinkedPoRows).toBeUndefined();
  });

  it('keeps pinned links on the extracted-line fallback when the merge model fails', async () => {
    mockGetAiResponse.mockRejectedValue(new Error('model unavailable'));

    const built = await buildFinalInvoiceLines(placedRows, poLines, undefined, {}, undefined, undefined, true, { invoiceDate: '2026-10-27', servicePeriod: null });

    expect(built.lines.find(line => line.description === 'DELIVERY CHARGE')).toMatchObject({ purchaseOrderLineId: DELIVERY_LINE, pinnedPurchaseOrderLineId: DELIVERY_LINE });
    expect(splitFreightLines(built.lines).freightLines).toEqual([]);
  });

  it('does not send the pin to the merge model', async () => {
    mockGetAiResponse.mockResolvedValue({ lines: productionMerge() } as any);

    await buildFinalInvoiceLines(placedRows, poLines, undefined, {}, undefined, undefined, true, { invoiceDate: '2026-10-27', servicePeriod: null });

    const input = JSON.parse((mockGetAiResponse.mock.calls[0][0] as any).messages[0].content);
    expect(input.extractedInvoiceLines).toHaveLength(11);
    expect(JSON.stringify(input)).not.toContain('pinnedPurchaseOrderLineId');
  });
});

describe('unlinkRowsOutsideTheirPoLine', () => {
  const parsed = (overrides: Record<string, unknown> = {}) => ({
    purchaseOrderLineId: GOODS_LINE,
    description: 'LIGHT TOWER,4-7KW LED VERT MAST',
    memo: null,
    extendedAmount: 1348,
    ...overrides,
  }) as any;
  const line = (description: string, extendedAmount: number, purchaseOrderLineId: string | null = GOODS_LINE): FinalInvoiceLine => ({
    lineOrder: 1,
    description,
    extendedAmount,
    quantity: 1,
    unitCost: extendedAmount,
    purchaseOrderLineId,
  });

  it('unlinks only a row that shares no wording with a PO line billed past its amount', () => {
    const lines = [line('LIGHT TOWER A', 674), line('LIGHT TOWER B', 674), line('DIESEL FUEL', 27.94)];
    const result = unlinkRowsOutsideTheirPoLine(lines, [parsed()]);
    expect(result.lines.map(item => item.purchaseOrderLineId)).toEqual([GOODS_LINE, GOODS_LINE, null]);
    expect(result.unlinked).toEqual([{ lineOrder: 1, description: 'DIESEL FUEL' }]);
  });

  it('keeps a row whose PO line is not over-billed, even when the wording differs', () => {
    const result = unlinkRowsOutsideTheirPoLine([line('Professional services', 1000)], [parsed()]);
    expect(result.unlinked).toEqual([]);
    expect(result.lines[0].purchaseOrderLineId).toBe(GOODS_LINE);
  });

  it('keeps an over-billed row that shares a word with its PO line', () => {
    const result = unlinkRowsOutsideTheirPoLine([line('LIGHT TOWER rental extension', 1500)], [parsed()]);
    expect(result.unlinked).toEqual([]);
  });

  it('keeps every link on a single broad PO line that no row describes, so Workday still sees the overbilling', () => {
    const broad = parsed({ description: 'Annual maintenance', extendedAmount: 1000 });
    const lines = [line('Labor', 600), line('Parts', 500)];
    const result = unlinkRowsOutsideTheirPoLine(lines, [broad]);
    expect(result.unlinked).toEqual([]);
    expect(result.lines.map(item => item.purchaseOrderLineId)).toEqual([GOODS_LINE, GOODS_LINE]);
  });

  it('keeps a PO line with no amount and never touches a pinned row or a credit', () => {
    expect(unlinkRowsOutsideTheirPoLine([line('DIESEL FUEL', 5000)], [parsed({ extendedAmount: null })]).unlinked).toEqual([]);
    const pinned = { ...line('DIESEL FUEL', 5000), pinnedPurchaseOrderLineId: GOODS_LINE };
    expect(unlinkRowsOutsideTheirPoLine([pinned], [parsed()]).unlinked).toEqual([]);
    const credit = { ...line('DIESEL FUEL', -5000), hasDiscount: true };
    expect(unlinkRowsOutsideTheirPoLine([credit], [parsed()]).unlinked).toEqual([]);
  });

  it('writes a note for rows the merge left without a link when the PO has open lines', () => {
    expect(unlinkedPoRowsNote([], [{ description: 'Setup fee' }])).toBe(
      '"Setup fee" is not linked to a PO line: no open line on the PO matched it, so it was coded from the closest PO line without a link.'
    );
  });

  it('returns no note when nothing was unlinked', () => {
    expect(unlinkedPoRowsNote([])).toBeUndefined();
    expect(unlinkedPoRowsNote(undefined)).toBeUndefined();
  });
});

describe('prompts', () => {
  it('tells the merge model to borrow worktags for an undescribed row but leave the PO line link empty', () => {
    expect(mergeInvoiceLinesPrompt).toContain('leave its purchaseOrderLineId null');
    expect(mergeInvoiceLinesPrompt).toContain('fuel on a light tower line');
    expect(mergeInvoiceLinesPrompt).toContain('Match a delivery, pickup, surcharge, or environmental row to the PO service line with that name');
  });

  it('asks OCR to return a priced surcharge row as a line, not a tax row', () => {
    expect(invoiceOcrPrompt).toContain('is a priced line item, not an additional tax row');
    expect(invoiceOcrPrompt).toContain('When the invoice prints more than one separate delivery, pickup, return, freight, or similar transport charge as priced rows');
  });
});
