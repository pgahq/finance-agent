import { applyPrintedTaxCharges, isTaxLikeChargeLabel, placeSummaryCharges, settlePlacedSummaryLines } from '../lib/header_charges.js';
import { chargeReconciliationMessages, prepareInvoiceCharges, reconcileSubmittedCharges, type FinalInvoiceLine } from '../lib/invoice_lines.js';

// SUPIN-467011: two lines, Sales Tax $28.26, a printed EnvChg tax row of $17.00, amount due $387.76.
const lines = [
  { description: '4001 - Concierge Dry Clean & Laundry Ticket - KING', quantity: null, unitCost: '180.50', totalPrice: '180.50', hasDiscount: false },
  { description: '4001 - Concierge Dry Clean & Laundry Ticket - KARLESKNT', quantity: null, unitCost: '162.00', totalPrice: '162.00', hasDiscount: false },
];
const base = { amountDue: '$387.76', lines, tax: '$28.26', taxLabel: 'Sales Tax', taxCleared: false };
const envChg = { label: 'EnvChg Tax', amount: '$17.00' };

describe('isTaxLikeChargeLabel', () => {
  it.each(['5% EnvChg Tax', 'EnvChg Tax', 'Env Chg Tax', 'Environmental Tax 5%', 'Tax - EnvChg', 'Sales Tax', 'State Tax', 'VAT'])(
    'treats %s as tax-like because it says tax', (label) => expect(isTaxLikeChargeLabel(label)).toBe(true)
  );

  it.each(['EnvChg', 'Environmental Charge', 'Recycling Fee', 'Fuel Surcharge', 'Service Charge', 'Delivery Surcharge', 'Subtotal', 'Balance Due', 'Tax ID', 'Tax Exempt', 'Taxable Amount', '', null])(
    'does not treat %s as tax-like', (label) => expect(isTaxLikeChargeLabel(label)).toBe(false)
  );
});

