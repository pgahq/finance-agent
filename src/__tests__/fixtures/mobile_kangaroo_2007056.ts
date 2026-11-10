// Mobile Kangaroo Frisco (MKPAYTX LLC) repair invoice 2007056 on PO-414849. The PDF prints a free
// "Business Approved Free Diagnostics" row (quantity 1, $0.00) and a "Display" row (quantity 1). It prints
// "Before taxes" $659.00, tax $54.37, and an amount due of $713.37. OCR read the Display price as the $713.37
// amount due. The original PDF was not available, so the row cells are representative.
function row(description: string, quantity: number | null, unitCost: string | null, totalPrice: string | null) {
  return { description, descriptionCells: null, quantity, unitCost, totalPrice, hasDiscount: null, tableNumber: 1, sectionLabel: null };
}

export const mobileKangarooFreeRow = row('Business Approved Free Diagnostics', 1, null, '$0.00');

/** Display as OCR read it: the tax-inclusive amount due as both its unit price and its total. */
export const mobileKangarooDisplayRow = row('Display', 1, '$713.37', '$713.37');

export const mobileKangarooRows = [mobileKangarooFreeRow, mobileKangarooDisplayRow];

/** Display as it prints: the pre-tax subtotal. */
export const mobileKangarooCorrectedDisplayRow = row('Display', 1, '$659.00', '$659.00');

export const mobileKangarooHeader = {
  extractedInvoiceDate: '2026-11-09',
  extractedAmountDue: '$713.37',
  extractedSuppliersInvoiceNumber: '2007056',
  extractedPurchaseOrderNumber: 'PO-414849',
  extractedFreightAmount: null,
  extractedTaxAmount: '$54.37',
  extractedTaxLabel: 'Tax',
  invoiceLineQuantityDisplayed: true,
  extractedLineSubtotal: { label: 'Before taxes', amount: '$659.00' },
  extractedPartialPayment: null,
  extractedPriorPayments: null,
  emailBalanceDue: null,
};
