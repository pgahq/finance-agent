import { findPurchaseOrderNumber, normalizePurchaseOrderNumber } from '../lib/purchase_order.js';

describe('normalizePurchaseOrderNumber', () => {
  it('normalizes prefixed and unprefixed PO numbers', () => {
    expect(normalizePurchaseOrderNumber('PO-414498')).toBe('PO-414498');
    expect(normalizePurchaseOrderNumber('po414498')).toBe('PO-414498');
    expect(normalizePurchaseOrderNumber('414498')).toBe('PO-414498');
    expect(normalizePurchaseOrderNumber('PO 414498')).toBe('PO-414498');
    expect(normalizePurchaseOrderNumber('PO#414498')).toBe('PO-414498');
  });

  it('returns undefined for invalid values', () => {
    expect(normalizePurchaseOrderNumber(null)).toBeUndefined();
    expect(normalizePurchaseOrderNumber('PO-12')).toBeUndefined();
    expect(normalizePurchaseOrderNumber('not-a-po')).toBeUndefined();
  });
});

describe('findPurchaseOrderNumber', () => {
  it('finds a PO number in email or filename text', () => {
    expect(findPurchaseOrderNumber('Please process PO-414498 today')).toBe('PO-414498');
    expect(findPurchaseOrderNumber(undefined, 'PO-404770.pdf')).toBe('PO-404770');
    expect(findPurchaseOrderNumber('PO 414498 attached')).toBe('PO-414498');
    expect(findPurchaseOrderNumber('Invoice for PO#414498')).toBe('PO-414498');
  });

  it('does not treat English words as PO numbers', () => {
    expect(findPurchaseOrderNumber('Please advise on the position of this invoice')).toBeUndefined();
    expect(findPurchaseOrderNumber('Is it possible to process this today?')).toBeUndefined();
    expect(findPurchaseOrderNumber(
      'Please advise on the position of this invoice for PO-414498'
    )).toBe('PO-414498');
  });

  it('returns undefined when no PO number is present', () => {
    expect(findPurchaseOrderNumber('Invoice attached', 'invoice.pdf')).toBeUndefined();
  });
});
