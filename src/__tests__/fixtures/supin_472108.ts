// SUPIN-472108: United Rentals "Rental Return" invoice 268897416-001 for PO-414148 (amount due $4,045.99).
// The PDF prints a RENTAL ITEMS table (Rental Subtotal $3,067.00) and a SALES/MISCELLANEOUS ITEMS table
// (Sales/Misc Subtotal $680.88), then "Agreement Subtotal" $3,591.67, which leaves out the DIESEL FUEL row because
// Fuel $156.21 is printed again after it, then Tax $298.11 and Total $4,045.99.
// DELIVERY CHARGE and PICKUP CHARGE ($208.66 each) are ordinary rows of the second table.
interface Row {
  description: string;
  descriptionCells: string[] | null;
  quantity: number | null;
  unitCost: string;
  totalPrice: string;
  hasDiscount: boolean | null;
  tableNumber: number;
  sectionLabel: string;
}

function row(description: string, quantity: number | null, unitCost: string, totalPrice: string, sectionLabel: string): Row {
  return { description, descriptionCells: null, quantity, unitCost, totalPrice, hasDiscount: null, tableNumber: 1, sectionLabel };
}

const RENTAL = 'RENTAL ITEMS';
const SALES = 'SALES/MISCELLANEOUS ITEMS';

export const supin472108ProductionRows: Row[] = [
  row("230/5135 FORKLIFT 8' FORKS", 1, '', 'N/C', RENTAL),
  row('11430789 FORKLIFT VARIABLE REACH 10000# 50\'-62\'', 1, '', '3,067.00', RENTAL),
  row('PROPERTY TAX SURCHARGE', 1, '46.005', '46.01', SALES),
  row('ENVIRONMENTAL SERVICE CHARGE', 1, '61.340', '61.34', SALES),
  row('DIESEL FUEL', 12.3, '12.700', '156.21', SALES),
];

export const supin472108DeliveryRow = row('DELIVERY CHARGE', 1, '208.660', '208.66', SALES);
export const supin472108PickupRow = row('PICKUP CHARGE', 1, '208.660', '208.66', SALES);

export const supin472108Rows: Row[] = [...supin472108ProductionRows, supin472108DeliveryRow, supin472108PickupRow];

export const supin472108Header = {
  extractedInvoiceDate: '2026-10-27',
  extractedAmountDue: '$4,045.99',
  extractedSuppliersInvoiceNumber: '268897416-001',
  extractedPurchaseOrderNumber: 'PO-414148',
  extractedFreightAmount: null,
  extractedFreightLabel: null,
  extractedTaxAmount: '$298.11',
  extractedTaxLabel: 'Tax',
  extractedOtherCharges: null,
  extractedSummaryCharges: null,
  invoiceLineQuantityDisplayed: true,
  extractedLineSubtotal: { label: 'Agreement Subtotal', amount: '3,591.67' },
  extractedPartialPayment: null,
  extractedPriorPayments: null,
};
