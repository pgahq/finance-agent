import {
  formatLineSubtotalNotes,
  formatPartialPaymentNotes,
  lineSubtotalReviewNote,
  lineSubtotalShortfallCents,
  planPartialPayment,
  selectDepositPoLine,
  sumExtractedLineCents,
  type PartialPaymentInput,
} from '../lib/partial_payment.js';
import {
  supin470584Header,
  supin470584PoLines,
  supin470584ProductionRows,
  supin470584Rows,
} from './fixtures/supin_470584.js';

const poLines = supin470584PoLines as any[];

function input(overrides: Partial<PartialPaymentInput> = {}): PartialPaymentInput {
  return {
    partialPayment: supin470584Header.extractedPartialPayment,
    lineSubtotal: supin470584Header.extractedLineSubtotal,
    amountDue: supin470584Header.extractedAmountDue,
    lines: supin470584Rows,
    poLines,
    ...overrides,
  };
}

describe('SUPIN-470584 fixture', () => {
  it('has 28 rows that total the printed $38,255.00, and the production read is one row short', () => {
    expect(supin470584Rows).toHaveLength(28);
    expect(sumExtractedLineCents(supin470584Rows)).toBe(3825500);
    expect(supin470584ProductionRows).toHaveLength(27);
    expect(sumExtractedLineCents(supin470584ProductionRows)).toBe(3420500);
  });

  it('prints two identical Fresh Cut Floral Centerpieces rows under different headings', () => {
    const floral = supin470584Rows.filter(line => line.description === 'Fresh Cut Floral Centerpieces');
    expect(floral).toHaveLength(2);
    expect(floral[0]).toMatchObject({ quantity: 30, unitCost: '$135.00', totalPrice: '$4,050.00' });
    expect(floral[1]).toMatchObject({ quantity: 30, unitCost: '$135.00', totalPrice: '$4,050.00' });
    expect(floral[0].sectionLabel).not.toBe(floral[1].sectionLabel);
  });
});

describe('lineSubtotalShortfallCents and lineSubtotalReviewNote', () => {
  const subtotal = supin470584Header.extractedLineSubtotal;

  it('reports the $4,050.00 missing from the production read', () => {
    expect(lineSubtotalShortfallCents(supin470584ProductionRows, subtotal)).toBe(405000);
  });

  it('reports nothing when the rows total the printed subtotal', () => {
    expect(lineSubtotalShortfallCents(supin470584Rows, subtotal)).toBeUndefined();
    expect(lineSubtotalReviewNote(supin470584Rows, subtotal)).toBeUndefined();
  });

  it('names the row whose amount equals the gap', () => {
    expect(lineSubtotalReviewNote(supin470584ProductionRows, subtotal)).toBe(
      'The extracted lines total $34,205.00, but the document prints $38,255.00 as "Total Cost of Contracted Services".'
      + ' The $4,050.00 difference equals "Fresh Cut Floral Centerpieces"; check whether that row is printed more than once.'
    );
  });

  it('says a row may not have been read when no row equals the gap', () => {
    const lines = supin470584Rows.filter((_, index) => index !== 0);
    expect(lineSubtotalReviewNote(lines, subtotal)).toContain('The $750.00 difference may be a row that was not read.');
  });

  it('flags rows that total more than the printed subtotal', () => {
    const lines = [...supin470584Rows, supin470584Rows[0]];
    expect(lineSubtotalReviewNote(lines, subtotal)).toContain('Check for a row that was read twice or a charge that is not a line.');
    expect(lineSubtotalShortfallCents(lines, subtotal)).toBeUndefined();
  });

  it('does nothing without a printed subtotal or with a row that has no total', () => {
    expect(lineSubtotalReviewNote(supin470584ProductionRows, null)).toBeUndefined();
    expect(lineSubtotalReviewNote(supin470584ProductionRows, { label: 'Sub Total', amount: 'see below' })).toBeUndefined();
    expect(lineSubtotalReviewNote([{ description: 'Travel', totalPrice: null }], subtotal)).toBeUndefined();
    expect(lineSubtotalReviewNote([], subtotal)).toBeUndefined();
  });

  it('formats the Workday note', () => {
    expect(formatLineSubtotalNotes(undefined)).toBe('');
    expect(formatLineSubtotalNotes('x')).toBe('\n\nLine subtotal review: x');
    expect(formatPartialPaymentNotes(undefined)).toBe('');
    expect(formatPartialPaymentNotes('x')).toBe('\n\nDeposit invoice: x');
  });
});

