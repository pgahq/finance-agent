import { debug } from '@pga/logger';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import PDFDocument from 'pdfkit';
import { pdfText } from './conversation_transcript.js';
import { officeKind, type OfficeKind } from './office_kind.js';

export { officeKind, type OfficeKind };

export class OfficeConversionError extends Error {
  constructor(kind: OfficeKind, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Could not convert ${kind} to PDF: ${reason}`);
    this.name = 'OfficeConversionError';
  }
}

const MAX_SHEET_ROWS = 3000;
const MAX_SHEET_COLUMNS = 60;
const MAX_TABLE_ROWS = 3000;
const MAX_CELL_CHARS = 2000;
const MAX_COLUMN_CHARS = 60;
// Stays under the per-request PDF page limits of the OCR and classification models.
const MAX_PDF_PAGES = 60;

class PageBudgetReached extends Error {}

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'table'; rows: string[][]; repeatHeader: boolean }
  | { type: 'image'; data: Buffer }
  | { type: 'pageBreak' };

interface RenderOptions {
  landscape: boolean;
  title: string;
  compress?: boolean;
}

const HTML_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return HTML_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function tidy(value: string): string {
  return value.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

/** Turns the regular HTML mammoth emits (headings, paragraphs, lists, tables, inline images) into blocks. */
export function htmlToBlocks(html: string): Block[] {
  const blocks: Block[] = [];
  const tokens = html.split(/(<[^>]+>)/);
  const lists: Array<{ ordered: boolean; count: number }> = [];
  let text = '';
  let current: { type: 'heading'; level: number } | { type: 'paragraph' } | undefined;
  let prefix = '';
  let table: { rows: string[][]; row: string[]; cell: string; inCell: boolean } | undefined;
  let tableDepth = 0;

  const flush = () => {
    const value = tidy(decodeEntities(text));
    if (value && current) {
      blocks.push(current.type === 'heading'
        ? { type: 'heading', level: current.level, text: value }
        : { type: 'paragraph', text: `${prefix}${value}` });
    }
    text = '';
    current = undefined;
    prefix = '';
  };

  for (const token of tokens) {
    if (!token.startsWith('<')) {
      if (table?.inCell) table.cell += token;
      else text += token;
      continue;
    }
    const tag = /^<\s*(\/?)\s*([a-z0-9]+)/i.exec(token);
    if (!tag) continue;
    const closing = tag[1] === '/';
    const name = tag[2].toLowerCase();

    if (name === 'table') {
      if (!closing) {
        tableDepth += 1;
        if (tableDepth === 1) {
          flush();
          table = { rows: [], row: [], cell: '', inCell: false };
        }
      } else {
        tableDepth = Math.max(0, tableDepth - 1);
        if (tableDepth === 0 && table) {
          if (table.rows.length) blocks.push({ type: 'table', rows: table.rows, repeatHeader: false });
          table = undefined;
        }
      }
      continue;
    }
    if (table) {
      if (tableDepth > 1) {
        if (!table.inCell) continue;
        if (closing && (name === 'td' || name === 'th')) table.cell += ' ';
        else if (name === 'br' || (closing && (name === 'tr' || name === 'p'))) table.cell += '\n';
        continue;
      }
      if (name === 'tr') {
        if (!closing) table.row = [];
        else if (table.row.length) table.rows.push(table.row);
      } else if (name === 'td' || name === 'th') {
        if (!closing) {
          table.inCell = true;
          table.cell = '';
        } else {
          table.row.push(tidy(decodeEntities(table.cell)));
          table.inCell = false;
        }
      } else if (table.inCell && (name === 'br' || (name === 'p' && closing))) {
        table.cell += '\n';
      }
      continue;
    }

    if (name === 'ul' || name === 'ol') {
      flush();
      if (closing) lists.pop();
      else lists.push({ ordered: name === 'ol', count: 0 });
    } else if (/^h[1-6]$/.test(name)) {
      if (closing) flush();
      else {
        flush();
        current = { type: 'heading', level: Number(name[1]) };
      }
    } else if (name === 'p' || name === 'li') {
      if (closing) flush();
      else {
        flush();
        current = { type: 'paragraph' };
        if (name === 'li') {
          const list = lists[lists.length - 1];
          if (list) list.count += 1;
          prefix = `${'    '.repeat(Math.max(0, lists.length - 1))}${list?.ordered ? `${list.count}. ` : '\u2022 '}`;
        }
      }
    } else if (name === 'br') {
      text += '\n';
    } else if (name === 'img' && !closing) {
      const src = /src="data:image\/(?:png|jpeg|jpg);base64,([^"]+)"/i.exec(token);
      if (src) {
        flush();
        blocks.push({ type: 'image', data: Buffer.from(src[1], 'base64') });
      }
    }
  }
  flush();
  return blocks;
}

function columnWidths(rows: string[][], columns: number): number[] {
  return Array.from({ length: columns }, (_, column) => {
    const longest = rows.reduce((max, row) => {
      const longestLine = (row[column] ?? '').split('\n').reduce((lineMax, line) => Math.max(lineMax, line.length), 0);
      return Math.max(max, longestLine);
    }, 0);
    return Math.min(MAX_COLUMN_CHARS, Math.max(3, longest)) * 4.4 + 8;
  });
}

function renderTable(doc: PDFKit.PDFDocument, rows: string[][], repeatHeader: boolean, addPage: () => void): void {
  const left = doc.page.margins.left;
  const available = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const columns = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (columns === 0) return;
  const widths = columnWidths(rows, columns).map((width) => Math.min(width, available));

  const chunks: Array<[number, number]> = [];
  let start = 0;
  let used = 0;
  for (let column = 0; column < columns; column += 1) {
    if (column > start && used + widths[column] > available) {
      chunks.push([start, column]);
      start = column;
      used = 0;
    }
    used += widths[column];
  }
  chunks.push([start, columns]);

  const fontSize = 8;
  const pad = 3;
  const bodyBottom = () => doc.page.height - doc.page.margins.bottom;

  chunks.forEach(([from, to], chunkIndex) => {
    if (chunkIndex > 0 || doc.y > bodyBottom() - 40) addPage();
    if (chunks.length > 1) {
      doc.font('Helvetica-Oblique').fontSize(8).fillColor('#666666')
        .text(`Columns ${from + 1}-${to} of ${columns}`, left, doc.y, { width: available });
      doc.moveDown(0.3);
    }

    const drawRow = (row: string[], bold: boolean) => {
      const heights = widths.slice(from, to).map((width, offset) => {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize);
        return doc.heightOfString(pdfText(row[from + offset] ?? ''), { width: width - pad * 2 });
      });
      const maxHeight = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;
      const rowHeight = Math.min(maxHeight, Math.max(...heights, fontSize) + pad * 2);
      if (doc.y + rowHeight > bodyBottom()) {
        addPage();
        if (repeatHeader && row !== rows[0]) drawRow(rows[0], true);
      }
      const top = doc.y;
      let x = left;
      widths.slice(from, to).forEach((width, offset) => {
        doc.rect(x, top, width, rowHeight).lineWidth(0.5).strokeColor('#bbbbbb').stroke();
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize).fillColor('#111111')
          .text(pdfText(row[from + offset] ?? ''), x + pad, top + pad, {
            width: width - pad * 2,
            height: rowHeight - pad * 2,
            ellipsis: true,
          });
        x += width;
      });
      doc.x = left;
      doc.y = top + rowHeight;
    };

    rows.forEach((row, index) => drawRow(row, repeatHeader && index === 0));
  });
  doc.moveDown(0.8);
  doc.x = left;
}

function renderBlocks(blocks: Block[], options: RenderOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      layout: options.landscape ? 'landscape' : 'portrait',
      margin: 36,
      compress: options.compress !== false,
      info: { Title: pdfText(options.title) },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    let pages = 1;
    doc.on('pageAdded', () => { pages += 1; });
    const addPage = () => {
      if (pages >= MAX_PDF_PAGES) throw new PageBudgetReached();
      doc.addPage();
    };

    try {
      const width = () => doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const left = doc.page.margins.left;
      if (blocks.length === 0) {
        doc.font('Helvetica-Oblique').fontSize(10).fillColor('#666666').text('(no readable content)', left, doc.y, { width: width() });
      }
      const drawBlock = (block: Block) => {
        if (block.type === 'pageBreak') {
          addPage();
        } else if (block.type === 'heading') {
          const size = Math.max(11, 20 - block.level * 2);
          doc.font('Helvetica-Bold').fontSize(size).fillColor('#111111').text(pdfText(block.text), left, doc.y, { width: width() });
          doc.moveDown(0.4);
        } else if (block.type === 'paragraph') {
          doc.font('Helvetica').fontSize(10).fillColor('#111111').text(pdfText(block.text), left, doc.y, { width: width() });
          doc.moveDown(0.5);
        } else if (block.type === 'image') {
          const maxHeight = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;
          if (doc.y > doc.page.margins.top + maxHeight / 2) addPage();
          try {
            doc.image(block.data, left, doc.y, { fit: [width(), maxHeight / 2] });
            doc.y += maxHeight / 2 + 6;
            doc.x = left;
          } catch (error) {
            debug('Skipped an embedded image that could not be drawn', { error: error instanceof Error ? error.message : String(error) });
          }
        } else {
          renderTable(doc, block.rows, block.repeatHeader, addPage);
        }
      };

      let truncated = false;
      for (const block of blocks) {
        if (pages >= MAX_PDF_PAGES) {
          truncated = true;
          break;
        }
        try {
          drawBlock(block);
        } catch (error) {
          if (!(error instanceof PageBudgetReached)) throw error;
          truncated = true;
          break;
        }
      }
      if (truncated) {
        debug('Truncated a converted Office PDF at the page limit', { maxPages: MAX_PDF_PAGES });
        doc.font('Helvetica-Oblique').fontSize(9).fillColor('#666666')
          .text(`[Output truncated after ${MAX_PDF_PAGES} pages]`, doc.page.margins.left, doc.y, { width: width() });
      }
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

async function docxBlocks(buffer: Buffer): Promise<Block[]> {
  const { value: html } = await mammoth.convertToHtml({ buffer });
  const blocks = htmlToBlocks(html);
  let tableRows = 0;
  return blocks.map((block) => {
    if (block.type !== 'table') return block;
    const room = Math.max(0, MAX_TABLE_ROWS - tableRows);
    tableRows += block.rows.length;
    if (block.rows.length <= room) return block;
    debug('Truncated a docx table', { rows: block.rows.length, kept: room });
    return { ...block, rows: block.rows.slice(0, room) };
  });
}

function generalNumber(value: number): string {
  return String(Number(value.toPrecision(12)));
}

function splitFormatSections(numFmt: string): string[] {
  const sections: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < numFmt.length; i += 1) {
    const char = numFmt[i];
    if (char === '"') quoted = !quoted;
    if (char === '\\' && i + 1 < numFmt.length) {
      current += char + numFmt[i + 1];
      i += 1;
    } else if (char === ';' && !quoted) {
      sections.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  sections.push(current);
  return sections;
}

/**
 * Renders a number the way Excel's number format shows it: currency symbols, percent, fixed decimals, thousands
 * separators, and parentheses for negatives. Dates, fractions, scientific, and scaled formats fall back to a plain number.
 */
export function formatNumberCell(value: number, numFmt: string | undefined): string {
  if (!numFmt || /^general$/i.test(numFmt.trim()) || !Number.isFinite(value)) return generalNumber(value);
  try {
    const sections = splitFormatSections(numFmt);
    const useNegativeSection = value < 0 && sections.length > 1;
    const section = value === 0 && sections.length > 2 ? sections[2] : useNegativeSection ? sections[1] : sections[0];

    let prefix = '';
    let suffix = '';
    let pattern = '';
    let percents = 0;
    let state = 'before' as 'before' | 'in' | 'after';
    const addLiteral = (text: string) => {
      if (state === 'in') state = 'after';
      if (state === 'before') prefix += text;
      else suffix += text;
    };
    for (let i = 0; i < section.length; i += 1) {
      const char = section[i];
      if (char === '"') {
        const end = section.indexOf('"', i + 1);
        addLiteral(section.slice(i + 1, end === -1 ? undefined : end));
        i = end === -1 ? section.length : end;
      } else if (char === '\\' || char === '_' || char === '*') {
        if (char === '\\' && i + 1 < section.length) addLiteral(section[i + 1]);
        i += 1;
      } else if (char === '[') {
        const end = section.indexOf(']', i);
        const content = section.slice(i + 1, end === -1 ? undefined : end);
        if (content.startsWith('$')) addLiteral(content.slice(1).split('-')[0]);
        i = end === -1 ? section.length : end;
      } else if ('0#?'.includes(char) || ((char === '.' || char === ',') && state !== 'after')) {
        if (state === 'after') return generalNumber(value);
        state = 'in';
        pattern += char;
      } else if (char === '%') {
        percents += 1;
        addLiteral('%');
      } else if (/[eE]/.test(char) && state === 'in') {
        return generalNumber(value);
      } else if (/[ymdhsgYMDHSG/]/.test(char) && state !== 'after' && pattern === '') {
        return generalNumber(value);
      } else {
        addLiteral(char);
      }
    }
    if (pattern === '' || pattern.endsWith(',') || /\?\//.test(section) || /[?]/.test(pattern)) return generalNumber(value);

    const [integerPattern, fractionPattern = ''] = pattern.split('.');
    const scaled = Math.abs(value) * 100 ** percents;
    const formatted = scaled.toLocaleString('en-US', {
      minimumIntegerDigits: Math.min(21, Math.max(1, (integerPattern.match(/0/g) ?? []).length)),
      minimumFractionDigits: (fractionPattern.match(/0/g) ?? []).length,
      maximumFractionDigits: fractionPattern.replace(/,/g, '').length,
      useGrouping: integerPattern.includes(','),
    });
    const isZero = Number(formatted.replace(/,/g, '')) === 0;
    const sign = value < 0 && !useNegativeSection && !isZero ? '-' : '';
    return `${sign}${prefix}${formatted}${suffix}`.trim();
  } catch {
    return generalNumber(value);
  }
}

function dateText(value: Date): string {
  const iso = value.toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace('T', ' ').slice(0, 16);
}

function cellText(cell: ExcelJS.Cell): string {
  let raw: unknown = cell.value;
  if (raw && typeof raw === 'object' && !(raw instanceof Date) && 'result' in raw) {
    raw = (raw as { result?: unknown }).result;
  }
  let text: string;
  if (raw instanceof Date) text = dateText(raw);
  else if (typeof raw === 'number') text = formatNumberCell(raw, cell.numFmt);
  else text = cell.text ?? '';
  return text.length > MAX_CELL_CHARS ? text.slice(0, MAX_CELL_CHARS) : text;
}

async function xlsxBlocks(buffer: Buffer): Promise<Block[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const blocks: Block[] = [];
  for (const sheet of workbook.worksheets) {
    if (sheet.state && sheet.state !== 'visible') continue;
    const rows: string[][] = [];
    let truncated = false;
    sheet.eachRow({ includeEmpty: false }, (row) => {
      if (rows.length >= MAX_SHEET_ROWS) {
        truncated = true;
        return;
      }
      const values: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell, column) => {
        if (column <= MAX_SHEET_COLUMNS) values[column - 1] = cellText(cell);
      });
      const filled = Array.from(values, (value) => value ?? '');
      if (filled.some((value) => value.trim() !== '')) rows.push(filled);
    });
    if (rows.length === 0) continue;
    const columns = rows.reduce((max, row) => Math.max(max, row.length), 0);
    if (blocks.length > 0) blocks.push({ type: 'pageBreak' });
    blocks.push({ type: 'heading', level: 2, text: sheet.name });
    blocks.push({ type: 'table', rows: rows.map((row) => Array.from({ length: columns }, (_, index) => row[index] ?? '')), repeatHeader: true });
    if (truncated) {
      debug('Truncated an xlsx sheet', { sheet: sheet.name, keptRows: MAX_SHEET_ROWS });
      blocks.push({ type: 'paragraph', text: `[Sheet truncated after ${MAX_SHEET_ROWS} rows]` });
    }
  }
  return blocks;
}

/** Renders a docx or xlsx as a text-and-table PDF for the model. It is not a faithful print of the original. */
export async function convertOfficeToPdf(
  buffer: Buffer,
  kind: OfficeKind,
  options: { compress?: boolean } = {},
): Promise<Buffer> {
  try {
    const blocks = kind === 'docx' ? await docxBlocks(buffer) : await xlsxBlocks(buffer);
    return await renderBlocks(blocks, {
      landscape: kind === 'xlsx',
      title: kind === 'docx' ? 'Word document' : 'Excel workbook',
      compress: options.compress,
    });
  } catch (error) {
    throw new OfficeConversionError(kind, error);
  }
}

export interface ModelDocument {
  fileName: string;
  contentType: string;
  buffer: Buffer;
}

// Classification and OCR read the same stored buffer in one run, so each file is converted once.
const conversions = new WeakMap<Buffer, Promise<Buffer | undefined>>();

async function convertForModel(doc: ModelDocument, kind: OfficeKind): Promise<Buffer | undefined> {
  try {
    const buffer = await convertOfficeToPdf(doc.buffer, kind);
    debug('Converted Office attachment to PDF for the model', {
      fileName: doc.fileName,
      kind,
      originalBytes: doc.buffer.length,
      pdfBytes: buffer.length,
    });
    return buffer;
  } catch (error) {
    debug('Office attachment could not be converted for the model; skipping it', {
      fileName: doc.fileName,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * The bytes to show the AI model for a stored attachment. PDFs and images pass through unchanged;
 * a docx or xlsx is converted to PDF in memory (the stored original is never replaced). Returns
 * undefined when an Office file cannot be converted, so callers can skip it without losing the rest.
 */
export async function toModelDocument<T extends ModelDocument>(doc: T): Promise<T | undefined> {
  const kind = officeKind(doc.fileName, doc.contentType);
  if (!kind) return doc;
  let pending = conversions.get(doc.buffer);
  if (!pending) {
    pending = convertForModel(doc, kind);
    conversions.set(doc.buffer, pending);
  }
  const buffer = await pending;
  return buffer ? { ...doc, contentType: 'application/pdf', buffer } : undefined;
}

/** True for a Word or Excel file the model cannot be shown because it could not be opened. */
export async function isUnreadableOffice(doc: ModelDocument): Promise<boolean> {
  return officeKind(doc.fileName, doc.contentType) !== undefined && (await toModelDocument(doc)) === undefined;
}
