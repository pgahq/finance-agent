import {
  applyInvoiceMemoIdentifiersToLines,
  composeInvoiceMemo,
  formatMemoServiceDates,
  hasMemoIdentifiers,
  INVOICE_MEMO_MAX_LENGTH,
  memoIdentifiersFromEnrichment,
  sanitizeMemoText,
  composeSuppliersInvoiceNumber,
  sanitizeSuppliersInvoiceNumber,
  supplierNameForInvoiceNumber,
} from '../lib/invoice_memo.js';
import { formatMemoIdentifierNotes } from '../lib/invoice_enrichment.js';
import type { FinalInvoiceLine } from '../lib/invoice_lines.js';

describe('composeInvoiceMemo', () => {
  it('returns undefined when nothing is present', () => {
    expect(composeInvoiceMemo({})).toBeUndefined();
    expect(composeInvoiceMemo({ description: '   ' })).toBeUndefined();
  });

  it('returns the description alone, lowercase with no ending period, when no identifiers are present', () => {
    expect(composeInvoiceMemo({ description: 'Office supplies.' })).toBe('office supplies');
  });

  it('matches the AP example: customer, service dates, short description', () => {
    expect(composeInvoiceMemo({
      customerId: '115117',
      servicePeriod: '09/01/2026 - 09/30/2026',
      description: 'Elevator phone line service.',
    })).toBe('Cust 115117 Svc Prd 09/01/26 - 09/30/26 elevator phone line service');
  });

  it('orders account, supplier reference, service dates, then description with single spaces', () => {
    expect(composeInvoiceMemo({
      accountNumber: '1033562',
      supplierReference: '5914196',
      supplierReferenceKind: 'order',
      servicePeriod: '2026 - September',
      description: 'Monthly software subscription',
    })).toBe('Acct 1033562 Ord 5914196 Svc Prd 09/01/26 - 09/30/26 monthly software subscription');
  });

  it('never uses periods to separate fields', () => {
    const memo = composeInvoiceMemo({
      accountNumber: '1033562',
      supplierReference: '5914196',
      supplierReferenceKind: 'job',
      servicePeriod: '9/7/26 - 9/13/26',
      description: 'Landscaping.',
    });
    expect(memo).toBe('Acct 1033562 Job 5914196 Svc Prd 09/07/26 - 09/13/26 landscaping');
    expect(memo).not.toMatch(/\. /);
  });

  it('emits the account number and drops the customer ID when both are printed', () => {
    expect(composeInvoiceMemo({
      accountNumber: '1033562',
      customerId: 'CU0122145',
      description: 'License fee',
    })).toBe('Acct 1033562 license fee');
  });

  it('falls back to the customer ID when there is no account number', () => {
    expect(composeInvoiceMemo({ customerId: 'CU0122145', description: 'License fee' })).toBe('Cust CU0122145 license fee');
    expect(composeInvoiceMemo({ customerId: 'Cust ID 44012' })).toBe('Cust 44012');
  });

  it('omits missing identifiers without treating later fields as fallbacks', () => {
    expect(composeInvoiceMemo({
      accountNumber: '1033562',
      supplierReference: '5914196',
      supplierReferenceKind: 'order',
      description: 'Sales type lease license fee',
    })).toBe('Acct 1033562 Ord 5914196 sales type lease license fee');

    expect(composeInvoiceMemo({
      customerId: 'CU0122145',
      servicePeriod: 'Q4 2026',
      description: 'Technology package tech fees',
    })).toBe('Cust CU0122145 Svc Prd Q4 26 technology package tech fees');
  });

  it.each([
    ['order', 'Ord'],
    ['confirmation', 'Conf'],
    ['job', 'Job'],
    ['file', 'File'],
    ['case', 'Case'],
  ])('labels a %s reference as %s', (kind, label) => {
    expect(composeInvoiceMemo({ supplierReference: '77-1234', supplierReferenceKind: kind })).toBe(`${label} 77-1234`);
  });

  it('infers the label from the value when no kind is given, and otherwise uses Ref', () => {
    expect(composeInvoiceMemo({ supplierReference: 'Order #5914196' })).toBe('Ord 5914196');
    expect(composeInvoiceMemo({ supplierReference: 'Conf No. AB12' })).toBe('Conf AB12');
    expect(composeInvoiceMemo({ supplierReference: '5914196' })).toBe('Ref 5914196');
  });

  it('prefers the stated reference kind over a label in the value', () => {
    expect(composeInvoiceMemo({ supplierReference: 'Matter 2026-14', supplierReferenceKind: 'file' })).toBe('File 2026-14');
  });

  it('drops the PGA PO from the memo and drops a supplier reference that is that PO', () => {
    expect(composeInvoiceMemo({ po: '414498', description: 'Summit ENG' })).toBe('summit ENG');
    expect(composeInvoiceMemo({ po: 'PO-414498', accountNumber: '12345', description: 'Summit ENG' })).toBe('Acct 12345 summit ENG');
    expect(composeInvoiceMemo({
      po: 'PO-414498',
      supplierReference: 'Order #414498',
      supplierReferenceKind: 'order',
      description: 'Summit ENG',
    })).toBe('summit ENG');
    expect(composeInvoiceMemo({ po: 'PGA COACHING', description: 'License fee' })).toBe('license fee');
  });

  it('strips redundant labels from extracted values', () => {
    expect(composeInvoiceMemo({
      accountNumber: 'AC #1033562',
      supplierReference: 'Order #5914196',
      servicePeriod: 'Service Period: 09/01/2026 - 09/30/2026',
    })).toBe('Acct 1033562 Ord 5914196 Svc Prd 09/01/26 - 09/30/26');

    expect(composeInvoiceMemo({ customerId: 'Bill-To Customer ID: CU0122145' })).toBe('Cust CU0122145');
  });

  it('does not treat an AC- sold-to value as an AC label', () => {
    expect(composeInvoiceMemo({
      accountNumber: 'AC-1033562',
      description: 'License fee',
    })).toBe('Acct AC-1033562 license fee');
  });

  it('keeps case for acronyms and words with digits in the description', () => {
    expect(composeInvoiceMemo({ description: 'HVAC repair' })).toBe('HVAC repair');
    expect(composeInvoiceMemo({ description: '3M signage' })).toBe('3M signage');
    expect(composeInvoiceMemo({ description: "McDonald's catering" })).toBe("McDonald's catering");
  });

  it('uses identifier text alone when there is no descriptive sentence', () => {
    expect(composeInvoiceMemo({ po: 'PO-404770', accountNumber: '12345' })).toBe('Acct 12345');
  });

  it('does not duplicate identifiers the model copied into the description', () => {
    expect(composeInvoiceMemo({
      po: 'PO-404770',
      description: 'PO-404770 | Office supplies',
    })).toBe('office supplies');

    expect(composeInvoiceMemo({
      po: 'PO-404770',
      accountNumber: '1033562',
      description: 'Acct 1033562 Office supplies',
    })).toBe('Acct 1033562 office supplies');

    expect(composeInvoiceMemo({
      po: 'PO-404770',
      accountNumber: '1033562',
      description: 'AC 1033562. PO-404770. Office supplies',
    })).toBe('Acct 1033562 office supplies');
  });

  it('strips old-style and current identifier tokens from the description even when they are not a leading prefix', () => {
    expect(composeInvoiceMemo({
      accountNumber: '12345',
      description: 'monthly AC 12345 software',
    })).toBe('Acct 12345 monthly software');

    expect(composeInvoiceMemo({
      accountNumber: '12345',
      description: 'AC #12345 monthly software',
    })).toBe('Acct 12345 monthly software');

    expect(composeInvoiceMemo({
      customerId: '115117',
      servicePeriod: '09/01/2026 - 09/30/2026',
      description: 'Customer ID 115117. Service Period 09/01/2026 - 09/30/2026. Elevator phone line service',
    })).toBe('Cust 115117 Svc Prd 09/01/26 - 09/30/26 elevator phone line service');

    expect(composeInvoiceMemo({
      customerId: '115117',
      servicePeriod: '09/01/2026 - 09/30/2026',
      description: 'Cust 115117 Svc Prd 09/01/26 - 09/30/26 elevator phone line service',
    })).toBe('Cust 115117 Svc Prd 09/01/26 - 09/30/26 elevator phone line service');
  });

  it('does not treat periods inside amounts or abbreviations as token separators', () => {
    expect(composeInvoiceMemo({
      accountNumber: '1033562',
      description: 'License fee 12.50 monthly for U.S. Open e.g. hospitality',
    })).toBe('Acct 1033562 license fee 12.50 monthly for U.S. Open e.g. hospitality');
  });

  it('replaces pay-file-unsafe characters in identifier values and descriptions', () => {
    expect(composeInvoiceMemo({
      accountNumber: '103|3562',
      description: 'Widgets >>> restock',
    })).toBe('Acct 103 3562 widgets restock');
  });

  it('leaves the description out when it would push the memo past the cap', () => {
    expect(composeInvoiceMemo({
      accountNumber: '1033562',
      description: 'x'.repeat(INVOICE_MEMO_MAX_LENGTH),
    })).toBe('Acct 1033562');
  });

  it('cuts and sanitizes a description-only memo that passes the cap', () => {
    const memo = composeInvoiceMemo({ description: `${'word '.repeat(INVOICE_MEMO_MAX_LENGTH / 5 + 20)}| <b>` });
    expect(memo).toHaveLength(INVOICE_MEMO_MAX_LENGTH - 1);
    expect(memo).not.toMatch(/[|<>]/);
    expect(memo?.endsWith(' ')).toBe(false);
  });

  it('formats an en-dash or em-dash service period before sanitizing it', () => {
    expect(composeInvoiceMemo({ customerId: '115117', servicePeriod: '09/01/2026 \u2013 09/30/2026' }))
      .toBe('Cust 115117 Svc Prd 09/01/26 - 09/30/26');
    expect(composeInvoiceMemo({ customerId: '115117', servicePeriod: '9/1/26\u20149/30/26' }))
      .toBe('Cust 115117 Svc Prd 09/01/26 - 09/30/26');
    expect(composeInvoiceMemo({ customerId: '115117', servicePeriod: 'Sept 28 \u2013 Oct 2' }))
      .toBe('Cust 115117 Svc Prd Sept 28 - Oct 2');
  });

  it('does not strip an en-dash service period copied into the description', () => {
    expect(composeInvoiceMemo({
      customerId: '115117',
      servicePeriod: '09/01/2026 \u2013 09/30/2026',
      description: 'Service Period 09/01/2026 \u2013 09/30/2026 elevator phone line service',
    })).toBe('Cust 115117 Svc Prd 09/01/26 - 09/30/26 elevator phone line service');
  });

  it('drops a supplier reference that is the email or note PO passed in', () => {
    expect(composeInvoiceMemo({
      po: 'PO-123456',
      supplierReference: 'Order # 123456',
      supplierReferenceKind: 'order',
      accountNumber: '12345',
    })).toBe('Acct 12345');
    expect(composeInvoiceMemo({ po: null, supplierReference: '123456', supplierReferenceKind: 'order' })).toBe('Ord 123456');
  });

  it('keeps a description that fits exactly', () => {
    const description = 'x'.repeat(INVOICE_MEMO_MAX_LENGTH - 'Acct 1 '.length);
    const memo = composeInvoiceMemo({ accountNumber: '1', description });
    expect(memo).toHaveLength(INVOICE_MEMO_MAX_LENGTH);
  });
});

