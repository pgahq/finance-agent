jest.mock('@pga/logger', () => ({ debug: jest.fn() }));

import {
  decidePurchaseOrderSupplier,
  formatPurchaseOrderSupplierNotes,
  purchaseOrderSupplierReviewLine,
  relateSupplierIdentities,
  resolvePurchaseOrderSupplier,
  supplierIdentityFromDocument,
  supplierNamesMatch,
  type PurchaseOrderSupplierInput,
} from '../lib/po_supplier.js';
import type { DatabaseConnection } from '../lib/database.js';

const golfGearDocument = {
  workday_id: 'golf-gear-wid',
  content: [
    'Company Name: GOLF GEAR LTD',
    'Supplier ID: S-000111',
    'Alternate Names: Club Pro Golf, Golf Gear',
    'Phone: (214) 555-0100',
    'Email: ar@golfgear.example',
    'Status: Active',
  ].join('\n'),
  metadata: { supplierName: 'GOLF GEAR LTD' },
};

const clubProDocument = {
  workday_id: 'club-pro-wid',
  content: [
    'Company Name: CLUB PRO GOLF GROUP LLC',
    'Phone: +1 214-555-0100',
    'Email: billing@clubpro.example',
    'Status: Active',
  ].join('\n'),
  metadata: { supplierName: 'CLUB PRO GOLF GROUP LLC' },
};

const incidentInput = (overrides: Partial<PurchaseOrderSupplierInput> = {}): PurchaseOrderSupplierInput => ({
  purchaseOrderNumber: 'PO-414373',
  purchaseOrderSupplier: { workdayId: 'club-pro-wid', descriptor: 'CLUB PRO GOLF GROUP LLC' },
  invoiceSupplierWID: 'golf-gear-wid',
  invoiceSupplier: { resolvedName: 'GOLF GEAR LTD', extractedName: 'Golf Gear Ltd' },
  ...overrides,
});

describe('supplierNamesMatch', () => {
  it.each([
    ['Club Pro Manufacturing USA', 'CLUB PRO MFG'],
    ['Club Pro Manufacturing', 'Club Pro Mfg., Inc.'],
    ['Pro Golf & Turf Co', 'Pro Golf and Turf Company'],
  ])('matches %s and %s', (left, right) => {
    expect(supplierNamesMatch(left, right)).toBe(true);
  });

  it.each([
    ['GOLF GEAR LTD', 'Club Pro Manufacturing USA'],
    ['Club Pro', 'Club Pro Golf'],
    ['Inc.', 'LLC'],
    ['Golf Holdings Inc', 'Golf Group LLC'],
    ['Golf America', 'Golf International'],
  ])('does not match %s and %s', (left, right) => {
    expect(supplierNamesMatch(left, right)).toBe(false);
  });
});

describe('supplierIdentityFromDocument', () => {
  it('reads names, alternate names, phones, and emails from cached supplier content', () => {
    expect(supplierIdentityFromDocument(golfGearDocument)).toEqual({
      names: ['GOLF GEAR LTD', 'Club Pro Golf', 'Golf Gear', 'GOLF GEAR LTD'],
      phones: ['(214) 555-0100'],
      emails: ['ar@golfgear.example'],
    });
  });

  it('keeps a comma inside the company name and splits comma-joined phones and emails', () => {
    expect(supplierIdentityFromDocument({
      content: [
        'Company Name: Smith, Jones & Co',
        'Phone: 214-555-0100, 214-555-0199',
        'Email: ar@smithjones.example, billing@smithjones.example',
      ].join('\n'),
    })).toEqual({
      names: ['Smith, Jones & Co'],
      phones: ['214-555-0100', '214-555-0199'],
      emails: ['ar@smithjones.example', 'billing@smithjones.example'],
    });
  });

  it('does not tie a company name containing a comma to its first word', () => {
    const smithJones = supplierIdentityFromDocument({ content: 'Company Name: Smith, Jones & Co' });
    expect(relateSupplierIdentities({ names: ['Smith LLC'], phones: [], emails: [] }, smithJones)).toBeUndefined();
  });
});

