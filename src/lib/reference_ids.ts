import { debug } from '@pga/logger';
import { tool } from 'ai';
import { z } from 'zod';
import {
  findDocumentsByReferenceId,
  findDocumentsByReferenceIds,
  getDatabaseConnection,
  searchDocumentsByTypes,
  type DatabaseConnection,
  type DocumentType,
} from './database.js';
import {
  adjustCostCenterSimilarity,
  isDoNotUseCostCenterFields,
  shouldSkipDoNotUseTieBreak,
} from './cost_center_match.js';
import { createEmbedding } from './rag.js';
import { htmlToText } from './html_text.js';
import { CODING_LINE_KEYWORD } from './email_coding_text.js';

export const REFERENCE_CODE_DOCUMENT_TYPES = [
  'company',
  'cost_center',
  'fund',
  'lob',
  'spend_category',
] as const satisfies readonly DocumentType[];

export interface CachedReferenceMatch {
  type: DocumentType;
  workdayId: string;
  referenceId: string;
  name?: string;
  confidence: number;
}

export const MIN_REFERENCE_MATCH_CONFIDENCE = 0.55;
const MIN_TOP_MATCH_MARGIN = 0.05;
export const MAX_INEXACT_REFERENCE_LOOKUPS = 4;

/** `code`: an explicit company code in the email. `name`: a company the email names without a code. */
export type EmailCompanyOrigin = 'code' | 'name';

export interface EmailCompanyMatch {
  workdayId?: string;
  referenceId?: string;
  name?: string;
  origin?: EmailCompanyOrigin;
}

function isCalendarYearToken(code: string): boolean {
  return /^(19|20)\d{2}$/.test(code);
}

function isCurrencyAmountFragment(text: string, index: number, token: string): boolean {
  const before = index > 0 ? text[index - 1] : '';
  const after = text[index + token.length] ?? '';
  const beforePrev = index > 1 ? text[index - 2] : '';
  const afterNext = text[index + token.length + 1] ?? '';
  if (before === '$' || before === '€' || before === '£') return true;
  if ((before === '.' || before === ',') && /\d/.test(beforePrev)) return true;
  if ((after === '.' || after === ',') && /\d/.test(afterNext)) return true;
  return false;
}

function isPostalCodeFragment(text: string, index: number, token: string): boolean {
  if (token.length === 5 && /^-\d{4}\b/.test(text.slice(index + token.length))) return true;
  if (token.length === 4 && index >= 6 && /^\d{5}-$/.test(text.slice(index - 6, index))) return true;
  return false;
}

function isPhoneNumberFragment(text: string, index: number, token: string): boolean {
  const windowStart = Math.max(0, index - 12);
  const window = text.slice(windowStart, index + token.length + 12).replace(/[()]/g, '');
  return /\d{3}[-.\s]\d{3}[-.\s]\d{4}/.test(window);
}

const US_STATE_ABBREVIATIONS = new Set(
  'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ')
);

const STREET_SUFFIX = '(?:street|st|road|rd|avenue|ave|av|boulevard|blvd|drive|dr|lane|ln|way|parkway|pkwy|pky|court|ct|circle|cir|place|pl|highway|hwy|trail|trl|terrace|ter|square|sq|plaza|plz|loop|pike|turnpike)';
const STREET_AFTER_NUMBER = new RegExp(String.raw`^[ \t]+(?:[A-Za-z0-9.'&-]+[ \t]+){0,3}?${STREET_SUFFIX}\b`, 'i');
const UNIT_BEFORE_NUMBER = /\b(?:suite|ste|unit|apt|apartment|floor|fl|room|rm|bldg|building|box|branch|ext|extension)\.?[ \t]*#?[ \t]*$/i;

function isStreetAddressFragment(text: string, index: number, token: string): boolean {
  if (STREET_AFTER_NUMBER.test(text.slice(index + token.length))) return true;
  return UNIT_BEFORE_NUMBER.test(text.slice(Math.max(0, index - 16), index));
}

