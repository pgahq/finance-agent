// SUPIN-472110: United Rentals rental return invoice 269060542-001 for PO-414149, $2,132.91.
// The PDF prints four light tower rentals, then a SALES/MISCELLANEOUS ITEMS table of seven priced rows (a property tax
// surcharge, an environmental charge, three diesel rows, and separate $228.16 delivery and pickup charges), an
// "Agreement Subtotal" of $1,851.50 that leaves the $124.46 of fuel out, and $156.95 of tax.
// Production OCR returned only eight rows: it added delivery and pickup into one $456.32 freight amount and read the
// surcharge as a tax row, so every row but the environmental charge went on the goods PO line.
function row(description: string, quantity: number, unitCost: string | null, totalPrice: string, sectionLabel: string, tableNumber: number) {
  return { description, descriptionCells: null, quantity, unitCost, totalPrice, hasDiscount: false, tableNumber, sectionLabel };
}

const RENTAL = 'RENTAL ITEMS';
const MISC = 'SALES/MISCELLANEOUS ITEMS';

const tower = (equipment: string, serial: string) =>
  row(`${equipment} - LIGHT TOWER,0-3KW LED VERT MAST - Serial: ${serial}`, 1, null, '$337.00', RENTAL, 1);

export const supin472110TowerRows = [
  tower('12152888', '37-006694'),
  tower('12155766', '37-006743'),
  tower('11502224', '3011969670'),
  tower('11536903', '37-002060'),
];

export const supin472110EnvironmentalRow = row('ENVIRONMENTAL SERVICE CHARGE [ENV/MCI]', 1, '26.960', '$26.96', MISC, 2);
export const supin472110DieselRows = [
  row('DIESEL FUEL [DSL/MCI]', 2.2, '12.700', '$27.94', MISC, 2),
  row('DYED DIESEL [DYEDDSL/MCI]', 3.1, '12.700', '$39.37', MISC, 2),
  row('DIESEL FUEL [DSL/MCI]', 4.5, '12.700', '$57.15', MISC, 2),
];
export const supin472110SurchargeRow = row('PROPERTY TAX SURCHARGE [DRSURAZ/MCI]', 1, '20.220', '$20.22', MISC, 2);
export const supin472110DeliveryRow = row('DELIVERY CHARGE', 1, '228.160', '$228.16', MISC, 2);
export const supin472110PickupRow = row('PICKUP CHARGE', 1, '228.160', '$228.16', MISC, 2);

/** What the document prints, row for row. */
export const supin472110Rows = [
  ...supin472110TowerRows,
  supin472110SurchargeRow,
  supin472110EnvironmentalRow,
  ...supin472110DieselRows,
  supin472110DeliveryRow,
  supin472110PickupRow,
];

/** What production OCR returned. */
export const supin472110ProductionRows = [
  ...supin472110TowerRows,
  supin472110EnvironmentalRow,
  ...supin472110DieselRows,
];

const header = {
  extractedInvoiceDate: '2026-10-27',
  extractedAmountDue: '$2,132.91',
  extractedSuppliersInvoiceNumber: '269060542-001',
  extractedPurchaseOrderNumber: 'PO-414149',
  extractedTaxAmount: '$156.95',
  extractedTaxLabel: 'Tax',
  invoiceLineQuantityDisplayed: true,
  extractedLineSubtotal: { label: 'Agreement Subtotal', amount: '$1,851.50' },
  extractedPartialPayment: null,
  extractedPriorPayments: null,
};

export const supin472110Header = {
  ...header,
  extractedFreightAmount: null,
  extractedFreightLabel: null,
  extractedOtherCharges: null,
};

export const supin472110ProductionHeader = {
  ...header,
  extractedFreightAmount: '$456.32',
  extractedFreightLabel: 'DELIVERY CHARGE and PICKUP CHARGE',
  extractedOtherCharges: [{ label: 'PROPERTY TAX SURCHARGE [DRSURAZ/MCI]', amount: '$20.22' }],
};

export const GOODS_LINE = 'ITEM_ORDER_LINE-3-28686';
export const DELIVERY_LINE = 'ORDER_SERVICE_LINE-3-33423';
export const PICKUP_LINE = 'ORDER_SERVICE_LINE-3-33447';
export const SURCHARGE_LINE = 'ORDER_SERVICE_LINE-3-33448';
export const ENVIRONMENTAL_LINE = 'ORDER_SERVICE_LINE-3-33449';

const poLine = (lineOrder: number, purchaseOrderLineId: string, description: string, extendedAmount: number, goods?: { quantity: number; unitCost: number }) => ({
  lineOrder,
  purchaseOrderLineId,
  purchaseOrderDocumentNumber: 'PO-414149',
  description,
  extendedAmount,
  ...goods,
});

/** PO-414149: one goods line ordered by quantity and four service lines. */
export const supin472110PoLines = [
  poLine(1, GOODS_LINE, 'LIGHT TOWER,4-7KW LED VERT MAST', 1348, { quantity: 4, unitCost: 337 }),
  poLine(2, SURCHARGE_LINE, 'PROPERTY TAX SURCHARGE', 20.22),
  poLine(3, ENVIRONMENTAL_LINE, 'ENVIRONMENTAL SERVICE CHARGE', 26.96),
  poLine(4, DELIVERY_LINE, 'DELIVERY CHARGE', 231.88),
  poLine(5, PICKUP_LINE, 'PICK UP CHARGE', 231.88),
];