describe('relateSupplierIdentities', () => {
  it('relates suppliers that share a phone number in different formats', () => {
    expect(relateSupplierIdentities(
      { names: ['GOLF GEAR LTD'], phones: ['(214) 555-0100'], emails: [] },
      { names: ['Club Pro Manufacturing USA'], phones: ['+1 214-555-0100'], emails: [] },
    )).toBe('phone (214) 555-0100 matches');
  });

  it.each(['gmail.com', 'comcast.net', 'quickbooks.com', 'pgahq.com', 'pga.com'])('ignores the shared domain %s', (domain) => {
    expect(relateSupplierIdentities(
      { names: ['Club Pro'], phones: [], emails: [`owner@${domain}`] },
      { names: ['Club Pro Golf'], phones: [], emails: [`someone@${domain}`] },
    )).toBeUndefined();
  });

  it('relates suppliers on a shared business email domain when their names share a word', () => {
    expect(relateSupplierIdentities(
      { names: ['Club Pro'], phones: [], emails: ['ar@clubpro.example'] },
      { names: ['Club Pro Golf'], phones: [], emails: ['billing@clubpro.example'] },
    )).toBe('email domain clubpro.example matches');
  });

  it('ignores a shared business email domain when the names share no word', () => {
    expect(relateSupplierIdentities(
      { names: ['Fairway Turf Supply'], phones: [], emails: ['ar@billingpartner.example'] },
      { names: ['Club Pro Manufacturing USA'], phones: [], emails: ['billing@billingpartner.example'] },
    )).toBeUndefined();
  });
});

describe('decidePurchaseOrderSupplier', () => {
  it('does nothing without a PO number', () => {
    expect(decidePurchaseOrderSupplier(incidentInput({ purchaseOrderNumber: undefined }))).toBeUndefined();
  });

  it('does nothing when the PO has no supplier', () => {
    expect(decidePurchaseOrderSupplier(incidentInput({ purchaseOrderSupplier: undefined }))).toBeUndefined();
  });

  it('reports the same supplier when the invoice already resolved to the PO supplier', () => {
    expect(decidePurchaseOrderSupplier(incidentInput({ invoiceSupplierWID: 'club-pro-wid' }))).toEqual({
      workdayId: 'club-pro-wid',
      descriptor: 'CLUB PRO GOLF GROUP LLC',
      purchaseOrderNumber: 'PO-414373',
      invoiceSupplierName: 'GOLF GEAR LTD',
      relation: 'same',
    });
  });

  it('submits the PO supplier for PO-414373 even though nothing ties GOLF GEAR LTD to CLUB PRO GOLF GROUP LLC', () => {
    expect(decidePurchaseOrderSupplier(incidentInput())).toEqual({
      workdayId: 'club-pro-wid',
      descriptor: 'CLUB PRO GOLF GROUP LLC',
      purchaseOrderNumber: 'PO-414373',
      invoiceSupplierName: 'GOLF GEAR LTD',
      relation: 'unrelated',
    });
  });

  it('relates the suppliers when the invoice supplier alternate name matches the PO supplier', () => {
    expect(decidePurchaseOrderSupplier(incidentInput(), {
      invoice: supplierIdentityFromDocument(golfGearDocument),
    })).toEqual(expect.objectContaining({
      workdayId: 'club-pro-wid',
      relation: 'related',
      reason: 'name "Club Pro Golf" matches "CLUB PRO GOLF GROUP LLC"',
    }));
  });

  it('relates the suppliers when the invoice letterhead names the PO supplier', () => {
    expect(decidePurchaseOrderSupplier(incidentInput({
      invoiceSupplier: { resolvedName: 'GOLF GEAR LTD', extractedName: 'Club Pro Golf Group' },
    }))?.relation).toBe('related');
  });

  it('submits the PO supplier when the invoice supplier was not resolved', () => {
    expect(decidePurchaseOrderSupplier(incidentInput({
      invoiceSupplierWID: undefined,
      invoiceSupplier: { extractedName: 'Club Pro Golf' },
    }))).toEqual(expect.objectContaining({ workdayId: 'club-pro-wid', relation: 'related', invoiceSupplierName: 'Club Pro Golf' }));
  });

  it('splits comma-joined invoice phones before relating suppliers', () => {
    expect(decidePurchaseOrderSupplier(incidentInput({
      invoiceSupplier: { resolvedName: 'GOLF GEAR LTD', phone: '972-555-0000, (214) 555-0100', email: 'ar@golfgear.example, x@gmail.com' },
    }), {
      purchaseOrder: supplierIdentityFromDocument(clubProDocument),
    })?.reason).toBe('phone (214) 555-0100 matches');
  });
});

