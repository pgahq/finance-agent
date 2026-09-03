import {
  applyInvoiceMemoIdentifiersToLines,
  composeInvoiceMemo,
  INVOICE_MEMO_MAX_LENGTH,
  memoIdentifiersFromEnrichment,
} from '../lib/invoice_memo.js';
import { formatMemoIdentifierNotes } from '../lib/invoice_enrichment.js';
import type { FinalInvoiceLine } from '../lib/invoice_lines.js';

describe('composeInvoiceMemo', () => {
  it('returns undefined when nothing is present', () => {
    expect(composeInvoiceMemo({})).toBeUndefined();
    expect(composeInvoiceMemo({ description: '   ' })).toBeUndefined();
  });

  it('returns the descriptive sentence alone when no identifiers are present', () => {
    expect(composeInvoiceMemo({ description: 'Office supplies' })).toBe('Office supplies');
  });

  it('includes each present identifier independently in stable order', () => {
    expect(composeInvoiceMemo({
      po: 'PO-404770',
      accountNumber: '1033562',
      jobNumber: '5914196',
      customerId: 'CU0122145',
      servicePeriod: '2026 - September',
      description: 'Monthly software subscription',
    })).toBe('PO-404770 | AC #1033562 | Job #5914196 | Customer ID CU0122145 | Service Period 2026 - September | Monthly software subscription');
  });

  it('omits missing identifiers without treating later fields as fallbacks', () => {
    expect(composeInvoiceMemo({
      accountNumber: '1033562',
      jobNumber: '5914196',
      description: 'Sales type lease license fee',
    })).toBe('AC #1033562 | Job #5914196 | Sales type lease license fee');

    expect(composeInvoiceMemo({
      customerId: 'CU0122145',
      servicePeriod: '2026 - September',
      description: 'Technology package tech fees',
    })).toBe('Customer ID CU0122145 | Service Period 2026 - September | Technology package tech fees');
  });

  it('normalizes PGA PO numbers and drops free-text PO values', () => {
    expect(composeInvoiceMemo({ po: '414498', description: 'Summit ENG' })).toBe('PO-414498 | Summit ENG');
    expect(composeInvoiceMemo({ po: 'PGA COACHING', description: 'License fee' })).toBe('License fee');
  });

  it('strips redundant labels from extracted values', () => {
    expect(composeInvoiceMemo({
      accountNumber: 'AC #1033562',
      jobNumber: 'Order #5914196',
      customerId: 'Bill-To Customer ID: CU0122145',
      servicePeriod: 'Service Period: 2026 - September',
    })).toBe('AC #1033562 | Job #5914196 | Customer ID CU0122145 | Service Period 2026 - September');
  });

  it('does not emit Customer ID when it duplicates the account number', () => {
    expect(composeInvoiceMemo({
      accountNumber: '1033562',
      customerId: '1033562',
      description: 'License fee',
    })).toBe('AC #1033562 | License fee');
  });

  it('uses identifier text alone when there is no descriptive sentence', () => {
    expect(composeInvoiceMemo({ po: 'PO-404770', accountNumber: '12345' })).toBe('PO-404770 | AC #12345');
  });

  it('does not duplicate an identifier prefix already on the description', () => {
    expect(composeInvoiceMemo({
      po: 'PO-404770',
      description: 'PO-404770 | Office supplies',
    })).toBe('PO-404770 | Office supplies');
  });

  it('caps memo length', () => {
    const memo = composeInvoiceMemo({
      description: 'x'.repeat(INVOICE_MEMO_MAX_LENGTH + 50),
    });
    expect(memo).toHaveLength(INVOICE_MEMO_MAX_LENGTH);
  });
});

describe('memoIdentifiersFromEnrichment', () => {
  it('prefers a matched PO document number over the extracted value', () => {
    expect(memoIdentifiersFromEnrichment({
      extractedPurchaseOrderNumber: 'PO-111111',
      extractedAccountNumber: '1033562',
      extractedJobNumber: null,
      extractedCustomerId: null,
      extractedServicePeriod: null,
    }, 'PO-414498')).toEqual({
      po: 'PO-414498',
      accountNumber: '1033562',
      jobNumber: null,
      customerId: null,
      servicePeriod: null,
    });
  });
});

describe('applyInvoiceMemoIdentifiersToLines', () => {
  it('applies the same identifier prefix to each line memo', () => {
    const lines: FinalInvoiceLine[] = [
      { lineOrder: 1, description: 'Widgets', memo: 'Widget purchase', quantity: 1, unitCost: 10 },
      { lineOrder: 2, description: 'Services', memo: null, quantity: 1, unitCost: 20 },
    ];

    expect(applyInvoiceMemoIdentifiersToLines(lines, {
      accountNumber: '1033562',
      jobNumber: '5914196',
    })).toEqual([
      { lineOrder: 1, description: 'Widgets', memo: 'AC #1033562 | Job #5914196 | Widget purchase', quantity: 1, unitCost: 10 },
      { lineOrder: 2, description: 'Services', memo: 'AC #1033562 | Job #5914196', quantity: 1, unitCost: 20 },
    ]);
  });

  it('leaves lines unchanged when there are no identifiers or line memos', () => {
    const lines: FinalInvoiceLine[] = [
      { lineOrder: 1, description: 'Widgets', quantity: 2, unitCost: 50 },
    ];
    expect(applyInvoiceMemoIdentifiersToLines(lines, {})).toEqual(lines);
  });
});

describe('formatMemoIdentifierNotes', () => {
  it('adds a notes line for each extracted identifier', () => {
    const notes = formatMemoIdentifierNotes({
      extractedAccountNumber: '1033562',
      extractedJobNumber: '5914196',
      extractedCustomerId: 'CU0122145',
      extractedServicePeriod: '2026 - September',
    });

    expect(notes).toContain('Account Number (from document): 1033562');
    expect(notes).toContain('Job Number (from document): 5914196');
    expect(notes).toContain('Customer ID (from document): CU0122145');
    expect(notes).toContain('Service Period (from document): 2026 - September');
  });
});
