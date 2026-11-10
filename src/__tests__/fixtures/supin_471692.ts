// SUPIN-471692: The Convention Store (TCS Transportation) invoice for PGA Foundation. The PDF prints a "Total Contract
// Price" of $23,887.00 but only the $5,909.50 balance is due; the email says $5,909.50 is the remaining balance and
// splits it $5,279.50 and $630.00 across two budgets. The original PDF was not available, so the rows are
// representative: they total the printed contract price.
function row(description: string, quantity: number, unitCost: string, totalPrice: string) {
  return { description, descriptionCells: null, quantity, unitCost, totalPrice, hasDiscount: null, tableNumber: 1, sectionLabel: null };
}

export const supin471692Rows = [
  row('Motorcoach transportation - event shuttles', 1, '$19,387.00', '$19,387.00'),
  row('Dedicated staging and dispatch coordination', 1, '$3,000.00', '$3,000.00'),
  row('Onsite transportation supervisor', 1, '$1,500.00', '$1,500.00'),
];

export const supin471692Header = {
  extractedInvoiceDate: '2026-10-20',
  extractedAmountDue: '$5,909.50',
  extractedSuppliersInvoiceNumber: 'TCS-1042',
  extractedPurchaseOrderNumber: null,
  extractedFreightAmount: null,
  extractedTaxAmount: null,
  invoiceLineQuantityDisplayed: true,
  extractedLineSubtotal: { label: 'Total Contract Price', amount: '$23,887.00' },
  extractedPartialPayment: null,
  extractedPriorPayments: null,
  emailBalanceDue: { amount: '$5,909.50', phrase: 'remaining balance' },
};

export const supin471692Payments = [{ label: 'Payments Received', amount: '$17,977.50' }];
