import { budgetSplitOptions, buildEmailWorktags } from '../lib/email_worktags.js';
import { invoiceMatchingPrompt } from '../prompts/enrich_invoice_prompt.js';
import { describeEmailBudgetSplit, formatEmailBudgetSplitNotes, formatEmailWorktagNotes } from '../lib/invoice_enrichment.js';

jest.mock('@pga/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
}));

const brandCoding = {
  event: null,
  lineOfBusiness: { extracted: 'Production & Advertising', referenceId: 'LOB-Production_&_Advertising' },
  fund: null,
  costCenter: { extracted: 'Brand & Marketing', name: 'CC-Brand & Digital Marketing', code: 'CC-Brand_&_Digital_Marketing' },
  spendCategory: { extracted: 'Advertising & Promotion', name: 'Advertising and Promotion', referenceId: 'SC-Advertising_and_Promotion' },
};
const recruitmentCoding = {
  event: null,
  lineOfBusiness: { extracted: 'Recruitment', referenceId: 'LOB-Recruitment' },
  fund: null,
  costCenter: { extracted: 'Recruitment', name: 'CC-Recruitment', code: 'CC-Recruitment' },
  spendCategory: { extracted: 'Sponsorship', name: 'Sponsorships', referenceId: 'SC-Sponsorships' },
};
const company = { extracted: '310', name: 'The Professional Golfers Association of America', workdayId: 'wid-310', referenceId: '310' };

describe('buildEmailWorktags', () => {
  it('returns undefined when the email gave no coding', () => {
    expect(buildEmailWorktags({ emailWorktags: null, emailBudgetSplits: null })).toBeUndefined();
  });

  it('flattens the invoice-wide coding like the old inline mapping', () => {
    const result = buildEmailWorktags({
      emailWorktags: { ...brandCoding, company },
      emailBudgetSplits: null,
    });

    expect(result).toEqual({
      costCenterId: 'CC-Brand_&_Digital_Marketing',
      eventWid: null,
      lobReferenceId: 'LOB-Production_&_Advertising',
      fundReferenceId: null,
      spendCategoryReferenceId: 'SC-Advertising_and_Promotion',
    });
  });

  it('carries each budget\'s coding and the readable base when the email splits the cost', () => {
    const result = buildEmailWorktags({
      emailWorktags: {
        event: null, lineOfBusiness: null, fund: null, costCenter: null, spendCategory: null, company,
      },
      emailBudgetSplits: [
        { label: "Chris Kulinski's Budget", amount: '$15,000', percent: null, equalShare: null, ...recruitmentCoding },
        { label: 'Brand and Marketing Budget', amount: '$20,000', percent: null, equalShare: null, ...brandCoding },
      ],
    }, undefined, { budgetSplitBaseCents: 3500000 });

    expect(result?.costCenterId).toBeNull();
    expect(result?.budgetSplitBaseCents).toBe(3500000);
    expect(result?.budgetSplits).toEqual([
      expect.objectContaining({ label: "Chris Kulinski's Budget", amount: '$15,000', costCenterId: 'CC-Recruitment', lobReferenceId: 'LOB-Recruitment', spendCategoryReferenceId: 'SC-Sponsorships' }),
      expect.objectContaining({ label: 'Brand and Marketing Budget', amount: '$20,000', costCenterId: 'CC-Brand_&_Digital_Marketing', spendCategoryReferenceId: 'SC-Advertising_and_Promotion' }),
    ]);
  });

  it('works when the model returns budgets but no invoice-wide coding', () => {
    const result = buildEmailWorktags({
      emailWorktags: null,
      emailBudgetSplits: [
        { label: 'A', amount: '$1', percent: null, equalShare: null, ...recruitmentCoding },
        { label: 'B', amount: '$2', percent: null, equalShare: null, ...brandCoding },
      ],
    });

    expect(result?.budgetSplits).toHaveLength(2);
  });

  it('treats a single budget as the invoice coding instead of a split', () => {
    const result = buildEmailWorktags({
      emailWorktags: null,
      emailBudgetSplits: [{ label: 'Only', amount: null, percent: null, equalShare: null, ...recruitmentCoding }],
    });

    expect(result).toEqual({
      costCenterId: 'CC-Recruitment',
      eventWid: null,
      lobReferenceId: 'LOB-Recruitment',
      fundReferenceId: null,
      spendCategoryReferenceId: 'SC-Sponsorships',
    });
  });

  it('drops a budget cost center that is really the email company code', () => {
    const result = buildEmailWorktags({
      emailWorktags: null,
      emailBudgetSplits: [
        { label: 'A', amount: '$1', percent: null, equalShare: null, ...recruitmentCoding, costCenter: { extracted: '310', name: null, code: '310' } },
        { label: 'B', amount: '$2', percent: null, equalShare: null, ...brandCoding },
      ],
    }, { referenceId: '310', workdayId: 'wid-310' });

    expect(result?.budgetSplits?.[0].costCenterId).toBeNull();
  });
});

