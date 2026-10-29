// SUPIN-472322: NMR Events invoice 320751 for PO-414792 (amount due $41,590.16), from the production OCR log.
// The printed Subtotal $48,102.66 already contains the $2,000.00 freight. $48,102.66 - Discount $8,866.66
// + Tax $2,354.16 = $41,590.16. The first read returned 59 rows totaling $44,714.66, so rows worth $1,388.00 were
// missed (the rows themselves are not in the log; the two below only carry their total) and the unlined discount
// was left off.
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

function row(description: string, quantity: number | null, unitCost: string, totalPrice: string, sectionLabel: string, tableNumber = 1): Row {
  return { description, descriptionCells: null, quantity, unitCost, totalPrice, hasDiscount: null, tableNumber, sectionLabel };
}

export const supin472322ProductionRows: Row[] = [
  row('Travel Expense - Train*', 2, '250.00', '500.00', 'Expenses', 1),
  row('Travel Expense- Per Diem Allowance - per day*', 3, '95.00', '1140.00', 'Expenses', 1),
  row('KIT: YAMAHA QL1 DIGITAL MIXING CONSOLE', 1, '500.00', '1000.00', 'Audio Equipment', 1),
  row('KIT: DALITE SAFLOC STAND FOR SMALL-FORMAT PROJECTORS', 2, '25.00', '50.00', 'Audio Equipment', 1),
  row('KIT: SHURE ULXD 4-CH H50 WIRELESS MICROPHONE SYSTEM', 2, '500.00', '2000.00', 'Audio Equipment', 1),
  row('D\'SAN LAPTOP SOUND PORT DI BOX', 4, '15.00', '120.00', 'Audio Equipment', 1),
  row('RADIAL JCP-2 ACTIVE PCDI', 2, '25.00', '100.00', 'Audio Equipment', 1),
  row('SHURE SM58 WIRED HANDHELD MICROPHONE', 2, '12.50', '50.00', 'Audio Equipment', 1),
  row('SENNHEISER E845S WIRED SWITCH MICROPHONE', 1, '20.00', '40.00', 'Audio Equipment', 1),
  row('KIT: QSC K10 1000W POWERED SPEAKER SYSTEM', 3, '210.00', '1260.00', 'Audio Equipment', 1),
  row('QSC K10 OUTDOOR WATERPROOF COVER', 2, '5.00', '20.00', 'Audio Equipment', 1),
  row('KIT: EAW RSX12 12" SELF POWERED SUBWOOFER (2 PACK)', 2, '250.00', '1000.00', 'Audio Equipment', 1),
  row('KIT: FBT JOLLY J5A POWERED SPEAKER SYSTEM- BLACK', 1, '100.00', '200.00', 'Audio Equipment', 1),
  row('KIT: CLEAR PLEXIGLASS METAL PODIUM', 1, '175.00', '350.00', 'Audio Equipment', 1),
  row('KIT: WHIRLWIND PRESSMITE COMPACT PASSIVE PRESS BOX', 1, '60.00', '60.00', 'Audio Equipment', 1),
  row('KIT: AUDIO XLR SNAKE PACKAGE', 1, '85.00', '170.00', 'Audio Equipment', 1),
  row('KIT: AUDIO XLR-M TO XLR-F CABLE PACKAGE*', 1, '75.00', '75.00', 'Audio Equipment', 1),
  row('KIT: AUDIO EDISON CABLE PACKAGE*', 1, '195.00', '195.00', 'Audio Equipment', 1),
  row('KIT: SMALL WORK BOX / TOOL BOX (AUDIO)', 1, '100.00', '100.00', 'Audio Equipment', 1),
  row('KIT: MICROPHONE TRIPOD FLOOR STAND (WITH SHORT BOOM ARM)', 8, '15.00', '120.00', 'Audio Equipment', 1),
  row('KIT: MACKIE 12-CHANNEL MIC/LINE MIXER', 1, '100.00', '100.00', 'Terrace Sound System', 1),
  row('KIT: DALITE SAFLOC STAND FOR SMALL-FORMAT PROJECTORS', 1, '25.00', '25.00', 'Terrace Sound System', 1),
  row('KIT: QSC K10 1000W POWERED SPEAKER SYSTEM', 1, '210.00', '210.00', 'Terrace Sound System', 1),
  row('SENNHEISER E845S WIRED SWITCH MICROPHONE', 1, '25.00', '25.00', 'Terrace Sound System', 1),
  row('KIT: TRIPOD MICROPHONE FLOOR STAND (WITH STANDARD BOOM ARM)', 1, '15.00', '15.00', 'Terrace Sound System', 1),
  row('Doug Fleener DMX 512 6-Way Opto Splitter', 1, '50.00', '50.00', 'Lighting Equipment', 1),
  row('KIT: LEPRECON LP-612 12- CHANNEL LIGHTING CONSOLE', 1, '175.00', '175.00', 'Lighting Equipment', 1),
  row('KIT: ETC SOURCE 4 LED LEKO 36°', 4, '80.00', '320.00', 'Spare Console', 1),
  row('KIT: 10\' PIPE & BASE LIGHTING TREE', 2, '75.00', '150.00', 'Spare Console', 1),
  row('KIT: CHAUVET FREEDOM PAR (8-PACK)', 3, '360.00', '1080.00', 'Spare Console', 1),
  row('KIT: LIGHTING CABLE PACKAGE', 1, '75.00', '75.00', 'Spare Console', 1),
  row('KIT: STAGING DECK QUAD RIPPLE (QUICK STAGE)', 1, '1200.00', '1200.00', 'Stage: 16\' wide x 8\' deep x 8" tall', 1),
  row('KIT: STAGING DECK QUAD RIPPLE (QUICK STAGE)', 1, '300.00', '300.00', 'Stage: Press Riser: Two 4\' wide x 4\' deep risers, 24" tall, with skirting', 1),
  row('KIT: DRAPE 7\' - 14\'H GREY 10\' (10\' PANEL)', 1, '1125.00', '1125.00', 'Stage: Press Riser: Two 4\' wide x 4\' deep risers, 24" tall, with skirting', 1),
  row('KIT: FOH DRAPE', 1, '500.00', '500.00', 'Stage: Press Riser: Two 4\' wide x 4\' deep risers, 24" tall, with skirting', 1),
  row('KIT: ROLAND V-60HD VIDEO SWITCHER', 1, '225.00', '225.00', 'Video Equipment', 1),
  row('KIT: MITTI/MILLUMIN PLAYBACK SYSTEM M4', 2, '313.33', '626.66', 'Video Equipment', 1),
  row('KIT: DECIMATOR MD-HX 3G HDMI/SDI CROSS CONVERTER', 2, '100.00', '200.00', 'Video Equipment', 1),
  row('KIT: WINDOWS GRAPHICS COMPUTER KIT', 1, '965.00', '965.00', 'Video Equipment', 1),
  row('KIT: SAMSUNG 65" UHD 4K QM65 LED DISPLAY 3840 x 2160', 2, '350.00', '700.00', 'Video Equipment', 1),
  row('KIT: SAMSUNG 55" UHD 4K QM55 LED DISPLAY 3840 x 2160', 4, '420.00', '1680.00', 'Spare 65" Display', 1),
  row('KIT: DUAL POST 72" STAND BLK SOCKS (SINGLE-DISPLAY)', 6, '70.00', '420.00', 'Spare 55" Display', 1),
  row('KIT: DECIMATOR MD-LX 3G HDMI/SDI CROSS CONVERTER', 6, '60.00', '360.00', 'Spare 55" Display', 1),
  row('KIT: 43" DOWNSTAGE MONITOR PACKAGE (2-PACK)', 1, '550.00', '550.00', 'Downstage Monitor', 1),
  row('KIT: DECIMATOR MD-HX 3G HDMI/SDI CROSS CONVERTER', 2, '105.00', '210.00', 'Downstage Monitor', 1),
  row('KIT: COBALT DIGITAL 1X6 12G HDSDI DISTRIBUTION AMP', 2, '125.00', '250.00', 'Downstage Monitor', 1),
  row('KIT: VIDEO CABLE PACKAGE*', 1, '298.00', '298.00', 'Downstage Monitor', 1),
  row('KIT: SMALL WORK BOX / TOOL BOX (VIDEO)', 1, '100.00', '100.00', 'Downstage Monitor', 1),
  row('KIT: EXPENDABLES KIT', 1, '195.00', '195.00', 'Expendables', 1),
  row('DUVETYNE (BLACK) 25 YARDS', 1, '175.00', '175.00', 'Expendables', 1),
  row('GARBAGE BAGS (1-BOX) (60 Gallon/ Drum Liners)', 1, '50.00', '50.00', 'Expendables', 1),
  row('Project Manager*', 1, '1000.00', '5600.00', 'LABOR', 2),
  row('Audio Engineer (A1)*', 1, '1000.00', '5600.00', 'LABOR', 2),
  row('Video Engineer Hi-Res*', 1, '1150.00', '5980.00', 'LABOR', 2),
  row('Stagehand - Set/Strike (10hr Day)*', 4, '750.00', '3000.00', 'LABOR', 2),
  row('Stagehand - Set/Strike (10hr Day)*', 4, '750.00', '3000.00', 'LABOR', 2),
  row('Project Manager*', 1, '1000.00', '200.00', 'Additional Overtime for 10/17', 2),
  row('Audio Engineer (A1)*', 1, '1000.00', '200.00', 'Additional Overtime for 10/17', 2),
  row('Video Engineer Hi-Res*', 1, '1150.00', '230.00', 'Additional Overtime for 10/17', 2),
];

export const supin472322MissedRows: Row[] = [
  row('Row the first read missed (A)', 1, '1000.00', '1000.00', 'Audio Equipment'),
  row('Row the first read missed (B)', 1, '388.00', '388.00', 'Audio Equipment'),
];

export const supin472322Rows: Row[] = [...supin472322ProductionRows, ...supin472322MissedRows];

export const supin472322Header = {
  extractedInvoiceDate: '2026-10-21',
  extractedDueDate: '2026-11-20',
  extractedAmountDue: '$41,590.16',
  extractedSuppliersInvoiceNumber: '320751',
  extractedPurchaseOrderNumber: 'PO-414792',
  extractedFreightAmount: '2000.00',
  extractedFreightLabel: 'Freight',
  extractedTaxAmount: '2354.16',
  extractedTaxLabel: 'Tax',
  extractedOtherCharges: null,
  extractedSummaryCharges: [{ label: 'Discount', amount: '8866.66' }],
  invoiceLineQuantityDisplayed: true,
  extractedLineSubtotal: { label: 'Subtotal', amount: '48102.66' },
  extractedPartialPayment: null,
  extractedPriorPayments: null,
};
