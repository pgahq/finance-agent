import {
  formatLineSubtotalNotes,
  formatPartialPaymentNotes,
  lineSubtotalReviewNote,
  lineSubtotalShortfallCents,
  planBalanceInvoice,
  planPartialPayment,
  secondReadRowsNote,
  selectDepositPoLine,
  sumExtractedLineCents,
  type BalanceInvoiceInput,
  type PartialPaymentInput,
} from '../lib/partial_payment.js';
import {
  supin470584Header,
  supin470584PoLines,
  supin470584ProductionRows,
  supin470584Rows,
} from './fixtures/supin_470584.js';

import { supin471692Header, supin471692Payments, supin471692Rows } from './fixtures/supin_471692.js';

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

  it('tells AP which rows only a second read found', () => {
    expect(secondReadRowsNote(null)).toBeUndefined();
    expect(secondReadRowsNote([])).toBeUndefined();
    expect(secondReadRowsNote([{ description: 'Fresh Cut Floral Centerpieces', totalPrice: '$4,050.00' }]))
      .toBe('A second read of the document added a row the first read missed: "Fresh Cut Floral Centerpieces" $4,050.00. Check it against the PDF.');
    const many = Array.from({ length: 7 }, (_, index) => ({ description: `Row ${index + 1}`, totalPrice: null }));
    expect(secondReadRowsNote(many)).toBe('A second read of the document added 7 rows the first read missed: "Row 1", "Row 2", "Row 3", "Row 4", "Row 5", and 2 more. Check them against the PDF.');
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
    expect(selectDepositPoLine(poLines, 3442950)).toEqual({ status: 'matched', line: poLines[0], consumed: false });
  });

  it('reads a service line from its extended amount', () => {
    const service = [{ lineOrder: 1, purchaseOrderLineId: 'S1', extendedAmount: '34429.50' }] as any[];
    expect(selectDepositPoLine(service, 3442950)).toEqual({ status: 'matched', line: service[0], consumed: false });
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
    expect(selectDepositPoLine([consumed, poLines[0]], 3442950)).toEqual({ status: 'matched', line: poLines[0], consumed: false });
  });

  it('keeps a lone consumed line so the link is dropped downstream', () => {
    const consumed = { ...poLines[0], availableForInvoicing: false };
    expect(selectDepositPoLine([consumed, poLines[1]], 3442950)).toEqual({ status: 'matched', line: consumed, consumed: true });
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

  it('applies the deposit but tells AP when the only PO line with that amount is already fully invoiced', () => {
    const consumed = [{ ...poLines[0], availableForInvoicing: false }, poLines[1]];
    const plan = planPartialPayment(input({ poLines: consumed }))!;

    expect(plan.applied).toBe(true);
    expect(plan.poLines).toEqual([consumed[0]]);
    const warning = 'The PO line for this amount is already fully invoiced or closed; check whether this deposit was billed before approving.';
    expect(plan.note).toContain(warning);
    expect(plan.slackLines).toContain(warning);
    expect(planPartialPayment(input())!.note).not.toContain('already fully invoiced');
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
    ['freight is also printed', { freightAmount: '$25.00' }, 'freight is also printed'],
    ['tax is also printed', { taxAmount: '$10.00' }, 'a tax amount is printed, and AP does not pay tax on a deposit (it is paid with the balance invoice), so check whether the amount due includes it'],
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

describe('planBalanceInvoice', () => {
  const balanceInput = (overrides: Partial<BalanceInvoiceInput> = {}): BalanceInvoiceInput => ({
    priorPayments: null,
    emailBalanceDue: supin471692Header.emailBalanceDue,
    lineSubtotal: supin471692Header.extractedLineSubtotal,
    amountDue: supin471692Header.extractedAmountDue,
    lines: supin471692Rows,
    poLines: undefined,
    ...overrides,
  });

  it('replaces the SUPIN-471692 lines with one balance line when the email calls the amount due the remaining balance', () => {
    const plan = planBalanceInvoice(balanceInput())!;

    expect(plan.applied).toBe(true);
    expect(plan.noteLabel).toBe('Balance invoice');
    expect(plan.line).toEqual({
      description: 'Total Contract Price (balance due of $23,887.00)',
      quantity: 1,
      unitCost: '$5,909.50',
      totalPrice: '$5,909.50',
      hasDiscount: null,
      tableNumber: 1,
    });
    expect(plan.poLines).toBeUndefined();
    expect(plan.amountDueNote).toBe('remaining balance of $23,887.00');
    expect(plan.note).toContain('"Total Contract Price" is $23,887.00 but the amount due is $5,909.50, and the email calls $5,909.50 the remaining balance (3 printed lines).');
    expect(plan.note).toContain('The document prints no payments that account for the difference.');
    expect(plan.note).toContain('submitted as one $5,909.50 line instead of the printed lines');
    expect(plan.slackLines).toEqual(['Total Contract Price: $23,887.00 contract total, $5,909.50 due (remaining balance per the email). Submitted as one balance line, not the printed lines.']);
  });

  it('applies on printed payments alone when they account for the gap to the cent', () => {
    const plan = planBalanceInvoice(balanceInput({ emailBalanceDue: null, priorPayments: supin471692Payments }))!;
    expect(plan.applied).toBe(true);
    expect(plan.note).toContain('"Total Contract Price" is $23,887.00, and $17,977.50 was already paid, which leaves the $5,909.50 amount due (3 printed lines).');
    expect(plan.slackLines[0]).toContain('after $17,977.50 paid');
  });

  it('adds several printed payment rows together', () => {
    const plan = planBalanceInvoice(balanceInput({
      emailBalanceDue: null,
      priorPayments: [{ label: 'Deposit', amount: '$10,000.00' }, { label: 'Second payment', amount: '($7,977.50)' }],
    }))!;
    expect(plan.applied).toBe(true);
    expect(plan.note).toContain('$17,977.50 was already paid');
  });

  it('uses the extracted rows as the contract total when no line total is printed', () => {
    const plan = planBalanceInvoice(balanceInput({ lineSubtotal: null }))!;
    expect(plan.applied).toBe(true);
    expect(plan.line?.description).toBe('Motorcoach transportation - event shuttles (balance due of $23,887.00)');
  });

  it('does not apply when printed payments do not reconcile and the email does not match', () => {
    const plan = planBalanceInvoice(balanceInput({
      emailBalanceDue: null,
      priorPayments: [{ label: 'Payments Received', amount: '$10,000.00' }],
    }))!;
    expect(plan.applied).toBe(false);
    expect(plan.line).toBeUndefined();
    expect(plan.note).toContain('the printed payments total $10,000.00, which leaves $13,887.00 of the $23,887.00 contract total, not the amount due $5,909.50');
    expect(plan.note).toContain('so the printed lines were submitted unchanged');
  });

  it('lets an exact email balance win over payments that do not reconcile', () => {
    const plan = planBalanceInvoice(balanceInput({ priorPayments: [{ label: 'Payments Received', amount: '$10,000.00' }] }))!;
    expect(plan.applied).toBe(true);
  });

  it('is silent with no signal', () => {
    expect(planBalanceInvoice(balanceInput({ emailBalanceDue: null }))).toBeUndefined();
    expect(planBalanceInvoice(balanceInput({ emailBalanceDue: { amount: '$5,909.50', phrase: '  ' } }))).toBeUndefined();
  });

  it('ignores an email balance that is not the printed amount due to the cent', () => {
    expect(planBalanceInvoice(balanceInput({ emailBalanceDue: { amount: '$5,909.51', phrase: 'remaining balance' } }))).toBeUndefined();
    expect(planBalanceInvoice(balanceInput({ emailBalanceDue: { amount: 'about $5,900', phrase: 'remaining balance' } }))).toBeUndefined();
  });

  it('is silent when the lines or contract total do not exceed the amount due', () => {
    expect(planBalanceInvoice(balanceInput({ amountDue: '$23,887.00' }))).toBeUndefined();
    expect(planBalanceInvoice(balanceInput({ amountDue: '$30,000.00', emailBalanceDue: { amount: '$30,000.00', phrase: 'balance' } }))).toBeUndefined();
    expect(planBalanceInvoice(balanceInput({ lines: [supin471692Rows[2]] }))).toBeUndefined();
    expect(planBalanceInvoice(balanceInput({ amountDue: null }))).toBeUndefined();
  });

  it('does not apply when tax or freight is also printed', () => {
    for (const charges of [{ taxAmount: '$100.00' }, { freightAmount: '$50.00' }]) {
      const plan = planBalanceInvoice(balanceInput(charges))!;
      expect(plan.applied).toBe(false);
      expect(plan.note).toContain('tax or freight is also printed');
      expect(plan.slackLines).toEqual(['Remaining-balance invoice not applied: tax or freight is also printed, and balance invoices with header charges are not booked automatically.']);
    }
  });

  describe('with a PO', () => {
    const balancePo = [
      { lineOrder: 1, purchaseOrderLineId: 'L1', quantity: 1, unitCost: 17977.5 },
      { lineOrder: 2, purchaseOrderLineId: 'L2', quantity: 1, unitCost: 5909.5 },
    ] as any[];

    it('pins the balance line to the PO line with that amount', () => {
      const plan = planBalanceInvoice(balanceInput({ poLines: balancePo }))!;
      expect(plan.applied).toBe(true);
      expect(plan.poLines).toEqual([balancePo[1]]);
    });

    it('does not apply when the PO has lines but none is the balance', () => {
      const plan = planBalanceInvoice(balanceInput({ poLines: [balancePo[0]] }))!;
      expect(plan.applied).toBe(false);
      expect(plan.note).toContain('no PO line is for $5,909.50');
    });

    it('applies but warns when the only matching PO line is already invoiced', () => {
      const plan = planBalanceInvoice(balanceInput({ poLines: [balancePo[0], { ...balancePo[1], availableForInvoicing: false }] }))!;
      expect(plan.applied).toBe(true);
      expect(plan.note).toContain('check whether this balance was billed before approving');
      expect(plan.slackLines).toHaveLength(2);
    });
  });
});

describe('formatPartialPaymentNotes label', () => {
  it('defaults to the deposit label and takes a balance label', () => {
    expect(formatPartialPaymentNotes('Text.')).toContain('Deposit invoice: Text.');
    expect(formatPartialPaymentNotes('Text.', 'Balance invoice')).toContain('Balance invoice: Text.');
    expect(formatPartialPaymentNotes(undefined, 'Balance invoice')).toBe('');
  });
});
