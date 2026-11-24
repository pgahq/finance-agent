import { placeChargesOnPoServiceLines } from '../lib/header_charges.js';
import {
  freightFromRowsMessage,
  prepareInvoiceCharges,
  reconcileSubmittedCharges,
  resolveHeaderChargeAmounts,
  splitFreightLines,
  type ExtractedInvoiceLine,
} from '../lib/invoice_lines.js';

// A fictional fuel invoice shaped like SUPIN-477534: two delivery rows whose labels carry the supplier's own
// charge code, a hazmat fee that names delivery, header freight not printed, and a separately printed tax.
const row = (description: string, quantity: number, unitCost: string, totalPrice: string): ExtractedInvoiceLine => ({
  description,
  descriptionCells: null,
  quantity,
  unitCost,
  totalPrice,
  hasDiscount: false,
});

const unleaded = row('Unleaded Fuel', 1, '640.00', '$640.00');
const diesel = row('Diesel Fuel', 1, '301.25', '$301.25');
const delivery = row('ABC - Delivery Charge', 4, '40.00', '$160.00');
const hazmatDelivery = row('XYZ - Hazmat/Environmental Delivery Fee', 1, '10.00', '$10.00');

const amountDue = '$1,125.35';
const tax = '$14.10';

describe('delivery rows with a supplier charge code', () => {
  it('sums both rows into header freight and keeps the fuel as the only lines', () => {
    const rows = [unleaded, diesel, delivery, hazmatDelivery];
    const split = splitFreightLines(rows);
    expect(split.merchandiseLines).toEqual([unleaded, diesel]);
    expect(split.freightLines).toEqual([delivery, hazmatDelivery]);
    expect(split.freightAmountFromLines).toBe(170);

    const headers = resolveHeaderChargeAmounts({
      extractedFreightAmount: null,
      extractedFreightLabel: null,
      extractedTaxAmount: tax,
      extractedTaxLabel: 'Sales Tax',
      freightAmountFromLines: split.freightAmountFromLines,
    });
    expect(headers.extractedFreightAmount).toBe('170');
    expect(headers.extractedTaxAmount).toBe('$14.10');

    const charges = prepareInvoiceCharges(rows, { amountDue, freight: headers.extractedFreightAmount, tax }, { allowFreightAsLines: true, removeDuplicates: true });
    expect(charges.freightAsLines).toBe(false);
    expect(charges.lines).toEqual([unleaded, diesel]);
    expect(reconcileSubmittedCharges(charges.lines, { amountDue, freight: charges.freightAmount, tax }, { removeDuplicates: false }).unreconciled).toBeUndefined();
  });

  it('keeps a bare hazmat or environmental fee and a pickup row as lines', () => {
    const hazmat = row('XYZ - Hazmat Fee', 1, '10.00', '$10.00');
    const environmental = row('Environmental Surcharge', 1, '8.00', '$8.00');
    const pickup = row('ABC - Pickup Charge', 1, '40.00', '$40.00');
    const split = splitFreightLines([unleaded, delivery, hazmat, environmental, pickup]);
    expect(split.freightLines).toEqual([delivery]);
    expect(split.merchandiseLines).toEqual([unleaded, hazmat, environmental, pickup]);
    expect(split.freightAmountFromLines).toBe(160);
  });

  it('keeps an item-coded row and a delivery-named rental as lines', () => {
    const itemCoded = row('SKU123 - Delivery Charge', 1, '25.00', '$25.00');
    const rental = row('ABC - Delivery truck rental', 1, '90.00', '$90.00');
    expect(splitFreightLines([itemCoded, rental]).freightLines).toEqual([]);
  });

  it('keeps a delivery-tax row out of header freight so the tax handling still sees it', () => {
    expect(splitFreightLines([unleaded, row('ABC - Delivery Tax', 1, '2.00', '$2.00')]).freightLines).toEqual([]);
  });

  it('accepts any two-to-four-letter code before a delivery row, and still keeps merchandise lookalikes as lines', () => {
    expect(splitFreightLines([row('AB - Delivery Fee', 1, '9.00', '$9.00')]).freightAmountFromLines).toBe(9);
    expect(splitFreightLines([row('AB - Delivery Fee Schedule', 1, '9.00', '$9.00'), row('AB - Freight Container', 1, '9.00', '$9.00')]).freightLines).toEqual([]);
  });
});