describe('applyPrintedTaxCharges', () => {
  it('today: leaves a $17.00 gap that the amount check reports', () => {
    const reconciled = reconcileSubmittedCharges(lines, { amountDue: '$387.76', tax: '$28.26' });
    expect(chargeReconciliationMessages(reconciled)).toEqual([
      'Lines $342.50 + freight $0.00 + tax $28.26 = $370.76, but the amount due is $387.76. Review lines and header charges.',
    ]);
  });

  it('adds the printed EnvChg to header tax so lines + freight + tax equal the amount due', () => {
    const applied = applyPrintedTaxCharges({ ...base, charges: [envChg] });

    expect(applied.taxAmount).toBe('45.26');
    expect(applied.taxCleared).toBe(false);
    expect(applied.message).toBe('Added "EnvChg Tax" $17.00 to header Tax_Amount so lines, freight, and tax equal the amount due.');
    expect(applied.breakdown).toBe('"Sales Tax" $28.26 + "EnvChg Tax" $17.00');
    const prepared = prepareInvoiceCharges(lines, { amountDue: '$387.76', tax: applied.taxAmount }, { allowFreightAsLines: true, removeDuplicates: true });
    expect(prepared.reconciliation.unreconciled).toBeUndefined();
    expect(reconcileSubmittedCharges(lines, { amountDue: '$387.76', tax: applied.taxAmount }).unreconciled).toBeUndefined();
  });

  it('applies the label as printed on invoice 20256324, "5% EnvChg Tax" $17.00 beside "Sales Tax" 8.25% $28.26', () => {
    const applied = applyPrintedTaxCharges({ ...base, charges: [{ label: '5% EnvChg Tax', amount: '17.00' }] });

    expect(applied.taxAmount).toBe('45.26');
    expect(applied.message).toBe('Added "5% EnvChg Tax" $17.00 to header Tax_Amount so lines, freight, and tax equal the amount due.');
  });

  it('uses the charge as the tax when no tax was read', () => {
    const applied = applyPrintedTaxCharges({
      ...base, tax: undefined, taxLabel: undefined, amountDue: '$359.50', charges: [envChg],
    });

    expect(applied.taxAmount).toBe('17.00');
    expect(applied.breakdown).toBe('"EnvChg Tax" $17.00');
  });

  it('replaces a cleared zero tax instead of adding to it', () => {
    const applied = applyPrintedTaxCharges({ ...base, tax: undefined, taxCleared: true, amountDue: '$359.50', charges: [envChg] });

    expect(applied.taxAmount).toBe('17.00');
    expect(applied.taxCleared).toBe(false);
  });

  it('adds several tax-like charges when together they equal the gap', () => {
    const applied = applyPrintedTaxCharges({
      ...base, charges: [envChg, { label: 'Recycling Tax', amount: '$3.00' }], amountDue: '$390.76',
    });

    expect(applied.taxAmount).toBe('48.26');
    expect(applied.message).toBe('Added "EnvChg Tax" $17.00 and "Recycling Tax" $3.00 to header Tax_Amount so lines, freight, and tax equal the amount due.');
  });

  it('adds only the one charge that equals the gap', () => {
    const applied = applyPrintedTaxCharges({ ...base, charges: [{ label: 'Recycling Tax', amount: '$3.00' }, envChg] });

    expect(applied.taxAmount).toBe('45.26');
    expect(applied.message).toContain('"EnvChg Tax" $17.00');
    expect(applied.message).not.toContain('Recycling');
  });

  it('does nothing when the totals already reconcile', () => {
    const applied = applyPrintedTaxCharges({ ...base, tax: '$45.26', charges: [envChg] });

    expect(applied).toEqual({ taxAmount: '$45.26', taxCleared: false });
  });

  it('does not count a Total Tax row and its components twice', () => {
    const applied = applyPrintedTaxCharges({
      ...base,
      tax: '$45.26',
      taxLabel: 'Total Tax',
      charges: [{ label: 'Sales Tax', amount: '$28.26' }, envChg],
    });

    expect(applied.taxAmount).toBe('$45.26');
    expect(applied.message).toBeUndefined();
  });

  it('counts two different taxes that have the same amount', () => {
    const applied = applyPrintedTaxCharges({
      ...base,
      tax: '$10.00',
      taxLabel: 'State Tax',
      amountDue: '$362.50',
      charges: [{ label: 'County Tax', amount: '$10.00' }],
    });

    expect(applied.taxAmount).toBe('20.00');
    expect(applied.message).toBe('Added "County Tax" $10.00 to header Tax_Amount so lines, freight, and tax equal the amount due.');
  });

  it('skips a total-tax row with the same amount as the header tax', () => {
    const applied = applyPrintedTaxCharges({ ...base, tax: '$10.00', taxLabel: 'State Tax', amountDue: '$362.50', charges: [{ label: 'Total Tax', amount: '$10.00' }] });

    expect(applied).toEqual({ taxAmount: '$10.00', taxCleared: false });
  });

  it('skips a tax row that repeats the tax already read', () => {
    const applied = applyPrintedTaxCharges({ ...base, amountDue: '$398.76', charges: [{ label: 'Sales Tax', amount: '$28.26' }] });

    expect(applied).toEqual({ taxAmount: '$28.26', taxCleared: false });
  });

  it('leaves the gap for the amount check when the charge does not explain it', () => {
    const applied = applyPrintedTaxCharges({ ...base, charges: [{ label: 'EnvChg Tax', amount: '$17.13' }] });

    expect(applied).toEqual({ taxAmount: '$28.26', taxCleared: false });
  });

  it('never computes an amount from a printed rate', () => {
    const applied = applyPrintedTaxCharges({ ...base, charges: [{ label: 'EnvChg Tax 5%', amount: '' }] });

    expect(applied).toEqual({ taxAmount: '$28.26', taxCleared: false });
  });

  it('does not move a charge whose printed label has no tax word, even when it explains the gap', () => {
    for (const label of ['EnvChg', 'Environmental Fee', 'Fuel Surcharge']) {
      const applied = applyPrintedTaxCharges({ ...base, charges: [{ label, amount: '$17.00' }] });

      expect(applied).toEqual({ taxAmount: '$28.26', taxCleared: false });
    }
  });

  it('ignores credits and unparseable amounts', () => {
    const applied = applyPrintedTaxCharges({ ...base, charges: [{ label: 'EnvChg Tax', amount: '-$17.00' }, { label: 'EnvChg Tax', amount: 'n/a' }] });

    expect(applied).toEqual({ taxAmount: '$28.26', taxCleared: false });
  });

  it('does nothing without an amount due, lines, charges, or when a charge was withheld', () => {
    const unchanged = { taxAmount: '$28.26', taxCleared: false };
    expect(applyPrintedTaxCharges({ ...base, amountDue: undefined, charges: [envChg] })).toEqual(unchanged);
    expect(applyPrintedTaxCharges({ ...base, lines: [], charges: [envChg] })).toEqual(unchanged);
    expect(applyPrintedTaxCharges({ ...base, charges: null })).toEqual(unchanged);
    expect(applyPrintedTaxCharges({ ...base, charges: [envChg], chargeWithheld: true })).toEqual(unchanged);
  });

  it('keeps header freight in the gap so a freight invoice still reconciles', () => {
    const balanced = applyPrintedTaxCharges({
      ...base,
      lines: [lines[0]],
      freight: '$10.00',
      amountDue: '$195.50',
      tax: '$5.00',
      charges: [{ label: 'EnvChg Tax', amount: '$3.00' }],
    });

    expect(balanced).toEqual({ taxAmount: '$5.00', taxCleared: false });
    const raised = applyPrintedTaxCharges({
      ...base,
      lines: [lines[0]],
      freight: '$10.00',
      amountDue: '$198.50',
      tax: '$5.00',
      charges: [{ label: 'EnvChg Tax', amount: '$3.00' }],
    });
    expect(raised.taxAmount).toBe('8.00');
  });
});

