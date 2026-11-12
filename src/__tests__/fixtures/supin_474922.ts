// SUPIN-474922: Berg Construction LLC "PGA App 3.pdf", an AIA G702-style pay application against PO-412562. The PDF
// prints a Contract Sum to Date of $591,532.00, 10% retainage of $59,153.20, previous certificates for payment of
// $402,241.76, and a current payment due of $130,137.04. Extraction read the contract sum to date as the one line and
// missed the retainage, so the agent booked $591,532.00. The rows are representative: the PDF is not committed.
function row(description: string, quantity: number, unitCost: string, totalPrice: string) {
  return { description, descriptionCells: null, quantity, unitCost, totalPrice, hasDiscount: null, tableNumber: 1, sectionLabel: null };
}

export const supin474922Rows = [
  row('Contract Sum to Date', 1, '$591,532.00', '$591,532.00'),
];

export const supin474922Retainage = { label: 'Retainage', percent: '10%', amount: '$59,153.20' };

export const supin474922Payments = [{ label: 'Less Previous Certificates for Payment', amount: '$402,241.76' }];

export const supin474922Header = {
  extractedInvoiceDate: '2026-11-10',
  extractedAmountDue: '$130,137.04',
  extractedSuppliersInvoiceNumber: '3',
  extractedPurchaseOrderNumber: 'PO-412562',
  extractedFreightAmount: null,
  extractedTaxAmount: null,
  invoiceLineQuantityDisplayed: true,
  extractedLineSubtotal: { label: 'Contract Sum to Date', amount: '$591,532.00' },
  extractedPartialPayment: null,
  extractedPriorPayments: supin474922Payments,
  extractedRetainage: supin474922Retainage,
  emailBalanceDue: null,
};