describe('selectDepositPoLine', () => {
  it('picks the one PO line that is the deposit amount', () => {
    expect(selectDepositPoLine(poLines, 3442950)).toEqual({ status: 'matched', line: poLines[0] });
  });

  it('reads a service line from its extended amount', () => {
    const service = [{ lineOrder: 1, purchaseOrderLineId: 'S1', extendedAmount: '34429.50' }] as any[];
    expect(selectDepositPoLine(service, 3442950)).toEqual({ status: 'matched', line: service[0] });
  });

  it('has no PO to pin when the PO has no lines', () => {
    expect(selectDepositPoLine(undefined, 3442950)).toEqual({ status: 'no_po' });
    expect(selectDepositPoLine([], 3442950)).toEqual({ status: 'no_po' });
  });

  it('does not pin when no line or several open lines have that amount', () => {
    expect(selectDepositPoLine(poLines, 100)).toEqual({ status: 'unmatched', reason: 'no PO line is for $1.00' });
    const twins = [poLines[0], { ...poLines[0], purchaseOrderLineId: 'OTHER', lineOrder: 3 }];
    expect(selectDepositPoLine(twins, 3442950)).toEqual({ status: 'unmatched', reason: 'several PO lines are for $34,429.50' });
  });

  it('prefers the open line over a consumed one with the same amount', () => {
    const consumed = { ...poLines[0], purchaseOrderLineId: 'USED', lineOrder: 3, availableForInvoicing: false };
    expect(selectDepositPoLine([consumed, poLines[0]], 3442950)).toEqual({ status: 'matched', line: poLines[0] });
  });

  it('keeps a lone consumed line so the link is dropped downstream', () => {
    const consumed = { ...poLines[0], availableForInvoicing: false };
    expect(selectDepositPoLine([consumed, poLines[1]], 3442950)).toEqual({ status: 'matched', line: consumed });
  });
});

