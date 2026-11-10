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

export function dollars(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function folioTotal({ nights, nightly, taxPerNight }: FolioOptions): number {
  return nights * (nightly + taxPerNight);
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