describe('delivery rows on a PO', () => {
  const poLines = [
    { purchaseOrderLineId: 'POL-GOODS', description: 'Bulk fuel', quantity: 1000, availableForInvoicing: true },
    { purchaseOrderLineId: 'POL-DELIVERY', description: 'Delivery Charge', quantity: null, availableForInvoicing: true },
  ];
  const place = (overrides: Record<string, unknown> = {}) => placeChargesOnPoServiceLines({
    lines: [unleaded, diesel, delivery, hazmatDelivery],
    otherCharges: null,
    freightAmount: null,
    freightLabel: null,
    taxAmount: tax,
    poLines: poLines as any[],
    ...overrides,
  });

  it('keeps the row that names a PO delivery service line as a pinned line, and freights the other', () => {
    const placed = place();
    expect(placed.lines.filter(line => line.pinnedPurchaseOrderLineId).map(line => line.description)).toEqual(['ABC - Delivery Charge']);
    const split = splitFreightLines(placed.lines);
    expect(split.freightLines.map(line => line.description)).toEqual(['XYZ - Hazmat/Environmental Delivery Fee']);
    expect(split.freightAmountFromLines).toBe(10);
    expect(split.merchandiseLines.map(line => line.description)).toEqual(['Unleaded Fuel', 'Diesel Fuel', 'ABC - Delivery Charge']);
  });

  it('sends both rows to header freight when the PO has no delivery service line', () => {
    const placed = place({ poLines: [poLines[0]] });
    expect(placed.lines.some(line => line.pinnedPurchaseOrderLineId)).toBe(false);
    const split = splitFreightLines(placed.lines);
    expect(split.freightLines).toHaveLength(2);
    expect(split.freightAmountFromLines).toBe(170);
  });
});

describe('freightFromRowsMessage', () => {
  const rows = [unleaded, diesel, delivery, hazmatDelivery];

  it('names the rows that were summed into freight the invoice never printed as one amount', () => {
    expect(freightFromRowsMessage(rows, { freight: '170', headerFreightRead: false })).toBe(
      'Freight $170.00 is the sum of these 2 freight rows, which are not invoice lines: "ABC - Delivery Charge" ($160.00), "XYZ - Hazmat/Environmental Delivery Fee" ($10.00).'
    );
  });

  it('says nothing when the header printed freight, a single row carries it, or the submitted freight is another amount', () => {
    expect(freightFromRowsMessage(rows, { freight: '170', headerFreightRead: true })).toBeUndefined();
    expect(freightFromRowsMessage([unleaded, delivery], { freight: '160', headerFreightRead: false })).toBeUndefined();
    expect(freightFromRowsMessage(rows, { freight: '25', headerFreightRead: false })).toBeUndefined();
    expect(freightFromRowsMessage(rows, { freight: undefined, headerFreightRead: false })).toBeUndefined();
  });

  it('counts only the rows with a readable amount and names the others, so an unreadable freight row is never hidden', () => {
    const unpriced = { description: 'QRS - Delivery Fee', descriptionCells: null, quantity: null, unitCost: null, totalPrice: null, hasDiscount: false } as ExtractedInvoiceLine;
    expect(splitFreightLines([unleaded, delivery, hazmatDelivery, unpriced]).freightLines).toHaveLength(3);
    expect(freightFromRowsMessage([unleaded, delivery, hazmatDelivery, unpriced], { freight: '170', headerFreightRead: false })).toBe(
      'Freight $170.00 is the sum of these 2 freight rows, which are not invoice lines: "ABC - Delivery Charge" ($160.00), "XYZ - Hazmat/Environmental Delivery Fee" ($10.00).'
      + ' Also left out of the lines with no positive readable amount, so check them against the document: "QRS - Delivery Fee" ($0.00).'
    );
  });

  it('reads a row priced only by quantity and unit cost, and says nothing for a credit that makes the sum another amount', () => {
    const byUnitCost = { ...delivery, totalPrice: null };
    expect(splitFreightLines([unleaded, byUnitCost, hazmatDelivery]).freightAmountFromLines).toBe(170);
    const credit = { ...hazmatDelivery, description: 'XYZ - Delivery Fee Credit', totalPrice: '-$10.00', unitCost: '-10.00' };
    expect(freightFromRowsMessage([unleaded, delivery, credit], { freight: '170', headerFreightRead: false })).toBeUndefined();
  });
});
