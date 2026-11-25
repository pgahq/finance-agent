// Deterministic event matching. The event cache holds only a name per event, and names carry the year and,
// for a section's own copy of an event, a section code ("26ZB-Lakeside_Jr_Skills_Series"). Embedding
// similarity cannot tell "26" from "2026" or "Jr." from "Junior", and ties among substring hits fall back to
// WID order, so the year, section, and wording are compared here instead.

export type EventMatchTier = 'exact' | 'contains' | 'semantic';

export interface ParsedEventText {
  year: number | null;
  sectionCode: string | null;
  tokens: string[];
}

export interface EventCandidate {
  workdayId: string;
  name: string;
  similarity?: number;
}

export type RankedEvent<T extends EventCandidate = EventCandidate> = T & {
  tier: EventMatchTier;
  year: number | null;
  sectionCode: string | null;
};

export interface EventRanking<T extends EventCandidate = EventCandidate> {
  queryYear: number | null;
  querySectionCode: string | null;
  ranked: Array<RankedEvent<T>>;
  /** The single best event, or null when no event stands alone as the best. */
  recommended: RankedEvent<T> | null;
  /** Events tied for best on an exact or contains match; never broken by WID order. */
  ambiguous: Array<RankedEvent<T>>;
}

const ABBREVIATIONS: Record<string, string> = {
  jr: 'junior',
  sr: 'senior',
  intl: 'international',
  natl: 'national',
  assoc: 'association',
  champ: 'championship',
  champs: 'championship',
  tourney: 'tournament',
  conf: 'conference',
  invit: 'invitational',
};

const STOPWORDS = new Set(['the', 'of', 'and']);

const CACHED_SECTION_PREFIX = /^\s*(\d{4}|\d{2})([A-Za-z]{2,5})\s*-\s*/;
const YEAR_WITH_SECTION = /^(\d{4}|\d{2})([A-Z]{2,5})$/;
const FISCAL_YEAR = /^fy(\d{4}|\d{2})$/i;
const MIN_YEAR = 2000;
const MAX_YEAR = 2099;
// A bare two-digit number is read as a year only in this range, so "Top 18" or "Hole 9" stays a word.
const MIN_TWO_DIGIT_YEAR = 20;
const MAX_TWO_DIGIT_YEAR = 39;

function expandYear(digits: string): number | null {
  const value = Number(digits);
  if (digits.length === 4) return value >= MIN_YEAR && value <= MAX_YEAR ? value : null;
  return value >= MIN_TWO_DIGIT_YEAR && value <= MAX_TWO_DIGIT_YEAR ? 2000 + value : null;
}

function sectionPrefixOf(text: string): { year: number; sectionCode: string; length: number } | null {
  const prefix = CACHED_SECTION_PREFIX.exec(text);
  const year = prefix ? expandYear(prefix[1]) : null;
  return prefix && year != null ? { year, sectionCode: prefix[2].toUpperCase(), length: prefix[0].length } : null;
}

