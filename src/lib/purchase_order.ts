import { htmlToText } from './html_text.js';

const PO_NUMBER_PATTERN = /\bPO[-–\s#]+(\w{6})\b/gi;

export function normalizePurchaseOrderNumber(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const stripped = raw.trim().replace(/^[Pp][Oo][-–\s#]*/, '');
  const normalized = `PO-${stripped}`;
  // A digit is required so words such as "PO Number" are not read as a PO.
  return /^PO-(?=\w*\d)\w{6}$/.test(normalized) ? normalized : undefined;
}

/** Every PO number in the texts, in order (duplicates kept). */
export function findPurchaseOrderNumbers(
  ...texts: Array<string | null | undefined>
): string[] {
  const found: string[] = [];
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(new RegExp(PO_NUMBER_PATTERN.source, PO_NUMBER_PATTERN.flags))) {
      const normalized = normalizePurchaseOrderNumber(match[1] ?? match[0]);
      if (normalized) found.push(normalized);
    }
  }
  return found;
}

export function findPurchaseOrderNumber(
  ...texts: Array<string | null | undefined>
): string | undefined {
  return findPurchaseOrderNumbers(...texts)[0];
}

// "PO-413672 Line 7", "PO# 413672 line #7", "PO number 413672, Ln 7", "PO-413672 Line Number 7".
// The line must follow on the same line of text with no sentence end between; "Line 7-8" and "Line 7 and 8" name no line.
const NOTE_PO_PATTERN = /\bPO(?:\s+number)?[-–\s#:]+(\w{6})\b(?:[ \t,:–-]*(?:line|ln)\.?\s*(?:number|no\.?|#)?\s*(\d{1,4})\b(?!\s*(?:[-–,&]|and\b|or\b)\s*\d))?/gi;
// A clause ends at a sentence end or the next PO number; "the PO line 8" stays in the clause.
const NOTE_CLAUSE_END = /[;?!\n]|(?<!\b(?:ln|no))\.(?=\s|$)|\bPO(?:\s+number)?[-–\s#:]+(?=\w*\d)\w{6}\b/i;
const NOTE_LINE_REFERENCE = /\b(?:lines?|ln)\b\.?\s*(?:number|no\.?|#)?\s*\d/i;

export interface NotePurchaseOrder {
  purchaseOrderNumber: string;
  /** Workday PO Line_Number, set only when the notes name exactly one line for this PO. */
  lineNumber?: number;
}

/** Distinct POs named in Intercom notes, in first-mention order. */
export function findNotePurchaseOrders(text?: string | null): NotePurchaseOrder[] {
  if (!text) return [];
  const plainText = htmlToText(text);
  const linesByPo = new Map<string, Set<number>>();
  // POs whose clause names a second line ("Line 7, not Line 8"), so no single line can be trusted.
  const ambiguousLines = new Set<string>();
  for (const match of plainText.matchAll(NOTE_PO_PATTERN)) {
    const purchaseOrderNumber = normalizePurchaseOrderNumber(match[1]);
    if (!purchaseOrderNumber) continue;
    const lines = linesByPo.get(purchaseOrderNumber) ?? new Set<number>();
    const lineNumber = match[2] ? Number(match[2]) : undefined;
    // Workday PO Line_Number starts at 1.
    if (lineNumber !== undefined && lineNumber > 0) lines.add(lineNumber);
    linesByPo.set(purchaseOrderNumber, lines);
    const rest = plainText.slice(match.index + match[0].length);
    const clauseEnd = rest.search(NOTE_CLAUSE_END);
    if (NOTE_LINE_REFERENCE.test(clauseEnd === -1 ? rest : rest.slice(0, clauseEnd))) {
      ambiguousLines.add(purchaseOrderNumber);
    }
  }
  return [...linesByPo].map(([purchaseOrderNumber, lines]) => ({
    purchaseOrderNumber,
    ...(lines.size === 1 && !ambiguousLines.has(purchaseOrderNumber) ? { lineNumber: [...lines][0] } : {}),
  }));
}

/**
 * The note PO to use over the invoice PO. A note naming several POs (for example "not PO 411406,
 * use PO-413672") resolves only when exactly one of them differs from the invoice PO.
 */
export function selectNotePurchaseOrder(
  notePurchaseOrders: NotePurchaseOrder[],
  invoicePurchaseOrderNumber?: string
): NotePurchaseOrder | undefined {
  if (notePurchaseOrders.length === 1) return notePurchaseOrders[0];
  const others = notePurchaseOrders.filter((po) => po.purchaseOrderNumber !== invoicePurchaseOrderNumber);
  return invoicePurchaseOrderNumber && others.length === 1 ? others[0] : undefined;
}

export interface PurchaseOrderEnrichmentContext {
  documentNumber: string;
  company?: {
    workdayId: string;
    name: string;
  };
  lines: Array<{
    lineOrder: number;
    purchaseOrderLineId: string;
    description?: string;
    memo?: string;
  }>;
}