describe('planPartialPayment', () => {
  it('replaces the SUPIN-470584 lines with one deposit line pinned to the deposit PO line', () => {
    const plan = planPartialPayment(input())!;

    expect(plan.applied).toBe(true);
    expect(plan.line).toEqual({
      description: 'Advance Deposit Due (90% of $38,255.00)',
      quantity: 1,
      unitCost: '$34,429.50',
      totalPrice: '$34,429.50',
      hasDiscount: null,
      tableNumber: 1,
    });
    expect(plan.poLines).toEqual([poLines[0]]);
    expect(plan.amountDueNote).toBe('90% deposit of $38,255.00');
    expect(plan.note).toBe(
      '"Advance Deposit Due" $34,429.50 is 90% of $38,255.00 for the contract total (28 printed lines).'
      + ' The invoice bills the deposit, so it was submitted as one $34,429.50 line instead of the printed lines.'
      + ' The full line list is below and on the attached PDF.'
    );
    expect(plan.slackLines).toEqual(['Advance Deposit Due: $34,429.50 is 90% of $38,255.00. Submitted as one deposit line, not the printed lines.']);
  });

  it('applies the same deposit when the production read dropped a row, since the printed amount is what is billed', () => {
    const plan = planPartialPayment(input({ lines: supin470584ProductionRows }))!;
    expect(plan.applied).toBe(true);
    expect(plan.line?.totalPrice).toBe('$34,429.50');
    expect(plan.note).toContain('(27 printed lines)');
  });

  it('applies a deposit with no PO and leaves the PO lines out', () => {
    const plan = planPartialPayment(input({ poLines: undefined }))!;
    expect(plan.applied).toBe(true);
    expect(plan.poLines).toBeUndefined();
  });

  it('applies a fixed-amount deposit that prints no percentage', () => {
    const plan = planPartialPayment(input({
      partialPayment: { label: 'Deposit Due', percent: null, amount: '$34,429.50' },
    }))!;
    expect(plan.applied).toBe(true);
    expect(plan.line?.description).toBe('Deposit Due (part of $38,255.00)');
    expect(plan.amountDueNote).toBe('deposit of $38,255.00');
  });

  it('uses the extracted rows as the contract total when no line total is printed', () => {
    const plan = planPartialPayment(input({ lineSubtotal: null }))!;
    expect(plan.applied).toBe(true);
    expect(plan.note).toContain('is 90% of $38,255.00');
  });

  it('accepts a one-cent rounding difference from the percentage', () => {
    const plan = planPartialPayment(input({
      lineSubtotal: { label: 'Total', amount: '$38,255.01' },
    }))!;
    expect(plan.applied).toBe(true);
  });

  it('does not touch a document with no deposit row or a label that is not a deposit', () => {
    expect(planPartialPayment(input({ partialPayment: null }))).toBeUndefined();
    expect(planPartialPayment(input({ partialPayment: undefined }))).toBeUndefined();
    expect(planPartialPayment(input({ partialPayment: { label: 'Balance Due', percent: null, amount: '$34,429.50' } }))).toBeUndefined();
    expect(planPartialPayment(input({ partialPayment: { label: 'Retainer', percent: null, amount: '$34,429.50' } }))).toBeUndefined();
  });

  it.each([
    'Less Deposit Paid',
    'Deposit Received',
    'Deposit Applied',
    'Credit for Deposit',
    'Remaining Balance After Deposit',
  ])('does not treat "%s" as the amount this invoice bills', (label) => {
    expect(planPartialPayment(input({ partialPayment: { label, percent: null, amount: '$34,429.50' } }))).toBeUndefined();
  });

  it.each([
    ['the deposit is not the amount due', { amountDue: '$30,000.00' }, 'the printed deposit $34,429.50 is not the amount due $30,000.00'],
    ['the amount due cannot be read', { amountDue: null }, 'the amount due is not a readable amount'],
    ['the deposit cannot be read', { partialPayment: { label: 'Advance Deposit Due', percent: '90%', amount: 'TBD' } }, 'the deposit amount is not a readable amount'],
    ['freight is also printed', { freightAmount: '$25.00' }, 'freight or tax is also printed'],
    ['tax is also printed', { taxAmount: '$10.00' }, 'freight or tax is also printed'],
    ['there is no contract total', { lineSubtotal: null, lines: [] }, 'the document prints no contract total to compare it with'],
    ['the contract total is not larger', { lineSubtotal: { label: 'Total', amount: '$34,429.50' } }, 'the deposit $34,429.50 is not less than the contract total $34,429.50'],
    ['the percentage does not match', { partialPayment: { label: 'Advance Deposit Due', percent: '50%', amount: '$34,429.50' } }, '50% of $38,255.00 is $19,127.50, not the printed $34,429.50'],
    ['no PO line is the deposit', { poLines: [poLines[1]] }, 'no PO line is for $34,429.50'],
  ] as Array<[string, Partial<PartialPaymentInput>, string]>)('leaves the lines alone when %s', (_name, overrides, reason) => {
    const plan = planPartialPayment(input(overrides))!;

    expect(plan.applied).toBe(false);
    expect(plan.line).toBeUndefined();
    expect(plan.poLines).toBeUndefined();
    expect(plan.note).toBe(
      `"${(overrides.partialPayment as any)?.label ?? 'Advance Deposit Due'}" looks like a deposit or partial payment, but ${reason},`
      + ' so the printed lines were submitted unchanged. The submitted lines may not match the amount due; check before approving.'
    );
    expect(plan.slackLines).toEqual([`Deposit or partial payment not applied: ${reason}.`]);
  });

  it('does not treat a percentage of 100 or more as a share', () => {
    const plan = planPartialPayment(input({
      partialPayment: { label: 'Advance Deposit Due', percent: '100%', amount: '$34,429.50' },
    }))!;
    expect(plan.applied).toBe(true);
    expect(plan.line?.description).toBe('Advance Deposit Due (part of $38,255.00)');
  });
});
