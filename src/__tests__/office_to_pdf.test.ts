import ExcelJS from 'exceljs';
import { Document, Packer, Paragraph, Table, TableCell, TableRow, HeadingLevel, TextRun } from 'docx';
import {
  OfficeConversionError,
  convertOfficeToPdf,
  formatNumberCell,
  htmlToBlocks,
  isUnreadableOffice,
  officeKind,
  toModelDocument,
} from '../lib/office_to_pdf.js';

jest.mock('@pga/logger', () => ({ debug: jest.fn() }));

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function sampleDocx(): Promise<Buffer> {
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ text: 'Invoice 4471', heading: HeadingLevel.HEADING_1 }),
        new Paragraph({ children: [new TextRun('Bill to: The PGA of America')] }),
        new Table({
          rows: [
            new TableRow({ children: ['Item', 'Amount'].map((text) => new TableCell({ children: [new Paragraph(text)] })) }),
            new TableRow({ children: ['Range balls', '$125.50'].map((text) => new TableCell({ children: [new Paragraph(text)] })) }),
          ],
        }),
      ],
    }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

async function sampleXlsx(sheets: Array<{ name: string; rows: Array<Array<string | number | Date>>; state?: 'visible' | 'hidden' }>): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    const worksheet = workbook.addWorksheet(sheet.name, { state: sheet.state ?? 'visible' });
    sheet.rows.forEach((row) => worksheet.addRow(row));
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function pdfText(buffer: Buffer): string {
  return [...buffer.toString('latin1').matchAll(/<([0-9A-Fa-f]+)>/g)]
    .map((match) => Buffer.from(match[1], 'hex').toString('latin1'))
    .join('');
}

