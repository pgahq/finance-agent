import { htmlToText } from './html_text.js';

const PO_NUMBER_PATTERN = /\bPO[-–\s#]+(\w{6})\b/gi;

export function normalizePurchaseOrderNumber(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const stripped = raw.trim().replace(/^[Pp][Oo][-–\s#]*/, '');
  const normalized = `PO-${stripped}`;
  // A digit is required so words such as "PO Number" are not read as a PO.
  return /^PO-(?=\w*\d)\w{6}$/.test(normalized) ? normalized : undefined;
}

export function findPurchaseOrderNumber(
  ...texts: Array<string | null | undefined>
): string | undefined {
  for (const text of texts) {
    if (!text) continue;
    const pattern = new RegExp(PO_NUMBER_PATTERN.source, PO_NUMBER_PATTERN.flags);
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const normalized = normalizePurchaseOrderNumber(match[1] ?? match[0]);
      if (normalized) return normalized;
    }
  }
  return undefined;
}

// "PO-413672 Line 7", "PO# 413672 line #7", "PO number 413672, Ln 7"
const NOTE_PO_PATTERN = /\bPO(?:\s+number)?[-–\s#:]+(\w{6})\b(?:[\s,.:;–-]*(?:line|ln)\.?\s*(?:#|no\.?)?\s*(\d{1,4})\b)?/gi;

export interface NotePurchaseOrder {
  purchaseOrderNumber: string;
  /** Workday PO Line_Number, set only when the notes name exactly one line for this PO. */
  lineNumber?: number;
}

/** Distinct POs named in Intercom notes, in first-mention order. */
export function findNotePurchaseOrders(text?: string | null): NotePurchaseOrder[] {
  if (!text) return [];
  const linesByPo = new Map<string, Set<number>>();
  for (const match of htmlToText(text).matchAll(NOTE_PO_PATTERN)) {
    const purchaseOrderNumber = normalizePurchaseOrderNumber(match[1]);
    if (!purchaseOrderNumber) continue;
    const lines = linesByPo.get(purchaseOrderNumber) ?? new Set<number>();
    const lineNumber = match[2] ? Number(match[2]) : undefined;
    if (lineNumber) lines.add(lineNumber);
    linesByPo.set(purchaseOrderNumber, lines);
  }
  return [...linesByPo].map(([purchaseOrderNumber, lines]) => ({
    purchaseOrderNumber,
    ...(lines.size === 1 ? { lineNumber: [...lines][0] } : {}),
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
