export type OfficeKind = 'docx' | 'xlsx';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Detects a convertible Office file by MIME type, falling back to the extension (Intercom often sends octet-stream). */
export function officeKind(fileName: string, contentType: string): OfficeKind | undefined {
  const type = contentType.split(';')[0].trim().toLowerCase();
  if (type === DOCX_MIME) return 'docx';
  if (type === XLSX_MIME) return 'xlsx';
  if (type !== '' && type !== 'application/octet-stream' && type !== 'binary/octet-stream') return undefined;
  const name = fileName.trim().toLowerCase();
  if (name.endsWith('.docx')) return 'docx';
  if (name.endsWith('.xlsx')) return 'xlsx';
  return undefined;
}