function pageCount(buffer: Buffer): number {
  return (buffer.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
}

describe('officeKind', () => {
  it('detects Word and Excel by MIME type', () => {
    expect(officeKind('a.bin', DOCX_MIME)).toBe('docx');
    expect(officeKind('a.bin', `${XLSX_MIME}; charset=binary`)).toBe('xlsx');
  });

  it('falls back to the extension only for generic content types', () => {
    expect(officeKind('Invoice.DOCX', 'application/octet-stream')).toBe('docx');
    expect(officeKind('Invoice.xlsx', '')).toBe('xlsx');
    expect(officeKind('Invoice.xlsx', 'application/pdf')).toBeUndefined();
  });

  it('does not accept legacy or unrelated formats', () => {
    expect(officeKind('a.doc', 'application/msword')).toBeUndefined();
    expect(officeKind('a.xls', 'application/octet-stream')).toBeUndefined();
    expect(officeKind('a.pdf', 'application/pdf')).toBeUndefined();
  });
});

describe('htmlToBlocks', () => {
  it('reads headings, lists, tables, and entities from mammoth HTML', () => {
    const blocks = htmlToBlocks(
      '<h1>Title &amp; more</h1><p>First<br />line</p><ul><li>one</li><li>two</li></ul>'
      + '<table><tr><td><p>A</p></td><td>B &lt; C</td></tr><tr><td>1</td><td>2</td></tr></table><p>After</p>'
    );
    expect(blocks).toEqual([
      { type: 'heading', level: 1, text: 'Title & more' },
      { type: 'paragraph', text: 'First\nline' },
      { type: 'paragraph', text: '\u2022 one' },
      { type: 'paragraph', text: '\u2022 two' },
      { type: 'table', rows: [['A', 'B < C'], ['1', '2']], repeatHeader: false },
      { type: 'paragraph', text: 'After' },
    ]);
  });
});

describe('htmlToBlocks nested tables', () => {
  it('flattens an inner table into its outer cell instead of repeating rows', () => {
    const blocks = htmlToBlocks(
      '<table><tr><td><p>Bill To: Acme</p></td><td><table><tr><td>Invoice #</td><td>123</td></tr>'
      + '<tr><td>Total</td><td>$500.00</td></tr></table></td></tr><tr><td>Item</td><td>Qty</td></tr></table>'
    );

    expect(blocks).toEqual([
      { type: 'table', rows: [['Bill To: Acme', 'Invoice # 123\nTotal $500.00'], ['Item', 'Qty']], repeatHeader: false },
    ]);
  });
});

describe('formatNumberCell', () => {
  it.each([
    [1234.5, '$#,##0.00', '$1,234.50'],
    [1234.5, '"$"#,##0.00_);("$"#,##0.00)', '$1,234.50'],
    [-1234.5, '"$"#,##0.00_);("$"#,##0.00)', '($1,234.50)'],
    [-1234.5, '$#,##0.00', '-$1,234.50'],
    [1234.5, '[$$-409]#,##0.00', '$1,234.50'],
    [0.075, '0.0%', '7.5%'],
    [0.075, '0%', '8%'],
    [1234.5599999999999, '0.00', '1234.56'],
    [1234567.891, '#,##0', '1,234,568'],
    [42, '00000', '00042'],
    [12.5, '#,##0.00 "USD"', '12.50 USD'],
    [1234.5599999999999, 'General', '1234.56'],
    [0.1 + 0.2, undefined, '0.3'],
    [0.5, '# ?/?', '0.5'],
    [1234.5, '0.00E+00', '1234.5'],
  ])('shows %p with format %p as %p', (value, format, expected) => {
    expect(formatNumberCell(value, format)).toBe(expected);
  });
});

describe('convertOfficeToPdf', () => {
  it('renders a docx with its paragraphs and table text', async () => {
    const pdf = await convertOfficeToPdf(await sampleDocx(), 'docx', { compress: false });

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const text = pdfText(pdf);
    expect(text).toContain('Invoice 4471');
    expect(text).toContain('Bill to: The PGA of America');
    expect(text).toContain('Range balls');
    expect(text).toContain('$125.50');
  });

  it('renders every visible xlsx sheet and skips hidden ones', async () => {
    const buffer = await sampleXlsx([
      { name: 'Summary', rows: [['Vendor', 'Total'], ['Acme Golf', 1234.5]] },
      { name: 'Detail', rows: [['Date', 'Note'], [new Date('2026-09-30T00:00:00Z'), 'Delivery']] },
      { name: 'Scratch', rows: [['secret']], state: 'hidden' },
    ]);

    const pdf = await convertOfficeToPdf(buffer, 'xlsx', { compress: false });

    const text = pdfText(pdf);
    expect(text).toContain('Summary');
    expect(text).toContain('Acme Golf');
    expect(text).toContain('1234.5');
    expect(text).toContain('Detail');
    expect(text).toContain('2026-09-30');
    expect(text).not.toContain('secret');
    expect(pageCount(pdf)).toBeGreaterThanOrEqual(2);
  });

  it('shows currency, percent, and formula date cells the way Excel displays them', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Totals');
    sheet.addRow(['Amount', 'Tax rate', 'Computed', 'Due']);
    sheet.addRow([1234.5, 0.075, 0, 0]);
    sheet.getCell('A2').numFmt = '$#,##0.00';
    sheet.getCell('B2').numFmt = '0.0%';
    sheet.getCell('C2').value = { formula: 'A2*0.9958', result: 1229.3099999999999 } as ExcelJS.CellFormulaValue;
    sheet.getCell('C2').numFmt = '0.00';
    sheet.getCell('D2').value = { formula: 'DATE(2026,9,30)', result: new Date('2026-09-30T00:00:00Z') } as ExcelJS.CellFormulaValue;
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const text = pdfText(await convertOfficeToPdf(buffer, 'xlsx', { compress: false }));

    expect(text).toContain('$1,234.50');
    expect(text).toContain('7.5%');
    expect(text).toContain('1229.31');
    expect(text).not.toContain('1229.3099');
    expect(text).toContain('2026-09-30');
  });

  it('stops at the page limit and says so instead of producing an oversized PDF', async () => {
    const rows: Array<Array<string | number>> = [['Line', 'Description']];
    for (let i = 1; i <= 3000; i += 1) rows.push([i, `Row number ${i}`]);

    const pdf = await convertOfficeToPdf(await sampleXlsx([{ name: 'Big', rows }]), 'xlsx', { compress: false });

    expect(pageCount(pdf)).toBeLessThanOrEqual(61);
    expect(pdfText(pdf)).toContain('Output truncated after 60 pages');
    expect(pdfText(pdf)).not.toContain('Row number 3000');
  });

  it('paginates long sheets and repeats the header row', async () => {
    const rows: Array<Array<string | number>> = [['Line', 'Description']];
    for (let i = 1; i <= 200; i += 1) rows.push([i, `Row number ${i}`]);

    const pdf = await convertOfficeToPdf(await sampleXlsx([{ name: 'Lines', rows }]), 'xlsx', { compress: false });

    expect(pageCount(pdf)).toBeGreaterThan(2);
    expect(pdfText(pdf)).toContain('Row number 200');
    expect((pdfText(pdf).match(/Description/g) ?? []).length).toBeGreaterThan(1);
  });

  it('splits very wide sheets into column groups', async () => {
    const row = Array.from({ length: 30 }, (_, i) => `Column ${i + 1} value that is fairly long`);

    const pdf = await convertOfficeToPdf(await sampleXlsx([{ name: 'Wide', rows: [row] }]), 'xlsx', { compress: false });

    const text = pdfText(pdf);
    expect(text).toContain('Columns 1-');
    expect(text).toContain('of 30');
    expect(text).toContain('Column 30 value');
  });

  it('produces a valid PDF for an empty workbook', async () => {
    const pdf = await convertOfficeToPdf(await sampleXlsx([{ name: 'Empty', rows: [] }]), 'xlsx', { compress: false });

    expect(pdfText(pdf)).toContain('no readable content');
  });

  it('throws OfficeConversionError for corrupt files', async () => {
    await expect(convertOfficeToPdf(Buffer.from('not a zip'), 'docx')).rejects.toBeInstanceOf(OfficeConversionError);
    await expect(convertOfficeToPdf(Buffer.from('not a zip'), 'xlsx')).rejects.toBeInstanceOf(OfficeConversionError);
  });
});

