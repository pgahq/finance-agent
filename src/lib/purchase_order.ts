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

// "Line 7", "Ln. 7", "line #7", "Line Number 7", "Line No: 7".
const NOTE_LINE_LABEL = String.raw`(?:line|ln)\.?[ \t]*(?:(?:number|no\.?|#)[ \t]*)?:?[ \t]*`;
// "PO-413672 Line 7", "PO# 413672 line #7", "PO number 413672, Ln 7". The line must follow on the same line of
// text with no sentence end between; ranges and lists ("Line 7-8", "7/8", "7 and 8", "7 to 8") name no line.
const NOTE_PO_PATTERN = new RegExp(
  String.raw`\bPO(?:\s+number)?[-–\s#:]+(\w{6})\b(?:[ \t,:–-]*${NOTE_LINE_LABEL}(\d{1,4})\b(?![ \t]*(?:[-–,&/+]|and\b|or\b|to\b|through\b|thru\b)[ \t]*(?:${NOTE_LINE_LABEL})?\d))?`,
  'gi'
);
// A clause ends at a sentence end or the next PO number; "the PO line 8" stays in the clause.
const NOTE_CLAUSE_END = /[;?!\n]|(?<!\b(?:ln|no))\.(?=\s|$)|\bPO(?:\s+number)?[-–\s#:]+(?=\w*\d)\w{6}\b/i;
const NOTE_LINE_REFERENCE = new RegExp(String.raw`\b(?:lines?|ln)\b\.?[ \t]*(?:(?:number|no\.?|#)[ \t]*)?:?[ \t]*\d`, 'i');
const NOTE_SENTENCE_END = /[;?!\n]|(?<!\b(?:ln|no))\.(?=\s)/i;
// "not PO 411406", "don't use the invoice PO 411406", "instead of PO 411406", "the old PO 411406".
const NOTE_REJECTED_BEFORE = /\b(?:not|don['’]?t\s+use|do\s+not\s+use|never\s+use|instead\s+of|rather\s+than|replac(?:e|es|ing)|wrong|old|incorrect|stale|outdated|invalid|closed|cancell?ed)(?:\s+(?:the|this|that|use|using|existing|invoice|invoice['’]s|printed))*[\s,:–-]*$/i;
// "PO 411406 is wrong", "PO-411406 (old)".
const NOTE_REJECTED_AFTER = /^[\s,:–(-]*(?:(?:is|was)\s+)?(?:wrong|old|incorrect|stale|outdated|invalid|closed|cancell?ed|not\s+(?:right|correct|valid))\b/i;

export interface NotePurchaseOrder {
  purchaseOrderNumber: string;
  /** Workday PO Line_Number, set only when the notes name exactly one line for this PO. */
  lineNumber?: number;
  /** The notes reject this PO ("not PO 411406", "PO 411406 is old"). */
  rejected?: boolean;
}

/** Distinct POs named in Intercom notes, in first-mention order. */
export function findNotePurchaseOrders(text?: string | null): NotePurchaseOrder[] {
  if (!text) return [];
  const plainText = htmlToText(text);
  const linesByPo = new Map<string, Set<number>>();
  // POs whose clause names a second line ("Line 7, not Line 8"), so no single line can be trusted.
  const ambiguousLines = new Set<string>();
  const rejected = new Set<string>();
  let previousEnd = 0;
  for (const match of plainText.matchAll(NOTE_PO_PATTERN)) {
    const purchaseOrderNumber = normalizePurchaseOrderNumber(match[1]);
    if (!purchaseOrderNumber) continue;
    const lines = linesByPo.get(purchaseOrderNumber) ?? new Set<number>();
    const lineNumber = match[2] ? Number(match[2]) : undefined;
    // Workday PO Line_Number starts at 1.
    if (lineNumber !== undefined && lineNumber > 0) lines.add(lineNumber);
    linesByPo.set(purchaseOrderNumber, lines);
    const end = match.index + match[0].length;
    const rest = plainText.slice(end);
    const clauseEnd = rest.search(NOTE_CLAUSE_END);
    const clause = clauseEnd === -1 ? rest : rest.slice(0, clauseEnd);
    if (NOTE_LINE_REFERENCE.test(clause)) ambiguousLines.add(purchaseOrderNumber);
    const before = plainText.slice(previousEnd, match.index).split(NOTE_SENTENCE_END).pop() ?? '';
    if (NOTE_REJECTED_BEFORE.test(before) || NOTE_REJECTED_AFTER.test(clause)) rejected.add(purchaseOrderNumber);
    previousEnd = end;
  }
  return [...linesByPo].map(([purchaseOrderNumber, lines]) => ({
    purchaseOrderNumber,
    ...(lines.size === 1 && !ambiguousLines.has(purchaseOrderNumber) ? { lineNumber: [...lines][0] } : {}),
    ...(rejected.has(purchaseOrderNumber) ? { rejected: true } : {}),
  }));
}

/**
 * The note PO to use over the invoice PO. A PO the notes reject is never used. A note naming several POs
 * resolves only when it rejects the invoice PO and exactly one other PO remains ("not PO 411406, use
 * PO-413672"); a note that names the invoice PO without rejecting it ("PO-411406 for invoice 69962699")
 * leaves the invoice PO in place.
 */
export function selectNotePurchaseOrder(
  notePurchaseOrders: NotePurchaseOrder[],
  invoicePurchaseOrderNumber?: string
): NotePurchaseOrder | undefined {
  if (notePurchaseOrders.length === 1) {
    return notePurchaseOrders[0].rejected ? undefined : notePurchaseOrders[0];
  }
  const invoicePurchaseOrder = notePurchaseOrders.find((po) => po.purchaseOrderNumber === invoicePurchaseOrderNumber);
  if (!invoicePurchaseOrder?.rejected) return undefined;
  const others = notePurchaseOrders.filter((po) => po.purchaseOrderNumber !== invoicePurchaseOrderNumber && !po.rejected);
  return others.length === 1 ? others[0] : undefined;
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