function isZipFragment(text: string, index: number, token: string): boolean {
  if (token.length !== 5) return false;
  const before = text.slice(Math.max(0, index - 4), index);
  const state = /\b([A-Z]{2})[ \t]+$/.exec(before)?.[1];
  if (state && US_STATE_ABBREVIATIONS.has(state)) return true;
  return /^[ \t]*(?:USA|US|United States)\b/.test(text.slice(index + token.length));
}

const CARD_DIGITS_BEFORE_NUMBER = /(?:\bending(?:[ \t]+in)?|\blast[ \t]+(?:4|four)(?:[ \t]+digits)?(?:[ \t]+of)?|[x*•]{2,})[ \t]*:?[ \t]*$/i;

function isIdentifierOrStatusFragment(text: string, index: number, token: string): boolean {
  if (CARD_DIGITS_BEFORE_NUMBER.test(text.slice(Math.max(0, index - 24), index))) return true;
  if (/^[-_][A-Za-z]/.test(text.slice(index + token.length))) return true;
  if (index >= 2 && /[-_]/.test(text[index - 1]) && /[A-Za-z]/.test(text[index - 2])) return true;
  return /^[ \t]+\d\.\d\.\d/.test(text.slice(index + token.length));
}

export function extractReferenceCodeCandidates(text: string): string[] {
  const tokens = new Set<string>();
  for (const match of text.matchAll(/\b\d{3,8}\b/g)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (isCalendarYearToken(token)) continue;
    if (isCurrencyAmountFragment(text, index, token)) continue;
    if (isPostalCodeFragment(text, index, token)) continue;
    if (isPhoneNumberFragment(text, index, token)) continue;
    if (isStreetAddressFragment(text, index, token)) continue;
    if (isZipFragment(text, index, token)) continue;
    if (isIdentifierOrStatusFragment(text, index, token)) continue;
    tokens.add(token);
  }
  for (const match of text.matchAll(/\b[A-Za-z]{1,8}[-_][A-Za-z0-9][A-Za-z0-9_-]{0,60}\b/g)) {
    if (/^[a-z]+[-_][a-z]+$/.test(match[0])) continue;
    tokens.add(match[0]);
  }
  return [...tokens];
}

function stringMetadata(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' ? value : undefined;
}

function matchName(metadata: Record<string, unknown> | undefined): string | undefined {
  return stringMetadata(metadata, 'companyName')
    || stringMetadata(metadata, 'name')
    || stringMetadata(metadata, 'referenceId')
    || stringMetadata(metadata, 'code');
}

function matchReferenceId(metadata: Record<string, unknown> | undefined, queriedCode: string): string {
  return stringMetadata(metadata, 'companyReferenceId')
    || stringMetadata(metadata, 'referenceId')
    || stringMetadata(metadata, 'code')
    || queriedCode;
}

export function mapDocumentToReferenceMatch(
  document: { workday_id: string; type: DocumentType; metadata?: Record<string, unknown> },
  queriedCode: string,
  confidence = 1
): CachedReferenceMatch {
  return {
    type: document.type,
    workdayId: document.workday_id,
    referenceId: matchReferenceId(document.metadata, queriedCode),
    name: matchName(document.metadata),
    confidence,
  };
}