describe('toModelDocument', () => {
  it('passes PDFs and images through unchanged', async () => {
    const pdf = { fileName: 'a.pdf', contentType: 'application/pdf', buffer: Buffer.from('pdf') };
    const png = { fileName: 'a.png', contentType: 'image/png', buffer: Buffer.from('png') };

    expect(await toModelDocument(pdf)).toBe(pdf);
    expect(await toModelDocument(png)).toBe(png);
  });

  it('converts Office files to PDF and keeps the original name', async () => {
    const original = { fileName: 'Timesheet.xlsx', contentType: XLSX_MIME, buffer: await sampleXlsx([{ name: 'S', rows: [['a']] }]) };

    const converted = await toModelDocument(original);

    expect(converted).toEqual({ fileName: 'Timesheet.xlsx', contentType: 'application/pdf', buffer: expect.any(Buffer) });
    expect(converted?.buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(original.contentType).toBe(XLSX_MIME);
  });

  it('returns undefined for an Office file that cannot be opened', async () => {
    expect(await toModelDocument({ fileName: 'bad.docx', contentType: DOCX_MIME, buffer: Buffer.from('nope') })).toBeUndefined();
  });

  it('converts the same stored buffer once for classification and OCR', async () => {
    const buffer = await sampleXlsx([{ name: 'S', rows: [['a']] }]);
    const doc = { fileName: 'Timesheet.xlsx', contentType: XLSX_MIME, buffer };

    const first = await toModelDocument(doc);
    const second = await toModelDocument({ ...doc });

    expect(second?.buffer).toBe(first?.buffer);
  });
});

describe('isUnreadableOffice', () => {
  it('is true only for an Office file that cannot be opened', async () => {
    expect(await isUnreadableOffice({ fileName: 'bad.docx', contentType: DOCX_MIME, buffer: Buffer.from('nope') })).toBe(true);
    expect(await isUnreadableOffice({ fileName: 'ok.xlsx', contentType: XLSX_MIME, buffer: await sampleXlsx([{ name: 'S', rows: [['a']] }]) })).toBe(false);
    expect(await isUnreadableOffice({ fileName: 'a.pdf', contentType: 'application/pdf', buffer: Buffer.from('pdf') })).toBe(false);
  });
});
