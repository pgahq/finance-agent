import type { DatabaseConnection } from './database.js';

/**
 * Supplier hints from the Intercom conversation thread.
 *
 * Notes and replies often name the supplier explicitly (a name and/or a
 * Workday Supplier ID like S-001234). Every conversation part is scanned, but
 * not the source email, and only IDs that exact-match the supplier cache are
 * presented to the model as authoritative.
 */

export interface SupplierNoteHints {
  supplierIds: string[];
  supplierNames: string[];
}

export interface ResolvedSupplierHint {
  supplierId: string;
  workdayId: string;
  supplierName?: string;
}

const SUPPLIER_ID_PATTERN = /\bS-\d{4,6}\b/gi;
const LABELED_NAME_PATTERN = /^[ \t]*(?:supplier|vendor)(?:[ \t]*:|[ \t]+[-–])[ \t]*(.+?)[ \t]*$/gim;
const MAX_NAME_LENGTH = 120;

function htmlToText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li)>/gi, '\n')
    .replace(/<[^>]{1,200}>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function normalizeName(raw: string): string | undefined {
  const cleaned = raw
    .replace(SUPPLIER_ID_PATTERN, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:\-–]+$/, '')
    .trim();
  if (cleaned.length < 2 || cleaned.length > MAX_NAME_LENGTH) return undefined;
  return cleaned;
}

export function extractSupplierNoteHints(
  ...texts: Array<string | null | undefined>
): SupplierNoteHints {
  const supplierIds = new Set<string>();
  const supplierNames = new Set<string>();

  for (const raw of texts) {
    if (!raw) continue;
    const text = htmlToText(raw);
    for (const match of text.matchAll(SUPPLIER_ID_PATTERN)) {
      supplierIds.add(match[0].toUpperCase());
    }
    for (const match of text.matchAll(LABELED_NAME_PATTERN)) {
      const name = normalizeName(match[1]);
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

export async function resolveSupplierIdHints(
  db: DatabaseConnection,
  supplierIds: string[]
): Promise<ResolvedSupplierHint[]> {
  if (supplierIds.length === 0) return [];
  const rows = await db.query(
    `SELECT workday_id, metadata
     FROM documents
     WHERE type = 'supplier'
       AND UPPER(metadata->>'supplierId') = ANY($1::text[])`,
    [supplierIds.map((id) => id.toUpperCase())]
  ) as Array<{ workday_id: string; metadata?: { supplierId?: string; supplierName?: string } }>;

  return rows
    .filter((row) => row.workday_id && row.metadata?.supplierId)
    .map((row) => ({
      supplierId: row.metadata!.supplierId!.toUpperCase(),
      workdayId: row.workday_id,
      ...(row.metadata?.supplierName ? { supplierName: row.metadata.supplierName } : {}),
    }));
}

/**
 * Prompt block appended after the email context. Empty when there are no hints.
 * Pass `resolved: undefined` when the cache lookup failed, so IDs are not reported as missing.
 */
export function formatSupplierNoteHintContext(
  hints: SupplierNoteHints,
  resolved: ResolvedSupplierHint[] | undefined
): string {
  if (!hasSupplierNoteHints(hints)) return '';

  const lines: string[] = [];
  const resolvedIds = new Set((resolved ?? []).map((hint) => hint.supplierId));
  const distinctSuppliers = new Map((resolved ?? []).map((hint) => [hint.workdayId, hint]));
  const unresolvedIds = hints.supplierIds.filter((id) => !resolvedIds.has(id));
  const describe = (hint: ResolvedSupplierHint) =>
    `${hint.supplierId}${hint.supplierName ? ` (${hint.supplierName})` : ''}, workdayId ${hint.workdayId}`;
  const authoritative = distinctSuppliers.size === 1 && unresolvedIds.length === 0;

  if (authoritative) {
    const [hint] = [...distinctSuppliers.values()];
    lines.push(`The conversation names Workday supplier ${describe(hint)}. This is an exact cached Supplier ID match: use this supplier as resolvedSupplier even when the invoice document suggests a different supplier.`);
  } else if (distinctSuppliers.size === 1) {
    const [hint] = [...distinctSuppliers.values()];
    lines.push(`The conversation names Workday supplier ${describe(hint)}, but also mention Supplier IDs that did not resolve. The hints are incomplete: do not override the invoice document; treat this supplier as a findSuppliers candidate only.`);
  } else if (distinctSuppliers.size > 1) {
    const names = [...distinctSuppliers.values()].map(describe).join('; ');
    lines.push(`The conversation names more than one Workday supplier: ${names}. Do not override the invoice document with one of them; report the supplier as ambiguous (or uncertain when verifying) and explain the conflict.`);
  }

  if (unresolvedIds.length > 0) {
    lines.push(resolved === undefined
      ? `The conversation mentions Supplier ID ${unresolvedIds.join(', ')}, which could not be verified. Call findSuppliers with it and accept a result only when its Supplier ID matches exactly.`
      : `The conversation mentions Supplier ID ${unresolvedIds.join(', ')}, which is not in the supplier cache. Do not treat it as a match.`);
  }

  const nameHints = authoritative ? [] : hints.supplierNames;
  for (const name of nameHints) {
    lines.push(`The conversation names the supplier "${name}". Call findSuppliers with this name first and prefer a result whose name matches it.`);
  }

  return `\n\nSupplier hints from the conversation thread:\n${lines.map((line) => `- ${line}`).join('\n')}`;
}