export function pickTopReferenceMatch(
  matches: CachedReferenceMatch[]
): CachedReferenceMatch | undefined {
  const ranked = [...matches]
    .filter((match) => match.confidence >= MIN_REFERENCE_MATCH_CONFIDENCE)
    .sort((left, right) => right.confidence - left.confidence);
  const top = ranked[0];
  if (!top) return undefined;

  const rivalType = ranked.find((match) => match.type !== top.type);
  if (rivalType && top.confidence < 1 && top.confidence - rivalType.confidence < MIN_TOP_MATCH_MARGIN) {
    return undefined;
  }
  if (top.confidence === 1 && rivalType?.confidence === 1) return undefined;

  const tiedSameType = ranked.filter((match) => {
    if (match.type !== top.type) return false;
    if (top.confidence === 1) return match.confidence === 1;
    return top.confidence - match.confidence < MIN_TOP_MATCH_MARGIN;
  });
  if (new Set(tiedSameType.map((match) => match.workdayId)).size > 1) {
    const costCenterTie = tiedSameType.every((match) => match.type === 'cost_center');
    if (costCenterTie) {
      const nonDnu = tiedSameType.filter((match) => !isDoNotUseCostCenterFields(match));
      if (nonDnu.length === 1) return nonDnu[0];
    }
    return undefined;
  }

  return top;
}

async function findSimilarReferenceMatches(
  db: DatabaseConnection,
  code: string
): Promise<CachedReferenceMatch[]> {
  const embedding = await createEmbedding(code);
  const rows = await searchDocumentsByTypes(db, embedding, code, REFERENCE_CODE_DOCUMENT_TYPES, 8);
  const matches = rows
    .map((row) => {
      const rawConfidence = Number(row.similarity) || 0;
      const confidence = row.type === 'cost_center'
        ? adjustCostCenterSimilarity(rawConfidence, row.metadata, code)
        : rawConfidence;
      return mapDocumentToReferenceMatch(row, code, confidence);
    })
    .filter((match) => match.confidence >= MIN_REFERENCE_MATCH_CONFIDENCE);

  return [...matches]
    .map((match, index) => ({ match, index }))
    .sort((left, right) => {
      if (right.match.confidence !== left.match.confidence) {
        return right.match.confidence - left.match.confidence;
      }
      if (
        !shouldSkipDoNotUseTieBreak(code)
        && left.match.type === 'cost_center'
        && right.match.type === 'cost_center'
      ) {
        const leftDnu = isDoNotUseCostCenterFields(left.match) ? 1 : 0;
        const rightDnu = isDoNotUseCostCenterFields(right.match) ? 1 : 0;
        if (leftDnu !== rightDnu) return leftDnu - rightDnu;
      }
      return left.index - right.index;
    })
    .map(({ match }) => match);
}

export async function resolveMatchesForCode(
  db: DatabaseConnection,
  code: string,
  exactDocuments: Array<{ workday_id: string; type: DocumentType; metadata?: Record<string, unknown> }>,
  options?: { allowInexact?: boolean }
): Promise<CachedReferenceMatch[]> {
  if (exactDocuments.length > 0) {
    return exactDocuments.map((document) => mapDocumentToReferenceMatch(document, code, 1));
  }
  if (options?.allowInexact === false || isCalendarYearToken(code)) return [];
  return findSimilarReferenceMatches(db, code);
}

export async function findCachedReferenceMatches(
  db: DatabaseConnection,
  code: string
): Promise<CachedReferenceMatch[]> {
  const documents = await findDocumentsByReferenceId(db, code, REFERENCE_CODE_DOCUMENT_TYPES);
  return resolveMatchesForCode(db, code, documents);
}

export function formatReferenceDirectory(
  resolved: Array<{ code: string; matches: CachedReferenceMatch[] }>
): string {
  if (resolved.length === 0) return '';

  const lines = resolved.map(({ code, matches }) => {
    if (matches.length === 0) {
      return `- ${code}: no cached company, cost center, fund, LOB, or spend category`;
    }
    const top = pickTopReferenceMatch(matches);
    const details = [...matches]
      .sort((left, right) => right.confidence - left.confidence)
      .map((match) => {
        const label = match.name ? `${match.name} ` : '';
        const topMark = top && match.workdayId === top.workdayId && match.type === top.type ? ', topMatch' : '';
        return `${match.type} ${label}(referenceId=${match.referenceId}, workdayId=${match.workdayId}, confidence=${match.confidence.toFixed(2)}${topMark})`;
      });
    return `- ${code}: ${details.join('; ')}`;
  });

  return `\n\nCached reference ID matches for codes in this email (highest-confidence match is the object type):\n${lines.join('\n')}`;
}

