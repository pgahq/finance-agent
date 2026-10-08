jest.mock('@pga/logger', () => ({ debug: jest.fn() }));

import {
  decidePurchaseOrderSupplier,
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
    'Alternate Names: CLUB PRO MFG, Golf Gear',
    'Phone: (214) 555-0100',
    'Email: ar@golfgear.example',
    'Status: Active',
  ].join('\n'),
  metadata: { supplierName: 'GOLF GEAR LTD' },
};

const clubProDocument = {
  workday_id: 'club-pro-wid',
  content: [
    'Company Name: Club Pro Manufacturing USA',
    'Phone: +1 214-555-0100',
    'Email: billing@clubpro.example',
    'Status: Active',
  ].join('\n'),
  metadata: { supplierName: 'Club Pro Manufacturing USA' },
};

const incidentInput = (overrides: Partial<PurchaseOrderSupplierInput> = {}): PurchaseOrderSupplierInput => ({
  purchaseOrderNumber: 'PO-414373',
  purchaseOrderSupplier: { workdayId: 'club-pro-wid', descriptor: 'Club Pro Manufacturing USA' },
  linksPurchaseOrderLines: true,
  submittedSupplierWID: 'golf-gear-wid',
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
      names: ['GOLF GEAR LTD', 'CLUB PRO MFG', 'Golf Gear', 'GOLF GEAR LTD'],
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
  it('does nothing when no PO line is linked', () => {
    expect(decidePurchaseOrderSupplier(incidentInput({ linksPurchaseOrderLines: false }))).toBeUndefined();
  });

  it('does nothing when the PO has no supplier', () => {
    expect(decidePurchaseOrderSupplier(incidentInput({ purchaseOrderSupplier: undefined }))).toBeUndefined();
  });

  it('allows no retry when the invoice already uses the PO supplier', () => {
    expect(decidePurchaseOrderSupplier(incidentInput({ submittedSupplierWID: 'club-pro-wid' }))).toEqual({
      relation: 'same',
      purchaseOrderSupplier: expect.objectContaining({ workdayId: 'club-pro-wid', allowRetry: false }),
    });
  });

  it('allows the PO supplier retry when the invoice supplier alternate name matches it', () => {
    expect(decidePurchaseOrderSupplier(incidentInput(), {
      submitted: supplierIdentityFromDocument(golfGearDocument),
    })).toEqual({
      relation: 'related',
      reason: 'name "CLUB PRO MFG" matches "Club Pro Manufacturing USA"',
      purchaseOrderSupplier: {
        workdayId: 'club-pro-wid',
        descriptor: 'Club Pro Manufacturing USA',
        purchaseOrderNumber: 'PO-414373',
        invoiceSupplierName: 'GOLF GEAR LTD',
        allowRetry: true,
      },
    });
  });

  it('allows the PO supplier retry when the invoice letterhead names the PO supplier', () => {
    expect(decidePurchaseOrderSupplier(incidentInput({
      invoiceSupplier: { resolvedName: 'GOLF GEAR LTD', extractedName: 'Club Pro Manufacturing' },
    }))?.relation).toBe('related');
  });

  it('allows the PO supplier retry when the default supplier stands in for an unmatched PO supplier', () => {
    expect(decidePurchaseOrderSupplier(incidentInput({
      submittedSupplierWID: 'default-supplier-wid',
      invoiceSupplier: { extractedName: 'Club Pro Manufacturing' },
    }))?.purchaseOrderSupplier.allowRetry).toBe(true);
  });

  it('splits comma-joined invoice phones before relating suppliers', () => {
    expect(decidePurchaseOrderSupplier(incidentInput({
      invoiceSupplier: { resolvedName: 'GOLF GEAR LTD', phone: '972-555-0000, (214) 555-0100', email: 'ar@golfgear.example, x@gmail.com' },
    }), {
      purchaseOrder: supplierIdentityFromDocument(clubProDocument),
    })?.reason).toBe('phone (214) 555-0100 matches');
  });

  it('refuses the PO supplier retry when nothing ties the suppliers together', () => {
    expect(decidePurchaseOrderSupplier(incidentInput())).toEqual({
      relation: 'unrelated',
      purchaseOrderSupplier: expect.objectContaining({ workdayId: 'club-pro-wid', allowRetry: false, invoiceSupplierName: 'GOLF GEAR LTD' }),
    });
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

  it('relates by names alone when the supplier cache is unavailable', async () => {
    const query = jest.fn().mockRejectedValue(new Error('connection refused'));

    const decision = await resolvePurchaseOrderSupplier(dbReturning(query), incidentInput({
      invoiceSupplier: { extractedName: 'CLUB PRO MFG' },
    }));

    expect(decision?.relation).toBe('related');
  });

  it('skips the cache lookup when the PO supplier is already submitted', async () => {
    const query = jest.fn();

    const decision = await resolvePurchaseOrderSupplier(dbReturning(query), incidentInput({ submittedSupplierWID: 'club-pro-wid' }));

    expect(query).not.toHaveBeenCalled();
    expect(decision?.relation).toBe('same');
  });
});
