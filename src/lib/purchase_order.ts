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

/**
 * The PO the texts name when they name exactly one distinct PO, leaving out `excluded`. Texts that name
 * several POs (an email covering more than one invoice) name none.
 */
export function findSolePurchaseOrderNumber(
  texts: Array<string | null | undefined>,
  excluded: ReadonlySet<string> = new Set()
): string | undefined {
  const named = new Set(findPurchaseOrderNumbers(...texts).filter((po) => !excluded.has(po)));
  return named.size === 1 ? [...named][0] : undefined;
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

// "invoice 69962682", "Inv # 69962682", "invoice no: INV-1001", "invoices 69962682 and 69962699". The number
// needs a digit and three characters, is never a PO ("invoice PO-411406"), and is not a date ("invoice 12/01").
const NOTE_INVOICE_NUMBER = String.raw`(?!PO(?:\b|[-–#]))(?=[A-Z0-9-]{3})[A-Z0-9][A-Z0-9-]*\d[A-Z0-9-]*(?![\w/])`;
const NOTE_INVOICE_PATTERN = new RegExp(
  String.raw`\b(?:invoices?|inv)\b\.?[ \t]*(?:(?:number|no\.?|#)[ \t]*)?[:#]?[ \t]*(${NOTE_INVOICE_NUMBER}(?:[ \t]*(?:,|&|and)[ \t]*#?[ \t]*${NOTE_INVOICE_NUMBER})*)`,
  'gi'
);
const NOTE_INVOICE_NUMBER_TOKEN = new RegExp(NOTE_INVOICE_NUMBER, 'gi');
const NOTE_TOKEN_BOUNDARY = /[;?!\n]|(?<!\b(?:ln|no|inv))\.(?=\s)/gi;

/** Invoice number as compared between AP notes and the invoice: "INV-0069962682" and "69962682" match. */
export function normalizeNoteInvoiceNumber(value?: string | null): string | undefined {
  const normalized = (value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(?:INVOICE|INV)/, '').replace(/^0+/, '');
  return normalized || undefined;
}

// "both invoices", "all the invoices", "these invoices", "each invoice": the PO covers every invoice on the ticket.
const NOTE_ALL_INVOICES = /\b(?:(?:both|all|these|those|the\s+(?:two|three|2|3))(?:\s+of\s+(?:the|these|those))?\s+invoices|(?:each|every)\s+invoice)\b/gi;
// A standalone line reference ("go to line 8", "line #8 for invoice 101535"), found anywhere outside a "PO-N Line N" match.
const NOTE_LINE_REFERENCE_PATTERN = /\b(?:lines?|ln)\b\.?[ \t]*(?:(?:number|no\.?|#)[ \t]*)?:?[ \t]*(\d{1,4})\b/gi;
const NOTE_LINE_RANGE_AFTER = new RegExp(String.raw`^[ \t]*(?:[-–,&/+]|and\b|or\b|to\b|through\b|thru\b)[ \t]*(?:${NOTE_LINE_LABEL})?\d`, 'i');
// Splits one sentence into clauses: "make invoice 101535 go to line 8, make invoice 101547 go to line 15".
const NOTE_CLAUSE_SPLIT = /,|[ \t][-–—][ \t]|\b(?:and|then|but)\b/gi;

type NoteToken =
  | { kind: 'po'; index: number; end: number; purchaseOrderNumber: string; lineNumber?: number; invoices: Set<string>; all: boolean }
  | { kind: 'invoice'; index: number; end: number; invoiceNumbers: string[] }
  | { kind: 'all'; index: number; end: number }
  | { kind: 'line'; index: number; end: number; lineNumber?: number }
  | { kind: 'clause'; index: number; end: number }
  | { kind: 'boundary'; index: number; end: number };

type NotePoToken = Extract<NoteToken, { kind: 'po' }>;
type NoteLineToken = Extract<NoteToken, { kind: 'line' }>;

/** A line reference tied to the invoices named beside it ("invoice 101535 go to line 8"). */
interface NoteLinePair {
  line: NoteLineToken;
  invoices: string[];
  /** Every PO in the sentence the line sits in; shared with the sentence, so it fills as the sentence is read. */
  sentenceOrders: NotePoToken[];
}

/**
 * Reads the note once. Each PO gets the invoices it is for ("PO-413672 for invoice 69962682"; an invoice named earlier
 * in the sentence covers every later PO in it: "Invoice 69962682: use PO-413672"), or `all` when the sentence says
 * "both invoices" / "all invoices". A line reference beside an invoice ("make invoice 101535 go to line 8") is paired
 * with that invoice. A sentence end, line break, or ";" resets the sentence; a comma, " - ", "and", "then" or "but"
 * resets the clause.
 */
function readNote(plainText: string): { orders: NotePoToken[]; pairs: NoteLinePair[] } {
  const tokens: NoteToken[] = [];
  const orders: NotePoToken[] = [];
  for (const match of plainText.matchAll(NOTE_PO_PATTERN)) {
    const purchaseOrderNumber = normalizePurchaseOrderNumber(match[1]);
    if (!purchaseOrderNumber) continue;
    const lineNumber = match[2] ? Number(match[2]) : undefined;
    const token: NotePoToken = {
      kind: 'po',
      index: match.index,
      end: match.index + match[0].length,
      purchaseOrderNumber,
      // Workday PO Line_Number starts at 1.
      ...(lineNumber !== undefined && lineNumber > 0 ? { lineNumber } : {}),
      invoices: new Set<string>(),
      all: false,
    };
    tokens.push(token);
    orders.push(token);
  }
  for (const match of plainText.matchAll(NOTE_INVOICE_PATTERN)) {
    const invoiceNumbers = [...match[1].matchAll(NOTE_INVOICE_NUMBER_TOKEN)]
      .map((token) => normalizeNoteInvoiceNumber(token[0]))
      .filter((invoiceNumber): invoiceNumber is string => Boolean(invoiceNumber));
    if (invoiceNumbers.length) tokens.push({ kind: 'invoice', index: match.index, end: match.index + match[0].length, invoiceNumbers });
  }
  const insideMatch = (index: number) => tokens.some((token) => index >= token.index && index < token.end);
  const overlapsInvoice = (index: number, end: number) =>
    tokens.some((token) => token.kind === 'invoice' && token.index >= index && token.index < end);
  for (const match of plainText.matchAll(NOTE_ALL_INVOICES)) {
    const end = match.index + match[0].length;
    if (!overlapsInvoice(match.index, end) && !insideMatch(match.index)) tokens.push({ kind: 'all', index: match.index, end });
  }
  for (const match of plainText.matchAll(NOTE_LINE_REFERENCE_PATTERN)) {
    if (insideMatch(match.index)) continue;
    const end = match.index + match[0].length;
    const lineNumber = Number(match[1]);
    const ranged = NOTE_LINE_RANGE_AFTER.test(plainText.slice(end));
    tokens.push({ kind: 'line', index: match.index, end, ...(lineNumber > 0 && !ranged ? { lineNumber } : {}) });
  }
  for (const match of plainText.matchAll(NOTE_TOKEN_BOUNDARY)) {
    if (!insideMatch(match.index)) tokens.push({ kind: 'boundary', index: match.index, end: match.index + match[0].length });
  }
  for (const match of plainText.matchAll(NOTE_CLAUSE_SPLIT)) {
    if (!insideMatch(match.index)) tokens.push({ kind: 'clause', index: match.index, end: match.index + match[0].length });
  }
  tokens.sort((a, b) => a.index - b.index);

  const pairs: NoteLinePair[] = [];
  let sentenceInvoices: string[] | undefined;
  let sentenceAll = false;
  let waiting: NotePoToken[] = [];
  let sentenceOrders: NotePoToken[] = [];
  let clauseInvoices: string[] | undefined;
  let pendingLines: NoteLineToken[] = [];
  // A line with no invoice in its clause belongs to an invoice named earlier in the sentence ("Invoice 101535: PO-413785, line 8").
  const flushLines = () => {
    if (sentenceInvoices) {
      for (const line of pendingLines) pairs.push({ line, invoices: sentenceInvoices, sentenceOrders });
    }
    pendingLines = [];
  };
  for (const token of tokens) {
    if (token.kind === 'boundary') {
      flushLines();
      sentenceInvoices = undefined;
      sentenceAll = false;
      waiting = [];
      sentenceOrders = [];
      clauseInvoices = undefined;
    } else if (token.kind === 'clause') {
      flushLines();
      clauseInvoices = undefined;
    } else if (token.kind === 'all') {
      sentenceAll = true;
      sentenceInvoices = undefined;
      waiting.forEach((order) => { order.all = true; });
      waiting = [];
    } else if (token.kind === 'line') {
      if (clauseInvoices) pairs.push({ line: token, invoices: clauseInvoices, sentenceOrders });
      else pendingLines.push(token);
    } else if (token.kind === 'po') {
      sentenceOrders.push(token);
      if (sentenceAll) token.all = true;
      else if (sentenceInvoices) sentenceInvoices.forEach((invoiceNumber) => token.invoices.add(invoiceNumber));
      else waiting.push(token);
    } else {
      clauseInvoices = token.invoiceNumbers;
      for (const line of pendingLines) pairs.push({ line, invoices: token.invoiceNumbers, sentenceOrders });
      pendingLines = [];
      if (waiting.length) {
        waiting.forEach((order) => token.invoiceNumbers.forEach((invoiceNumber) => order.invoices.add(invoiceNumber)));
        waiting = [];
      } else {
        sentenceInvoices = token.invoiceNumbers;
        sentenceAll = false;
      }
    }
  }
  flushLines();
  return { orders, pairs };
}

export interface NotePurchaseOrder {
  purchaseOrderNumber: string;
  /** Workday PO Line_Number, set only when the notes name exactly one line for this PO that is not tied to an invoice. */
  lineNumber?: number;
  /**
   * Line per normalized invoice number, for notes that give invoices different lines on one PO
   * ("make invoice 101535 go to line 8, make invoice 101547 go to line 15"). An invoice here uses this line, not `lineNumber`.
   */
  lineNumbersByInvoice?: Record<string, number>;
  /** Invoices the notes give more than one line, a range, or a line that cannot be told apart; none of them is pinned. */
  conflictingLineInvoices?: string[];
  /** The notes name a line after this PO, then a second one, so no untied line is trusted. */
  lineConflict?: boolean;
  /** The notes reject this PO ("not PO 411406", "PO 411406 is old"). */
  rejected?: boolean;
  /** Normalized invoice numbers the notes tie this PO to ("PO-413672 for invoice 69962682"). */
  invoiceNumbers?: string[];
  /** The notes say this PO is for every invoice ("both invoices go to PO-413672"). */
  allInvoices?: boolean;
}

interface NotePurchaseOrderDraft {
  untiedLines: Set<number>;
  untiedAmbiguous: boolean;
  linesByInvoice: Map<string, Set<number>>;
  conflictingInvoices: Set<string>;
  invoices: Set<string>;
  all: boolean;
  rejected: boolean;
}

/** Distinct POs named in Intercom notes, in first-mention order. */
export function findNotePurchaseOrders(text?: string | null): NotePurchaseOrder[] {
  if (!text) return [];
  const plainText = htmlToText(text);
  const { orders, pairs } = readNote(plainText);
  const claimedLineStarts = new Set(pairs.map((pair) => pair.line.index));
  const drafts = new Map<string, NotePurchaseOrderDraft>();
  const draftFor = (purchaseOrderNumber: string) => {
    let draft = drafts.get(purchaseOrderNumber);
    if (!draft) {
      draft = {
        untiedLines: new Set(),
        untiedAmbiguous: false,
        linesByInvoice: new Map(),
        conflictingInvoices: new Set(),
        invoices: new Set(),
        all: false,
        rejected: false,
      };
      drafts.set(purchaseOrderNumber, draft);
    }
    return draft;
  };
  const addInvoiceLine = (draft: NotePurchaseOrderDraft, invoiceNumber: string, lineNumber: number | undefined) => {
    draft.invoices.add(invoiceNumber);
    if (lineNumber === undefined) {
      draft.conflictingInvoices.add(invoiceNumber);
      return;
    }
    const lines = draft.linesByInvoice.get(invoiceNumber) ?? new Set<number>();
    lines.add(lineNumber);
    draft.linesByInvoice.set(invoiceNumber, lines);
  };

  let previousEnd = 0;
  for (const order of orders) {
    const draft = draftFor(order.purchaseOrderNumber);
    order.invoices.forEach((invoiceNumber) => draft.invoices.add(invoiceNumber));
    if (order.all) draft.all = true;
    const rest = plainText.slice(order.end);
    const clauseEnd = rest.search(NOTE_CLAUSE_END);
    const clause = clauseEnd === -1 ? rest : rest.slice(0, clauseEnd);
    // A second line reference in the clause ("Line 7, not Line 8") makes the line untrustworthy, unless an invoice claims it.
    const unclaimedLineReference = [...clause.matchAll(new RegExp(NOTE_LINE_REFERENCE.source, 'gi'))]
      .some((match) => !claimedLineStarts.has(order.end + match.index));
    const tiedInvoices = order.all ? [] : [...order.invoices];
    if (order.lineNumber !== undefined) {
      if (tiedInvoices.length) {
        for (const invoiceNumber of tiedInvoices) {
          addInvoiceLine(draft, invoiceNumber, order.lineNumber);
          if (unclaimedLineReference) draft.conflictingInvoices.add(invoiceNumber);
        }
      } else {
        draft.untiedLines.add(order.lineNumber);
      }
    }
    if (unclaimedLineReference && !tiedInvoices.length) draft.untiedAmbiguous = true;
    const before = plainText.slice(previousEnd, order.index).split(NOTE_SENTENCE_END).pop() ?? '';
    if (NOTE_REJECTED_BEFORE.test(before) || NOTE_REJECTED_AFTER.test(clause)) draft.rejected = true;
    previousEnd = order.end;
  }

  // A line beside an invoice counts only in a sentence that names a PO; "Invoice 101535 line 2 is a duplicate charge"
  // is about the invoice, not a PO line.
  for (const pair of pairs) {
    if (!pair.sentenceOrders.length) continue;
    const owner = pair.sentenceOrders.reduce((nearest, order) =>
      Math.abs(order.index - pair.line.index) < Math.abs(nearest.index - pair.line.index) ? order : nearest);
    const draft = draftFor(owner.purchaseOrderNumber);
    pair.invoices.forEach((invoiceNumber) => addInvoiceLine(draft, invoiceNumber, pair.line.lineNumber));
  }

  return [...drafts].map(([purchaseOrderNumber, draft]) => {
    const untiedLine = draft.untiedLines.size === 1 && !draft.untiedAmbiguous ? [...draft.untiedLines][0] : undefined;
    const lineConflict = draft.untiedLines.size > 1 || (draft.untiedLines.size === 1 && draft.untiedAmbiguous);
    const conflicting = new Set(draft.conflictingInvoices);
    const lineByInvoice = new Map<string, number>();
    for (const [invoiceNumber, lines] of draft.linesByInvoice) {
      if (lines.size > 1) conflicting.add(invoiceNumber);
      else if (!conflicting.has(invoiceNumber)) lineByInvoice.set(invoiceNumber, [...lines][0]);
    }
    const invoiceNumbers = [...draft.invoices];
    const sharedLines = new Set(lineByInvoice.values());
    // One line for every invoice the PO is tied to is the plain "PO Line N for invoice X" note.
    const sharedLine = !draft.all && untiedLine === undefined && !lineConflict && !conflicting.size
      && sharedLines.size === 1 && invoiceNumbers.every((invoiceNumber) => lineByInvoice.has(invoiceNumber))
      ? [...sharedLines][0]
      : undefined;
    const lineNumber = sharedLine ?? untiedLine;
    return {
      purchaseOrderNumber,
      ...(lineNumber !== undefined ? { lineNumber } : {}),
      ...(sharedLine === undefined && lineByInvoice.size ? { lineNumbersByInvoice: Object.fromEntries(lineByInvoice) } : {}),
      ...(conflicting.size ? { conflictingLineInvoices: [...conflicting] } : {}),
      ...(lineConflict ? { lineConflict: true } : {}),
      ...(draft.rejected ? { rejected: true } : {}),
      ...(invoiceNumbers.length ? { invoiceNumbers } : {}),
      ...(draft.all ? { allInvoices: true } : {}),
    };
  });
}

/**
 * The PO line the notes give this invoice, and whether they gave it a line that cannot be applied. A line named for
 * this invoice wins over a line named for the PO as a whole.
 */
export function noteLineForInvoice(
  notePurchaseOrder: NotePurchaseOrder,
  invoiceNumber?: string | null
): { lineNumber?: number; conflict: boolean } {
  const normalizedInvoiceNumber = normalizeNoteInvoiceNumber(invoiceNumber);
  if (normalizedInvoiceNumber) {
    if (notePurchaseOrder.conflictingLineInvoices?.includes(normalizedInvoiceNumber)) return { conflict: true };
    const lineNumber = notePurchaseOrder.lineNumbersByInvoice?.[normalizedInvoiceNumber];
    if (lineNumber !== undefined) return { lineNumber, conflict: false };
  }
  if (notePurchaseOrder.lineNumber !== undefined) return { lineNumber: notePurchaseOrder.lineNumber, conflict: false };
  return { conflict: Boolean(notePurchaseOrder.lineConflict) };
}

/**
 * Unrejected note POs the notes tie to other invoices, when they tie no PO to this invoice. A PO the notes give to
 * every invoice is never "for another invoice".
 */
export function findNotePurchaseOrdersForOtherInvoices(
  notePurchaseOrders: NotePurchaseOrder[],
  invoiceNumber?: string | null
): NotePurchaseOrder[] {
  const normalizedInvoiceNumber = normalizeNoteInvoiceNumber(invoiceNumber);
  if (notePurchaseOrders.some((po) => !po.rejected && po.allInvoices)) return [];
  if (normalizedInvoiceNumber && notePurchaseOrders.some((po) => po.invoiceNumbers?.includes(normalizedInvoiceNumber))) {
    return [];
  }
  return notePurchaseOrders.filter((po) => !po.rejected && po.invoiceNumbers?.length);
}

/**
 * The note PO to use over the invoice PO. A PO the notes reject is never used.
 *
 * When the notes tie POs to invoice numbers (a conversation with several invoices) or give a PO to every invoice
 * ("both invoices go to PO-413672"), only a PO tied to this invoice's number (else one given to every invoice) can
 * override, and an invoice the notes do not name keeps its own PO. Without an invoice number (before enrichment, or when it
 * was not read), a PO given to every invoice is used only when it is the one PO the notes name for invoices.
 * Otherwise a note naming one PO overrides, and a note naming several resolves only when it rejects the invoice PO
 * and exactly one other PO remains ("not PO 411406, use PO-413672").
 */
export function selectNotePurchaseOrder(
  notePurchaseOrders: NotePurchaseOrder[],
  invoicePurchaseOrderNumber?: string,
  invoiceNumber?: string | null
): NotePurchaseOrder | undefined {
  if (notePurchaseOrders.some((po) => po.invoiceNumbers?.length || po.allInvoices)) {
    const normalizedInvoiceNumber = normalizeNoteInvoiceNumber(invoiceNumber);
    // A PO tied to this invoice's number beats one given to every invoice ("Invoice 101 goes to PO-111111. The
    // other invoices go to PO-222222.").
    const tiedToInvoice = notePurchaseOrders.filter(
      (po) => !po.rejected && normalizedInvoiceNumber && po.invoiceNumbers?.includes(normalizedInvoiceNumber)
    );
    const forInvoice = tiedToInvoice.length ? tiedToInvoice : notePurchaseOrders.filter((po) => !po.rejected && po.allInvoices);
    if (forInvoice.length !== 1) return undefined;
    if (normalizedInvoiceNumber) return forInvoice[0];
    const tiedToInvoices = notePurchaseOrders.filter((po) => !po.rejected && (po.allInvoices || po.invoiceNumbers?.length));
    return tiedToInvoices.length === 1 && forInvoice[0].allInvoices ? forInvoice[0] : undefined;
  }
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
