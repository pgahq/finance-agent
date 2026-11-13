import PDFDocument from 'pdfkit';

// Fictional reimbursement packets for the live model check. The real packets AP sends carry a person's name,
// handwriting, and card details, so nothing like them is committed to this public repo: these are generated with
// typed text. They exercise the same trap (a hotel folio that totals more than the form approves) but not
// handwriting, so a live pass here does not prove a handwritten form reads correctly.

export interface FolioOptions {
  guest: string;
  hotel: string;
  nights: number;
  nightly: number;
  taxPerNight: number;
  zeroBalance?: boolean;
}

export interface FormOptions {
  title: string;
  payee: string;
  line: string;
  amount?: string;
  total?: string;
  date: string;
}

export interface GridLine {
  description: string;
  /** Index into `columns`: the category column this line item's amount goes in. */
  column: number;
  amount: number;
}

export interface GridFormOptions {
  title: string;
  payee: string;
  date: string;
  columns: string[];
  lines: GridLine[];
  /** Draw the form sideways on a portrait page, the way a scanned landscape form arrives. */
  rotated?: boolean;
  /** Shade the header and totals rows, the way a photocopied form does. */
  shaded?: boolean;
}

export function dollars(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function folioTotal({ nights, nightly, taxPerNight }: FolioOptions): number {
  return nights * (nightly + taxPerNight);
}

export function gridFormTotals(form: GridFormOptions): { columns: number[]; grand: number } {
  const columns = form.columns.map((_label, index) => form.lines
    .filter((line) => line.column === index)
    .reduce((sum, line) => sum + Math.round(line.amount * 100), 0) / 100);
  return { columns, grand: columns.reduce((sum, total) => sum + Math.round(total * 100), 0) / 100 };
}

function render(draw: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    draw(doc);
    doc.end();
  });
}

function drawForm(doc: PDFKit.PDFDocument, form: FormOptions): void {
  doc.addPage();
  doc.fontSize(16).text(form.title);
  doc.moveDown();
  doc.fontSize(11);
  doc.text(`First and Last Name: ${form.payee}`);
  doc.text('Host Site: Sample City');
  doc.moveDown();
  doc.text('Expense Description and Date of Expense          Amount to Pay');
  doc.text(`${form.line}          ${form.amount ?? ''}`);
  doc.moveDown();
  doc.text(`TOTAL          ${form.total ?? form.amount ?? ''}`);
  doc.moveDown(2);
  doc.text(`Runner Name: ${form.payee}          Date: ${form.date}`);
}

// A grid-style expense report with no "Amount to Pay" label: categories run across, line items run down, and the
// TOTALS row prints each column total and a grand total under "Sum of All Columns".
function drawGridForm(doc: PDFKit.PDFDocument, form: GridFormOptions): void {
  doc.addPage({ size: [612, 792] });
  if (form.rotated) {
    doc.translate(0, 792);
    doc.rotate(-90);
  }
  const width = form.rotated ? 792 : 612;
  const left = 24;
  const descriptionWidth = width * 0.34;
  const cellWidth = (width - left * 2 - descriptionWidth) / (form.columns.length + 1);
  const cellX = (index: number) => left + descriptionWidth + index * cellWidth;
  const rowHeight = 20;
  const shade = (x: number, y: number, w: number, h: number) => {
    if (!form.shaded) return;
    doc.save().fillColor('#9a9a9a').rect(x, y, w, h).fill().restore();
  };
  const cell = (text: string, x: number, y: number, w: number, bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor('black').text(text, x + 3, y + 5, { width: w - 6, align: 'center' });
  };

  doc.font('Helvetica-Bold').fontSize(15).fillColor('black').text(form.title, left, 24);
  doc.font('Helvetica').fontSize(9).text(`PAYEE NAME: ${form.payee}`, left, 52);
  doc.text('BUSINESS PURPOSE: Sample Association Annual Meeting', left, 66);

  let y = 92;
  shade(left, y, width - left * 2, rowHeight * 2);
  doc.rect(left, y, width - left * 2, rowHeight * 2).stroke();
  cell('DESCRIPTION', left, y + 8, descriptionWidth, true);
  form.columns.forEach((label, index) => cell(label.toUpperCase(), cellX(index), y + 8, cellWidth, true));
  cell('Sum of All Columns', cellX(form.columns.length), y + 2, cellWidth, true);
  y += rowHeight * 2;

  for (const line of form.lines) {
    doc.rect(left, y, width - left * 2, rowHeight).stroke();
    doc.font('Helvetica').fontSize(9).fillColor('black').text(line.description, left + 4, y + 5, { width: descriptionWidth - 8 });
    cell(dollars(line.amount), cellX(line.column), y, cellWidth);
    cell(dollars(line.amount), cellX(form.columns.length), y, cellWidth, true);
    y += rowHeight;
  }

  const totals = gridFormTotals(form);
  shade(left, y, width - left * 2, rowHeight);
  doc.rect(left, y, width - left * 2, rowHeight).stroke();
  cell('TOTALS', left, y, descriptionWidth, true);
  totals.columns.forEach((total, index) => cell(dollars(total), cellX(index), y, cellWidth, true));
  cell(dollars(totals.grand), cellX(form.columns.length), y, cellWidth, true);
  y += rowHeight + 24;
  doc.font('Helvetica').fontSize(9).text(`SIGNATURE: ${form.payee}          DATE: ${form.date}`, left, y);
}

function drawFolio(doc: PDFKit.PDFDocument, folio: FolioOptions): void {
  doc.addPage();
  doc.fontSize(14).text(folio.hotel);
  doc.moveDown();
  doc.fontSize(10);
  doc.text(`Guest: ${folio.guest}`);
  doc.text('Room: 1914    Arrive: 10/29/2026    Depart: 11/04/2026');
  doc.moveDown();
  doc.text('DISPLAY DATE        DESCRIPTION        AMOUNT');
  for (let night = 0; night < folio.nights; night += 1) {
    doc.text(`Night ${night + 1}        Room Charge        ${dollars(folio.nightly)}`);
    doc.text(`Night ${night + 1}        Taxes        ${dollars(folio.taxPerNight)}`);
  }
  const total = folioTotal(folio);
  doc.moveDown();
  doc.text(`Total: ${dollars(total)}`);
  if (folio.zeroBalance) {
    doc.text(`Payments: -${dollars(total)}`);
    doc.text('Balance: $0.00');
  }
}

export function reimbursementPacketPdf(form: FormOptions | undefined, folio: FolioOptions | undefined): Promise<Buffer> {
  return render((doc) => {
    if (form) drawForm(doc, form);
    if (folio) drawFolio(doc, folio);
  });
}

export function gridExpenseFormPdf(form: GridFormOptions, folio?: FolioOptions): Promise<Buffer> {
  return render((doc) => {
    drawGridForm(doc, form);
    if (folio) drawFolio(doc, folio);
  });
}

export function vendorInvoicePdf(vendor: string, invoiceNumber: string, amountDue: number): Promise<Buffer> {
  return render((doc) => {
    doc.addPage();
    doc.fontSize(16).text(vendor);
    doc.fontSize(11).moveDown();
    doc.text('Invoice');
    doc.text(`Invoice Number: ${invoiceNumber}`);
    doc.text('Invoice Date: 11/02/2026');
    doc.text('Bill To: PGA of America');
    doc.moveDown();
    doc.text(`Event rental          ${dollars(amountDue)}`);
    doc.text(`Amount Due: ${dollars(amountDue)}`);
    doc.text('Payment terms: Net 30');
  });
}
