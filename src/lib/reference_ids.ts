import { debug } from '@pga/logger';
import { tool } from 'ai';
import { z } from 'zod';
import {
  findDocumentsByReferenceId,
  findDocumentsByReferenceIds,
  getDatabaseConnection,
  type DatabaseConnection,
  type DocumentType,
} from './database.js';

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
}

export interface EmailCompanyMatch {
  workdayId?: string;
  referenceId?: string;
  name?: string;
}

export function extractReferenceCodeCandidates(text: string): string[] {
  const tokens = new Set<string>();
  for (const match of text.matchAll(/\b\d{3,8}\b/g)) {
    tokens.add(match[0]);
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
  queriedCode: string
): CachedReferenceMatch {
  return {
    type: document.type,
    workdayId: document.workday_id,
    referenceId: matchReferenceId(document.metadata, queriedCode),
    name: matchName(document.metadata),
  };
}

export async function findCachedReferenceMatches(
  db: DatabaseConnection,
  code: string
): Promise<CachedReferenceMatch[]> {
  const documents = await findDocumentsByReferenceId(db, code, REFERENCE_CODE_DOCUMENT_TYPES);
  return documents.map((document) => mapDocumentToReferenceMatch(document, code));
}

export function formatReferenceDirectory(
  resolved: Array<{ code: string; matches: CachedReferenceMatch[] }>
): string {
  if (resolved.length === 0) return '';

  const lines = resolved.map(({ code, matches }) => {
    if (matches.length === 0) {
      return `- ${code}: no cached company, cost center, fund, LOB, or spend category`;
    }
    const details = matches.map((match) => {
      const label = match.name ? `${match.name} ` : '';
      return `${match.type} ${label}(referenceId=${match.referenceId}, workdayId=${match.workdayId})`;
    });
    return `- ${code}: ${details.join('; ')}`;
  });

  return `\n\nCached reference ID matches for codes in this email:\n${lines.join('\n')}`;
}

export async function resolveReferenceCodesFromText(
  db: DatabaseConnection,
  text: string
): Promise<Array<{ code: string; matches: CachedReferenceMatch[] }>> {
  const codes = extractReferenceCodeCandidates(text);
  if (codes.length === 0) return [];

  const grouped = await findDocumentsByReferenceIds(db, codes, REFERENCE_CODE_DOCUMENT_TYPES);
  return codes.map((code) => ({
    code,
    matches: (grouped.get(code) ?? []).map((document) => mapDocumentToReferenceMatch(document, code)),
  }));
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
  if (emailCompany?.workdayId) {
    return {
      workdayId: emailCompany.workdayId,
      referenceId: emailCompany.referenceId || undefined,
      name: emailCompany.name || undefined,
    };
  }

  const codes = [
    ...(emailCompany?.referenceId ? [emailCompany.referenceId] : []),
    ...(emailCompany?.extracted ? extractReferenceCodeCandidates(emailCompany.extracted) : []),
    ...(emailBody ? extractReferenceCodeCandidates(emailBody) : []),
  ];
  const uniqueCodes = [...new Set(codes.map((code) => code.trim()).filter(Boolean))];
  if (uniqueCodes.length === 0) return undefined;

  const grouped = await findDocumentsByReferenceIds(options.db, uniqueCodes, REFERENCE_CODE_DOCUMENT_TYPES);
  const matchesFor = (code: string) =>
    (grouped.get(code) ?? []).map((document) => mapDocumentToReferenceMatch(document, code));

  if (emailCompany?.referenceId) {
    const companies = uniqueCompanies(matchesFor(emailCompany.referenceId));
    if (companies.length === 1) {
      return {
        ...companies[0],
        name: emailCompany.name || companies[0].name,
      };
    }
  }

  const companies = uniqueCompanies(uniqueCodes.flatMap((code) => matchesFor(code)));
  if (companies.length === 1) {
    debug('Resolved a unique company from email reference codes', companies[0]);
    return companies[0];
  }
  return undefined;
}

export function selectCompanyForCreateInvoice(options: {
  emailCompany?: EmailCompanyMatch;
  recommendedCompanyWID?: string;
  defaultCompanyReferenceId: string;
}): { companyId: string; companyReferenceType: 'WID' | 'Company_Reference_ID' } {
  if (options.emailCompany?.workdayId) {
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
  It exact-matches cached Company_Reference_ID, Cost_Center_Reference_ID, Fund_ID, LOB reference IDs, and spend category reference IDs.
  Do not assume a numeric code is a cost center — this lookup tells you which object type it is.

  Examples: "912", "72200", "FD-001"`,
  inputSchema: z.object({
    code: z.string().describe('The reference ID or code to look up exactly'),
  }),
  execute: async ({ code }) => {
    const db = await getDatabaseConnection(process.env);
    const matches = await findCachedReferenceMatches(db, code);
    debug(`Resolve Reference Code Tool: ${code} matched ${matches.length} object(s)`);
    return {
      success: true,
      code,
      matches,
    };
  },
});