export async function resolveReferenceCodesFromText(
  db: DatabaseConnection,
  text: string
): Promise<Array<{ code: string; matches: CachedReferenceMatch[] }>> {
  const codes = extractReferenceCodeCandidates(text);
  if (codes.length === 0) return [];

  const grouped = await findDocumentsByReferenceIds(db, codes, REFERENCE_CODE_DOCUMENT_TYPES);
  const unmatched = codes.filter((code) => (grouped.get(code) ?? []).length === 0);
  const inexactCodes = new Set(unmatched.slice(0, MAX_INEXACT_REFERENCE_LOOKUPS));
  return Promise.all(codes.map(async (code) => {
    const exactDocuments = grouped.get(code) ?? [];
    if (exactDocuments.length > 0) {
      return {
        code,
        matches: exactDocuments.map((document) => mapDocumentToReferenceMatch(document, code, 1)),
      };
    }
    if (!inexactCodes.has(code)) {
      return { code, matches: [] };
    }
    try {
      return { code, matches: await findSimilarReferenceMatches(db, code) };
    } catch (error) {
      debug(`Inexact lookup failed for reference code ${code}:`, error);
      return { code, matches: [] };
    }
  }));
}

const CODE_ONLY_SEPARATORS = /[\s/,;|&\-–]/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Reference codes the email actually uses as coding: a code right after a company label, any code on a line
 * that says it is coding, or a line that is only codes ("912 / 72200"). Numbers inside signatures, addresses,
 * account numbers, and phone extensions are candidates but never coding.
 */
export function explicitCodingCodes(text: string): string[] {
  const codes = new Set<string>();
  for (const line of text.split('\n')) {
    const candidates = extractReferenceCodeCandidates(line);
    if (candidates.length === 0) continue;
    const keywordLine = CODING_LINE_KEYWORD.test(line);
    const remainder = candidates.reduce((rest, code) => rest.split(code).join(''), line);
    const codesOnly = remainder.replace(CODE_ONLY_SEPARATORS, '') === '';
    for (const code of candidates) {
      const labeled = new RegExp(
        String.raw`\b(?:company|co|entity)\b\.?[ \t]*(?:code|id|no\.?|number|#)?[ \t]*[:=#\-–]?[ \t]*${escapeRegExp(code)}\b`,
        'i'
      ).test(line);
      if (labeled || keywordLine || codesOnly) codes.add(code);
    }
  }
  return [...codes];
}

function normalizeForNameMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function companyNamedInText(extracted: string | null | undefined, text: string | undefined): boolean {
  const name = normalizeForNameMatch(extracted ?? '');
  if (name.length < 4 || !text) return false;
  return ` ${normalizeForNameMatch(text)} `.includes(` ${name} `);
}

function uniqueCompanies(matches: CachedReferenceMatch[]): EmailCompanyMatch[] {
  const byId = new Map<string, EmailCompanyMatch>();
  for (const match of matches.filter((item) => item.type === 'company')) {
    const key = match.workdayId || match.referenceId;
    if (!key || byId.has(key)) continue;
    byId.set(key, {
      workdayId: match.workdayId,
      referenceId: match.referenceId,
      name: match.name,
    });
  }
  return [...byId.values()];
}

function isShortNumericReferenceId(value: string): boolean {
  return /^\d{2,8}$/.test(value.trim());
}