function rawTokens(text: string): string[] {
  return text.replace(/['’`]/g, '').split(/[^A-Za-z0-9]+/).filter(Boolean);
}

function wordToken(raw: string): string | null {
  const lower = raw.toLowerCase();
  const word = ABBREVIATIONS[lower] ?? lower;
  return STOPWORDS.has(word) ? null : word;
}

/**
 * Splits event text into a year, a section code, and normalized words. `knownSectionCodes` (uppercase) are the
 * codes the cache uses; an email names a section only by writing one of them (as "26ZB" or as an uppercase
 * "ZB"), so ordinary words are never read as sections.
 */
export function parseEventText(text: string, knownSectionCodes: ReadonlySet<string> = new Set()): ParsedEventText {
  let year: number | null = null;
  let sectionCode: string | null = null;
  let body = text;

  const prefix = sectionPrefixOf(text);
  if (prefix) {
    year = prefix.year;
    sectionCode = prefix.sectionCode;
    body = text.slice(prefix.length);
  }

  const raws = rawTokens(body);
  const isSectionWord = (raw: string) => /^[A-Z]{2,5}$/.test(raw) && knownSectionCodes.has(raw);
  const lastWordIndex = raws.length - 1 - [...raws].reverse().findIndex(raw => !isSectionWord(raw));
  const words: Array<{ raw: string; index: number }> = [];
  let twoDigit: { index: number; year: number } | null = null;

  for (const [index, raw] of raws.entries()) {
    const fiscal = FISCAL_YEAR.exec(raw);
    if (fiscal) {
      year ??= expandYear(fiscal[1]);
      continue;
    }
    if (/^\d{4}$/.test(raw)) {
      const parsed = expandYear(raw);
      if (parsed != null) {
        year ??= parsed;
        continue;
      }
    }
    const attached = YEAR_WITH_SECTION.exec(raw);
    if (attached && knownSectionCodes.has(attached[2])) {
      const parsed = expandYear(attached[1]);
      if (parsed != null) {
        year ??= parsed;
        sectionCode ??= attached[2];
        continue;
      }
    }
    if (!sectionCode && isSectionWord(raw)) {
      sectionCode = raw;
      continue;
    }
    if (/^\d{2}$/.test(raw) && (index === 0 || index === lastWordIndex)) {
      const parsed = expandYear(raw);
      if (parsed != null) twoDigit = { index, year: parsed };
    }
    words.push({ raw, index });
  }

  const yearIndex = twoDigit && year == null ? twoDigit.index : null;
  if (twoDigit && year == null) year = twoDigit.year;

  const tokens: string[] = [];
  for (const { raw, index } of words) {
    if (yearIndex != null && index === yearIndex) continue;
    const word = wordToken(raw);
    if (word) tokens.push(word);
  }
  return { year, sectionCode, tokens };
}

export function eventNameOf(document: { content?: string | null; metadata?: unknown }): string {
  const metadata = document.metadata;
  if (metadata && typeof metadata === 'object') {
    const name = (metadata as Record<string, unknown>).name;
    if (typeof name === 'string' && name.trim()) return name.trim();
  }
  return (document.content ?? '').replace(/^\s*Event Name:\s*/i, '').trim();
}

export function knownSectionCodesOf(names: readonly string[]): Set<string> {
  const codes = new Set<string>();
  for (const name of names) {
    const prefix = sectionPrefixOf(name);
    if (prefix) codes.add(prefix.sectionCode);
  }
  return codes;
}

function isSubset(needle: readonly string[], haystack: ReadonlySet<string>): boolean {
  return needle.every((token) => haystack.has(token));
}

interface Gate {
  queryYear: number | null;
  querySectionCode: string | null;
}

function passesGates(gate: Gate, event: ParsedEventText): boolean {
  if (gate.queryYear != null && event.year != null && event.year !== gate.queryYear) return false;
  return gate.querySectionCode ? event.sectionCode === gate.querySectionCode : event.sectionCode == null;
}

/**
 * The cache has no uniqueness guarantee on (type, workday_id). A repeated row with the same normalized name is
 * one event; a WID whose rows disagree on the name cannot be trusted, so it is dropped rather than letting row
 * order choose. A row with no WID or no name cannot be matched.
 */
function usableCandidates<T extends EventCandidate>(candidates: readonly T[]): T[] {
  const byWorkdayId = new Map<string, T[]>();
  for (const candidate of candidates) {
    if (!candidate.workdayId?.trim() || !candidate.name?.trim()) continue;
    byWorkdayId.set(candidate.workdayId, [...(byWorkdayId.get(candidate.workdayId) ?? []), candidate]);
  }
  const key = (candidate: EventCandidate) => JSON.stringify(parseEventText(candidate.name));
  return [...byWorkdayId.values()].flatMap((rows) => (rows.every((row) => key(row) === key(rows[0])) ? [rows[0]] : []));
}

const TIER_ORDER: Record<EventMatchTier, number> = { exact: 0, contains: 1, semantic: 2 };

/**
 * Ranks cached events for the event text an email names. An event qualifies only if its year does not
 * contradict a year the email names and it is the main event unless the email names that event's section. Among
 * those, an event for the preferred year (the email's, else `preferredYear`) beats other years, and then an event
 * whose words equal the email's beats one that adds words. A repeated WID counts once. Events with similarity and no word match rank last by
 * similarity and are never recommended on their own.
 */
export function rankEventCandidates<T extends EventCandidate>(
  query: string,
  candidates: readonly T[],
  options: { preferredYear?: number | null } = {}
): EventRanking<T> {
  const usable = usableCandidates(candidates);
  const known = knownSectionCodesOf(usable.map((candidate) => candidate.name));
  const parsedQuery = parseEventText(query, known);
  const gate: Gate = { queryYear: parsedQuery.year, querySectionCode: parsedQuery.sectionCode };
  const wantedYear = parsedQuery.year ?? options.preferredYear ?? null;
  const queryTokens = new Set(parsedQuery.tokens);

  const entries = usable.flatMap((candidate) => {
    const parsed = parseEventText(candidate.name, known);
    if (!passesGates(gate, parsed)) return [];
    const eventTokens = new Set(parsed.tokens);
    let tier: EventMatchTier | null = null;
    if (queryTokens.size > 0 && isSubset([...queryTokens], eventTokens)) {
      tier = eventTokens.size === queryTokens.size ? 'exact' : 'contains';
    } else if (candidate.similarity != null) {
      tier = 'semantic';
    }
    if (!tier) return [];
    return [{
      event: { ...candidate, tier, year: parsed.year, sectionCode: parsed.sectionCode } as RankedEvent<T>,
      yearRank: wantedYear != null && parsed.year === wantedYear ? 0 : 1,
      extra: eventTokens.size - queryTokens.size,
    }];
  });

  entries.sort((left, right) => (
    Number(left.event.tier === 'semantic') - Number(right.event.tier === 'semantic')
    || left.yearRank - right.yearRank
    || TIER_ORDER[left.event.tier] - TIER_ORDER[right.event.tier]
    || (left.event.tier === 'semantic' ? 0 : left.extra - right.extra)
    || (right.event.similarity ?? 0) - (left.event.similarity ?? 0)
    || left.event.name.localeCompare(right.event.name)
  ));

  const ranked = entries.map((entry) => entry.event);
  const best = entries[0];
  let recommended: RankedEvent<T> | null = null;
  let ambiguous: Array<RankedEvent<T>> = [];
  if (best && best.event.tier !== 'semantic') {
    const tied = entries.filter((entry) => (
      entry.event.tier === best.event.tier && entry.yearRank === best.yearRank && entry.extra === best.extra
    )).map((entry) => entry.event);
    if (tied.length === 1) recommended = tied[0];
    else ambiguous = tied;
  }
  return { queryYear: gate.queryYear, querySectionCode: gate.querySectionCode, ranked, recommended, ambiguous };
}

export interface EventCoding {
  extracted: string | null;
  workdayId: string | null;
}

/** What `resolveEventCoding` adds to the model's event coding; the model schema does not carry these. */
export interface EventResolutionFields {
  name?: string | null;
  ambiguousNames?: string[];
}

export function eventResolutionOf(event: EventCoding | null | undefined): EventResolutionFields {
  return (event ?? {}) as EventResolutionFields;
}

/**
 * Checks the event the model resolved against the cached events. A single exact or contains word match for the
 * email's text replaces the model's pick; a tie, or a pick that contradicts the email's year or section, leaves
 * the event unresolved; a pick the rules do not contradict stays.
 */
export function resolveEventCoding<E extends EventCoding>(
  event: E | null | undefined,
  events: readonly EventCandidate[],
  options: { preferredYear?: number | null } = {}
): (E & EventResolutionFields) | E | null | undefined {
  if (!event) return event;
  const text = event.extracted?.trim();
  if (!text) return event.workdayId ? { ...event, workdayId: null } : event;

  const ranking = rankEventCandidates(text, events, options);
  if (ranking.recommended) {
    return { ...event, workdayId: ranking.recommended.workdayId, name: ranking.recommended.name };
  }
  if (ranking.ambiguous.length > 0) {
    return { ...event, workdayId: null, ambiguousNames: ranking.ambiguous.map((candidate) => candidate.name) };
  }
  if (!event.workdayId) return event;

  const usable = usableCandidates(events);
  const chosen = usable.find((candidate) => candidate.workdayId === event.workdayId);
  return chosen && isCompatible(text, chosen, usable)
    ? { ...event, name: chosen.name }
    : { ...event, workdayId: null };
}

function isCompatible(query: string, chosen: EventCandidate, events: readonly EventCandidate[]): boolean {
  const known = knownSectionCodesOf(events.map((candidate) => candidate.name));
  const parsedQuery = parseEventText(query, known);
  return passesGates({ queryYear: parsedQuery.year, querySectionCode: parsedQuery.sectionCode }, parseEventText(chosen.name, known));
}
