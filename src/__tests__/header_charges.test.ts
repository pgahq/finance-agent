import { applyPrintedTaxCharges, isTaxLikeChargeLabel } from '../lib/header_charges.js';
import { chargeReconciliationMessages, prepareInvoiceCharges, reconcileSubmittedCharges } from '../lib/invoice_lines.js';

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
