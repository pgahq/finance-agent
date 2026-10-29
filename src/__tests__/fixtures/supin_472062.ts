// SUPIN-472062: CCH INCORPORATED (Wolters Kluwer) invoice 5418045207. The PDF lists seven eFile/eSign usage rows and
// only the last prints a price: eSign Non 8879, quantity 23 at $1.25. It prints Subtotal $28.75, Sales Tax $1.90, and
// Amount Due $30.65. OCR read that row's line total as $30.65 (the tax-inclusive amount due), so the lines plus tax
// were $32.55. The original PDF was not available, so the six unpriced row descriptions are representative.
function row(description: string, quantity: number | null, unitCost: string | null, totalPrice: string | null) {
  return { description, descriptionCells: null, quantity, unitCost, totalPrice, hasDiscount: null, tableNumber: 1, sectionLabel: null };
}

const unpricedRows = [
  row('eFile Federal 1040 Individual', 4, null, null),
  row('eFile Federal 1120 Corporate', 2, null, null),
  row('eFile Federal 1065 Partnership', 3, null, null),
  row('eFile State Individual', 5, null, null),
  row('eFile Extension 4868', 2, null, null),
  row('eSign Resident 8879', 6, null, null),
];

export const supin472062EsignRow = row('eSign Non 8879', 23, '$1.25', '$30.65');

/** The rows as OCR returned them: the eSign total is the amount due. */
export const supin472062Rows = [...unpricedRows, supin472062EsignRow];

/** The same row as it should be read: quantity x unit price. */
export const supin472062CorrectedEsignRow = { ...supin472062EsignRow, totalPrice: '$28.75' };

export const supin472062Header = {
  extractedInvoiceDate: '2026-10-23',
  extractedAmountDue: '$30.65',
  extractedSuppliersInvoiceNumber: '5418045207',
  extractedPurchaseOrderNumber: null,
  extractedFreightAmount: null,
  extractedTaxAmount: '$1.90',
  extractedTaxLabel: 'Sales Tax',
  invoiceLineQuantityDisplayed: true,
  extractedLineSubtotal: { label: 'Subtotal', amount: '$28.75' },
  extractedPartialPayment: null,
  extractedPriorPayments: null,
  emailBalanceDue: null,
};