describe('budgetSplitOptions', () => {
  const charges = { amountDue: '$35,000', freightAmount: undefined, taxAmount: undefined };

  it('uses amount due less freight and tax as the base', () => {
    expect(budgetSplitOptions({ charges })).toEqual({ budgetSplitBaseCents: 3500000 });
    expect(budgetSplitOptions({ charges: { amountDue: '$1,000.00', freightAmount: '$50.00', taxAmount: '$25.50' } }))
      .toEqual({ budgetSplitBaseCents: 92450 });
  });

  it('blocks splits for all-freight invoices, withheld charges, and unreadable amounts due', () => {
    expect(budgetSplitOptions({ charges, freightAsLines: true }).budgetSplitBlockedReason).toContain('all-freight');
    expect(budgetSplitOptions({ charges, chargeWithheld: true }).budgetSplitBlockedReason).toContain('could not be read');
    expect(budgetSplitOptions({ charges: { amountDue: undefined } }).budgetSplitBlockedReason).toContain('amount due');
  });
});

describe('email budget split notes', () => {
  const outcome = {
    applied: true,
    budgets: [
      { label: "Chris Kulinski's Budget", amountCents: 1500000, costCenterId: 'CC-Recruitment', spendCategoryId: 'SC-Sponsorships' },
      { label: 'Brand and Marketing Budget', amountCents: 2000000, costCenterId: 'CC-Brand_&_Digital_Marketing', spendCategoryId: 'SC-Advertising_and_Promotion' },
    ],
  };

  it('lists one line per budget in the Workday note and Slack', () => {
    expect(describeEmailBudgetSplit(outcome)).toEqual([
      "$15,000.00 Chris Kulinski's Budget (Cost Center CC-Recruitment, Spend Category SC-Sponsorships)",
      '$20,000.00 Brand and Marketing Budget (Cost Center CC-Brand_&_Digital_Marketing, Spend Category SC-Advertising_and_Promotion)',
    ]);
    expect(formatEmailBudgetSplitNotes(outcome)).toBe(
      "\n\nEmail budget split (one invoice line per budget): "
      + "$15,000.00 Chris Kulinski's Budget (Cost Center CC-Recruitment, Spend Category SC-Sponsorships); "
      + '$20,000.00 Brand and Marketing Budget (Cost Center CC-Brand_&_Digital_Marketing, Spend Category SC-Advertising_and_Promotion)'
    );
  });

  it('writes the review note when the split was not applied and nothing otherwise', () => {
    expect(formatEmailBudgetSplitNotes({ applied: false, review: 'The email splits the cost across 2 budgets (A; B), but x.', budgets: [] }))
      .toBe('\n\nBudget split review: The email splits the cost across 2 budgets (A; B), but x.');
    expect(describeEmailBudgetSplit({ applied: false, review: 'x', budgets: [] })).toEqual([]);
    expect(formatEmailBudgetSplitNotes(undefined)).toBe('');
  });

  it('names the spend category in the email worktag note', () => {
    const notes = formatEmailWorktagNotes({
      emailWorktags: { ...brandCoding, company },
    } as any);

    expect(notes).toContain('Spend Category: Advertising & Promotion (resolved: Advertising and Promotion)');
  });
});

describe('budget split prompt rule', () => {
  it('treats a stated share per budget as the instruction to divide, and naming budgets alone as no split', () => {
    expect(invoiceMatchingPrompt).toContain(
      'A dollar amount or percentage stated for each budget is itself an instruction to divide the cost, even without those words.'
    );
    expect(invoiceMatchingPrompt).toContain('Merely naming more than one budget is not a split');
    expect(invoiceMatchingPrompt).toContain('"$15,000 to Recruitment and $20,000 to Brand and Marketing"');
  });
});
