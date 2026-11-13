// Fictional figures shaped like SUPIN-474922 (the real supplier, PO, and amounts are not committed): Example Construction LLC
// "Pay App 3.pdf", an AIA G702 pay application against PO-900123 (application 3, period to 7/31/2026). As printed: Contract Sum to Date $612,500.00, Total Completed and Stored to Date $551,250.00
// (90%), Total retainage $0.00, previous certificates $367,500.00, current payment due $183,750.00, and Balance to
// Finish $61,250.00. The agent read the contract sum as the base, so $612,500.00 - $367,500.00 missed the amount due and
// the full total was booked. The PDF is not committed.
function row(description: string, quantity: number, unitCost: string, totalPrice: string) {
  return { description, descriptionCells: null, quantity, unitCost, totalPrice, hasDiscount: null, tableNumber: 1, sectionLabel: null };
}

export const supin474922Rows = [
  row('Gravel for the 2026 PGA Championship', 1, '$612,500.00', '$612,500.00'),
];

export const supin474922Payments = [{ label: 'Less Previous Certificates for Payment', amount: '$367,500.00' }];

export const supin474922Header = {
  extractedInvoiceDate: '2026-11-10',
  extractedAmountDue: '$183,750.00',
  extractedSuppliersInvoiceNumber: '3',
  extractedPurchaseOrderNumber: 'PO-900123',
  extractedFreightAmount: null,
  extractedTaxAmount: null,
  invoiceLineQuantityDisplayed: true,
  extractedLineSubtotal: { label: 'Total Completed and Stored to Date', amount: '$551,250.00' },
  extractedPartialPayment: null,
  extractedPriorPayments: supin474922Payments,
  emailBalanceDue: null,
};
