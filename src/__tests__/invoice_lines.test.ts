import { isFreightOrHandlingLine, splitFreightLines } from '../lib/invoice_lines.js';

describe('isFreightOrHandlingLine', () => {
  it.each([
    'Shipping',
    'Freight',
    'Shipping & Handling',
    'Shipping and Handling',
    'Delivery',
    'Postage',
    'S&H',
    'S/H',
    'Handling',
    'Freight Charge',
    'Shipping Charges',
    'Delivery Fee',
    'Inbound Freight',
    'Ground Shipping',
    'UPS Freight',
    'FedEx Shipping',
    'USPS Postage',
    'Overnight Shipping',
    'DHL Express Freight',
  ])('treats %s as a freight/handling charge', (description) => {
    expect(isFreightOrHandlingLine(description)).toBe(true);
  });

  it.each([
    'Shipping Container',
    'Overnight shipping boxes',
    'Freightliner parts',
    'Handling equipment',
    'Delivery truck rental',
    'Consulting Services',
    'Widgets',
  ])('does not treat %s as a freight/handling charge', (description) => {
    expect(isFreightOrHandlingLine(description)).toBe(false);
  });

  it('returns false for empty descriptions', () => {
    expect(isFreightOrHandlingLine(undefined)).toBe(false);
    expect(isFreightOrHandlingLine(null)).toBe(false);
    expect(isFreightOrHandlingLine('')).toBe(false);
    expect(isFreightOrHandlingLine('   ')).toBe(false);
  });
});

describe('splitFreightLines', () => {
  it('separates freight lines from merchandise and sums freight amounts', () => {
    const split = splitFreightLines([
      { description: 'Consulting Services', totalPrice: '$100.00' },
      { description: 'Shipping & Handling', totalPrice: '$15.00' },
      { description: 'Widgets', unitCost: '50.00' },
    ]);

    expect(split.merchandiseLines.map(l => l.description)).toEqual([
      'Consulting Services',
      'Widgets',
    ]);
    expect(split.freightLines.map(l => l.description)).toEqual(['Shipping & Handling']);
    expect(split.freightAmountFromLines).toBe(15);
  });

  it('reads SOAP OCR description and extended amount fields', () => {
    const split = splitFreightLines([
      { Item_Description: 'Item 1', Extended_Amount: 100 },
      { Item_Description: 'Freight', Extended_Amount: '12.50' },
    ]);

    expect(split.merchandiseLines).toHaveLength(1);
    expect(split.freightLines).toHaveLength(1);
    expect(split.freightAmountFromLines).toBe(12.5);
  });

  it('returns no freight amount when no freight lines are present', () => {
    const split = splitFreightLines([
      { description: 'Widgets', extendedAmount: 100 },
    ]);

    expect(split.merchandiseLines).toHaveLength(1);
    expect(split.freightLines).toHaveLength(0);
    expect(split.freightAmountFromLines).toBeUndefined();
  });
});
