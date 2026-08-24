import { debug } from '@pga/logger';
import { tool } from 'ai';
import { z } from 'zod';
import {
  findDocumentsByReferenceId,
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
  for (const match of text.matchAll(/\b\d{2,8}\b/g)) {
    tokens.add(match[0]);
  }
  for (const match of text.matchAll(/\b[A-Za-z]{1,8}[-_][A-Za-z0-9][A-Za-z0-9_-]{0,60}\b/g)) {
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
  const resolved = [];
  for (const code of codes) {
    resolved.push({ code, matches: await findCachedReferenceMatches(db, code) });
  }
  return resolved;
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
  if (emailCompany?.workdayId || emailCompany?.referenceId) {
    const referenceId = emailCompany.referenceId || undefined;
    let workdayId = emailCompany.workdayId || undefined;
    if (!workdayId && referenceId) {
      const companies = uniqueCompanies(await findCachedReferenceMatches(options.db, referenceId));
      if (companies.length === 1) {
        workdayId = companies[0].workdayId;
      }
    }
    return {
      workdayId,
      referenceId,
      name: emailCompany.name || undefined,
    };
  }

  const codes = [
    ...(emailCompany?.extracted ? extractReferenceCodeCandidates(emailCompany.extracted) : []),
    ...(emailBody ? extractReferenceCodeCandidates(emailBody) : []),
  ];
  const uniqueCodes = [...new Set(codes)];
  if (uniqueCodes.length === 0) return undefined;

  const companyMatches: CachedReferenceMatch[] = [];
  for (const code of uniqueCodes) {
    companyMatches.push(...(await findCachedReferenceMatches(options.db, code)));
  }

  const companies = uniqueCompanies(companyMatches);
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