describe('formatMemoServiceDates', () => {
  it.each([
    ['09/01/2026 - 09/30/2026', '09/01/26 - 09/30/26'],
    ['9/7/26 - 9/13/26', '09/07/26 - 09/13/26'],
    ['9/7/26-9/13/26', '09/07/26 - 09/13/26'],
    ['2026-09-01 to 2026-09-30', '09/01/26 - 09/30/26'],
    ['Sep 1, 2026 - Sep 30, 2026', '09/01/26 - 09/30/26'],
    ['9/7/2026', '09/07/26'],
    ['2026-09-07', '09/07/26'],
    ['2026 - September', '09/01/26 - 09/30/26'],
    ['September 2026', '09/01/26 - 09/30/26'],
    ['Sept 2026', '09/01/26 - 09/30/26'],
    ['2026-02', '02/01/26 - 02/28/26'],
    ['02/2028', '02/01/28 - 02/29/28'],
    ['Q4 2026', 'Q4 26'],
    ['2026 Q1', 'Q1 26'],
    ['09/01/2026 \u2013 09/30/2026', '09/01/26 - 09/30/26'],
    ['9/1/26\u20149/30/26', '09/01/26 - 09/30/26'],
    ['Aug 2026', '08/01/26 - 08/31/26'],
    ['AUGUST 2026', '08/01/26 - 08/31/26'],
    ['Sep. 2026', '09/01/26 - 09/30/26'],
    ['June 2026', '06/01/26 - 06/30/26'],
    ['2026 - Dec', '12/01/26 - 12/31/26'],
    ['Aug 5, 2026', '08/05/26'],
  ])('formats %s as %s', (input, expected) => {
    expect(formatMemoServiceDates(input)).toBe(expected);
  });

  it('keeps text it cannot read as printed', () => {
    expect(formatMemoServiceDates('Sept 28 - Oct 2')).toBe('Sept 28 - Oct 2');
    expect(formatMemoServiceDates('13/45/2026')).toBe('13/45/2026');
    expect(formatMemoServiceDates('Annual services')).toBe('Annual services');
    expect(formatMemoServiceDates('Sept 28 \u2013 Oct 2')).toBe('Sept 28 - Oct 2');
  });

  it.each(['Augusta 2026', 'Marketing 2026', 'Junior 2026', '2026 Mayhem', 'Octane 2026', 'Decatur 2026'])(
    'does not read the month-like word in "%s" as a month',
    (input) => {
      expect(formatMemoServiceDates(input)).toBe(input);
    }
  );
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

describe('composeSuppliersInvoiceNumber', () => {
  it('keeps a printed invoice number that is not the account number', () => {
    expect(composeSuppliersInvoiceNumber({
      invoiceNumber: 'INV|001>>>',
      accountNumber: '1033562',
      invoiceDate: '2026-09-15',
      supplierName: 'Test Supplier',
    })).toBe('INV-001');
  });

  it('appends MMMYY to the account number when the invoice number is the account number', () => {
    expect(composeSuppliersInvoiceNumber({
      invoiceNumber: '20-1183-01',
      accountNumber: '20 1183 01',
      invoiceDate: '2026-09-15',
      supplierName: 'City of Frisco Texas',
    })).toBe('20-1183-01SEP26');
  });

  it('appends MMMYY when there is an account number and no invoice number', () => {
    expect(composeSuppliersInvoiceNumber({
      invoiceNumber: null,
      accountNumber: '54875-48235',
      invoiceDate: '2022-04-01',
      supplierName: 'Comcast',
    })).toBe('54875-48235APR22');
  });

  it('keeps a printed number that only matches the account after pay-file sanitizing', () => {
    expect(composeSuppliersInvoiceNumber({
      invoiceNumber: '20|1183',
      accountNumber: '201183',
      invoiceDate: '2026-09-15',
    })).toBe('20-1183');
  });

  it('uses the resolved supplier name when the extracted name has no letters', () => {
    expect(supplierNameForInvoiceNumber('123!!!', 'Safari')).toBe('Safari');
    expect(composeSuppliersInvoiceNumber({
      invoiceDate: '2022-04-01',
      supplierName: supplierNameForInvoiceNumber('123!!!', 'Safari'),
    })).toBe('SAFA040122');
  });

  it('uses the first four letters of the supplier and MMDDYY when neither number is present', () => {
    expect(composeSuppliersInvoiceNumber({
      invoiceNumber: null,
      accountNumber: null,
      invoiceDate: '2022-04-01',
      supplierName: 'Safari',
    })).toBe('SAFA040122');
    expect(composeSuppliersInvoiceNumber({
      invoiceDate: '2022-04-08',
      supplierName: 'A&B',
    })).toBe('AB040822');
  });

  it('leaves a generated number unset when the document has no invoice date', () => {
    expect(composeSuppliersInvoiceNumber({
      invoiceNumber: '20-1183-01',
      accountNumber: '20-1183-01',
      supplierName: 'City of Frisco Texas',
    })).toBeUndefined();
    expect(composeSuppliersInvoiceNumber({
      supplierName: 'Safari',
      invoiceDate: 'not-a-date',
    })).toBeUndefined();
    expect(composeSuppliersInvoiceNumber({
      invoiceDate: '2022-02-31',
      supplierName: 'Safari',
    })).toBeUndefined();
  });
});

describe('hasMemoIdentifiers', () => {
  it('is true only when at least one identifier token would be emitted', () => {
    expect(hasMemoIdentifiers({})).toBe(false);
    expect(hasMemoIdentifiers({ po: 'PGA COACHING' })).toBe(false);
    expect(hasMemoIdentifiers({ po: 'PO-414498' })).toBe(false);
    expect(hasMemoIdentifiers({ accountNumber: '1033562' })).toBe(true);
    expect(hasMemoIdentifiers({ customerId: 'CU0122145' })).toBe(true);
    expect(hasMemoIdentifiers({ supplierReference: '5914196', supplierReferenceKind: 'order' })).toBe(true);
    expect(hasMemoIdentifiers({ servicePeriod: 'Q4 2026' })).toBe(true);
    expect(hasMemoIdentifiers({ po: 'PO-414498', supplierReference: 'PO-414498' })).toBe(false);
  });
});

describe('memoIdentifiersFromEnrichment', () => {
  it('reads the document identifiers and the extracted PO used only to drop a duplicate reference', () => {
    expect(memoIdentifiersFromEnrichment({
      extractedPurchaseOrderNumber: 'PO-111111',
      extractedAccountNumber: '1033562',
      extractedSupplierReference: '5914196',
      extractedSupplierReferenceKind: 'order',
      extractedCustomerId: null,
      extractedServicePeriod: null,
    })).toEqual({
      po: 'PO-111111',
      accountNumber: '1033562',
      customerId: null,
      supplierReference: '5914196',
      supplierReferenceKind: 'order',
      servicePeriod: null,
    });
  });

  it('prefers the matched, email, or note PO over the extracted one', () => {
    const identifiers = memoIdentifiersFromEnrichment({
      extractedPurchaseOrderNumber: null,
      extractedAccountNumber: null,
      extractedSupplierReference: 'Order # 123456',
      extractedSupplierReferenceKind: 'order',
      extractedCustomerId: null,
      extractedServicePeriod: null,
    }, 'PO-123456');
    expect(identifiers.po).toBe('PO-123456');
    expect(composeInvoiceMemo(identifiers)).toBeUndefined();
  });
});

describe('applyInvoiceMemoIdentifiersToLines', () => {
  it('cuts and sanitizes a long description-only line memo when there are no identifiers', () => {
    const lines: FinalInvoiceLine[] = [
      { lineOrder: 1, description: 'Widgets', memo: `${'word '.repeat(150)}| <b>`, quantity: 1, unitCost: 10 },
    ];
    const [line] = applyInvoiceMemoIdentifiersToLines(lines, {});
    expect(line.memo).toHaveLength(INVOICE_MEMO_MAX_LENGTH - 1);
    expect(line.memo).not.toMatch(/[|<>]/);
  });

  it('applies the same identifier prefix to each line memo', () => {
    const lines: FinalInvoiceLine[] = [
      { lineOrder: 1, description: 'Widgets', memo: 'Widget purchase', quantity: 1, unitCost: 10 },
      { lineOrder: 2, description: 'Services', memo: null, quantity: 1, unitCost: 20 },
    ];

    expect(applyInvoiceMemoIdentifiersToLines(lines, {
      accountNumber: '1033562',
      supplierReference: '5914196',
      supplierReferenceKind: 'job',
    })).toEqual([
      { lineOrder: 1, description: 'Widgets', memo: 'Acct 1033562 Job 5914196 widget purchase', quantity: 1, unitCost: 10 },
      { lineOrder: 2, description: 'Services', memo: 'Acct 1033562 Job 5914196', quantity: 1, unitCost: 20 },
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
      extractedSupplierReference: '5914196',
      extractedSupplierReferenceKind: 'order',
      extractedCustomerId: 'CU0122145',
      extractedServicePeriod: '2026 - September',
    });

    expect(notes).toContain('Account Number (from document): 1033562');
    expect(notes).toContain('Supplier Reference (from document): Order 5914196');
    expect(notes).toContain('Customer ID (from document): CU0122145');
    expect(notes).toContain('Service Period (from document): 2026 - September');
  });
});
