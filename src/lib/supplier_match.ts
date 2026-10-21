import { debug } from '@pga/logger';
import { findDocumentsContainingWords, findSuppliersByNameWord, type DatabaseConnection } from './database.js';
import { nameTokens, namesShareToken, supplierNamesMatch } from './po_supplier.js';

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
  const named = segments.filter((segment) => !LOCATION_LABEL.test(segment));
  // Only a dropped location label shows the printed name is "branch - company"; any other " - " part, such as
  // "Pinehurst Resort - Pro Shop", is just part of the name and must not stand alone.
  const hasBranchLabel = segments.length > 1 && named.length < segments.length;
  return [...new Set([...(hasBranchLabel ? named : []), whole])];
}

/** The company name that leads a remit-to block ("SiteOne Landscape Supply, LLC, 24110 Network Place, ..."), before any street or PO Box. */
export function remitToCompanyName(remitToAddress: string | null | undefined): string | undefined {
  const parts = (remitToAddress ?? '').split(/[,\n]/).map((part) => part.trim()).filter(Boolean);
  const nameParts: string[] = [];
  for (const part of parts) {
    if (/\d/.test(part) || /^p\.?\s*o\.?\s*box\b/i.test(part)) {
      // "New York, NY 10001" has no payee name: the part before a state and ZIP is the city.
      if (/^[A-Z]{2}(\s*\d{5}\b|$)/.test(part)) nameParts.pop();
      break;
    }
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
  sources: Array<SupplierNameEvidence['source']>;
  recordNames: string[];
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
        if (!existing.sources.includes(item.source)) existing.sources.push(item.source);
      } else {
        matches.set(document.workday_id, {
          workdayId: document.workday_id,
          supplierName: record.supplierName,
          ...(record.supplierId ? { supplierId: record.supplierId } : {}),
          evidence: [line],
          sources: [item.source],
          recordNames: [record.supplierName, ...record.alternateNames],
        });
      }
    }
  }
  return matches;
}

/** Candidate rows read per name. A full page may hide another supplier with the same name, so it is never treated as unique. */
export const SUPPLIER_CANDIDATE_LIMIT = 200;

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
  let truncated = false;
  for (const item of evidence) {
    const rows = await findDocumentsContainingWords(db, 'supplier', [...nameTokens(item.name)], SUPPLIER_CANDIDATE_LIMIT);
    if (rows.length >= SUPPLIER_CANDIDATE_LIMIT) truncated = true;
    for (const row of rows) candidates.set(row.workday_id, row);
  }

  // A remit-to payee is often a factoring company or bank lockbox, so a remit-to-only match must also share a
  // distinctive word with the printed supplier name.
  const printedName = cleanName(input.printedName ?? '');
  const matches = [...matchSuppliersByName(evidence, [...candidates.values()]).values()]
    .filter((match) => !excluded.has(match.workdayId));
  const [only] = matches;
  const confirmed = !truncated && matches.length === 1 && only
    && (only.sources.includes('printed') || (printedName !== '' && namesShareToken([printedName], only.recordNames)))
    ? only
    : undefined;
  debug('Supplier name evidence lookup', {
    evidence,
    truncated,
    matched: matches.map((match) => ({ workdayId: match.workdayId, supplierId: match.supplierId, supplierName: match.supplierName })),
    accepted: confirmed?.workdayId,
  });
  return confirmed;
}

/**
 * Words too common in supplier names to identify a business on their own. The cache counts decide first (a word on
 * many suppliers is never distinctive); this list is a backstop for a sparse or lagging cache.
 */
const GENERIC_NAME_WORDS = new Set([
  'golf', 'club', 'clubs', 'country', 'course', 'courses', 'links', 'resort', 'resorts', 'pro', 'shop', 'shops',
  'car', 'cars', 'cart', 'carts', 'rental', 'rentals', 'sales', 'service', 'services', 'supply', 'supplies',
  'equipment', 'landscape', 'landscaping', 'turf', 'products', 'systems', 'solutions', 'associates', 'association',
  'society', 'national', 'american', 'united', 'first', 'new', 'north', 'south', 'east', 'west', 'central',
  'rocky', 'mountain', 'mountains', 'valley', 'lake', 'river', 'pacific', 'atlantic', 'southern', 'northern',
  'eastern', 'western', 'texas', 'florida', 'carolina', 'california', 'mexico', 'arizona', 'colorado',
]);

const MIN_DISTINCTIVE_WORD_LENGTH = 4;

/** A word found in this many supplier names is common, however distinctive it looks. */
export const DISTINCTIVE_WORD_SUPPLIER_LIMIT = 25;

/** A shared word is worth listing for AP only while it narrows the field to a handful of suppliers. */
const MAX_LISTED_PER_WORD = 5;
export const MAX_POSSIBLE_SUPPLIERS = 5;

export interface PossibleSupplier {
  workdayId: string;
  supplierId?: string;
  supplierName: string;
  reason: string;
}

