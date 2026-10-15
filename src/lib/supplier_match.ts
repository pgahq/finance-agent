import { debug } from '@pga/logger';
import { findDocumentsContainingWords, type DatabaseConnection } from './database.js';
import { nameTokens, supplierNamesMatch } from './po_supplier.js';

export interface SupplierRecord {
  supplierId?: string;
  supplierName: string;
  alternateNames: string[];
  addresses: string[];
  phones: string[];
  emails: string[];
}

type SupplierDocumentContent = { content?: string | null; metadata?: unknown };
type SupplierDocumentRow = SupplierDocumentContent & { workday_id: string };

function contentLine(content: string, label: string): string | undefined {
  return content.split('\n').find((row) => row.startsWith(`${label}:`))?.slice(label.length + 1).trim();
}

function metadataList(metadata: Record<string, unknown>, key: string): string[] | undefined {
  const value = metadata[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())) : undefined;
}

/**
 * Reads a cached supplier document into its full record. Rows cached since the list fields shipped carry exact
 * lists in metadata; older rows fall back to the comma-joined content lines, where only alternate names are split.
 */
export function supplierRecordFromDocument(row: SupplierDocumentContent): SupplierRecord {
  const content = row.content ?? '';
  const metadata = (row.metadata && typeof row.metadata === 'object' ? row.metadata : {}) as Record<string, unknown>;
  const fromContent = (label: string, split: boolean): string[] => {
    const line = contentLine(content, label);
    if (!line) return [];
    return split ? line.split(',').map((part) => part.trim()).filter(Boolean) : [line];
  };
  const supplierName = typeof metadata.supplierName === 'string' && metadata.supplierName
    ? metadata.supplierName
    : contentLine(content, 'Company Name') ?? '';
  const supplierId = typeof metadata.supplierId === 'string' && metadata.supplierId
    ? metadata.supplierId
    : contentLine(content, 'Supplier ID');
  return {
    ...(supplierId ? { supplierId } : {}),
    supplierName,
    alternateNames: metadataList(metadata, 'alternateNames') ?? fromContent('Alternate Names', true),
    addresses: metadataList(metadata, 'addresses') ?? fromContent('Address', false),
    phones: metadataList(metadata, 'phones') ?? fromContent('Phone', false),
    emails: metadataList(metadata, 'emails') ?? fromContent('Email', false),
  };
}

const LOCATION_LABEL = /^[A-Za-z][A-Za-z .'-]*,?\s+[A-Z]{2}$/;

function cleanName(value: string): string {
  return value
    .replace(/#\s*\w+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-,\s]+|[-,\s]+$/g, '');
}

/**
 * Company names a branch-style printed name could stand for. "Lindenhurst NY - All Pro Horticulture #433" gives
 * "All Pro Horticulture": store numbers and "City ST" location labels are dropped, and each remaining part is a candidate.
 */
export function printedSupplierNameCandidates(printedName: string | null | undefined): string[] {
  const whole = cleanName(printedName ?? '');
  if (!whole) return [];
  const segments = (printedName ?? '').split(/\s+[-–—]\s+|\s*\|\s*/).map(cleanName).filter(Boolean);
  const named = segments.length > 1 ? segments.filter((segment) => !LOCATION_LABEL.test(segment)) : segments;
  return [...new Set([...named, whole])];
}

/** The company name that leads a remit-to block ("SiteOne Landscape Supply, LLC, 24110 Network Place, ..."), before any street or PO Box. */
export function remitToCompanyName(remitToAddress: string | null | undefined): string | undefined {
  const parts = (remitToAddress ?? '').split(/[,\n]/).map((part) => part.trim()).filter(Boolean);
  const nameParts: string[] = [];
  for (const part of parts) {
    if (/\d/.test(part) || /^p\.?\s*o\.?\s*box\b/i.test(part)) break;
    nameParts.push(part);
  }
  return nameParts.length ? nameParts.join(', ') : undefined;
}

export interface SupplierNameEvidence {
  source: 'remit_to' | 'printed';
  name: string;
}

export interface SupplierNameMatch {
  workdayId: string;
  supplierName: string;
  supplierId?: string;
  evidence: string[];
}

/** Which cached suppliers each piece of name evidence equals, by primary name or any alternate name. */
export function matchSuppliersByName(
  evidence: SupplierNameEvidence[],
  documents: SupplierDocumentRow[]
): Map<string, SupplierNameMatch> {
  const matches = new Map<string, SupplierNameMatch>();
  for (const document of documents) {
    const record = supplierRecordFromDocument(document);
    for (const item of evidence) {
      const primary = record.supplierName && supplierNamesMatch(item.name, record.supplierName) ? record.supplierName : undefined;
      const alternate = primary ? undefined : record.alternateNames.find((name) => supplierNamesMatch(item.name, name));
      const matched = primary ?? alternate;
      if (!matched) continue;
      const label = item.source === 'remit_to' ? 'remit-to company' : 'printed name';
      const line = `${label} "${item.name}" matches ${primary ? 'supplier name' : 'alternate name'} "${matched}"`;
      const existing = matches.get(document.workday_id);
      if (existing) {
        existing.evidence.push(line);
      } else {
        matches.set(document.workday_id, {
          workdayId: document.workday_id,
          supplierName: record.supplierName,
          ...(record.supplierId ? { supplierId: record.supplierId } : {}),
          evidence: [line],
        });
      }
    }
  }
  return matches;
}

export interface SupplierNameLookupInput {
  printedName?: string | null;
  remitToAddress?: string | null;
  excludeWorkdayIds?: Array<string | undefined>;
}

/**
 * Finds the one cached supplier that the remit-to company or the printed name equals by name or alternate name,
 * even when the printed branch address and phone are not on the record. Never guesses: any name that matches
 * two suppliers, or evidence that points at different suppliers, returns undefined.
 */
export async function findUniqueSupplierByNameEvidence(
  db: DatabaseConnection,
  input: SupplierNameLookupInput
): Promise<SupplierNameMatch | undefined> {
  const remitTo = remitToCompanyName(input.remitToAddress);
  const evidence: SupplierNameEvidence[] = [
    ...(remitTo ? [{ source: 'remit_to' as const, name: remitTo }] : []),
    ...printedSupplierNameCandidates(input.printedName).map((name) => ({ source: 'printed' as const, name })),
  ].filter((item) => nameTokens(item.name).size >= 2);
  if (evidence.length === 0) return undefined;

  const excluded = new Set((input.excludeWorkdayIds ?? []).filter((id): id is string => Boolean(id)));
  const candidates = new Map<string, SupplierDocumentRow>();
  for (const item of evidence) {
    const rows = await findDocumentsContainingWords(db, 'supplier', [...nameTokens(item.name)]);
    for (const row of rows) candidates.set(row.workday_id, row);
  }

  const matches = [...matchSuppliersByName(evidence, [...candidates.values()]).values()]
    .filter((match) => !excluded.has(match.workdayId));
  debug('Supplier name evidence lookup', {
    evidence,
    matched: matches.map((match) => ({ workdayId: match.workdayId, supplierId: match.supplierId, supplierName: match.supplierName })),
  });
  return matches.length === 1 ? matches[0] : undefined;
}