describe('placeSummaryCharges', () => {
  // SUPIN-470485, Summit Golf Brands 1654146: Merchandise $282.50, Decoration $5.00, Sub Total $287.50,
  // S&H $25.18, TOTAL $312.68. The Decoration row is printed only in the totals block.
  const summitLines = [
    { description: 'Polo - Navy', quantity: 12, unitCost: '15.00', totalPrice: '180.00', hasDiscount: null },
    { description: 'Cap - White', quantity: 10, unitCost: '10.25', totalPrice: '102.50', hasDiscount: null },
  ];
  const summit = { lines: summitLines, amountDue: '$312.68', freight: '$25.18', freightCleared: false, taxCleared: false };
  const summitTotals = [
    { label: 'Merchandise', amount: '$282.50' },
    { label: 'Decoration', amount: '$5.00' },
    { label: 'Sub Total', amount: '$287.50' },
    { label: 'S&H', amount: '$25.18' },
    { label: 'TOTAL', amount: '$312.68' },
  ];

  // SUPIN-467235 (Oct 13): $74.00 of lines including a Decoration row, $10.00 freight, and an unsigned
  // "Merchandise Discount" $13.80 in the totals block. $74.00 - $13.80 + $10.00 = $70.20 due.
  const discountLines = [
    { description: 'Towel - Tri-fold', quantity: 3, unitCost: '23.00', totalPrice: '69.00', hasDiscount: null },
    { description: 'Decoration', quantity: null, unitCost: null, totalPrice: '5.00', hasDiscount: null },
  ];
  const discountInvoice = { lines: discountLines, freight: '$10.00', freightCleared: false, taxCleared: false };
  const discountTotals = [
    { label: 'Decoration', amount: '$5.00' },
    { label: 'Merchandise Discount', amount: '$13.80' },
  ];

  it('adds the SUPIN-470485 Decoration $5.00 as a line so lines + S&H equal the $312.68 total', () => {
    const placed = placeSummaryCharges({ ...summit, charges: summitTotals });

    expect(placed.lines).toEqual([{ description: 'Decoration', quantity: null, unitCost: null, totalPrice: '5.00', hasDiscount: null }]);
    expect(placed.message).toBe('Added "Decoration" $5.00 from the invoice totals as an invoice line so lines, freight, and tax equal the amount due.');
    expect(placed.reviewNote).toBeUndefined();
    expect(reconcileSubmittedCharges([...summitLines, ...placed.lines], { amountDue: '$312.68', freight: '$25.18' }).unreconciled).toBeUndefined();
  });

  it('adds the SUPIN-469896 Decoration $13.00 that left lines $13.00 short of $373.81', () => {
    const placed = placeSummaryCharges({
      lines: [
        { description: 'Quarter-zip pullover', quantity: 10, unitCost: '18.50', totalPrice: '185.00', hasDiscount: null },
        { description: 'Golf towel', quantity: 1, unitCost: '175.81', totalPrice: '175.81', hasDiscount: null },
      ],
      amountDue: '$373.81',
      freightCleared: false,
      taxCleared: false,
      charges: [{ label: 'Decoration', amount: '$13.00' }, { label: 'Sub Total', amount: '$373.81' }],
    });

    expect(placed.lines).toEqual([expect.objectContaining({ description: 'Decoration', totalPrice: '13.00' })]);
  });

  it('applies the SUPIN-467235 unsigned Merchandise Discount as a credit when the credit makes $70.20', () => {
    const placed = placeSummaryCharges({ ...discountInvoice, amountDue: '$70.20', charges: discountTotals });

    expect(placed.lines).toEqual([{ description: 'Merchandise Discount', quantity: null, unitCost: null, totalPrice: '-13.80', hasDiscount: true }]);
    expect(placed.message).toBe('Added "Merchandise Discount" -$13.80 from the invoice totals as an invoice line so lines, freight, and tax equal the amount due.');
    expect(reconcileSubmittedCharges([...discountLines, ...placed.lines], { amountDue: '$70.20', freight: '$10.00' }).unreconciled).toBeUndefined();
  });

  it('adds nothing and gives both readings when only the charge reading of an unsigned discount adds up', () => {
    const placed = placeSummaryCharges({ ...discountInvoice, amountDue: '$97.80', charges: discountTotals });

    expect(placed.lines).toEqual([]);
    expect(placed.message).toBeUndefined();
    expect(placed.reviewNote).toBe('"Merchandise Discount" $13.80 was not added: as a credit, lines, freight, and tax would total $70.20; as a charge, $97.80, which matches the amount due. Check which it is before approving.');
  });

  it('leaves a discount that neither sign explains to the review note', () => {
    const placed = placeSummaryCharges({ ...discountInvoice, amountDue: '$75.00', charges: discountTotals });

    expect(placed.lines).toEqual([]);
    expect(placed.reviewNote).toBe('"Merchandise Discount" $13.80 was printed in the invoice totals but not added: it does not explain the $9.00 difference between lines, freight, and tax ($84.00) and the amount due ($75.00).');
  });

  it.each(['($13.80)', '-$13.80', '$-13.80', '13.80-'])('never reads the printed credit %s as a charge', (amount) => {
    const charges = [{ label: 'Merchandise Discount', amount }];

    expect(placeSummaryCharges({ ...discountInvoice, amountDue: '$70.20', charges }).lines)
      .toEqual([expect.objectContaining({ totalPrice: '-13.80', hasDiscount: true })]);
    const charge = placeSummaryCharges({ ...discountInvoice, amountDue: '$97.80', charges });
    expect(charge.lines).toEqual([]);
    expect(charge.reviewNote).toContain('"Merchandise Discount" -$13.80 was printed in the invoice totals but not added');
  });

  it('adds a fee and a discount together when both are needed to reach the amount due', () => {
    const placed = placeSummaryCharges({
      ...summit,
      amountDue: '$298.88',
      charges: [...summitTotals, { label: 'Merchandise Discount', amount: '$13.80' }],
    });

    expect(placed.lines.map(line => [line.description, line.totalPrice])).toEqual([['Decoration', '5.00'], ['Merchandise Discount', '-13.80']]);
    expect(placed.message).toBe('Added "Decoration" $5.00 and "Merchandise Discount" -$13.80 from the invoice totals as invoice lines so lines, freight, and tax equal the amount due.');
  });

  it('names the other rows when an unsigned discount only adds up as a charge alongside them', () => {
    const placed = placeSummaryCharges({
      ...summit,
      amountDue: '$326.48',
      charges: [{ label: 'Decoration', amount: '$5.00' }, { label: 'Promo', amount: '$13.80' }],
    });

    expect(placed.lines).toEqual([]);
    expect(placed.reviewNote).toBe('"Promo" $13.80 was not added: as a credit, lines, freight, and tax would total $298.88; as a charge with "Decoration" $5.00, $326.48, which matches the amount due. Check which it is before approving.');
  });

  it('skips a totals row that repeats a line or a discount the lines already carry', () => {
    expect(placeSummaryCharges({
      ...discountInvoice,
      lines: [...discountLines, { description: 'Merchandise Discount', quantity: null, unitCost: null, totalPrice: '-13.80', hasDiscount: true }],
      amountDue: '$80.00',
      charges: discountTotals,
    })).toEqual({ lines: [] });
    expect(placeSummaryCharges({
      ...discountInvoice,
      lines: [
        { description: 'Towel - Tri-fold', quantity: 3, unitCost: '23.00', totalPrice: '55.20', hasDiscount: true },
        discountLines[1],
      ],
      amountDue: '$75.00',
      charges: discountTotals,
    }).reviewNote).toBeUndefined();
  });

  it('adds nothing when the lines already equal the amount due', () => {
    const netLines = [{ description: 'Towel - Tri-fold', quantity: 3, unitCost: '23.00', totalPrice: '60.20', hasDiscount: true }];

    expect(placeSummaryCharges({ ...discountInvoice, lines: netLines, amountDue: '$70.20', charges: discountTotals })).toEqual({ lines: [] });
    expect(placeSummaryCharges({ ...summit, amountDue: '$307.68', charges: summitTotals })).toEqual({ lines: [] });
  });

  it('never computes an amount from a rate and says the row had no amount', () => {
    const placed = placeSummaryCharges({ ...summit, charges: [{ label: 'Discount 10%', amount: null }, { label: 'Setup', amount: '5%' }] });

    expect(placed.lines).toEqual([]);
    expect(placed.reviewNote).toBe('"Discount 10%" and "Setup" were printed in the invoice totals without an amount, so they were not added.');
  });

  it.each([
    ['Sub Total'], ['Merchandise'], ['Merchandise Total'], ['Grand Total'], ['Amount Paid'], ['Balance Due'], ['Deposit'],
    ['Less Payment'], ['Shipping & Handling'], ['Freight'], ['S&H'], ['S / H'], ['Sales Tax'], ['EnvChg Tax'],
  ])('ignores the %s row', (label) => {
    expect(placeSummaryCharges({ ...summit, charges: [{ label, amount: '$5.00' }] })).toEqual({ lines: [] });
  });

  it('ignores a charge row that restates the header freight under a label the freight matcher misses', () => {
    const placed = placeSummaryCharges({ ...summit, charges: [{ label: 'Frt', amount: '$25.18' }, { label: 'Decoration', amount: '$5.00' }] });

    expect(placed.lines).toEqual([expect.objectContaining({ description: 'Decoration' })]);
  });

  it.each([['Decoration Total'], ['Credit Card Fee'], ['Setup Charge']])('treats %s as a charge', (label) => {
    expect(placeSummaryCharges({ ...summit, charges: [{ label, amount: '$5.00' }] }).lines)
      .toEqual([expect.objectContaining({ description: label, totalPrice: '5.00' })]);
  });

  it('adds nothing for a row that is too large or ambiguous, and names it', () => {
    const placed = placeSummaryCharges({ ...summit, charges: [{ label: 'Setup', amount: '$25.00' }] });
    expect(placed.lines).toEqual([]);
    expect(placed.reviewNote).toBe('"Setup" $25.00 was printed in the invoice totals but not added: it does not explain the $5.00 difference between lines, freight, and tax ($307.68) and the amount due ($312.68).');

    const twoFees = placeSummaryCharges({ ...summit, charges: [{ label: 'Setup', amount: '$5.00' }, { label: 'Screen', amount: '$5.00' }] });
    expect(twoFees.lines).toEqual([]);
    expect(twoFees.reviewNote).toContain('"Setup" $5.00 and "Screen" $5.00 were printed in the invoice totals but not added');
  });

  it('does not let a discount take the lines to zero or below', () => {
    const placed = placeSummaryCharges({
      lines: [{ description: 'Sample', quantity: null, unitCost: null, totalPrice: '10.00', hasDiscount: null }],
      amountDue: '$0.00',
      freightCleared: false,
      taxCleared: false,
      charges: [{ label: 'Discount', amount: '-$10.00' }],
    });

    expect(placed.lines).toEqual([]);
    expect(placed.reviewNote).toContain('"Discount" -$10.00 was printed in the invoice totals but not added');
  });

  it('counts cleared freight and tax as zero and needs every line amount and the amount due', () => {
    expect(placeSummaryCharges({ ...summit, freightCleared: true, amountDue: '$287.50', charges: summitTotals }).lines).toHaveLength(1);
    expect(placeSummaryCharges({ ...summit, amountDue: null, charges: summitTotals })).toEqual({ lines: [] });
    expect(placeSummaryCharges({
      ...summit,
      lines: [...summitLines, { description: 'Gift box', quantity: null, unitCost: null, totalPrice: 'Included', hasDiscount: null }],
      charges: summitTotals,
    })).toEqual({ lines: [] });
  });
});