export interface DistinctiveWordLookup {
  match?: SupplierNameMatch;
  possible: PossibleSupplier[];
}

/** The words of the printed name that could identify a business: not a legal suffix, generic term, or short fragment. */
export function distinctiveNameWords(printedName: string | null | undefined): string[] {
  const words = new Set<string>();
  const candidates = printedSupplierNameCandidates(printedName);
  // With a branch label the last candidate is the whole printed name, whose city label is not a business word.
  for (const candidate of candidates.length > 1 ? candidates.slice(0, -1) : candidates) {
    for (const token of nameTokens(candidate)) {
      if (token.length >= MIN_DISTINCTIVE_WORD_LENGTH && !/^\d+$/.test(token) && !GENERIC_NAME_WORDS.has(token)) words.add(token);
    }
  }
  return [...words];
}

/**
 * Finds the one cached supplier a distinctive word of the printed name points to, even when the rest of the
 * printed name, the address, and the phone differ from the record. A word counts only when it appears as a whole
 * word in the names of fewer than DISTINCTIVE_WORD_SUPPLIER_LIMIT suppliers, and it picks a supplier only when
 * that word is on exactly one supplier and no other supplier matches as many printed words. Anything less never
 * guesses: the suppliers that share a word come back as possible matches for AP to review.
 */
export async function findSupplierByDistinctiveWord(
  db: DatabaseConnection,
  input: { printedName?: string | null; excludeWorkdayIds?: Array<string | undefined> }
): Promise<DistinctiveWordLookup> {
  const words = distinctiveNameWords(input.printedName);
  if (words.length === 0) return { possible: [] };

  const excluded = new Set((input.excludeWorkdayIds ?? []).filter((id): id is string => Boolean(id)));
  const suppliers = new Map<string, { record: SupplierRecord; words: Set<string>; uniqueWords: Set<string>; narrowWords: Set<string> }>();
  const commonWords: string[] = [];

  for (const word of words) {
    const fetched = await findSuppliersByNameWord(db, word, DISTINCTIVE_WORD_SUPPLIER_LIMIT);
    if (fetched.length >= DISTINCTIVE_WORD_SUPPLIER_LIMIT) {
      commonWords.push(word);
      continue;
    }
    const rows = fetched.filter((row) => !excluded.has(row.workday_id));
    for (const row of rows) {
      const entry = suppliers.get(row.workday_id) ?? { record: supplierRecordFromDocument(row), words: new Set(), uniqueWords: new Set(), narrowWords: new Set() };
      entry.words.add(word);
      if (fetched.length === 1) entry.uniqueWords.add(word);
      if (fetched.length <= MAX_LISTED_PER_WORD) entry.narrowWords.add(word);
      suppliers.set(row.workday_id, entry);
    }
  }

  const ranked = [...suppliers.entries()].sort((a, b) => b[1].words.size - a[1].words.size);
  const withUniqueWord = ranked.filter(([, entry]) => entry.uniqueWords.size > 0);
  const [top, runnerUp] = ranked;
  const pickedEntry = withUniqueWord.length === 1 && top && top[0] === withUniqueWord[0]?.[0]
    && (!runnerUp || top[1].words.size > runnerUp[1].words.size)
    ? top
    : undefined;

  const possible = ranked
    .filter(([, entry]) => entry.narrowWords.size > 0)
    .slice(0, MAX_POSSIBLE_SUPPLIERS)
    .map(([workdayId, entry]): PossibleSupplier => ({
      workdayId,
      ...(entry.record.supplierId ? { supplierId: entry.record.supplierId } : {}),
      supplierName: entry.record.supplierName,
      reason: `name has ${[...entry.narrowWords].map((word) => `"${word.toUpperCase()}"`).join(', ')}`,
    }));

  debug('Supplier distinctive word lookup', {
    words,
    commonWords,
    suppliers: ranked.map(([workdayId, entry]) => ({
      workdayId,
      supplierId: entry.record.supplierId,
      supplierName: entry.record.supplierName,
      words: [...entry.words],
      uniqueWords: [...entry.uniqueWords],
    })),
    accepted: pickedEntry?.[0],
  });

  if (!pickedEntry) return { possible };
  const [workdayId, entry] = pickedEntry;
  const printedName = cleanName(input.printedName ?? '');
  const matchedWords = [...entry.uniqueWords].map((word) => `"${word.toUpperCase()}"`).join(', ');
  return {
    match: {
      workdayId,
      supplierName: entry.record.supplierName,
      ...(entry.record.supplierId ? { supplierId: entry.record.supplierId } : {}),
      evidence: [`printed name "${printedName}" has the distinctive word ${matchedWords}, which only this supplier's name or alternate name has`],
      sources: ['printed'],
      recordNames: [entry.record.supplierName, ...entry.record.alternateNames],
    },
    possible,
  };
}
