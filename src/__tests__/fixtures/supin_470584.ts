// SUPIN-470584: Activity Planners deposit invoice 2130B for PO-414712. The PDF prints 28 rows grouped under event-day
// headings, "Total Cost of Contracted Services" $38,255.00, a 90% deposit, and "Advance Deposit Due" $34,429.50.
// "Fresh Cut Floral Centerpieces" 30 x $135.00 is printed under both Tuesday and Wednesday.
export const MONDAY = 'Monday, November 2, 2026 - Board Dinner Enhancements';
export const TUESDAY_RECEPTION = 'Tuesday, November 3, 2026 - Welcome Reception Enhancements';
export const TUESDAY_MEAL = 'Tuesday, November 3, 2026 - Daytime Meal Room Enhancement';
export const WEDNESDAY = 'Wednesday, November 4, 2026 - Awards Event Enhancements';
export const THURSDAY = 'Thursday, November 5, 2026 - Legacy Book Reception';

function row(sectionLabel: string, description: string, quantity: number, unitCost: string, totalPrice: string) {
  return { description, descriptionCells: null, quantity, unitCost, totalPrice, hasDiscount: null, tableNumber: 1, sectionLabel };
}

export const supin470584Rows = [
  row(MONDAY, '132” Abstract Table Linens – Red', 6, '$125.00', '$750.00'),
  row(MONDAY, 'Geometric Gold Centerpieces – Rental', 6, '$60.00', '$360.00'),
  row(MONDAY, 'Gold Satin Napkin with Pearl Ring – Rental', 60, '$5.00', '$300.00'),
  row(MONDAY, 'Mercury Gold Votives with LED Light – Rental', 24, '$5.00', '$120.00'),
  row(MONDAY, '132” Gold Satin Table Linens for Tall Cocktails', 3, '$80.00', '$240.00'),
  row(MONDAY, 'Crinkle Taffeta Red Sashes for Tall Cocktails', 3, '$7.00', '$21.00'),
  row(MONDAY, 'Red Alstroemeria Cut Flower Bubble Bowls Tall Cocktails &Bar', 5, '$45.00', '$225.00'),
  row(MONDAY, 'Mercury Gold Votives with LED Light – Rental', 6, '$5.00', '$30.00'),
  row(TUESDAY_RECEPTION, 'Custom Sign with Embellishments for Entry (Art by Client)', 1, '$160.00', '$160.00'),
  row(TUESDAY_RECEPTION, '132” Table Linens – Blue/White Checkered', 32, '$70.00', '$2,240.00'),
  row(TUESDAY_RECEPTION, '132” Table Linens – Blue Dupioni', 33, '$70.00', '$2,310.00'),
  row(TUESDAY_RECEPTION, 'Wood Lanterns with Fairy Lights – Rental', 35, '$35.00', '$1,225.00'),
  row(TUESDAY_RECEPTION, 'Fresh Cut Floral Centerpieces', 30, '$135.00', '$4,050.00'),
  row(TUESDAY_RECEPTION, 'Cornhole Set with Custom Branding & Matching Bags', 1, '$350.00', '$350.00'),
  row(TUESDAY_RECEPTION, 'Giant Hook and Ring Game – Single Day Rental', 1, '$1,350.00', '$1,350.00'),
  row(TUESDAY_RECEPTION, 'Ping Pong Tables with Accessories and Branding', 2, '$920.00', '$1,840.00'),
  row(TUESDAY_MEAL, 'Cylinder Centerpieces with Blue/Gold/White Golf Balls', 40, '$50.00', '$2,000.00'),
  row(WEDNESDAY, '132” Table Linens – Blue & Gold Crinkle Taffeta – Alternating', 67, '$75.00', '$5,025.00'),
  row(WEDNESDAY, 'Sashes to Tie off Tall Cocktails - Alternating', 7, '$7.00', '$49.00'),
  row(WEDNESDAY, 'Table Runners – Blue & Gold Crinkle Taffeta – Alternating', 60, '$30.00', '$1,800.00'),
  row(WEDNESDAY, 'Tri-Globe Non-Floral Centerpieces for Tables with Blue Runners', 30, '$65.00', '$1,950.00'),
  row(WEDNESDAY, 'Fresh Cut Floral Centerpieces', 30, '$135.00', '$4,050.00'),
  row(WEDNESDAY, 'Blue or Gold Crinkle Taffeta Napkins with Keyring Gift', 600, '$11.50', '$6,900.00'),
  row(WEDNESDAY, 'Additional Napkins – No Keyring', 25, '$4.00', '$100.00'),
  row(THURSDAY, '132” Geometric Prism Table Linens – Set in Crescents of (6)', 3, '$125.00', '$375.00'),
  row(THURSDAY, 'Sky Blue Napkins Handed Off to Hotel to Roll Silver', 20, '$4.00', '$80.00'),
  row(THURSDAY, 'Silver Fairy Light Luminaries – Rental', 3, '$35.00', '$105.00'),
  row(THURSDAY, 'Labor Fee for Setup/Strike (Event Under $1,000)', 1, '$250.00', '$250.00'),
];

// What the model returned in production: the Wednesday floral row was not read.
export const supin470584ProductionRows = supin470584Rows.filter((_, index) => index !== 21);

export const supin470584Header = {
  extractedInvoiceDate: '2026-10-07',
  extractedAmountDue: '$34,429.50',
  extractedSuppliersInvoiceNumber: '2130B',
  extractedPurchaseOrderNumber: 'PO-414712',
  extractedFreightAmount: null,
  extractedTaxAmount: null,
  invoiceLineQuantityDisplayed: true,
  extractedLineSubtotal: { label: 'Total Cost of Contracted Services', amount: '$38,255.00' },
  extractedPartialPayment: { label: 'Advance Deposit Due', percent: '90%', amount: '$34,429.50' },
};

// PO-414712: a 90% deposit line and a 10% balance line.
export const supin470584PoLines = [
  { lineOrder: 1, purchaseOrderLineId: 'ITEM_ORDER_LINE-3-29976', purchaseOrderDocumentNumber: 'PO-414712', quantity: 1, unitCost: 34429.5 },
  { lineOrder: 2, purchaseOrderLineId: 'ITEM_ORDER_LINE-3-29955', purchaseOrderDocumentNumber: 'PO-414712', quantity: 1, unitCost: 3825.5 },
];
