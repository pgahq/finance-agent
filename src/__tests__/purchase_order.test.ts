import {
  findNotePurchaseOrders,
  findNotePurchaseOrdersForOtherInvoices,
  findPurchaseOrderNumber,
  findPurchaseOrderNumbers,
  findSolePurchaseOrderNumber,
  normalizePurchaseOrderNumber,
  noteLineForInvoice,
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

describe('findSolePurchaseOrderNumber', () => {
  it('returns the one PO the texts name, however often', () => {
    expect(findSolePurchaseOrderNumber(['Re: PO-414373', 'Please use PO 414373', 'PO-414373.pdf'])).toBe('PO-414373');
  });

  it('names no PO when the texts name several', () => {
    expect(findSolePurchaseOrderNumber(['Invoices for PO-414373', 'and PO-411406'])).toBeUndefined();
  });

  it('leaves out excluded POs before counting', () => {
    expect(findSolePurchaseOrderNumber(['PO-414373 and PO-411406'], new Set(['PO-411406']))).toBe('PO-414373');
    expect(findSolePurchaseOrderNumber(['PO-411406'], new Set(['PO-411406']))).toBeUndefined();
  });

  it('names no PO when none is present', () => {
    expect(findSolePurchaseOrderNumber([undefined, null, 'Invoice attached'])).toBeUndefined();
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
    expect(findNotePurchaseOrders('use PO-413672 Line 7, not Line 8')).toEqual([{ purchaseOrderNumber: 'PO-413672', lineConflict: true }]);
    expect(findNotePurchaseOrders('use PO-413672 Line 7 and 8')).toEqual([{ purchaseOrderNumber: 'PO-413672' }]);
    expect(findNotePurchaseOrders('use PO-413672 Line 7 and Ln 8')).toEqual([{ purchaseOrderNumber: 'PO-413672' }]);
    expect(findNotePurchaseOrders('use PO-413672 Lines 7 and 8')).toEqual([{ purchaseOrderNumber: 'PO-413672' }]);
    expect(findNotePurchaseOrders('PO-413672 Line 7\nPO-413672 Line 8')).toEqual([{ purchaseOrderNumber: 'PO-413672', lineConflict: true }]);
    expect(findNotePurchaseOrders('use PO-413672 Line 7, not the PO line 8')).toEqual([{ purchaseOrderNumber: 'PO-413672', lineConflict: true }]);
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
      { purchaseOrderNumber: 'PO-413672', lineConflict: true },
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

describe('notes that give one PO a different line for each invoice', () => {
  const tristan = 'Both invoices go to PO-413785 - make invoice 101535 go to line 8, make invoice 101547 go to line 15';
  const perInvoice = {
    purchaseOrderNumber: 'PO-413785',
    allInvoices: true,
    invoiceNumbers: ['101535', '101547'],
    lineNumbersByInvoice: { '101535': 8, '101547': 15 },
  };

  it("reads Tristan's note: both invoices get the PO, 101535 line 8, 101547 line 15", () => {
    const notePurchaseOrders = findNotePurchaseOrders(tristan);
    expect(notePurchaseOrders).toEqual([perInvoice]);
    for (const [invoiceNumber, lineNumber] of [['101535', 8], ['101547', 15]] as const) {
      const selected = selectNotePurchaseOrder(notePurchaseOrders, undefined, invoiceNumber);
      expect(selected?.purchaseOrderNumber).toBe('PO-413785');
      expect(noteLineForInvoice(selected!, invoiceNumber)).toEqual({ lineNumber, conflict: false });
    }
  });

  it('reads the same note from Intercom HTML and with invoice number formatting', () => {
    expect(findNotePurchaseOrders(`<p>${tristan}</p>`)).toEqual([perInvoice]);
    const selected = selectNotePurchaseOrder(findNotePurchaseOrders(tristan), 'PO-411406', 'INV-0101547');
    expect(noteLineForInvoice(selected!, 'INV-0101547')).toEqual({ lineNumber: 15, conflict: false });
  });

  it('gives a PO to every invoice, including one the note does not name or whose number was not read', () => {
    const notePurchaseOrders = findNotePurchaseOrders(tristan);
    expect(selectNotePurchaseOrder(notePurchaseOrders, undefined, '101999')?.purchaseOrderNumber).toBe('PO-413785');
    expect(selectNotePurchaseOrder(notePurchaseOrders, undefined, undefined)?.purchaseOrderNumber).toBe('PO-413785');
    expect(selectNotePurchaseOrder(notePurchaseOrders, undefined, null)?.purchaseOrderNumber).toBe('PO-413785');
    expect(noteLineForInvoice(notePurchaseOrders[0], '101999')).toEqual({ conflict: false });
    expect(findNotePurchaseOrdersForOtherInvoices(notePurchaseOrders, '101999')).toEqual([]);
  });

  it('reads "invoice X: PO Line N" sentences with a different line each', () => {
    expect(findNotePurchaseOrders('Invoice 101535: PO-413785 Line 8. Invoice 101547: PO-413785 Line 15.')).toEqual([
      { purchaseOrderNumber: 'PO-413785', invoiceNumbers: ['101535', '101547'], lineNumbersByInvoice: { '101535': 8, '101547': 15 } },
    ]);
    expect(findNotePurchaseOrders('PO-413785 Line 8 for invoice 101535 and PO-413785 Line 15 for invoice 101547')).toEqual([
      { purchaseOrderNumber: 'PO-413785', invoiceNumbers: ['101535', '101547'], lineNumbersByInvoice: { '101535': 8, '101547': 15 } },
    ]);
    expect(findNotePurchaseOrders('Invoice 101535: use PO-413785, line 8\nInvoice 101547: use PO-413785, line 15')).toEqual([
      { purchaseOrderNumber: 'PO-413785', invoiceNumbers: ['101535', '101547'], lineNumbersByInvoice: { '101535': 8, '101547': 15 } },
    ]);
  });

  it('names the PO once and gives each invoice its line', () => {
    const expected = [
      { purchaseOrderNumber: 'PO-413785', invoiceNumbers: ['101535', '101547'], lineNumbersByInvoice: { '101535': 8, '101547': 15 } },
    ];
    expect(findNotePurchaseOrders('PO-413785 - invoice 101535 line 8, invoice 101547 line 15')).toEqual(expected);
    expect(findNotePurchaseOrders('Use PO-413785: line 8 for invoice 101535, line #15 for invoice 101547')).toEqual(expected);
    expect(findNotePurchaseOrders('Use PO-413785, invoice 101535 goes to Ln 8 and invoice 101547 goes to Line No: 15.')).toEqual(expected);
  });

  it('treats both/all/these/each invoices as every invoice on the ticket', () => {
    for (const note of [
      'Use PO-413785 for both invoices',
      'All invoices go to PO-413785',
      'These invoices are for PO-413785.',
      'Put the two invoices on PO-413785',
      'PO-413785 for each invoice',
    ]) {
      expect(findNotePurchaseOrders(note)).toEqual([{ purchaseOrderNumber: 'PO-413785', allInvoices: true }]);
    }
    expect(findNotePurchaseOrders('Both invoices go to PO-413785 Line 8')).toEqual([
      { purchaseOrderNumber: 'PO-413785', allInvoices: true, lineNumber: 8 },
    ]);
  });

  it('does not read "both invoices 101535 and 101547" as an all-invoices marker', () => {
    expect(findNotePurchaseOrders('both invoices 101535 and 101547 use PO-413785')).toEqual([
      { purchaseOrderNumber: 'PO-413785', invoiceNumbers: ['101535', '101547'] },
    ]);
  });

  it('keeps an untied line for invoices the note does not give a line', () => {
    expect(findNotePurchaseOrders('Both invoices go to PO-413785 Line 8, invoice 101547 goes to line 15')[0]).toEqual({
      purchaseOrderNumber: 'PO-413785',
      allInvoices: true,
      lineNumber: 8,
      invoiceNumbers: ['101547'],
      lineNumbersByInvoice: { '101547': 15 },
    });
  });

  it('gives no line to an invoice the note gives two lines, a range, or a contradicted line', () => {
    const conflicted = (note: string) => findNotePurchaseOrders(note)[0];
    expect(conflicted('Both invoices go to PO-413785, invoice 101535 line 8, invoice 101535 line 9, invoice 101547 line 15')).toEqual({
      purchaseOrderNumber: 'PO-413785',
      allInvoices: true,
      invoiceNumbers: ['101535', '101547'],
      lineNumbersByInvoice: { '101547': 15 },
      conflictingLineInvoices: ['101535'],
    });
    expect(conflicted('PO-413785: invoice 101535 line 8-9, invoice 101547 line 15')).toEqual({
      purchaseOrderNumber: 'PO-413785',
      invoiceNumbers: ['101535', '101547'],
      lineNumbersByInvoice: { '101547': 15 },
      conflictingLineInvoices: ['101535'],
    });
    expect(conflicted('Invoice 101535: use PO-413785 Line 8, not Line 9')).toEqual({
      purchaseOrderNumber: 'PO-413785',
      invoiceNumbers: ['101535'],
      conflictingLineInvoices: ['101535'],
    });
  });

  it('reports a conflicting line for the invoice only', () => {
    const [noteOrder] = findNotePurchaseOrders('Both invoices go to PO-413785, invoice 101535 line 8, invoice 101535 line 9, invoice 101547 line 15');
    expect(noteLineForInvoice(noteOrder, '101535')).toEqual({ conflict: true });
    expect(noteLineForInvoice(noteOrder, '101547')).toEqual({ lineNumber: 15, conflict: false });
  });

  it('ignores a line it cannot give to one PO when the note names several POs', () => {
    expect(findNotePurchaseOrders('PO-413785 for invoice 101535; PO-411406 for invoice 101547. Invoice 101535 line 8')).toEqual([
      { purchaseOrderNumber: 'PO-413785', invoiceNumbers: ['101535'] },
      { purchaseOrderNumber: 'PO-411406', invoiceNumbers: ['101547'] },
    ]);
  });

  it('keeps the single-line shapes for notes with one line and one invoice', () => {
    expect(findNotePurchaseOrders('use PO-413672 Line 7 for invoice 69962682')).toEqual([
      { purchaseOrderNumber: 'PO-413672', lineNumber: 7, invoiceNumbers: ['69962682'] },
    ]);
    expect(noteLineForInvoice({ purchaseOrderNumber: 'PO-413672', lineNumber: 7 }, '69962682')).toEqual({ lineNumber: 7, conflict: false });
    expect(noteLineForInvoice({ purchaseOrderNumber: 'PO-413672', lineConflict: true }, undefined)).toEqual({ conflict: true });
    expect(noteLineForInvoice({ purchaseOrderNumber: 'PO-413672' }, '69962682')).toEqual({ conflict: false });
  });
});

describe('notes that behave as they did before per-invoice lines', () => {
  it('pins no PO line for an invoice remark in a sentence that names no PO', () => {
    expect(findNotePurchaseOrders('Use PO-413785. Invoice 101535 go to line 8.')).toEqual([{ purchaseOrderNumber: 'PO-413785' }]);
    expect(
      findNotePurchaseOrders('Use PO-413785 for this one.\nInvoice 101535 line 2 is a duplicate charge, please remove.')
    ).toEqual([{ purchaseOrderNumber: 'PO-413785' }]);
    expect(findNotePurchaseOrders('PO-413785.\nInvoice 101535 line 8, invoice 101547 line 15.')).toEqual([
      { purchaseOrderNumber: 'PO-413785' },
    ]);
  });

  it('still gives the PO to every invoice, tied or not, when a note only remarks on one invoice line', () => {
    const notePurchaseOrders = findNotePurchaseOrders('Use PO-413785. Invoice 101535 go to line 8.');
    for (const invoiceNumber of ['101535', '101547', undefined]) {
      expect(selectNotePurchaseOrder(notePurchaseOrders, undefined, invoiceNumber)?.purchaseOrderNumber).toBe('PO-413785');
      expect(noteLineForInvoice(notePurchaseOrders[0], invoiceNumber)).toEqual({ conflict: false });
    }
  });

  it('keeps the PO tied to an invoice when the note gives the other invoices another PO', () => {
    const note = 'Invoice 101 goes to PO-111111. The other two invoices go to PO-222222.';
    const notePurchaseOrders = findNotePurchaseOrders(note);
    expect(notePurchaseOrders).toEqual([
      { purchaseOrderNumber: 'PO-111111', invoiceNumbers: ['101'] },
      { purchaseOrderNumber: 'PO-222222' },
    ]);
    expect(selectNotePurchaseOrder(notePurchaseOrders, undefined, '101')?.purchaseOrderNumber).toBe('PO-111111');
    expect(selectNotePurchaseOrder(notePurchaseOrders, undefined, '102')).toBeUndefined();
  });

  it('does not read a bare "two invoices" as every invoice', () => {
    expect(findNotePurchaseOrders('The other two invoices go to PO-222222')).toEqual([{ purchaseOrderNumber: 'PO-222222' }]);
    expect(findNotePurchaseOrders('The two invoices go to PO-222222')).toEqual([
      { purchaseOrderNumber: 'PO-222222', allInvoices: true },
    ]);
  });
});

describe('selectNotePurchaseOrder with a PO given to every invoice', () => {
  const everyInvoice = { purchaseOrderNumber: 'PO-413785', allInvoices: true };
  const forA = { purchaseOrderNumber: 'PO-413672', invoiceNumbers: ['69962682'] };

  it('does not use the PO before an invoice number is known when another PO is tied to an invoice', () => {
    expect(selectNotePurchaseOrder([everyInvoice, forA], undefined, undefined)).toBeUndefined();
  });

  it('uses the PO tied to this invoice over the PO given to every invoice', () => {
    expect(selectNotePurchaseOrder([everyInvoice, forA], undefined, '69962682')).toBe(forA);
    expect(selectNotePurchaseOrder([everyInvoice, forA], undefined, '101535')).toBe(everyInvoice);
  });

  it('stays put when an invoice is tied to two POs', () => {
    const forAToo = { purchaseOrderNumber: 'PO-500001', invoiceNumbers: ['69962682'] };
    expect(selectNotePurchaseOrder([everyInvoice, forA, forAToo], undefined, '69962682')).toBeUndefined();
    expect(selectNotePurchaseOrder([everyInvoice, forA], undefined, '101535')).toBe(everyInvoice);
  });

  it('never uses an all-invoices PO the note rejects', () => {
    expect(selectNotePurchaseOrder([{ ...everyInvoice, rejected: true }], undefined, '101535')).toBeUndefined();
  });

  it('does not call an all-invoices PO a PO for other invoices', () => {
    expect(findNotePurchaseOrdersForOtherInvoices([everyInvoice, forA], '101535')).toEqual([]);
  });
});
