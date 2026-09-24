/**
 * Supplier hints from the Intercom conversation thread.
 *
 * AP staff add notes naming the supplier explicitly (a name and/or a Workday
 * Supplier ID like S-001234). Notes are merged into the enrichment email body,
 * but the model needs an explicit, authoritative signal to prefer them over
 * its own guess from the invoice PDF.
 */

export interface SupplierNoteHints {
  supplierIds: string[];
  supplierNames: string[];
}

const SUPPLIER_ID_PATTERN = /\bS-[A-Za-z0-9]{4,6}\b/g;
const LABELED_NAME_PATTERN = /^\s*(?:supplier|vendor)\s*[:-]\s*(.+?)\s*$/gim;
const MAX_NAME_LENGTH = 120;

function normalizeId(raw: string): string {
  return raw.trim().toUpperCase();
}

function normalizeName(raw: string): string | undefined {
  const cleaned = raw.replace(/\s+/g, ' ').trim().replace(/[.,;:]+$/, '').trim();
  if (cleaned.length < 2 || cleaned.length > MAX_NAME_LENGTH) return undefined;
  if (/^s-[a-z0-9]{4,6}$/i.test(cleaned)) return undefined;
  return cleaned;
}

export function extractSupplierNoteHints(
  ...texts: Array<string | null | undefined>
): SupplierNoteHints {
  const supplierIds = new Set<string>();
  const supplierNames = new Set<string>();

  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(SUPPLIER_ID_PATTERN)) {
      supplierIds.add(normalizeId(match[0]));
    }
    for (const match of text.matchAll(LABELED_NAME_PATTERN)) {
      const name = normalizeName(match[1] ?? '');
      if (name) supplierNames.add(name);
    }
  }

  return {
    supplierIds: [...supplierIds],
    supplierNames: [...supplierNames],
  };
}

export function hasSupplierNoteHints(hints: SupplierNoteHints): boolean {
  return hints.supplierIds.length > 0 || hints.supplierNames.length > 0;
}

/** Prompt block appended after the email context. Empty when there are no hints. */
export function formatSupplierNoteHintContext(hints: SupplierNoteHints): string {
  if (!hasSupplierNoteHints(hints)) return '';
  const lines = [
    ...hints.supplierIds.map((id) => `- Supplier ID: ${id}`),
    ...hints.supplierNames.map((name) => `- Supplier name: ${name}`),
  ];
  return `\n\nThe conversation thread explicitly names this supplier (AP note or email — treat as authoritative over the invoice PDF):\n${lines.join('\n')}\nCall findSuppliers with the hinted ID or name first. If the hinted supplier resolves in Workday, use it even when the invoice document suggests a different supplier.`;
}
