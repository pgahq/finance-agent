import {
  findNotePurchaseOrders,
  findNotePurchaseOrdersForOtherInvoices,
  findPurchaseOrderNumber,
  findPurchaseOrderNumbers,
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

  it('lists every PO number in order', () => {
    expect(findPurchaseOrderNumbers('PO-413672 and PO 411406', 'PO-413672.pdf')).toEqual(['PO-413672', 'PO-411406', 'PO-413672']);
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

  it('reads "Line Number N" and colon-labeled lines', () => {
    for (const note of ['PO-413672 Line Number 7', 'PO-413672 Line Number: 7', 'PO-413672 Line No: 7', 'PO-413672, Line: 7', 'PO-413672 Ln. 7']) {
      expect(findNotePurchaseOrders(note)).toEqual([{ purchaseOrderNumber: 'PO-413672', lineNumber: 7 }]);
    }
  });

  it('names no line for ranges and lists written with words or slashes', () => {
    for (const note of ['use PO-413672 Line 7 to 8', 'use PO-413672 Line 7 through 8', 'use PO-413672 Line 7/8', 'use PO-413672 Line 7 or Line 8']) {
      expect(findNotePurchaseOrders(note)).toEqual([{ purchaseOrderNumber: 'PO-413672' }]);
    }
    expect(findNotePurchaseOrders('use PO-413672 Line 7 to code the service')).toEqual([
      { purchaseOrderNumber: 'PO-413672', lineNumber: 7 },
    ]);
  });

  it('treats CRLF as a line break', () => {
    expect(findNotePurchaseOrders('use PO-413672\r\nLine 7 is freight')).toEqual([{ purchaseOrderNumber: 'PO-413672' }]);
  });

  it('does not bind a line from the next sentence, a range, or Line 0', () => {
    expect(findNotePurchaseOrders('use PO-413672. Line 7 of the invoice is freight')).toEqual([{ purchaseOrderNumber: 'PO-413672' }]);
    expect(findNotePurchaseOrders('use PO-413672; line 7 is wrong')).toEqual([{ purchaseOrderNumber: 'PO-413672' }]);
    expect(findNotePurchaseOrders('use PO-413672 Line 7-8')).toEqual([{ purchaseOrderNumber: 'PO-413672' }]);
    expect(findNotePurchaseOrders('use PO-413672 Line 0')).toEqual([{ purchaseOrderNumber: 'PO-413672' }]);
  });

  it('names no line when the same clause names a second line for the PO', () => {
    expect(findNotePurchaseOrders('use PO-413672 Line 7, not Line 8')).toEqual([{ purchaseOrderNumber: 'PO-413672' }]);
    expect(findNotePurchaseOrders('use PO-413672 Line 7 and 8')).toEqual([{ purchaseOrderNumber: 'PO-413672' }]);
    expect(findNotePurchaseOrders('use PO-413672 Line 7 and Ln 8')).toEqual([{ purchaseOrderNumber: 'PO-413672' }]);
    expect(findNotePurchaseOrders('use PO-413672 Lines 7 and 8')).toEqual([{ purchaseOrderNumber: 'PO-413672' }]);
    expect(findNotePurchaseOrders('PO-413672 Line 7\nPO-413672 Line 8')).toEqual([{ purchaseOrderNumber: 'PO-413672' }]);
    expect(findNotePurchaseOrders('use PO-413672 Line 7, not the PO line 8')).toEqual([{ purchaseOrderNumber: 'PO-413672' }]);
  });

  it('keeps the line when a later sentence or block names another line', () => {
    expect(findNotePurchaseOrders('use PO-413672 Line 7! Line 2 of the invoice is freight')).toEqual([
      { purchaseOrderNumber: 'PO-413672', lineNumber: 7 },
    ]);
    expect(findNotePurchaseOrders('<section>use PO-413672 Line 7</section><section>Line 2 is freight</section>')).toEqual([
      { purchaseOrderNumber: 'PO-413672', lineNumber: 7 },
    ]);
    expect(findNotePurchaseOrders('use PO-413672 Line 7<br class="x">Line 2 is freight')).toEqual([
      { purchaseOrderNumber: 'PO-413672', lineNumber: 7 },
    ]);
  });

  it('does not bind a line from a separate block', () => {
    expect(findNotePurchaseOrders('<div>use PO-413672</div><div>Line 7 is freight</div>')).toEqual([{ purchaseOrderNumber: 'PO-413672' }]);
    expect(findNotePurchaseOrders('<div title="a>b">use PO-413672</div><p data-x=\'>\'>Line 7 is freight</p>')).toEqual([
      { purchaseOrderNumber: 'PO-413672' },
    ]);
  });

  it('keeps each PO line when the note names two POs', () => {
    expect(findNotePurchaseOrders('use PO-413672 Line 7, not PO 411406 Line 1')).toEqual([
      { purchaseOrderNumber: 'PO-413672', lineNumber: 7 },
      { purchaseOrderNumber: 'PO-411406', lineNumber: 1, rejected: true },
    ]);
  });

  it('reads PO numbers wrapped in angle brackets', () => {
    expect(findNotePurchaseOrders('use <PO-413672>')).toEqual([{ purchaseOrderNumber: 'PO-413672' }]);
    expect(findNotePurchaseOrders('use <PO 413672> line 7')).toEqual([{ purchaseOrderNumber: 'PO-413672' }]);
    expect(findNotePurchaseOrders('<p>use &lt;PO-413672&gt;</p>')).toEqual([{ purchaseOrderNumber: 'PO-413672' }]);
  });

  it('keeps plain-text comparisons around a PO', () => {
    expect(findNotePurchaseOrders('if amount < 100 use PO-413672 Line 7 > otherwise ask')).toEqual([
      { purchaseOrderNumber: 'PO-413672', lineNumber: 7 },
    ]);
  });

  it('ignores PO wording with no PO number', () => {
    expect(findNotePurchaseOrders("Don't use the PO on the invoice")).toEqual([]);
    expect(findNotePurchaseOrders(undefined)).toEqual([]);
  });

  it('lists each distinct PO once and drops a line number the notes contradict', () => {
    expect(findNotePurchaseOrders('use PO-413672 Line 7\n\nPO-413672 Line 8, not PO 411406')).toEqual([
      { purchaseOrderNumber: 'PO-413672' },
      { purchaseOrderNumber: 'PO-411406', rejected: true },
    ]);
    expect(findNotePurchaseOrders('PO-413672 Line 7\n\nconfirmed PO-413672 line 7')).toEqual([
      { purchaseOrderNumber: 'PO-413672', lineNumber: 7 },
    ]);
  });

  it('marks a PO the note rejects', () => {
    for (const note of [
      'Not PO 411406 — use PO-413672',
      "Don't use the invoice PO 411406, use PO-413672",
      'use PO-413672 instead of PO-411406',
      'PO 411406 is old; use PO-413672',
      'the old PO 411406 is closed. PO-413672 Line 7',
    ]) {
      const found = findNotePurchaseOrders(note);
      expect(found.find((po) => po.purchaseOrderNumber === 'PO-411406')?.rejected).toBe(true);
      expect(found.find((po) => po.purchaseOrderNumber === 'PO-413672')?.rejected).toBeUndefined();
    }
  });

  it('does not mark the override PO as rejected by wording about the invoice PO', () => {
    expect(findNotePurchaseOrders("Don't use the PO on the invoice, use PO-413672 Line 7")).toEqual([
      { purchaseOrderNumber: 'PO-413672', lineNumber: 7 },
    ]);
    expect(findNotePurchaseOrders('PO 413672 Line 7 for invoice 69962682; PO-411406 for invoice 69962699')).toEqual([
      { purchaseOrderNumber: 'PO-413672', lineNumber: 7, invoiceNumbers: ['69962682'] },
      { purchaseOrderNumber: 'PO-411406', invoiceNumbers: ['69962699'] },
    ]);
  });

  it('ties each PO to the invoice the note names with it', () => {
    const invoicesFor = (note: string) => Object.fromEntries(
      findNotePurchaseOrders(note).map((po) => [po.purchaseOrderNumber, po.invoiceNumbers])
    );
    expect(invoicesFor('PO-413672 Line 7 for invoice 69962682. PO-411406 for Inv # 69962699')).toEqual({
      'PO-413672': ['69962682'],
      'PO-411406': ['69962699'],
    });
    expect(invoicesFor('Invoice 69962682: use PO-413672 Line 7\nInvoice no. 69962699 - PO 411406')).toEqual({
      'PO-413672': ['69962682'],
      'PO-411406': ['69962699'],
    });
    expect(invoicesFor('for invoice INV-0069962682 not PO 411406, use PO-413672')).toEqual({
      'PO-411406': ['69962682'],
      'PO-413672': ['69962682'],
    });
    expect(invoicesFor('use PO-413672 for invoices 69962682, 69962690 and 69962699')).toEqual({
      'PO-413672': ['69962682', '69962690', '69962699'],
    });
  });

  it('does not tie a PO to an invoice from another sentence or to the invoice PO', () => {
    expect(findNotePurchaseOrders('use PO-413672 Line 7. The invoice 69962682 total is right')).toEqual([
      { purchaseOrderNumber: 'PO-413672', lineNumber: 7 },
    ]);
    expect(findNotePurchaseOrders('the invoice PO-411406 is wrong, use PO-413672')).toEqual([
      { purchaseOrderNumber: 'PO-411406', rejected: true },
      { purchaseOrderNumber: 'PO-413672' },
    ]);
    expect(findNotePurchaseOrders("Don't use the PO on the invoice. use PO-413672 Line 7")).toEqual([
      { purchaseOrderNumber: 'PO-413672', lineNumber: 7 },
    ]);
    expect(findNotePurchaseOrders('invoice 12/01 and invoice 2 of 3: use PO-413672')).toEqual([
      { purchaseOrderNumber: 'PO-413672' },
    ]);
  });
});

describe('selectNotePurchaseOrder', () => {
  const note = { purchaseOrderNumber: 'PO-413672', lineNumber: 7 };
  const invoicePo = { purchaseOrderNumber: 'PO-411406', rejected: true };

  it('uses the only note PO', () => {
    expect(selectNotePurchaseOrder([note], 'PO-411406')).toBe(note);
    expect(selectNotePurchaseOrder([note], undefined)).toBe(note);
  });

  it('picks the note PO that is not the invoice PO when the note rejects the invoice PO', () => {
    expect(selectNotePurchaseOrder([invoicePo, note], 'PO-411406')).toBe(note);
  });

  it('keeps the invoice PO when the note names it without rejecting it', () => {
    const confirmed = { purchaseOrderNumber: 'PO-411406' };
    expect(selectNotePurchaseOrder([note, confirmed], 'PO-411406')).toBeUndefined();
  });

  it('never uses a PO the note rejects', () => {
    expect(selectNotePurchaseOrder([invoicePo], undefined)).toBeUndefined();
    expect(selectNotePurchaseOrder([invoicePo, note, { purchaseOrderNumber: 'PO-500001', rejected: true }], 'PO-411406')).toBe(note);
  });

  it('returns undefined when the notes name several POs it cannot tell apart', () => {
    expect(selectNotePurchaseOrder([invoicePo, note], undefined)).toBeUndefined();
    expect(selectNotePurchaseOrder([invoicePo, note], 'PO-999999')).toBeUndefined();
    expect(selectNotePurchaseOrder([], 'PO-411406')).toBeUndefined();
  });

  describe('when the notes tie POs to invoice numbers', () => {
    const forA = { purchaseOrderNumber: 'PO-413672', lineNumber: 7, invoiceNumbers: ['69962682'] };
    const forB = { purchaseOrderNumber: 'PO-411406', invoiceNumbers: ['69962699'] };

    it('uses the PO tied to this invoice', () => {
      expect(selectNotePurchaseOrder([forA, forB], 'PO-411406', 'INV-0069962682')).toBe(forA);
      expect(selectNotePurchaseOrder([forA, forB], 'PO-411406', '69962699')).toBe(forB);
    });

    it('keeps the invoice PO for an invoice the notes do not name', () => {
      expect(selectNotePurchaseOrder([forA], 'PO-411406', '69962699')).toBeUndefined();
      expect(selectNotePurchaseOrder([forA, { purchaseOrderNumber: 'PO-500001' }], 'PO-411406', '69962699')).toBeUndefined();
      expect(selectNotePurchaseOrder([forA], 'PO-411406', undefined)).toBeUndefined();
    });

    it('skips rejected POs and stays put when two POs are tied to the same invoice', () => {
      const rejected = { purchaseOrderNumber: 'PO-411406', rejected: true, invoiceNumbers: ['69962682'] };
      expect(selectNotePurchaseOrder([rejected, forA], 'PO-411406', '69962682')).toBe(forA);
      const other = { purchaseOrderNumber: 'PO-500001', invoiceNumbers: ['69962682'] };
      expect(selectNotePurchaseOrder([forA, other], 'PO-411406', '69962682')).toBeUndefined();
    });
  });
});

describe('findNotePurchaseOrdersForOtherInvoices', () => {
  const forA = { purchaseOrderNumber: 'PO-413672', lineNumber: 7, invoiceNumbers: ['69962682'] };
  const forB = { purchaseOrderNumber: 'PO-411406', invoiceNumbers: ['69962699'] };

  it('lists the tied POs when the notes tie none to this invoice', () => {
    expect(findNotePurchaseOrdersForOtherInvoices([forA], '69962699')).toEqual([forA]);
    expect(findNotePurchaseOrdersForOtherInvoices([forA, { purchaseOrderNumber: 'PO-500001' }], undefined)).toEqual([forA]);
  });

  it('lists nothing when a PO is tied to this invoice, the notes tie none, or the tied PO is rejected', () => {
    expect(findNotePurchaseOrdersForOtherInvoices([forA, forB], 'INV-0069962699')).toEqual([]);
    expect(findNotePurchaseOrdersForOtherInvoices([{ purchaseOrderNumber: 'PO-413672' }], '69962699')).toEqual([]);
    expect(findNotePurchaseOrdersForOtherInvoices([{ ...forA, rejected: true }], '69962699')).toEqual([]);
  });
});
