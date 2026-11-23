// SUPIN-477265: Intercom, Inc. invoice 763647F0-0023. The PDF prints "SMS Sent/Received US" usage as a $157.00 summary
// row with the tier breakdown under it (four flat fees of $33.00 and one of $25.00, plus $0.00 "First"/"Next" rows),
// and two taxes: Texas state tax $7.94 and Frisco city tax $2.55. It prints Total excluding tax $158.79 and Amount Due
// $169.28. OCR read every row correctly, so the agent booked the summary and the tiers ($315.79) and only the state tax.
function row(description: string, quantity: number, unitCost: string | null, totalPrice: string, sectionLabel: string) {
  return { description, descriptionCells: null, quantity, unitCost, totalPrice, hasDiscount: false, tableNumber: 1, sectionLabel };
}

const prorated = 'Phone Numbers Activated US - Prorated Changes';
const usage = 'Additional Usage';
const smsRow = (totalPrice: string) => row('SMS Sent/Received US - Oct 21–Nov 21, 2026', 7335, null, totalPrice, usage);

export const supin477265Rows = [
  row('Remaining time on Phone Numbers Activated US after 21 Oct 2026 - Oct 21–Nov 21, 2026', 1, '$1.80', '$1.80', prorated),
  row('Unused time on Phone Numbers Activated US after 20 Nov 2026 - Nov 20, 2026', 1, '-$0.01', '-$0.01', prorated),
  smsRow('$0.00'),
  row('First 19,000', 7335, '$0.00 per 1,000', '$0.00', usage),
  smsRow('$157.00'),
  row('First 1', 1, '$0.00', '$0.00', usage),
  row('Flat fee for next 6,001 to 7,500', 0, null, '$33.00', usage),
  row('Next 6,001 to 7,500', 1335, '$0.00', '$0.00', usage),
  row('Flat fee for next 4,501 to 6,000', 0, null, '$33.00', usage),
  row('Next 4,501 to 6,000', 1500, '$0.00', '$0.00', usage),
  row('Flat fee for next 3,001 to 4,500', 0, null, '$33.00', usage),
  row('Next 3,001 to 4,500', 1500, '$0.00', '$0.00', usage),
  row('Flat fee for next 1,501 to 3,000', 0, null, '$33.00', usage),
  row('Next 1,501 to 3,000', 1500, '$0.00', '$0.00', usage),
  row('Flat fee for next 2 to 1,500', 0, null, '$25.00', usage),
  row('Next 2 to 1,500', 1499, '$0.00', '$0.00', usage),
];

export const supin477265FlatFeeDescriptions = [
  'Flat fee for next 6,001 to 7,500',
  'Flat fee for next 4,501 to 6,000',
  'Flat fee for next 3,001 to 4,500',
  'Flat fee for next 1,501 to 3,000',
  'Flat fee for next 2 to 1,500',
];

export const supin477265CityTax = { label: 'TX CITY TAX - FRISCO (2% on $127.03)', amount: '$2.55' };

export const supin477265Header = {
  extractedInvoiceDate: '2026-11-21',
  extractedDueDate: '2027-01-20',
  extractedAmountDue: '$169.28',
  extractedSuppliersInvoiceNumber: '763647F0-0023',
  extractedPurchaseOrderNumber: null,
  extractedFreightAmount: null,
  extractedTaxAmount: '$7.94',
  extractedTaxLabel: 'TX STATE TAX - TEXAS (6.25% on $127.03)',
  invoiceLineQuantityDisplayed: true,
  extractedLineSubtotal: { label: 'Total excluding tax', amount: '$158.79' },
  extractedOtherCharges: [supin477265CityTax],
  extractedPartialPayment: null,
  extractedPriorPayments: null,
  emailBalanceDue: null,
};