export async function resolveCompanyFromEmail(options: {
  db: DatabaseConnection;
  emailBody?: string;
  /** Text where a company may be named without a code: AP notes and the email's coding lines (`emailCodingText`). */
  codingText?: string;
  /** AP's internal notes: any code in them is coding, since AP wrote it. */
  apNotes?: string;
  emailCompany?: {
    extracted?: string | null;
    workdayId?: string | null;
    referenceId?: string | null;
    name?: string | null;
  } | null;
}): Promise<EmailCompanyMatch | undefined> {
  const { emailCompany, emailBody, codingText, apNotes } = options;
  const rawWorkdayId = emailCompany?.workdayId?.trim() || undefined;
  const claimedWid = rawWorkdayId && !isShortNumericReferenceId(rawWorkdayId) ? rawWorkdayId : undefined;
  const claimedReferenceId = (
    emailCompany?.referenceId?.trim()
    || (rawWorkdayId && isShortNumericReferenceId(rawWorkdayId) ? rawWorkdayId : undefined)
  ) || undefined;

  const apCodes = apNotes ? extractReferenceCodeCandidates(htmlToText(apNotes)) : [];
  const bodyCodes = [...(emailBody ? explicitCodingCodes(htmlToText(emailBody)) : []), ...apCodes];
  const extractedCodes = emailCompany?.extracted
    ? extractReferenceCodeCandidates(emailCompany.extracted)
    : [];
  const emailCodes = bodyCodes.length > 0
    ? bodyCodes
    : (emailBody?.trim() ? [] : extractedCodes);
  const uniqueCodes = [...new Set(emailCodes.map((code) => code.trim()).filter(Boolean))];

  if (uniqueCodes.length === 0) {
    // The model also fills this from the invoice bill-to, so a name counts only when the email itself says it.
    if (claimedWid && companyNamedInText(emailCompany?.extracted, codingText)) {
      return {
        workdayId: claimedWid,
        referenceId: claimedReferenceId,
        name: emailCompany?.name || undefined,
        origin: 'name',
      };
    }
    return undefined;
  }

  const grouped = await findDocumentsByReferenceIds(options.db, uniqueCodes, REFERENCE_CODE_DOCUMENT_TYPES);
  const matchesFor = (code: string) =>
    (grouped.get(code) ?? []).map((document) => mapDocumentToReferenceMatch(document, code, 1));
  const exactCompanies = uniqueCompanies(uniqueCodes.flatMap((code) => matchesFor(code)));

  if (claimedWid) {
    const matching = exactCompanies.find((company) => company.workdayId === claimedWid);
    if (matching) {
      return {
        workdayId: claimedWid,
        referenceId: matching.referenceId || claimedReferenceId,
        name: emailCompany?.name || matching.name,
        origin: 'code',
      };
    }
  }

  const claimedCodeInEmail = claimedReferenceId
    && uniqueCodes.some((code) => code.toLowerCase() === claimedReferenceId.toLowerCase());
  if (claimedCodeInEmail && claimedReferenceId) {
    const referencedExact = uniqueCompanies(matchesFor(claimedReferenceId));
    if (referencedExact.length === 1) {
      return {
        ...referencedExact[0],
        name: emailCompany?.name || referencedExact[0].name,
        origin: 'code',
      };
    }
  }

  if (exactCompanies.length === 1) {
    debug('Resolved a unique company from explicit email coding', exactCompanies[0]);
    return { ...exactCompanies[0], origin: 'code' };
  }
  return undefined;
}

export type CreateInvoiceCompanySource = 'email' | 'po' | 'recommended' | 'default';

/** The company an email override replaced: the matched PO's company, or the invoice's verified bill-to company. */
export type CompanyConflict = { with: 'po' | 'bill_to'; workdayId: string };

export type SelectedCreateInvoiceCompany = {
  companyId: string;
  companyReferenceType: 'WID' | 'Company_Reference_ID';
  source: CreateInvoiceCompanySource;
  emailOrigin?: EmailCompanyOrigin;
  conflict?: CompanyConflict;
};

