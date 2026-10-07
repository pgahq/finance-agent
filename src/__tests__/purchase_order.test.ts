import {
  findNotePurchaseOrders,
  findPurchaseOrderNumber,
  normalizePurchaseOrderNumber,
  selectNotePurchaseOrder,
} from '../lib/purchase_order.js';

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
    expect(normalizePurchaseOrderNumber('PO Number')).toBeUndefined();
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

  it('does not treat the label "PO Number" as a PO number', () => {
    expect(findPurchaseOrderNumber('PO Number: see attached invoice')).toBeUndefined();
    expect(findPurchaseOrderNumber('PO Number: PO-414672')).toBe('PO-414672');
  });

  it('returns undefined when no PO number is present', () => {
    expect(findPurchaseOrderNumber('Invoice attached', 'invoice.pdf')).toBeUndefined();
  });
});

describe('findNotePurchaseOrders', () => {
  it('reads the PO and line from an AP override note', () => {
    expect(findNotePurchaseOrders("<p>Don't use the PO on the invoice. use PO-413672 Line 7</p>"))
      .toEqual([{ purchaseOrderNumber: 'PO-413672', lineNumber: 7 }]);
  });

  it('reads common PO and line spellings', () => {
    expect(findNotePurchaseOrders('PO# 413672 line #7')).toEqual([{ purchaseOrderNumber: 'PO-413672', lineNumber: 7 }]);
    expect(findNotePurchaseOrders('PO 413672, Ln 12')).toEqual([{ purchaseOrderNumber: 'PO-413672', lineNumber: 12 }]);
    expect(findNotePurchaseOrders('PO number 413672')).toEqual([{ purchaseOrderNumber: 'PO-413672' }]);
    expect(findNotePurchaseOrders('use PO-413672')).toEqual([{ purchaseOrderNumber: 'PO-413672' }]);
  });

  it('ignores PO wording with no PO number', () => {
    expect(findNotePurchaseOrders("Don't use the PO on the invoice")).toEqual([]);
    expect(findNotePurchaseOrders(undefined)).toEqual([]);
  });

  it('lists each distinct PO once and drops a line number the notes contradict', () => {
    expect(findNotePurchaseOrders('use PO-413672 Line 7\n\nPO-413672 Line 8, not PO 411406')).toEqual([
      { purchaseOrderNumber: 'PO-413672' },
      { purchaseOrderNumber: 'PO-411406' },
    ]);
    expect(findNotePurchaseOrders('PO-413672 Line 7\n\nconfirmed PO-413672 line 7')).toEqual([
      { purchaseOrderNumber: 'PO-413672', lineNumber: 7 },
    ]);
  });
});

describe('selectNotePurchaseOrder', () => {
  const note = { purchaseOrderNumber: 'PO-413672', lineNumber: 7 };
  const invoicePo = { purchaseOrderNumber: 'PO-411406' };

  it('uses the only note PO', () => {
    expect(selectNotePurchaseOrder([note], 'PO-411406')).toBe(note);
    expect(selectNotePurchaseOrder([note], undefined)).toBe(note);
  });

  it('picks the note PO that is not the invoice PO', () => {
    expect(selectNotePurchaseOrder([invoicePo, note], 'PO-411406')).toBe(note);
  });

  it('returns undefined when the notes name several POs it cannot tell apart', () => {
    expect(selectNotePurchaseOrder([invoicePo, note], undefined)).toBeUndefined();
    expect(selectNotePurchaseOrder([invoicePo, note], 'PO-999999')).toBeUndefined();
    expect(selectNotePurchaseOrder([], 'PO-411406')).toBeUndefined();
  });
});
