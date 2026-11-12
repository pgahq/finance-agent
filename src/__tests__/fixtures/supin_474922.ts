// SUPIN-474922: Berg Construction LLC "PGA App 3.pdf", an AIA G702 pay application against PO-412562 (application 3,
// period to 7/31/2026). As printed: Contract Sum to Date $591,532.00, Total Completed and Stored to Date $532,378.80
// (90%), Total retainage $0.00, previous certificates $402,241.76, current payment due $130,137.04, and Balance to
// Finish $59,153.20. The agent read the contract sum as the base, so $591,532.00 - $402,241.76 missed the amount due and
// the full total was booked. The PDF is not committed.
function row(description: string, quantity: number, unitCost: string, totalPrice: string) {
  return { description, descriptionCells: null, quantity, unitCost, totalPrice, hasDiscount: null, tableNumber: 1, sectionLabel: null };
}

export const supin474922Rows = [
  row('Gravel for the 2026 PGA Championship', 1, '$591,532.00', '$591,532.00'),
];

export const supin474922Payments = [{ label: 'Less Previous Certificates for Payment', amount: '$402,241.76' }];

export const supin474922Header = {
  extractedInvoiceDate: '2026-11-10',
  extractedAmountDue: '$130,137.04',
  extractedSuppliersInvoiceNumber: '3',
  extractedPurchaseOrderNumber: 'PO-412562',
  extractedFreightAmount: null,
  extractedTaxAmount: null,
  invoiceLineQuantityDisplayed: true,
  extractedLineSubtotal: { label: 'Total Completed and Stored to Date', amount: '$532,378.80' },
  extractedPartialPayment: null,
  extractedPriorPayments: supin474922Payments,
  emailBalanceDue: null,
};
