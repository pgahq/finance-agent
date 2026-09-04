import {
  applyInvoiceMemoIdentifiersToLines,
  composeInvoiceMemo,
  hasMemoIdentifiers,
  INVOICE_MEMO_MAX_LENGTH,
  memoIdentifiersFromEnrichment,
  sanitizeMemoText,
  sanitizeSuppliersInvoiceNumber,
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

  it('includes each present identifier independently in check-print order', () => {
    expect(composeInvoiceMemo({
      po: 'PO-404770',
      accountNumber: '1033562',
      jobNumber: '5914196',
      customerId: 'CU0122145',
      servicePeriod: '2026 - September',
      description: 'Monthly software subscription',
    })).toBe('AC 1033562. Customer ID CU0122145. Job 5914196. PO-404770. Service Period 2026 - September. Monthly software subscription');
  });

  it('omits missing identifiers without treating later fields as fallbacks', () => {
    expect(composeInvoiceMemo({
      accountNumber: '1033562',
      jobNumber: '5914196',
      description: 'Sales type lease license fee',
    })).toBe('AC 1033562. Job 5914196. Sales type lease license fee');

    expect(composeInvoiceMemo({
      customerId: 'CU0122145',
      servicePeriod: '2026 - September',
      description: 'Technology package tech fees',
    })).toBe('Customer ID CU0122145. Service Period 2026 - September. Technology package tech fees');
  });

  it('normalizes PGA PO numbers and drops free-text PO values', () => {
    expect(composeInvoiceMemo({ po: '414498', description: 'Summit ENG' })).toBe('PO-414498. Summit ENG');
    expect(composeInvoiceMemo({ po: 'PGA COACHING', description: 'License fee' })).toBe('License fee');
  });

  it('strips redundant labels from extracted values', () => {
    expect(composeInvoiceMemo({
      accountNumber: 'AC #1033562',
      jobNumber: 'Order #5914196',
      customerId: 'Bill-To Customer ID: CU0122145',
      servicePeriod: 'Service Period: 2026 - September',
    })).toBe('AC 1033562. Customer ID CU0122145. Job 5914196. Service Period 2026 - September');

    expect(composeInvoiceMemo({
      customerId: 'Cust ID 44012',
    })).toBe('Customer ID 44012');
  });

  it('does not treat an AC- sold-to value as an AC label', () => {
    expect(composeInvoiceMemo({
      accountNumber: 'AC-1033562',
      description: 'License fee',
    })).toBe('AC AC-1033562. License fee');
  });

  it('drops Job when it normalizes to the same PGA PO', () => {
    expect(composeInvoiceMemo({
      po: 'PO-414498',
      jobNumber: '414498',
      description: 'Summit ENG',
    })).toBe('PO-414498. Summit ENG');

    expect(composeInvoiceMemo({
      po: 'PO-414498',
      jobNumber: 'Order #414498',
      description: 'Summit ENG',
    })).toBe('PO-414498. Summit ENG');
  });

  it('does not emit Customer ID when it duplicates the account number', () => {
    expect(composeInvoiceMemo({
      accountNumber: '1033562',
      customerId: '1033562',
      description: 'License fee',
    })).toBe('AC 1033562. License fee');
  });

  it('uses identifier text alone when there is no descriptive sentence', () => {
    expect(composeInvoiceMemo({ po: 'PO-404770', accountNumber: '12345' })).toBe('AC 12345. PO-404770');
  });

  it('does not duplicate an identifier prefix already on the description', () => {
    expect(composeInvoiceMemo({
      po: 'PO-404770',
      description: 'PO-404770 | Office supplies',
    })).toBe('PO-404770. Office supplies');

    expect(composeInvoiceMemo({
      po: 'PO-404770',
      description: 'PO-404770. Office supplies',
    })).toBe('PO-404770. Office supplies');

    expect(composeInvoiceMemo({
      po: 'PO-404770',
      accountNumber: '1033562',
      description: 'AC 1033562. PO-404770. Office supplies',
    })).toBe('AC 1033562. PO-404770. Office supplies');
  });

  it('strips identifier tokens from the description even when they are not a leading full prefix', () => {
    expect(composeInvoiceMemo({
      po: 'PO-404770',
      accountNumber: '12345',
      description: 'AC #12345 monthly software',
    })).toBe('AC 12345. PO-404770. monthly software');
  });

  it('does not treat periods inside amounts or abbreviations as token separators', () => {
    expect(composeInvoiceMemo({
      accountNumber: '1033562',
      description: 'License fee 12.50 monthly for U.S. Open e.g. hospitality',
    })).toBe('AC 1033562. License fee 12.50 monthly for U.S. Open e.g. hospitality');
  });

  it('replaces pay-file-unsafe characters in identifier values and descriptions', () => {
    expect(composeInvoiceMemo({
      accountNumber: '103|3562',
      description: 'Widgets >>> restock',
    })).toBe('AC 103 3562. Widgets restock');
  });

  it('caps memo length', () => {
    const memo = composeInvoiceMemo({
      description: 'x'.repeat(INVOICE_MEMO_MAX_LENGTH + 50),
    });
    expect(memo).toHaveLength(INVOICE_MEMO_MAX_LENGTH);
  });
});

describe('sanitizeMemoText', () => {
  it('keeps letters, digits, spaces, hyphen, period, comma, apostrophe, slash, and hash', () => {
    expect(sanitizeMemoText("AC 1033562. Q1 2024, John's / PO-1 #2")).toBe("AC 1033562. Q1 2024, John's / PO-1 #2");
  });

  it('replaces pipes and angle brackets with spaces', () => {
    expect(sanitizeMemoText('AC 1 | Job 2 >>> more <<< rest')).toBe('AC 1 Job 2 more rest');
  });
});

describe('sanitizeSuppliersInvoiceNumber', () => {
  it('returns undefined for blank values', () => {
    expect(sanitizeSuppliersInvoiceNumber(null)).toBeUndefined();
    expect(sanitizeSuppliersInvoiceNumber('   ')).toBeUndefined();
  });

  it('keeps letters, digits, hyphen, period, slash, and hash', () => {
    expect(sanitizeSuppliersInvoiceNumber('INV-001.2/A#3')).toBe('INV-001.2/A#3');
  });

  it('replaces pipes and other unsafe characters with a hyphen', () => {
    expect(sanitizeSuppliersInvoiceNumber('INV|001>>>')).toBe('INV-001');
    expect(sanitizeSuppliersInvoiceNumber('INV 001')).toBe('INV-001');
  });
});

describe('hasMemoIdentifiers', () => {
  it('is true only when at least one identifier token would be emitted', () => {
    expect(hasMemoIdentifiers({})).toBe(false);
    expect(hasMemoIdentifiers({ po: 'PGA COACHING' })).toBe(false);
    expect(hasMemoIdentifiers({ po: 'PO-414498' })).toBe(true);
    expect(hasMemoIdentifiers({ accountNumber: '1033562' })).toBe(true);
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
      { lineOrder: 1, description: 'Widgets', memo: 'AC 1033562. Job 5914196. Widget purchase', quantity: 1, unitCost: 10 },
      { lineOrder: 2, description: 'Services', memo: 'AC 1033562. Job 5914196', quantity: 1, unitCost: 20 },
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
