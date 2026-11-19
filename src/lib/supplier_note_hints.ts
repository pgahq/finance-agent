import type { DatabaseConnection } from './database.js';
import { htmlToText } from './html_text.js';
import { supplierNamesMatch } from './po_supplier.js';

/**
 * Supplier hints from the email context (subject, source email, and every
 * conversation part).
 *
 * Emails, notes, and replies often name the supplier explicitly (a name and/or
 * a Workday Supplier ID like S-001234). Only an exact supplier-cache match from
 * an Intercom conversation part is presented to the model as authoritative.
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

function normalizeName(raw: string): string | undefined {
  const cleaned = raw
    .replace(SUPPLIER_ID_PATTERN, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:\-–]+$/, '')
    .trim()
    .replace(/^<\s*(.*?)\s*>$/, '$1');
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
 * Looking up a Supplier ID named anywhere in a piece of text (an Intercom conversation, an email body, or
 * both joined together, such as `emailContext.plainTextBody`) and checking it against an expected name, so a
 * caller never has to re-implement the extraction, the cache lookup, and the name check separately. Never
 * guesses: more than one distinct Supplier ID in the text is `ambiguous` rather than picking one.
 */
export type SupplierIdFromTextResult =
  | { outcome: 'none' }
  | { outcome: 'ambiguous'; supplierIds: string[] }
  | { outcome: 'not_cached'; supplierId: string }
  | { outcome: 'name_mismatch'; supplierId: string; workdayId: string; supplierName: string }
  | { outcome: 'excluded'; supplierId: string; workdayId: string; supplierName: string }
  | { outcome: 'resolved'; supplierId: string; workdayId: string; supplierName: string };

export async function resolveSupplierIdFromText(
  db: DatabaseConnection,
  text: string | null | undefined,
  expectedName: string,
  options: { excludeWorkdayIds?: Array<string | undefined> } = {}
): Promise<SupplierIdFromTextResult> {
  const { supplierIds } = extractSupplierNoteHints(text);
  if (supplierIds.length === 0) return { outcome: 'none' };
  if (supplierIds.length > 1) return { outcome: 'ambiguous', supplierIds };

  const [supplierId] = supplierIds;
  const [hint] = await resolveSupplierIdHints(db, [supplierId]);
  if (!hint) return { outcome: 'not_cached', supplierId };

  if (!hint.supplierName || !supplierNamesMatch(expectedName, hint.supplierName)) {
    return { outcome: 'name_mismatch', supplierId, workdayId: hint.workdayId, supplierName: hint.supplierName ?? '' };
  }

  const excluded = new Set((options.excludeWorkdayIds ?? []).filter((id): id is string => Boolean(id)));
  if (excluded.has(hint.workdayId)) {
    return { outcome: 'excluded', supplierId, workdayId: hint.workdayId, supplierName: hint.supplierName };
  }

  return { outcome: 'resolved', supplierId, workdayId: hint.workdayId, supplierName: hint.supplierName };
}

/**
 * Prompt block appended after the email context. Empty when there are no hints.
 * Pass `resolved: undefined` when the cache lookup failed, so IDs are not reported as missing.
 * Only a match whose ID appears in `trustedSupplierIds` (Intercom conversation parts) may
 * override the invoice document; IDs seen only in the source or inbound email are candidates.
 */
export function formatSupplierNoteHintContext(
  hints: SupplierNoteHints,
  resolved: ResolvedSupplierHint[] | undefined,
  trustedSupplierIds: readonly string[] = []
): string {
  if (!hasSupplierNoteHints(hints)) return '';

  const lines: string[] = [];
  const resolvedIds = new Set((resolved ?? []).map((hint) => hint.supplierId));
  const trustedIds = new Set(trustedSupplierIds.map((id) => id.toUpperCase()));
  const distinctSuppliers = new Map((resolved ?? []).map((hint) => [hint.workdayId, hint]));
  const unresolvedIds = hints.supplierIds.filter((id) => !resolvedIds.has(id));
  const describe = (hint: ResolvedSupplierHint) =>
    `${hint.supplierId}${hint.supplierName ? ` (${hint.supplierName})` : ''}, workdayId ${hint.workdayId}`;
  const [singleMatch] = distinctSuppliers.size === 1 ? [...distinctSuppliers.values()] : [];
  const authoritative = Boolean(singleMatch)
    && unresolvedIds.length === 0
    && trustedIds.has(singleMatch.supplierId);

  if (authoritative) {
    lines.push(`An Intercom conversation note or reply names Workday supplier ${describe(singleMatch)}. This is an exact cached Supplier ID match: use this supplier as resolvedSupplier even when the invoice document suggests a different supplier.`);
  } else if (singleMatch && unresolvedIds.length > 0) {
    lines.push(`The email context names Workday supplier ${describe(singleMatch)}, but also mentions Supplier IDs that did not resolve. The hints are incomplete: do not override the invoice document; treat this supplier as a findSuppliers candidate only.`);
  } else if (singleMatch) {
    lines.push(`The inbound email names Workday supplier ${describe(singleMatch)}. The sender's own text is not authoritative: treat this supplier as a findSuppliers candidate only and do not override the invoice document.`);
  } else if (distinctSuppliers.size > 1) {
    const names = [...distinctSuppliers.values()].map(describe).join('; ');
    lines.push(`The email context names more than one Workday supplier: ${names}. Do not override the invoice document with one of them; report the supplier as ambiguous (or uncertain when verifying) and explain the conflict.`);
  }

  if (unresolvedIds.length > 0) {
    lines.push(resolved === undefined
      ? `The email context mentions Supplier ID ${unresolvedIds.join(', ')}, which could not be verified. Call findSuppliers with it and accept a result only when its Supplier ID matches exactly.`
      : `The email context mentions Supplier ID ${unresolvedIds.join(', ')}, which is not in the supplier cache. Do not treat it as a match.`);
  }

  const nameHints = authoritative ? [] : hints.supplierNames;
  for (const name of nameHints) {
    lines.push(`The email context names the supplier "${name}". Call findSuppliers with this name first and prefer a result whose name matches it.`);
  }

  return `\n\nSupplier hints from the email and conversation:\n${lines.map((line) => `- ${line}`).join('\n')}`;
}
