jest.mock('@pga/logger', () => ({ debug: jest.fn() }));
jest.mock('../lib/ai.js', () => ({ getAiResponse: jest.fn() }));
jest.mock('../lib/invoice_ocr.js', () => ({
  ...jest.requireActual('../lib/invoice_ocr.js'),
  extractInvoiceDocuments: jest.fn(),
}));
jest.mock('../lib/database.js', () => ({
  getDatabaseConnection: jest.fn(),
  getDocumentsByWorkdayIds: jest.fn(),
}));

import { getDatabaseConnection, getDocumentsByWorkdayIds } from '../lib/database.js';
import { getAiResponse } from '../lib/ai.js';
import { extractInvoiceDocuments } from '../lib/invoice_ocr.js';
import { enrichInvoiceFromAttachments, formatPaymentTermsNotes } from '../lib/invoice_enrichment.js';
import type { InvoiceEnrichmentResult } from '../prompts/enrich_invoice_prompt.js';
import {
  applyPaymentTermsDiscountRule,
  describePaymentTerms,
  hasDiscountPercent,
  isExactPaymentTermsMatch,
  paymentTermsNameOf,
  rankPaymentTermsSearchResults,
} from '../lib/payment_terms_match.js';

const candidate = (workday_id: string, name: string, similarity = 1) => ({
  workday_id,
  similarity,
  content: `Payment Terms: ${name}`,
  metadata: { name },
});

describe('hasDiscountPercent', () => {
  it.each([
    ['3% 30 Net 30', true],
    ['2.5 % 10 Net 45', true],
    ['Net 30', false],
    ['30 NET', false],
    ['Due on receipt', false],
    ['', false],
    ['3 percent 30 Net 30', true],
    ['2.5 Percent 10 Net 45', true],
    ['a high percentage of invoices', false],
  ])('%s -> %s', (text, expected) => {
    expect(hasDiscountPercent(text)).toBe(expected);
  });
});

describe('isExactPaymentTermsMatch', () => {
  it('ignores case, spacing, and word order', () => {
    expect(isExactPaymentTermsMatch('30 NET', 'Net 30')).toBe(true);
    expect(isExactPaymentTermsMatch('NET30', 'Net 30')).toBe(true);
  });

  it('does not treat a discount term as the plain term', () => {
    expect(isExactPaymentTermsMatch('30 NET', '3% 30 Net 30')).toBe(false);
    expect(isExactPaymentTermsMatch('Net 30', 'Net 45')).toBe(false);
  });

  it('treats "%" and spelled-out "percent" as the same discount term', () => {
    expect(isExactPaymentTermsMatch('2% 10 Net 30', '2 percent 10 Net 30')).toBe(true);
  });
});

describe('paymentTermsNameOf', () => {
  it('rejects content that does not look like "Payment Terms: <name>"', () => {
    expect(paymentTermsNameOf({ content: 'Cost Center: Some Unrelated Record', metadata: undefined })).toBe('');
    expect(paymentTermsNameOf({ content: undefined, metadata: undefined })).toBe('');
  });
});

describe('rankPaymentTermsSearchResults', () => {
  const tied = [
    candidate('wid-d3', '3% 30 Net 30'),
    candidate('wid-d2', '2% 10 Net 30'),
    candidate('wid-plain', 'Net 30', 0.97),
    candidate('wid-eom', 'Net 30 EOM', 0.98),
  ];

  it('puts the exact plain term first and discount terms last when the invoice prints no discount', () => {
    expect(rankPaymentTermsSearchResults(tied, '30 NET').map((r) => r.workday_id)).toEqual([
      'wid-plain', 'wid-eom', 'wid-d2', 'wid-d3',
    ]);
  });

  it('keeps discount terms in contention when the invoice prints a discount', () => {
    const order = rankPaymentTermsSearchResults(tied, '3% 30 Net 30').map((r) => r.workday_id);
    expect(order[0]).toBe('wid-d3');
    expect(order.indexOf('wid-d2')).toBeLessThan(order.indexOf('wid-plain'));
  });

  it('orders equal scores by Workday ID whatever order they arrived in', () => {
    const rows = [candidate('wid-c', 'Net 15'), candidate('wid-a', 'Net 20'), candidate('wid-b', 'Net 25')];
    const forward = rankPaymentTermsSearchResults(rows, 'Net 60').map((r) => r.workday_id);
    const reversed = rankPaymentTermsSearchResults([...rows].reverse(), 'Net 60').map((r) => r.workday_id);
    expect(forward).toEqual(['wid-a', 'wid-b', 'wid-c']);
    expect(reversed).toEqual(forward);
  });

  it('reads the name from content when metadata has none', () => {
    const rows = [
      { workday_id: 'wid-d', similarity: 1, content: 'Payment Terms: 1% 10 Net 30' },
      { workday_id: 'wid-p', similarity: 0.9, content: 'Payment Terms: Net 45' },
    ];
    expect(rankPaymentTermsSearchResults(rows, 'Net 30').map((r) => r.workday_id)).toEqual(['wid-p', 'wid-d']);
  });
});