function emailCompanyConflict(options: {
  emailWorkdayId?: string;
  recommendedCompanyWID?: string;
  poCompanyWID?: string;
}): CompanyConflict | undefined {
  const { emailWorkdayId, poCompanyWID, recommendedCompanyWID } = options;
  if (!emailWorkdayId) return undefined;
  if (poCompanyWID && poCompanyWID !== emailWorkdayId) return { with: 'po', workdayId: poCompanyWID };
  if (recommendedCompanyWID && recommendedCompanyWID !== emailWorkdayId) {
    return { with: 'bill_to', workdayId: recommendedCompanyWID };
  }
  return undefined;
}

export function selectCompanyForCreateInvoice(options: {
  emailCompany?: EmailCompanyMatch;
  recommendedCompanyWID?: string;
  poCompanyWID?: string;
  defaultCompany?: { companyId: string; companyReferenceType: 'WID' | 'Company_Reference_ID' };
}): SelectedCreateInvoiceCompany {
  const emailOrigin = options.emailCompany?.origin;
  if (options.emailCompany?.workdayId && !isShortNumericReferenceId(options.emailCompany.workdayId)) {
    const conflict = emailCompanyConflict({
      emailWorkdayId: options.emailCompany.workdayId,
      recommendedCompanyWID: options.recommendedCompanyWID,
      poCompanyWID: options.poCompanyWID,
    });
    return {
      companyId: options.emailCompany.workdayId,
      companyReferenceType: 'WID',
      source: 'email',
      ...(emailOrigin ? { emailOrigin } : {}),
      ...(conflict ? { conflict } : {}),
    };
  }
  if (options.emailCompany?.referenceId) {
    return {
      companyId: options.emailCompany.referenceId,
      companyReferenceType: 'Company_Reference_ID',
      source: 'email',
      ...(emailOrigin ? { emailOrigin } : {}),
    };
  }
  if (options.poCompanyWID) {
    return { companyId: options.poCompanyWID, companyReferenceType: 'WID', source: 'po' };
  }
  if (options.recommendedCompanyWID) {
    return { companyId: options.recommendedCompanyWID, companyReferenceType: 'WID', source: 'recommended' };
  }
  return {
    companyId: options.defaultCompany?.companyId ?? '',
    companyReferenceType: options.defaultCompany?.companyReferenceType ?? 'Company_Reference_ID',
    source: 'default',
  };
}

export function costCenterCodeExcludingCompany(
  costCenterCode: string | null | undefined,
  emailCompany?: EmailCompanyMatch
): string | null {
  if (!costCenterCode) return null;
  if (
    emailCompany?.referenceId &&
    costCenterCode.toLowerCase() === emailCompany.referenceId.toLowerCase()
  ) {
    return null;
  }
  return costCenterCode;
}

export const resolveReferenceCodeTool = tool({
  description: `Resolve a short Workday reference ID / code across cached object types.

  Use this when an email or invoice coding line contains a bare code such as "912", "72200", or "LOB-Golf".
  It first exact-matches cached Company_Reference_ID, Cost_Center_Reference_ID, Fund_ID, LOB reference IDs, and spend category reference IDs.
  If there is no exact hit, it ranks similar cached objects by confidence and uses the highest-confidence match as the object type.
  Do not assume a numeric code is a cost center — use topMatch.type.

  Examples: "912", "72200", "FD-001"`,
  inputSchema: z.object({
    code: z.string().describe('The reference ID or code to look up. Exact metadata matches win; otherwise the highest-confidence similar object is returned.'),
  }),
  execute: async ({ code }) => {
    const db = await getDatabaseConnection(process.env);
    const matches = await findCachedReferenceMatches(db, code);
    const topMatch = pickTopReferenceMatch(matches);
    debug(`Resolve Reference Code Tool: ${code} matched ${matches.length} object(s); top=${topMatch?.type ?? 'none'}`);
    return {
      success: true,
      code,
      topMatch: topMatch ?? null,
      matches,
    };
  },
});
