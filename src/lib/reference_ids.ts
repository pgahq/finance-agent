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
import { createEmbedding } from './rag.js';

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

export interface EmailCompanyMatch {
  workdayId?: string;
  referenceId?: string;
  name?: string;
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

export function extractReferenceCodeCandidates(text: string): string[] {
  const tokens = new Set<string>();
  for (const match of text.matchAll(/\b\d{3,8}\b/g)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (isCalendarYearToken(token)) continue;
    if (isCurrencyAmountFragment(text, index, token)) continue;
    if (isPostalCodeFragment(text, index, token)) continue;
    if (isPhoneNumberFragment(text, index, token)) continue;
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
  if (new Set(tiedSameType.map((match) => match.workdayId)).size > 1) return undefined;

  return top;
}

async function findSimilarReferenceMatches(
  db: DatabaseConnection,
  code: string
): Promise<CachedReferenceMatch[]> {
  const embedding = await createEmbedding(code);
  const rows = await searchDocumentsByTypes(db, embedding, code, REFERENCE_CODE_DOCUMENT_TYPES, 8);
  return rows
    .map((row) => mapDocumentToReferenceMatch(row, code, Number(row.similarity) || 0))
    .filter((match) => match.confidence >= MIN_REFERENCE_MATCH_CONFIDENCE);
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
  return Promise.all(codes.map(async (code) => ({
    code,
    matches: await resolveMatchesForCode(db, code, grouped.get(code) ?? [], {
      allowInexact: inexactCodes.has(code),
    }),
  })));
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
  emailCompany?: {
    extracted?: string | null;
    workdayId?: string | null;
    referenceId?: string | null;
    name?: string | null;
  } | null;
}): Promise<EmailCompanyMatch | undefined> {
  const { emailCompany, emailBody } = options;
  const rawWorkdayId = emailCompany?.workdayId?.trim() || undefined;
  const claimedWid = rawWorkdayId && !isShortNumericReferenceId(rawWorkdayId) ? rawWorkdayId : undefined;
  const claimedReferenceId = (
    emailCompany?.referenceId?.trim()
    || (rawWorkdayId && isShortNumericReferenceId(rawWorkdayId) ? rawWorkdayId : undefined)
  ) || undefined;

  const codes = [
    ...(claimedReferenceId ? [claimedReferenceId] : []),
    ...(emailCompany?.extracted ? extractReferenceCodeCandidates(emailCompany.extracted) : []),
    ...(emailBody ? extractReferenceCodeCandidates(emailBody) : []),
  ];
  const uniqueCodes = [...new Set(codes.map((code) => code.trim()).filter(Boolean))];

  if (claimedWid && uniqueCodes.length === 0) {
    return {
      workdayId: claimedWid,
      referenceId: claimedReferenceId,
      name: emailCompany?.name || undefined,
    };
  }
  if (uniqueCodes.length === 0) return undefined;

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
      };
    }
  }

  if (claimedReferenceId) {
    const referencedExact = uniqueCompanies(matchesFor(claimedReferenceId));
    if (referencedExact.length === 1) {
      return {
        ...referencedExact[0],
        name: emailCompany?.name || referencedExact[0].name,
      };
    }
  }

  if (exactCompanies.length === 1) {
    debug('Resolved a unique company from exact email reference codes', exactCompanies[0]);
    return exactCompanies[0];
  }
  return undefined;
}

export function selectCompanyForCreateInvoice(options: {
  emailCompany?: EmailCompanyMatch;
  recommendedCompanyWID?: string;
  defaultCompanyReferenceId: string;
}): { companyId: string; companyReferenceType: 'WID' | 'Company_Reference_ID' } {
  if (options.emailCompany?.workdayId && !isShortNumericReferenceId(options.emailCompany.workdayId)) {
    return { companyId: options.emailCompany.workdayId, companyReferenceType: 'WID' };
  }
  if (options.emailCompany?.referenceId) {
    return { companyId: options.emailCompany.referenceId, companyReferenceType: 'Company_Reference_ID' };
  }
  if (options.recommendedCompanyWID) {
    return { companyId: options.recommendedCompanyWID, companyReferenceType: 'WID' };
  }
  return {
    companyId: options.defaultCompanyReferenceId,
    companyReferenceType: 'Company_Reference_ID',
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
