import {
  emailCodingOverPurchaseOrder,
  emailCodingOverridesPoSupplierWids,
  formatPurchaseOrderSkippedNotes,
  type EmailCodingOverPurchaseOrderInput,
} from '../lib/email_coding_over_po.js';

const coding = (cc: string | null, sc: string | null) => ({
  company: null,
  event: null,
  fund: null,
  lineOfBusiness: null,
  costCenter: cc ? { extracted: cc, name: cc, code: cc } : null,
  spendCategory: sc ? { extracted: sc, name: sc, referenceId: sc } : null,
});

const split = (label: string, share: { amount?: string; percent?: number; equalShare?: boolean }, cc: string | null = 'CC-Membership Dues', sc: string | null = null) => ({
  label,
  amount: share.amount ?? null,
  percent: share.percent ?? null,
  equalShare: share.equalShare ?? null,
  ...coding(cc, sc),
});

const pbdSplits = () => [
  split('Fulfillment', { amount: '$1,032.60' }, 'CC-Membership Dues', 'SC-Fulfillment'),
  split('Printing', { amount: '$2,091.38' }, 'CC-Membership Dues', 'SC-Printing'),
  split('Postage', { amount: '$489.41' }, 'CC-Membership Dues', 'SC-Postage'),
];

const input = (overrides: Partial<EmailCodingOverPurchaseOrderInput> & { splits?: ReturnType<typeof pbdSplits> } = {}): EmailCodingOverPurchaseOrderInput => ({
  invoiceSupplierWorkdayId: 'pbd-wid',
  purchaseOrderFromNote: false,
  env: { EMAIL_CODING_OVERRIDES_PO_SUPPLIER_WIDS: 'pbd-wid' } as NodeJS.ProcessEnv,
  result: {
    emailWorktags: null,
    emailBudgetSplits: overrides.splits ?? pbdSplits(),
    extractedAmountDue: '$3,613.39',
    extractedFreightAmount: null,
    extractedTaxAmount: null,
  },
  ...overrides,
});

describe('emailCodingOverridesPoSupplierWids', () => {
  it('reads a comma or whitespace separated list and ignores blanks', () => {
    expect([...emailCodingOverridesPoSupplierWids({ EMAIL_CODING_OVERRIDES_PO_SUPPLIER_WIDS: ' a, b\nc ,, ' } as NodeJS.ProcessEnv)]).toEqual(['a', 'b', 'c']);
  });

  it('is empty when the parameter is missing', () => {
    expect(emailCodingOverridesPoSupplierWids({} as NodeJS.ProcessEnv).size).toBe(0);
  });
});

describe('emailCodingOverPurchaseOrder', () => {
  it('sets the PO aside for a listed supplier whose email budgets total the amount due (SUPIN-474055)', () => {
    expect(emailCodingOverPurchaseOrder(input())).toBe(true);
  });

  it('matches only the invoice supplier, never the supplier a PO was issued to', () => {
    expect(emailCodingOverPurchaseOrder(input({ invoiceSupplierWorkdayId: 'other-record' }))).toBe(false);
    expect(emailCodingOverPurchaseOrder(input({ invoiceSupplierWorkdayId: null }))).toBe(false);
  });

  it('leaves the PO in charge for every supplier that is not listed, and when the list is empty', () => {
    expect(emailCodingOverPurchaseOrder(input({ invoiceSupplierWorkdayId: 'x' }))).toBe(false);
    expect(emailCodingOverPurchaseOrder(input({ env: {} as NodeJS.ProcessEnv }))).toBe(false);
  });

  it('compares supplier WIDs without regard to case or padding', () => {
    expect(emailCodingOverPurchaseOrder(input({
      invoiceSupplierWorkdayId: ' PBD-WID ',
      env: { EMAIL_CODING_OVERRIDES_PO_SUPPLIER_WIDS: 'Pbd-Wid' } as NodeJS.ProcessEnv,
    }))).toBe(true);
  });

  it('never sets aside a PO that an AP note chose', () => {
    expect(emailCodingOverPurchaseOrder(input({ purchaseOrderFromNote: true }))).toBe(false);
  });

  it('never sets aside a PO the requester named in the email when it differs from the printed one', () => {
    expect(emailCodingOverPurchaseOrder(input({ purchaseOrderNamedInEmail: true }))).toBe(false);
    expect(emailCodingOverPurchaseOrder(input({ purchaseOrderNamedInEmail: false }))).toBe(true);
  });

  it('needs two or more budgets', () => {
    expect(emailCodingOverPurchaseOrder(input({ splits: [pbdSplits()[0]] }))).toBe(false);
    expect(emailCodingOverPurchaseOrder(input({ splits: [] }))).toBe(false);
  });

  it('keeps the PO when the budget amounts do not reconcile', () => {
    const splits = pbdSplits();
    splits[0] = split('Fulfillment', { amount: '$1,000.00' }, 'CC-Membership Dues', 'SC-Fulfillment');
    expect(emailCodingOverPurchaseOrder(input({ splits }))).toBe(false);
  });

  it('keeps the PO when a budget has neither a cost center nor a spend category', () => {
    const splits = pbdSplits();
    splits[2] = split('Postage', { amount: '$489.41' }, null, null);
    expect(emailCodingOverPurchaseOrder(input({ splits }))).toBe(false);
  });

  it('keeps the PO when the shares mix amounts and percentages', () => {
    const splits = pbdSplits();
    splits[1] = split('Printing', { percent: 50 }, 'CC-Membership Dues', 'SC-Printing');
    expect(emailCodingOverPurchaseOrder(input({ splits }))).toBe(false);
  });

  it('accepts percentages that total 100 and an even split', () => {
    const percents = [split('A', { percent: 60 }), split('B', { percent: 40 })];
    expect(emailCodingOverPurchaseOrder(input({ splits: percents }))).toBe(true);
    const even = [split('A', { equalShare: true }), split('B', { equalShare: true })];
    expect(emailCodingOverPurchaseOrder(input({ splits: even }))).toBe(true);
  });

  it('accepts amounts that total the merchandise before header tax and freight, and the amount due that includes them', () => {
    const base = input();
    const withCharges = (splits: ReturnType<typeof pbdSplits>) => input({
      splits,
      result: { ...base.result, emailBudgetSplits: splits, extractedAmountDue: '$1,100.00', extractedTaxAmount: '$100.00' },
    });
    expect(emailCodingOverPurchaseOrder(withCharges([split('A', { amount: '$400.00' }), split('B', { amount: '$600.00' })]))).toBe(true);
    expect(emailCodingOverPurchaseOrder(withCharges([split('A', { amount: '$500.00' }), split('B', { amount: '$600.00' })]))).toBe(true);
    expect(emailCodingOverPurchaseOrder(withCharges([split('A', { amount: '$500.00' }), split('B', { amount: '$550.00' })]))).toBe(false);
  });

  it('keeps the PO when the amount due cannot be read', () => {
    const base = input();
    expect(emailCodingOverPurchaseOrder(input({ result: { ...base.result, extractedAmountDue: null } }))).toBe(false);
  });
});

describe('formatPurchaseOrderSkippedNotes', () => {
  it('says the PO was not used and the invoice is not linked to it', () => {
    expect(formatPurchaseOrderSkippedNotes('PO-414088')).toBe(
      "\n\nPurchase order: PO-414088 on the invoice was not used. The email gives budget coding and this supplier's invoices are coded from the email; the invoice is not linked to a PO."
    );
  });
});