describe('formatPurchaseOrderSupplierNotes', () => {
  it('adds nothing when the invoice already resolved to the PO supplier', () => {
    expect(formatPurchaseOrderSupplierNotes(decidePurchaseOrderSupplier(incidentInput({ invoiceSupplierWID: 'club-pro-wid' })))).toBe('');
    expect(formatPurchaseOrderSupplierNotes(undefined)).toBe('');
  });

  it('asks AP to confirm the PO number when the invoice names an unrelated company', () => {
    expect(formatPurchaseOrderSupplierNotes(decidePurchaseOrderSupplier(incidentInput()))).toBe(
      '\n\nSupplier from PO: Set to CLUB PRO GOLF GROUP LLC, the supplier on PO-414373.'
      + ' The invoice names GOLF GEAR LTD, which does not look like the same company; confirm the PO number.'
    );
  });

  it('explains why a related invoice supplier was replaced', () => {
    expect(formatPurchaseOrderSupplierNotes(decidePurchaseOrderSupplier(incidentInput(), {
      invoice: supplierIdentityFromDocument(golfGearDocument),
    }))).toBe(
      '\n\nSupplier from PO: Set to CLUB PRO GOLF GROUP LLC, the supplier on PO-414373.'
      + ' The invoice names GOLF GEAR LTD (name "Club Pro Golf" matches "CLUB PRO GOLF GROUP LLC").'
    );
  });
});

describe('purchaseOrderSupplierReviewLine', () => {
  it('flags only an unrelated invoice supplier', () => {
    expect(purchaseOrderSupplierReviewLine(decidePurchaseOrderSupplier(incidentInput()))).toBe(
      'Supplier set from PO-414373 (CLUB PRO GOLF GROUP LLC); the invoice names GOLF GEAR LTD, which does not look like the same company. Confirm the PO number.'
    );
    expect(purchaseOrderSupplierReviewLine(decidePurchaseOrderSupplier(incidentInput(), {
      invoice: supplierIdentityFromDocument(golfGearDocument),
    }))).toBeUndefined();
    expect(purchaseOrderSupplierReviewLine(decidePurchaseOrderSupplier(incidentInput({ invoiceSupplierWID: 'club-pro-wid' })))).toBeUndefined();
  });
});

describe('resolvePurchaseOrderSupplier', () => {
  const dbReturning = (query: jest.Mock): DatabaseConnection => ({ query } as unknown as DatabaseConnection);

  it('relates suppliers through their cached profiles', async () => {
    const query = jest.fn().mockResolvedValue([golfGearDocument, clubProDocument]);

    const decision = await resolvePurchaseOrderSupplier(dbReturning(query), incidentInput());

    expect(query).toHaveBeenCalledWith(expect.stringContaining('workday_id = ANY'), ['supplier', ['golf-gear-wid', 'club-pro-wid']]);
    expect(decision?.relation).toBe('related');
  });

  it('still returns the PO supplier when the supplier cache is unavailable', async () => {
    const query = jest.fn().mockRejectedValue(new Error('connection refused'));

    const decision = await resolvePurchaseOrderSupplier(dbReturning(query), incidentInput());

    expect(decision).toEqual(expect.objectContaining({ workdayId: 'club-pro-wid', relation: 'unrelated' }));
  });

  it('skips the cache lookup when the invoice already resolved to the PO supplier', async () => {
    const query = jest.fn();

    const decision = await resolvePurchaseOrderSupplier(dbReturning(query), incidentInput({ invoiceSupplierWID: 'club-pro-wid' }));

    expect(query).not.toHaveBeenCalled();
    expect(decision?.relation).toBe('same');
  });
});
