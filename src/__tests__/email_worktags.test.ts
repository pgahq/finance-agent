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
  company: null,
  event: null,
  lineOfBusiness: { extracted: 'Production & Advertising', referenceId: 'LOB-Production_&_Advertising' },
  fund: null,
  costCenter: { extracted: 'Brand & Marketing', name: 'CC-Brand & Digital Marketing', code: 'CC-Brand_&_Digital_Marketing' },
  spendCategory: { extracted: 'Advertising & Promotion', name: 'Advertising and Promotion', referenceId: 'SC-Advertising_and_Promotion' },
};
const recruitmentCoding = {
  company: null,
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

  it('carries each budget\'s own company and the invoice company', () => {
    const result = buildEmailWorktags({
      emailWorktags: { ...brandCoding, company },
      emailBudgetSplits: [
        { label: 'A', amount: '$1', percent: null, equalShare: null, ...recruitmentCoding },
        {
          label: 'B', amount: '$2', percent: null, equalShare: null, ...brandCoding,
          company: { extracted: '410', name: 'PGA Corporation', workdayId: 'wid-410', referenceId: '410' },
        },
      ],
    }, { referenceId: '310', workdayId: 'wid-310' }, { budgetSplitBaseCents: 300, budgetSplitGrossCents: 330 });

    expect(result?.companyReferenceId).toBe('310');
    expect(result?.budgetSplitGrossCents).toBe(330);
    expect(result?.budgetSplits?.map(split => split.companyReferenceId)).toEqual([null, '410']);
    expect(result?.budgetSplits?.[1].companyName).toBe('PGA Corporation');
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
    expect(budgetSplitOptions({ charges })).toEqual({ budgetSplitBaseCents: 3500000, budgetSplitGrossCents: 3500000 });
    expect(budgetSplitOptions({ charges: { amountDue: '$1,000.00', freightAmount: '$50.00', taxAmount: '$25.50' } }))
      .toEqual({ budgetSplitBaseCents: 92450, budgetSplitGrossCents: 100000 });
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

  it('names the company and explains the rolled-in tax when the email budgeted the amount due', () => {
    const rolledIn = {
      applied: true,
      budgets: [
        { label: 'SPLIT #1', amountCents: 1176423, costCenterId: 'CC-A', spendCategoryId: null, companyId: null },
        { label: 'SPLIT #2', amountCents: 185751, costCenterId: 'CC-B', spendCategoryId: null, companyId: '410' },
      ],
      headerChargesRolledIn: { amountDueCents: 1362174, lineTotalCents: 1247400 },
      review: 'SPLIT #2 has no spend category in the email; set its spend category before approving.',
    };

    expect(describeEmailBudgetSplit(rolledIn)[1]).toBe('$1,857.51 SPLIT #2 (Company 410, Cost Center CC-B)');
    const notes = formatEmailBudgetSplitNotes(rolledIn);
    expect(notes).toContain("The email's amounts total $13,621.74, the full amount due, so each budget line carries its share of the $1,147.74 of tax and freight and the invoice header tax and freight were cleared");
    expect(notes).toContain('\n\nBudget split review: SPLIT #2 has no spend category');
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

  it('asks for a per-budget company and an expense item as a spend category hint', () => {
    expect(invoiceMatchingPrompt).toContain("put it in that entry's company");
    expect(invoiceMatchingPrompt).toContain('"Expense Item: Hotel"');
    expect(invoiceMatchingPrompt).toContain('"Lodging" spend category');
  });
});
