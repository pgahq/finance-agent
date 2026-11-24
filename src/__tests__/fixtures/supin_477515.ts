// SUPIN-477515: an invoice that prints a sales tax rate and a pre-tax subtotal but never prints the tax in dollars.
// OCR read tax as null, so lines of $560.00 were booked against the $604.13 amount due and the gap was the sales tax.
// Every name and amount here is invented: 120 pops at $3.50 and a $140.00 setup fee, no delivery charge, a 7.88% rate
// (printed rounded to two decimals), and an amount due that adds the tax to the cent.
function row(description: string, quantity: number, unitCost: string, totalPrice: string) {
  return { description, descriptionCells: null, quantity, unitCost, totalPrice, hasDiscount: false, tableNumber: 1, sectionLabel: null };
}

export const supin477515Rows = [
  row('Assorted frozen pops with toppings', 120, '$3.50', '$420.00'),
  row('Setup and serving fees', 1, '$140.00', '$140.00'),
];

export const supin477515Header = {
  extractedInvoiceDate: null,
  extractedAmountDue: '$604.13',
  extractedSuppliersInvoiceNumber: '1042',
  extractedPurchaseOrderNumber: null,
  extractedFreightAmount: '$0.00',
  extractedFreightLabel: 'Delivery Fee',
  extractedTaxAmount: null,
  extractedTaxLabel: null,
  extractedTaxRate: '7.88%',
  invoiceLineQuantityDisplayed: true,
  extractedLineSubtotal: { label: 'SUBTOTAL', amount: '$560.00' },
  extractedOtherCharges: null,
  extractedSummaryCharges: null,
  extractedPartialPayment: null,
  extractedPriorPayments: null,
  emailBalanceDue: null,
};

export const supin477515Tax = '44.13';

export const supin477515Detail = 'Sales tax $44.13 computed from printed rate 7.88% on $560.00 pre-tax subtotal';