describe('settlePlacedSummaryLines', () => {
  const placed = {
    lines: [{ description: 'Merchandise Discount', quantity: null, unitCost: null, totalPrice: '-13.80', hasDiscount: true }],
    message: 'Added "Merchandise Discount" -$13.80 from the invoice totals as an invoice line so lines, freight, and tax equal the amount due.',
  };
  const merchandise: FinalInvoiceLine = {
    lineOrder: 1,
    description: 'Towel - Tri-fold',
    extendedAmount: 74,
    costCenterId: 'CC-100',
    purchaseOrderLineId: 'POL-1',
    purchaseOrderLineQuantity: 3,
  };
  const discount: FinalInvoiceLine = {
    lineOrder: 2,
    description: 'Merchandise Discount',
    extendedAmount: -13.8,
    hasDiscount: true,
    costCenterId: 'CC-100',
    purchaseOrderLineId: 'POL-1',
    purchaseOrderLineQuantity: 3,
  };

  it('keeps the coding but drops the PO line link from a placed row and says so', () => {
    const settled = settlePlacedSummaryLines([merchandise, discount], placed);

    expect(settled.lines[0]).toBe(merchandise);
    expect(settled.lines[1]).toMatchObject({ costCenterId: 'CC-100', purchaseOrderLineId: null, purchaseOrderLineQuantity: null });
    expect(settled.message).toBe(`${placed.message} It is not linked to a PO line.`);
    expect(settled.codingNote).toBeUndefined();
  });

  it('drops the Amount-check sentence when the placed row is not a submitted line', () => {
    const settled = settlePlacedSummaryLines([merchandise], placed);

    expect(settled).toEqual({ lines: [merchandise] });
  });

  it('flags a placed discount beside lines on more than one cost center', () => {
    const settled = settlePlacedSummaryLines(
      [merchandise, { ...merchandise, lineOrder: 2, costCenterId: 'CC-200' }, { ...discount, lineOrder: 3, purchaseOrderLineId: null }],
      placed
    );

    expect(settled.message).toBe(placed.message);
    expect(settled.codingNote).toBe('"Merchandise Discount" -$13.80 is a single line, but the invoice lines use more than one cost center. Check how the discount should be coded before approving.');
  });

  it('leaves lines unchanged when nothing was placed', () => {
    const lines = [merchandise];
    expect(settlePlacedSummaryLines(lines, { lines: [], reviewNote: 'note' })).toEqual({ lines });
  });
});
