import {
  amountDueGapCents,
  hasPrintedRetainage,
  amountDueShortfallCents,
  formatLineSubtotalNotes,
  formatPartialPaymentNotes,
  lineSubtotalReviewNote,
  poTotalReviewNote,
  lineSubtotalShortfallCents,
  planBalanceInvoice,
  planPartialPayment,
  reviewAmountDueGapCents,
  secondReadRowsNote,
  subtotalFreightCents,
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

import { supin472322Header, supin472322PoLines, supin472322ProductionRows, supin472322Rows } from './fixtures/supin_472322.js';
import { summaryCreditCents } from '../lib/header_charges.js';
import { supin472108Header, supin472108ProductionRows, supin472108Rows } from './fixtures/supin_472108.js';
import { supin471692Header, supin471692Payments, supin471692Rows } from './fixtures/supin_471692.js';
import { supin474922Header, supin474922Payments, supin474922Retainage, supin474922Rows } from './fixtures/supin_474922.js';

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

describe('amount due gap (SUPIN-472108)', () => {
  const base = {
    amountDue: supin472108Header.extractedAmountDue,
    tax: supin472108Header.extractedTaxAmount,
  };
  const subtotal = supin472108Header.extractedLineSubtotal;

  it('counts a no-charge row as $0 instead of making the sum unreadable', () => {
    expect(sumExtractedLineCents([
      { description: 'Forks', totalPrice: 'N/C' },
      { description: 'Rental', totalPrice: '$10.00' },
      { description: 'Standard Fee', totalPrice: 'Included' },
    ])).toBe(1000);
    expect(sumExtractedLineCents([{ description: 'Rental', totalPrice: 'TBD' }])).toBeUndefined();
  });

  it('reports the $417.32 the delivery and pickup rows are worth', () => {
    expect(amountDueGapCents({ ...base, lines: supin472108ProductionRows })).toBe(41732);
    expect(amountDueShortfallCents({ ...base, lines: supin472108ProductionRows })).toBe(41732);
  });

  it('reports zero once the rows reconcile, and nothing when they overshoot', () => {
    expect(amountDueGapCents({ ...base, lines: supin472108Rows })).toBe(0);
    expect(amountDueShortfallCents({ ...base, lines: supin472108Rows })).toBeUndefined();
    expect(amountDueGapCents({ ...base, lines: [...supin472108Rows, supin472108Rows[1]] })).toBeLessThan(0);
  });

  it('subtracts the printed freight and other charges', () => {
    expect(amountDueGapCents({ ...base, lines: supin472108ProductionRows, freight: '$208.66' })).toBe(20866);
    expect(amountDueGapCents({ ...base, lines: supin472108ProductionRows, otherCharges: [{ amount: '$417.32' }] })).toBe(0);
    // A row that repeats the header tax is the same money, so it is not taken out twice.
    const tax = '$298.11';
    const withTax = { ...base, lines: supin472108ProductionRows, tax, taxLabel: 'Tax' };
    const untaxed = amountDueGapCents({ ...withTax, otherCharges: null });
    expect(amountDueGapCents({ ...withTax, otherCharges: [{ label: 'Tax', amount: tax }] })).toBe(untaxed);
    expect(amountDueGapCents({ ...withTax, otherCharges: [{ label: 'Total Tax', amount: tax }] })).toBe(untaxed);
    expect(amountDueGapCents({ ...withTax, otherCharges: [{ label: 'County Tax', amount: tax }] })).toBe((untaxed ?? 0) - 29811);
  });

  it('does not check deposit invoices, prior payments, or unreadable amounts', () => {
    expect(amountDueGapCents({ ...base, lines: supin472108ProductionRows, partialPayment: { amount: '$1.00' } })).toBeUndefined();
    expect(amountDueGapCents({ ...base, lines: supin472108ProductionRows, priorPayments: [{}] })).toBeUndefined();
    expect(amountDueGapCents({ ...base, amountDue: null, lines: supin472108ProductionRows })).toBeUndefined();
    expect(amountDueGapCents({ ...base, lines: [{ description: 'x', totalPrice: null }] })).toBeUndefined();
  });

  it('leaves a gap that a totals-block row explains to that row', () => {
    const lines = supin472108ProductionRows;
    expect(amountDueShortfallCents({ ...base, lines, summaryCharges: [{ amount: '$417.32' }] })).toBeUndefined();
    expect(amountDueShortfallCents({ ...base, lines, summaryCharges: [{ amount: '$200.00' }, { amount: '$217.32' }] })).toBeUndefined();
    expect(amountDueShortfallCents({ ...base, lines, summaryCharges: [{ amount: '$5.00' }] })).toBe(41732);
  });

  it('reads a gap that a totals-block row explains as zero for the review note', () => {
    const lines = supin472108ProductionRows;
    expect(reviewAmountDueGapCents({ ...base, lines })).toBe(41732);
    expect(reviewAmountDueGapCents({ ...base, lines, summaryCharges: [{ amount: '$417.32' }] })).toBe(0);
    expect(reviewAmountDueGapCents({ ...base, lines, otherCharges: [{ amount: '$417.32' }] })).toBe(0);
    expect(reviewAmountDueGapCents({ ...base, lines: supin472108Rows })).toBe(0);
    expect(reviewAmountDueGapCents({ ...base, lines, partialPayment: { amount: '$1.00' } })).toBeUndefined();
  });

  it('words the review note from the amount due, not the partial printed subtotal', () => {
    const production = supin472108ProductionRows;
    expect(lineSubtotalReviewNote(production, subtotal, 41732)).toBe(
      'The extracted lines total $3,330.56, but the document prints $3,591.67 as "Agreement Subtotal".'
      + ' Lines, freight, and tax are $417.32 short of the amount due, so charges that the document prints (for example delivery, pickup, or other rows) were probably not read.'
    );
    expect(lineSubtotalReviewNote(production, subtotal, 0)).toBeUndefined();
    expect(lineSubtotalReviewNote(production, subtotal)).toContain('The $261.11 difference may be a row that was not read.');
    expect(lineSubtotalReviewNote(production, subtotal, 26111)).toContain('The $261.11 difference may be a row that was not read.');
  });
});

describe('freight inside the subtotal and an unlined discount (SUPIN-472322)', () => {
  const header = supin472322Header;
  const credit = summaryCreditCents(header.extractedSummaryCharges, supin472322ProductionRows);
  const base = { amountDue: header.extractedAmountDue, freight: header.extractedFreightAmount, tax: header.extractedTaxAmount, creditCents: credit };

  it('reads the unsigned discount as a $8,866.66 credit', () => {
    expect(credit).toBe(886666);
    expect(summaryCreditCents([{ label: 'Service Fee', amount: '8866.66' }], supin472322ProductionRows)).toBe(0);
    expect(summaryCreditCents([{ label: 'Discount', amount: '-$100.00' }], [])).toBe(10000);
    expect(summaryCreditCents(null, [])).toBe(0);
  });

  it('counts the credit when the rows overshoot the amount due, giving the real $1,388.00 gap', () => {
    expect(amountDueGapCents({ ...base, lines: supin472322ProductionRows })).toBe(138800);
    expect(amountDueShortfallCents({ ...base, lines: supin472322ProductionRows })).toBe(138800);
    expect(amountDueGapCents({ ...base, lines: supin472322ProductionRows, creditCents: 0 })).toBe(-747866);
    expect(amountDueGapCents({ ...base, lines: supin472322Rows })).toBe(0);
  });

  it('leaves a totals-block fee alongside an unsigned discount to placeSummaryCharges instead of asking for a second read', () => {
    const summaryCharges = [{ label: 'Discount', amount: '200.00' }, { label: 'Service Fee', amount: '50.00' }];
    const input = {
      lines: [{ description: 'Rental', totalPrice: '1,000.00' }],
      amountDue: '$850.00',
      summaryCharges,
      creditCents: summaryCreditCents(summaryCharges, [{ description: 'Rental', totalPrice: '1,000.00' }]),
    };
    expect(input.creditCents).toBe(20000);
    expect(amountDueGapCents(input)).toBe(5000);
    expect(amountDueShortfallCents(input)).toBeUndefined();
    expect(reviewAmountDueGapCents(input)).toBe(0);
  });

  it('ignores the credit when the rows do not overshoot', () => {
    expect(amountDueGapCents({ ...base, lines: supin472108Rows, amountDue: '$4,045.99', freight: null, tax: '$298.11' })).toBe(0);
    expect(amountDueGapCents({ ...base, lines: supin472322Rows.slice(0, 20), creditCents: 100 })).toBeGreaterThan(0);
  });

  it('finds the freight inside the printed subtotal from the document arithmetic', () => {
    expect(subtotalFreightCents({ subtotal: header.extractedLineSubtotal, ...base })).toBe(200000);
    expect(subtotalFreightCents({ subtotal: { label: 'Subtotal', amount: '46102.66' }, ...base })).toBeUndefined();
    expect(subtotalFreightCents({ subtotal: header.extractedLineSubtotal, ...base, freight: null })).toBeUndefined();
    expect(subtotalFreightCents({ subtotal: null, ...base })).toBeUndefined();
    // A repeated header tax row is not a second tax, so it does not hide the freight inside the subtotal.
    const repeatedTax = { subtotal: { label: 'Subtotal', amount: '1,100.00' }, amountDue: '$1,150.00', freight: '$100.00', tax: '$50.00', taxLabel: 'Sales Tax', creditCents: 0 };
    expect(subtotalFreightCents({ ...repeatedTax, otherCharges: [{ label: 'Sales Tax', amount: '$50.00' }] })).toBe(10000);
    expect(subtotalFreightCents({ ...repeatedTax, otherCharges: [{ label: 'County Tax', amount: '$50.00' }] })).toBeUndefined();
  });

  it('measures the subtotal shortfall without the freight inside it', () => {
    expect(lineSubtotalShortfallCents(supin472322ProductionRows, header.extractedLineSubtotal)).toBe(338800);
    expect(lineSubtotalShortfallCents(supin472322ProductionRows, header.extractedLineSubtotal, 200000)).toBe(138800);
    expect(lineSubtotalShortfallCents(supin472322Rows, header.extractedLineSubtotal, 200000)).toBeUndefined();
  });

  it('words the note around the rows without freight', () => {
    expect(lineSubtotalReviewNote(supin472322ProductionRows, header.extractedLineSubtotal, 138800, 200000)).toBe(
      'The extracted lines total $44,714.66, but the document prints $48,102.66 as "Subtotal", $46,102.66 without the $2,000.00 freight it includes.'
      + ' The $1,388.00 difference may be a row that was not read.'
    );
    expect(lineSubtotalReviewNote(supin472322Rows, header.extractedLineSubtotal, undefined, 200000)).toBeUndefined();
    expect(lineSubtotalReviewNote(supin472322Rows, header.extractedLineSubtotal, 0, 200000)).toBeUndefined();
  });

  it('says no row carries the $1,388.00 once a second read found none, and that the second read was skipped when it was', () => {
    const head = 'The extracted lines total $44,714.66, but the document prints $48,102.66 as "Subtotal", $46,102.66 without the $2,000.00 freight it includes.';
    expect(lineSubtotalReviewNote(supin472322ProductionRows, header.extractedLineSubtotal, 138800, 200000, 'rejected')).toBe(
      `${head} A second read of the document found no row that makes up the $1,388.00, so the document's own totals may not agree (a section or summary total that is higher than its rows).`
      + ' Check the PDF; if no row carries the $1,388.00, it is not missing from the lines.'
    );
    expect(lineSubtotalReviewNote(supin472322ProductionRows, header.extractedLineSubtotal, 138800, 200000, 'skipped')).toBe(
      `${head} The $1,388.00 difference may be a row that was not read. A second read was skipped because the first read was slow.`
    );
    expect(lineSubtotalReviewNote(supin472322ProductionRows, header.extractedLineSubtotal, 138800, 200000, 'inconclusive')).toBe(
      `${head} The $1,388.00 difference may be a row that was not read. A second read changed or added rows but did not make up the difference, so it was not used.`
    );
    expect(lineSubtotalReviewNote(supin472322ProductionRows, header.extractedLineSubtotal, 138800, 200000, 'not_lines')).toBe(
      `${head} A second read returned a row that would make up the shortfall, but its label reads as tax, a balance, a payment, or a finance charge, so it was not added as a line. Check the PDF for what that row is.`
    );
    expect(lineSubtotalReviewNote(supin472322ProductionRows, header.extractedLineSubtotal, 138800, 200000, 'failed')).toBe(
      `${head} The $1,388.00 difference may be a row that was not read.`
    );
    expect(lineSubtotalReviewNote(supin472322Rows, header.extractedLineSubtotal, 0, 200000, 'rejected')).toBeUndefined();
  });
});

describe('poTotalReviewNote (SUPIN-472322)', () => {
  const due = supin472322Header.extractedAmountDue;

  it('names six PO lines that total the amount due beside 59 submitted rows', () => {
    expect(poTotalReviewNote(supin472322PoLines as any[], due, 59)).toBe(
      "The PO's 6 lines total $41,590.16, which is the amount due, so the supplier may have billed what the PO lists rather than the 59 rows read from the PDF."
      + ' The invoice lines were not changed to match the PO; AP may need to book one line per PO line.'
    );
  });

  it('says nothing when the PO total is not the amount due, a PO line has no amount, or the line counts match', () => {
    expect(poTotalReviewNote(supin472322PoLines as any[], '$41,590.17', 59)).toBeUndefined();
    expect(poTotalReviewNote([...supin472322PoLines, { lineOrder: 7, purchaseOrderLineId: 'X' }] as any[], due, 59)).toBeUndefined();
    expect(poTotalReviewNote(supin472322PoLines as any[], due, 6)).toBeUndefined();
    expect(poTotalReviewNote(undefined, due, 59)).toBeUndefined();
    expect(poTotalReviewNote([], due, 59)).toBeUndefined();
    expect(poTotalReviewNote(supin472322PoLines as any[], null, 59)).toBeUndefined();
  });

  it('reads a PO line from quantity times unit cost when it has no extended amount', () => {
    const lines = [{ lineOrder: 1, purchaseOrderLineId: 'A', quantity: 2, unitCost: 50 }, { lineOrder: 2, purchaseOrderLineId: 'B', quantity: 1, unitCost: 25 }] as any[];
    expect(poTotalReviewNote(lines, '$125.00', 5)).toContain("The PO's 2 lines total $125.00");
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

  it('uses the extracted rows as the contract total only when printed payments account for the gap', () => {
    const plan = planBalanceInvoice(balanceInput({ lineSubtotal: null, emailBalanceDue: null, priorPayments: supin471692Payments }))!;
    expect(plan.applied).toBe(true);
    expect(plan.line?.description).toBe('Motorcoach transportation - event shuttles (balance due of $23,887.00)');
  });

  it('does not trust the email alone without a printed contract total', () => {
    expect(planBalanceInvoice(balanceInput({ lineSubtotal: null }))).toBeUndefined();
  });

  it('says so when printed payments disagree with the amount due but the email matches', () => {
    const plan = planBalanceInvoice(balanceInput({ priorPayments: [{ label: 'Payments Received', amount: '$10,000.00' }] }))!;
    expect(plan.applied).toBe(true);
    expect(plan.note).toContain('The document prints $10,000.00 in payments, which leaves $13,887.00, not the amount due; check the payments against the PDF.');
    expect(plan.slackLines[0]).toContain('the PDF prints $10,000.00 in payments, which does not match, so check them');
    expect(plan.note).not.toContain('prints no payments');
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

describe('planBalanceInvoice for a pay application with retainage (SUPIN-474922)', () => {
  const payAppInput = (overrides: Partial<BalanceInvoiceInput> = {}): BalanceInvoiceInput => ({
    priorPayments: supin474922Payments,
    retainage: supin474922Retainage,
    emailBalanceDue: null,
    lineSubtotal: supin474922Header.extractedLineSubtotal,
    amountDue: supin474922Header.extractedAmountDue,
    lines: supin474922Rows,
    poLines: undefined,
    ...overrides,
  });
  const poLine = (id: string, amount: number, extra: Record<string, unknown> = {}) => ({ lineOrder: 1, purchaseOrderLineId: id, quantity: 1, unitCost: amount, extendedAmount: amount, ...extra }) as any;

  it('has contract sum, retainage, and previous certificates that reconcile to the current payment due', () => {
    expect(59153.2).toBeCloseTo(591532 * 0.1, 2);
    expect(591532.0 - 59153.2 - 402241.76).toBeCloseTo(130137.04, 2);
  });

  it('books one line at the current payment due with the breakdown note', () => {
    const plan = planBalanceInvoice(payAppInput())!;

    expect(plan.applied).toBe(true);
    expect(plan.noteLabel).toBe('Pay application');
    expect(plan.line).toEqual({
      description: 'Pay application - current payment due (Contract Sum to Date $591,532.00)',
      quantity: 1,
      unitCost: '$130,137.04',
      totalPrice: '$130,137.04',
      hasDiscount: null,
      tableNumber: 1,
    });
    expect(plan.poLines).toBeUndefined();
    expect(plan.note).toContain('"Contract Sum to Date" is $591,532.00, less "Retainage" (10%) $59,153.20, less "Less Previous Certificates for Payment" $402,241.76, which leaves the $130,137.04 current payment due (1 printed line).');
    expect(plan.note).toContain('submitted as one $130,137.04 line instead of the printed lines');
    expect(plan.amountDueNote).toBe('pay application, $591,532.00 to date');
    expect(plan.slackLines).toEqual(['Contract Sum to Date: $591,532.00 to date, less $59,153.20 retainage, less $402,241.76 previous payments, $130,137.04 current payment due. Submitted as one pay-application line, not the printed lines.']);
  });

  it('does not apply the incident reading, where the retainage was not extracted', () => {
    const plan = planBalanceInvoice(payAppInput({ retainage: null }))!;
    expect(plan.applied).toBe(false);
    expect(plan.noteLabel).toBe('Balance invoice');
    expect(plan.line).toBeUndefined();
    expect(plan.note).toContain('the printed payments total $402,241.76, which leaves $189,290.24 of the $591,532.00 contract total, not the amount due $130,137.04');
  });

  it('applies a first pay application that has retainage and no previous certificates', () => {
    const plan = planBalanceInvoice(payAppInput({ priorPayments: null, amountDue: '$532,378.80' }))!;
    expect(plan.applied).toBe(true);
    expect(plan.note).toContain('"Contract Sum to Date" is $591,532.00, less "Retainage" (10%) $59,153.20, which leaves the $532,378.80 current payment due');
    expect(plan.slackLines[0]).toBe('Contract Sum to Date: $591,532.00 to date, less $59,153.20 retainage, $532,378.80 current payment due. Submitted as one pay-application line, not the printed lines.');
  });

  it('reads retainage printed in parentheses or without a percent', () => {
    const plan = planBalanceInvoice(payAppInput({ retainage: { label: 'Less Retainage', percent: null, amount: '($59,153.20)' } }))!;
    expect(plan.applied).toBe(true);
    expect(plan.note).toContain('less "Less Retainage" $59,153.20');
  });

  it('does not apply and shows the arithmetic when the figures do not reconcile', () => {
    const plan = planBalanceInvoice(payAppInput({ retainage: { ...supin474922Retainage, amount: '$59,153.21' } }))!;
    expect(plan.applied).toBe(false);
    expect(plan.noteLabel).toBe('Pay application');
    expect(plan.line).toBeUndefined();
    expect(plan.note).toBe('This looks like a construction pay application with retainage, but the $591,532.00 contract total less $59,153.21 retainage and $402,241.76 in previous payments is $130,137.03, not the current payment due $130,137.04, so the printed lines were submitted unchanged. The submitted lines may not match the current payment due; check before approving.');
    expect(plan.slackLines).toEqual(['Pay application not applied: the $591,532.00 contract total less $59,153.21 retainage and $402,241.76 in previous payments is $130,137.03, not the current payment due $130,137.04.']);
  });

  it('does not apply when a printed amount is off by the retainage alone', () => {
    const plan = planBalanceInvoice(payAppInput({ priorPayments: null }))!;
    expect(plan.applied).toBe(false);
    expect(plan.note).toContain('the $591,532.00 contract total less $59,153.20 retainage is $532,378.80, not the current payment due $130,137.04');
  });

  it('applies but mentions a printed percent that does not match the retainage amount', () => {
    const plan = planBalanceInvoice(payAppInput({ retainage: { ...supin474922Retainage, percent: '5%' } }))!;
    expect(plan.applied).toBe(true);
    expect(plan.note).toContain('5% of $591,532.00 is $29,576.60, not the printed retainage $59,153.20; check the retainage against the PDF.');
  });

  it.each([['TBD'], ['see attached'], ['--']])('does not apply and names the unreadable retainage %s', (amount) => {
    const plan = planBalanceInvoice(payAppInput({ retainage: { ...supin474922Retainage, amount } }))!;
    expect(plan.applied).toBe(false);
    expect(plan.line).toBeUndefined();
    expect(plan.noteLabel).toBe('Pay application');
    expect(plan.note).toContain(`the printed retainage "${amount}" is not a readable amount, so the figures cannot be checked, so the printed lines were submitted unchanged`);
    expect(plan.slackLines).toEqual([`Pay application not applied: the printed retainage "${amount}" is not a readable amount, so the figures cannot be checked.`]);
  });

  it.each([['Tax'], [''], ['Retainage Release'], ['Less Retainage Released']])('does not apply when the retainage row is labeled "%s"', (label) => {
    const plan = planBalanceInvoice(payAppInput({ retainage: { ...supin474922Retainage, label } }))!;
    expect(plan.applied).toBe(false);
    expect(plan.line).toBeUndefined();
    expect(plan.noteLabel).toBe('Pay application');
    expect(plan.note).toContain(`the printed row "${label}" is not labeled as retainage held, so the figures cannot be checked`);
  });

  it.each([['Retainage'], ['Less 10% Retainage'], ['Retention'], ['Less Retention Held'], ['Retainage Held']])('accepts the retainage label "%s"', (label) => {
    expect(planBalanceInvoice(payAppInput({ retainage: { ...supin474922Retainage, label } }))!.applied).toBe(true);
  });

  it('does not apply when the document prints no contract sum to date, which a line sum cannot stand in for', () => {
    const plan = planBalanceInvoice(payAppInput({ lineSubtotal: null }))!;
    expect(plan.applied).toBe(false);
    expect(plan.note).toContain('the document prints no contract sum to date to reconcile the retainage against');
  });

  it.each(['TBD 59,153.20', 'see attached 59153.20', '10% 59,153.20'])('does not apply when the retainage "%s" only contains digits', (amount) => {
    const plan = planBalanceInvoice(payAppInput({ retainage: { ...supin474922Retainage, amount } }))!;
    expect(plan.applied).toBe(false);
    expect(plan.note).toContain('is not a readable amount');
  });

  it('does not apply when a previous payment only contains digits', () => {
    const plan = planBalanceInvoice(payAppInput({ priorPayments: [{ label: 'Less Previous Certificates for Payment', amount: 'TBD 402,241.76' }] }))!;
    expect(plan.applied).toBe(false);
  });

  it('counts a $0.00 previous payment row as none and still sums the other rows', () => {
    const plan = planBalanceInvoice(payAppInput({ priorPayments: [{ label: 'Prior', amount: '$0.00' }, ...supin474922Payments] }))!;
    expect(plan.applied).toBe(true);
    expect(plan.line?.totalPrice).toBe('$130,137.04');
  });

  it('does not take a "Customer Retention Services" row for retainage held', () => {
    const plan = planBalanceInvoice(payAppInput({ retainage: { ...supin474922Retainage, label: 'Customer Retention Services' } }))!;
    expect(plan.applied).toBe(false);
    expect(plan.note).toContain('is not labeled as retainage held');
  });

  it('does not apply when a printed previous payment is not a readable amount', () => {
    const plan = planBalanceInvoice(payAppInput({ priorPayments: [{ label: 'Less Previous Certificates for Payment', amount: 'TBD' }] }))!;
    expect(plan.applied).toBe(false);
    expect(plan.note).toContain('a printed previous payment is not a readable amount, so the figures cannot be checked');
  });

  it('treats a printed $0.00 previous payment as none on a first pay application', () => {
    const plan = planBalanceInvoice(payAppInput({
      priorPayments: [{ label: 'Less Previous Certificates for Payment', amount: '$0.00' }],
      amountDue: '$532,378.80',
    }))!;
    expect(plan.applied).toBe(true);
    expect(plan.note).toContain('less "Retainage" (10%) $59,153.20, which leaves the $532,378.80 current payment due');
  });

  it('treats a printed $0.00 retainage as none, so the legacy balance rule decides', () => {
    const plan = planBalanceInvoice(payAppInput({ retainage: { ...supin474922Retainage, percent: null, amount: '$0.00' } }))!;
    expect(plan.applied).toBe(false);
    expect(plan.noteLabel).toBe('Balance invoice');
  });

  it('books without a PO link when the PO has no lines', () => {
    const none = planBalanceInvoice(payAppInput({ poLines: [] as any[] }))!;
    expect(none.applied).toBe(true);
    expect(none.noteLabel).toBe('Pay application');
  });

  it('is silent when the lines or contract total do not exceed the amount due', () => {
    expect(planBalanceInvoice(payAppInput({ amountDue: '$591,532.00' }))).toBeUndefined();
    expect(planBalanceInvoice(payAppInput({ amountDue: null }))).toBeUndefined();
  });

  it('does not apply when tax or freight is also printed', () => {
    for (const charges of [{ taxAmount: '$100.00' }, { freightAmount: '$50.00' }]) {
      const plan = planBalanceInvoice(payAppInput(charges))!;
      expect(plan.applied).toBe(false);
      expect(plan.note).toContain('pay applications with header charges are not booked automatically');
    }
  });

  it('does not let an email balance book a pay application whose figures do not reconcile', () => {
    const plan = planBalanceInvoice(payAppInput({
      retainage: { ...supin474922Retainage, amount: '$50,000.00' },
      emailBalanceDue: { amount: '$130,137.04', phrase: 'remaining balance' },
    }))!;
    expect(plan.applied).toBe(false);
    expect(plan.note).toContain('is $139,290.24, not the current payment due $130,137.04');
    expect(plan.note).toContain('so the printed lines were submitted unchanged');
  });

  it('books a partly finished job from Total Completed and Stored to Date, not the larger contract sum', () => {
    const plan = planBalanceInvoice(payAppInput({
      lineSubtotal: { label: 'Total Completed and Stored to Date', amount: '$591,532.00' },
      emailBalanceDue: null,
    }))!;
    expect(plan.applied).toBe(true);
    expect(plan.line?.description).toBe('Pay application - current payment due (Total Completed and Stored to Date $591,532.00)');
    expect(plan.note).toContain('"Total Completed and Stored to Date" is $591,532.00, less "Retainage" (10%) $59,153.20');
  });

  it('flags the contract sum as the base when the completed work is smaller', () => {
    const plan = planBalanceInvoice(payAppInput({
      lineSubtotal: { label: 'Contract Sum to Date', amount: '$700,000.00' },
      emailBalanceDue: null,
    }))!;
    expect(plan.applied).toBe(false);
    expect(plan.note).toContain('the $700,000.00 contract total less $59,153.20 retainage and $402,241.76 in previous payments is $238,605.04, not the current payment due $130,137.04');
  });

  it('reports a percent mismatch when the arithmetic reconciles', () => {
    const plan = planBalanceInvoice(payAppInput({ retainage: { ...supin474922Retainage, percent: '5%' } }))!;
    expect(plan.applied).toBe(true);
    expect(plan.note).toContain('5% of $591,532.00 is $29,576.60, not the printed retainage $59,153.20');
  });

  describe('with a PO', () => {
    it('pins the one open PO line for the contract sum to date', () => {
      const contractLine = poLine('L1', 591532);
      const plan = planBalanceInvoice(payAppInput({ poLines: [contractLine, poLine('L2', 12000)] }))!;
      expect(plan.applied).toBe(true);
      expect(plan.poLines).toEqual([contractLine]);
      expect(plan.note).not.toContain('PO line');
    });

    it('pins a PO line that equals the current payment due first', () => {
      const dueLine = poLine('L2', 130137.04);
      const plan = planBalanceInvoice(payAppInput({ poLines: [poLine('L1', 591532), dueLine] }))!;
      expect(plan.poLines).toEqual([dueLine]);
    });

    it('pins the only PO line whatever its amount', () => {
      const only = poLine('L1', 700000);
      const plan = planBalanceInvoice(payAppInput({ poLines: [only] }))!;
      expect(plan.applied).toBe(true);
      expect(plan.poLines).toEqual([only]);
    });

    it('warns when the only PO line is already fully invoiced', () => {
      const plan = planBalanceInvoice(payAppInput({ poLines: [poLine('L1', 591532, { availableForInvoicing: false })] }))!;
      expect(plan.applied).toBe(true);
      expect(plan.note).toContain('The PO line for this pay application is already fully invoiced or closed; check whether this pay application was billed before approving.');
      expect(plan.slackLines).toHaveLength(2);
    });

    it('leaves the line unpinned for the merge, and says so, when several PO lines could fit', () => {
      const plan = planBalanceInvoice(payAppInput({ poLines: [poLine('L1', 300000), poLine('L2', 291532)] }))!;
      expect(plan.applied).toBe(true);
      expect(plan.poLines).toBeUndefined();
      expect(plan.note).toContain('No PO line is for $130,137.04, and none or several PO lines are for the $591,532.00 contract total, so the PO line was left to the line merge; check the PO line coding before approving.');
      expect(plan.slackLines).toHaveLength(2);
    });
  });
});

describe('hasPrintedRetainage', () => {
  it.each([
    [{ label: 'Retainage', percent: '10%', amount: '$59,153.20' }, true],
    [{ label: 'Less Retention Held', percent: null, amount: '($59,153.20)' }, true],
    [{ label: 'Retainage', percent: null, amount: 'TBD' }, false],
    [{ label: 'Retainage', percent: null, amount: '$0.00' }, false],
    [{ label: 'Tax', percent: null, amount: '$59,153.20' }, false],
    [{ label: 'Retainage Release', percent: null, amount: '$59,153.20' }, false],
    [null, false],
    [undefined, false],
  ])('reads %j as %s', (retainage, expected) => {
    expect(hasPrintedRetainage(retainage as any)).toBe(expected);
  });
});

describe('amountDueGapCents with retainage', () => {
  it('is not a meaningful check on a pay application', () => {
    expect(amountDueGapCents({ lines: supin474922Rows, amountDue: '$130,137.04', retainage: supin474922Retainage })).toBeUndefined();
  });

  it('still checks the gap when the retainage row is unreadable or not a retainage row', () => {
    expect(amountDueGapCents({ lines: supin474922Rows, amountDue: '$130,137.04', retainage: { ...supin474922Retainage, amount: 'TBD' } })).toBe(130137.04 * 100 - 591532 * 100);
  });
});

describe('formatPartialPaymentNotes label', () => {
  it('defaults to the deposit label and takes a balance label', () => {
    expect(formatPartialPaymentNotes('Text.')).toContain('Deposit invoice: Text.');
    expect(formatPartialPaymentNotes('Text.', 'Balance invoice')).toContain('Balance invoice: Text.');
    expect(formatPartialPaymentNotes(undefined, 'Balance invoice')).toBe('');
  });
});
