// Fictional fixture for a remaining-balance invoice whose PO "final payment" line is larger than the amount due
// (the PO line was sized for the full remaining contract before this invoice's own deposits were netted off).
// Everything here — the venue, amounts, and PO line descriptions — is invented for the test and does not match any
// real invoice, supplier, or PO.
function row(description: string, quantity: number, unitCost: string, totalPrice: string) {
  return { description, descriptionCells: null, quantity, unitCost, totalPrice, hasDiscount: null, tableNumber: 1, sectionLabel: null };
}

// Sub-Total $42,650.00 across 3 charge rows.
export const remainingBalanceOverageRows = [
  row('Guest Rooms', 1, '$22,000.00', '$22,000.00'),
  row('Banquet F&B', 1, '$16,500.00', '$16,500.00'),
  row('Meeting Room Rental', 1, '$4,150.00', '$4,150.00'),
];

// Two deposits already paid, summing $30,650.00, leaving $12,000.00 due.
export const remainingBalanceOverageDeposits = [
  { label: 'Deposit on Hand', amount: '$20,000.00' },
  { label: 'Deposit on Hand', amount: '$10,650.00' },
];

export const remainingBalanceOverageHeader = {
  extractedInvoiceDate: '2026-11-01',
  extractedAmountDue: '$12,000.00',
  extractedSuppliersInvoiceNumber: 'EX-0001',
  extractedPurchaseOrderNumber: 'PO-EX0001',
  extractedFreightAmount: null,
  extractedTaxAmount: null,
  invoiceLineQuantityDisplayed: true,
  extractedLineSubtotal: { label: 'Sub-Total', amount: '$42,650.00' },
  extractedPartialPayment: null,
  extractedPriorPayments: remainingBalanceOverageDeposits,
  emailBalanceDue: null,
};

// The PO's one line, described as a final payment, for $1,500.00 more than the $12,000.00 amount due.
export const remainingBalanceFinalPaymentPoLine = [
  { lineOrder: 1, purchaseOrderLineId: 'PL-EX1', description: 'Final payment for all remaining event charges', extendedAmount: 13500 },
] as any[];

// The same single-line PO, but with no "final payment" wording, to exercise the sole-open-line fallback.
export const remainingBalanceUnlabeledSinglePoLine = [
  { lineOrder: 1, purchaseOrderLineId: 'PL-EX1', description: 'Event services', extendedAmount: 13500 },
] as any[];

// Two lines both described as a final payment, each big enough to cover the balance: ambiguous, so neither is picked.
export const remainingBalanceAmbiguousPoLines = [
  { lineOrder: 1, purchaseOrderLineId: 'PL-EX2', description: 'Final payment, rooms block', extendedAmount: 13500 },
  { lineOrder: 2, purchaseOrderLineId: 'PL-EX3', description: 'Remaining balance, catering', extendedAmount: 14000 },
] as any[];

// A single final-payment line that is smaller than the $12,000.00 amount due: the PO itself needs attention.
export const remainingBalanceShortPoLine = [
  { lineOrder: 1, purchaseOrderLineId: 'PL-EX4', description: 'Final payment for all remaining event charges', extendedAmount: 9000 },
] as any[];