describe('applyPaymentTermsDiscountRule', () => {
  it('refuses a discount term when the printed terms show no discount', async () => {
    const result = await applyPaymentTermsDiscountRule(
      { name: '30 NET', workdayId: 'wid-d3' },
      async () => '3% 30 Net 30'
    );
    expect(result).toEqual({ name: '30 NET', workdayId: null, resolvedName: null, rejectedDiscountTerm: '3% 30 Net 30' });
  });

  it('keeps a discount term when the invoice prints the discount', async () => {
    const result = await applyPaymentTermsDiscountRule(
      { name: '3% 30 Net 30', workdayId: 'wid-d3' },
      async () => '3% 30 Net 30'
    );
    expect(result).toEqual({ name: '3% 30 Net 30', workdayId: 'wid-d3', resolvedName: '3% 30 Net 30' });
  });

  it('keeps a plain term and records its Workday name', async () => {
    const result = await applyPaymentTermsDiscountRule({ name: '30 NET', workdayId: 'wid-plain' }, async () => 'Net 30');
    expect(result).toEqual({ name: '30 NET', workdayId: 'wid-plain', resolvedName: 'Net 30' });
  });

  it('fails closed when the name cannot be verified and the invoice prints no discount', async () => {
    const terms = { name: '30 NET', workdayId: 'wid-x' };
    const expected = { name: '30 NET', workdayId: null, resolvedName: null, unverified: true };
    await expect(applyPaymentTermsDiscountRule(terms, async () => undefined)).resolves.toEqual(expected);
    await expect(applyPaymentTermsDiscountRule(terms, async () => { throw new Error('db down'); })).resolves.toEqual(expected);
  });

  it('keeps an unverifiable match when the invoice already prints a discount', async () => {
    const terms = { name: '3% 30 Net 30', workdayId: 'wid-x' };
    await expect(applyPaymentTermsDiscountRule(terms, async () => undefined)).resolves.toBe(terms);
    await expect(applyPaymentTermsDiscountRule(terms, async () => { throw new Error('db down'); })).resolves.toBe(terms);
  });

  it('fails closed on a name that is too long or multiline to trust', async () => {
    const terms = { name: '30 NET', workdayId: 'wid-x' };
    await expect(applyPaymentTermsDiscountRule(terms, async () => 'Net 30\n3% 10 Net 30')).resolves.toEqual(
      { name: '30 NET', workdayId: null, resolvedName: null, unverified: true }
    );
  });

  it('does nothing without a match', async () => {
    const lookup = jest.fn();
    const terms = { name: '30 NET', workdayId: null };
    await expect(applyPaymentTermsDiscountRule(terms, lookup)).resolves.toBe(terms);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('describePaymentTerms and notes', () => {
  it('shows only the printed text when it agrees with the Workday term', () => {
    expect(describePaymentTerms({ name: '30 NET', resolvedName: 'Net 30' })).toBe('30 NET');
    expect(describePaymentTerms({ name: 'Net 30' })).toBe('Net 30');
  });

  it('shows the Workday term when it reads differently', () => {
    expect(describePaymentTerms({ name: '30 NET', resolvedName: 'Net 30 EOM' })).toBe('30 NET (Workday: Net 30 EOM)');
  });

  it('says why a discount term was not used', () => {
    expect(describePaymentTerms({ name: '30 NET', rejectedDiscountTerm: '3% 30 Net 30' })).toBe(
      '30 NET (no Workday match; "3% 30 Net 30" was not used because the invoice shows no discount)'
    );
  });

  it('says the match could not be confirmed safe', () => {
    expect(describePaymentTerms({ name: '30 NET', unverified: true })).toBe(
      '30 NET (no Workday match; the matched term\'s name could not be confirmed safe)'
    );
  });

  it('puts the same explanation in the Workday note, with the Workday ID as an extra detail', () => {
    const base = { extractedPaymentTerms: { name: '30 NET', workdayId: null, rejectedDiscountTerm: '3% 30 Net 30' } } as unknown as InvoiceEnrichmentResult;
    expect(formatPaymentTermsNotes(base)).toBe(
      '\n\nPayment Terms (from document): 30 NET (no Workday match; "3% 30 Net 30" was not used because the invoice shows no discount)'
    );
    const unverified = { extractedPaymentTerms: { name: '30 NET', workdayId: null, unverified: true } } as unknown as InvoiceEnrichmentResult;
    expect(formatPaymentTermsNotes(unverified)).toBe(
      '\n\nPayment Terms (from document): 30 NET (no Workday match; the matched term\'s name could not be confirmed safe)'
    );
    const resolvedSameName = { extractedPaymentTerms: { name: '30 NET', workdayId: 'wid-plain', resolvedName: 'Net 30' } } as unknown as InvoiceEnrichmentResult;
    expect(formatPaymentTermsNotes(resolvedSameName)).toBe('\n\nPayment Terms (from document): 30 NET (Workday ID: wid-plain)');
    const resolvedDifferentName = { extractedPaymentTerms: { name: '30 NET', workdayId: 'wid-eom', resolvedName: 'Net 30 EOM' } } as unknown as InvoiceEnrichmentResult;
    expect(formatPaymentTermsNotes(resolvedDifferentName)).toBe('\n\nPayment Terms (from document): 30 NET (Workday: Net 30 EOM) (Workday ID: wid-eom)');
    const unmatched = { extractedPaymentTerms: { name: '30 NET', workdayId: null } } as unknown as InvoiceEnrichmentResult;
    expect(formatPaymentTermsNotes(unmatched)).toBe('\n\nPayment Terms (from document): 30 NET (no Workday match found)');
  });
});

describe('enrichInvoiceFromAttachments payment terms', () => {
  const ocr = (paymentTerms: string) => ({
    printedSupplier: { supplierName: 'Example Print Co', address: null, phone: null, email: null, taxId: null, website: null, industry: null, contactPerson: null, memo: null, remitToAddress: null },
    printedBillTo: { companyName: 'Example Buyer Inc', address: null, phone: null, email: null },
    extractedOtherCharges: null,
    extractedPaymentTerms: { name: paymentTerms },
    extractedInvoiceLines: null,
  });
  const matching = (workdayId: string | null) => ({
    supplier: { status: 'matching', confidence: 0.9, extractedInformation: {}, resolvedSupplier: null, potentialDuplicateSuppliers: null, recommendation: { action: 'update_invoice', reason: 'ok' }, reason: 'ok' },
    companyVerification: { status: 'matching', confidence: 0.9, extractedInformation: {}, recommended: null, reason: 'ok' },
    emailSummary: null,
    extractedPaymentTerms: { name: 'ignored', workdayId },
    emailWorktags: null,
    emailBudgetSplits: null,
  });
  const existingSupplier = { descriptor: 'Example Print Co', id: 'wid-supplier' };

  beforeEach(() => {
    (getDatabaseConnection as jest.Mock).mockReset().mockResolvedValue({});
    (getDocumentsByWorkdayIds as jest.Mock).mockReset();
  });

  it('does not use a discount term the model picked for a plain "30 NET" invoice', async () => {
    (extractInvoiceDocuments as jest.Mock).mockResolvedValue(ocr('30 NET'));
    (getAiResponse as jest.Mock).mockResolvedValue(matching('wid-d3'));
    (getDocumentsByWorkdayIds as jest.Mock).mockResolvedValue([
      { workday_id: 'wid-d3', content: 'Payment Terms: 3% 30 Net 30', metadata: { name: '3% 30 Net 30' } },
    ]);

    const result = await enrichInvoiceFromAttachments({} as never, [], existingSupplier);

    expect(getDocumentsByWorkdayIds).toHaveBeenCalledWith({}, 'payment_terms', ['wid-d3']);
    expect(result.extractedPaymentTerms).toEqual({
      name: '30 NET', workdayId: null, resolvedName: null, rejectedDiscountTerm: '3% 30 Net 30',
    });
  });

  it('keeps the plain term and records its name', async () => {
    (extractInvoiceDocuments as jest.Mock).mockResolvedValue(ocr('30 NET'));
    (getAiResponse as jest.Mock).mockResolvedValue(matching('wid-plain'));
    (getDocumentsByWorkdayIds as jest.Mock).mockResolvedValue([
      { workday_id: 'wid-plain', content: 'Payment Terms: Net 30', metadata: { name: 'Net 30' } },
    ]);

    const result = await enrichInvoiceFromAttachments({} as never, [], existingSupplier);

    expect(result.extractedPaymentTerms).toEqual({ name: '30 NET', workdayId: 'wid-plain', resolvedName: 'Net 30' });
  });

  it('fails closed when the cache lookup fails and the invoice prints no discount', async () => {
    (extractInvoiceDocuments as jest.Mock).mockResolvedValue(ocr('30 NET'));
    (getAiResponse as jest.Mock).mockResolvedValue(matching('wid-d3'));
    (getDocumentsByWorkdayIds as jest.Mock).mockRejectedValue(new Error('db down'));

    const result = await enrichInvoiceFromAttachments({} as never, [], existingSupplier);

    expect(result.extractedPaymentTerms).toEqual({
      name: '30 NET', workdayId: null, resolvedName: null, unverified: true,
    });
  });

  it('keeps an unverifiable match when the cache lookup fails but the invoice prints a discount', async () => {
    (extractInvoiceDocuments as jest.Mock).mockResolvedValue(ocr('3% 30 Net 30'));
    (getAiResponse as jest.Mock).mockResolvedValue(matching('wid-d3'));
    (getDocumentsByWorkdayIds as jest.Mock).mockRejectedValue(new Error('db down'));

    const result = await enrichInvoiceFromAttachments({} as never, [], existingSupplier);

    expect(result.extractedPaymentTerms).toEqual({ name: '3% 30 Net 30', workdayId: 'wid-d3' });
  });

  it('fails closed when duplicate cache rows for the same Workday ID disagree on the name', async () => {
    (extractInvoiceDocuments as jest.Mock).mockResolvedValue(ocr('30 NET'));
    (getAiResponse as jest.Mock).mockResolvedValue(matching('wid-d3'));
    (getDocumentsByWorkdayIds as jest.Mock).mockResolvedValue([
      { workday_id: 'wid-d3', content: 'Payment Terms: Net 30', metadata: { name: 'Net 30' } },
      { workday_id: 'wid-d3', content: 'Payment Terms: 3% 30 Net 30', metadata: { name: '3% 30 Net 30' } },
    ]);

    const result = await enrichInvoiceFromAttachments({} as never, [], existingSupplier);

    expect(result.extractedPaymentTerms).toEqual({
      name: '30 NET', workdayId: null, resolvedName: null, unverified: true,
    });
  });

  it('fails closed when one of two duplicate cache rows for the same Workday ID is malformed', async () => {
    (extractInvoiceDocuments as jest.Mock).mockResolvedValue(ocr('30 NET'));
    (getAiResponse as jest.Mock).mockResolvedValue(matching('wid-d3'));
    (getDocumentsByWorkdayIds as jest.Mock).mockResolvedValue([
      { workday_id: 'wid-d3', content: 'Payment Terms: Net 30', metadata: { name: 'Net 30' } },
      { workday_id: 'wid-d3', content: 'unrelated record with no payment terms prefix', metadata: undefined },
    ]);

    const result = await enrichInvoiceFromAttachments({} as never, [], existingSupplier);

    expect(result.extractedPaymentTerms).toEqual({
      name: '30 NET', workdayId: null, resolvedName: null, unverified: true,
    });
  });

  it('uses the name when duplicate cache rows for the same Workday ID agree', async () => {
    (extractInvoiceDocuments as jest.Mock).mockResolvedValue(ocr('30 NET'));
    (getAiResponse as jest.Mock).mockResolvedValue(matching('wid-plain'));
    (getDocumentsByWorkdayIds as jest.Mock).mockResolvedValue([
      { workday_id: 'wid-plain', content: 'Payment Terms: Net 30', metadata: { name: 'Net 30' } },
      { workday_id: 'wid-plain', content: 'Payment Terms: Net 30', metadata: { name: 'Net 30' } },
    ]);

    const result = await enrichInvoiceFromAttachments({} as never, [], existingSupplier);

    expect(result.extractedPaymentTerms).toEqual({ name: '30 NET', workdayId: 'wid-plain', resolvedName: 'Net 30' });
  });
});
