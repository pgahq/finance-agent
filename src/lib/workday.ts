import { debug } from '@pga/logger';
import path from 'path';
import { isWorkdayValidationError, parseWorkdayValidationDetails, summarizeValidationError, humanWorkdayValidationMessage, isLineOfBusinessRelatedWorktagError, isRequiredLineOfBusinessWorktagError, collectWorkdayValidationErrorText } from './invoice_validation_failures.js';
import { classifyWorkdayValidationField } from './workday_validation_field_agent.js';
import type { FinalInvoiceLine } from './invoice_lines.js';
import { applyRelatedLobWorktags, parseExtractedAmount, splitFreightLines } from './invoice_lines.js';
import {
  DEFAULT_LINE_OF_BUSINESS_ID,
  extractLineOfBusinessId,
  parseRelatedWorktagsResponse,
  relatedLobHasUsableValue,
  relatedWorktagsTotalPages,
  relatedLobSoapReference,
  resolveRelatedLobId,
  worktagsIncludeLineOfBusiness,
  type RelatedLob,
} from './related_worktags.js';

import type {
  DownloadedAttachment,
  PresignedAttachment,
  SupplierInvoiceSoapResponse,
  WorkdayInvoice
} from './types.js';

// Import strong-soap for SOAP client using dynamic import
let strong: any;
const getStrongSoap = async () => {
  if (!strong) {
    const strongSoapModule = await import('strong-soap');
    strong = strongSoapModule.soap;
  }
  return strong;
};

export interface WorkdayConfig {
  domain: string;
  tenant: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export const getWorkdayConfig = (env: NodeJS.ProcessEnv): WorkdayConfig => ({
  domain: env.WORKDAY_DOMAIN!,
  tenant: env.WORKDAY_TENANT!,
  clientId: env.WORKDAY_CLIENT_ID!,
  clientSecret: env.WORKDAY_CLIENT_SECRET!,
  refreshToken: env.WORKDAY_REFRESH_TOKEN!,
});

const generateAuthToken = ({ clientId, clientSecret }: { clientId: string; clientSecret: string }): string => {
  return Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
};

const getAccessToken = async (config: WorkdayConfig): Promise<string> => {
  const authToken = generateAuthToken({ clientId: config.clientId, clientSecret: config.clientSecret });
  const headers = { Authorization: `Basic ${authToken}` };

  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('refresh_token', config.refreshToken);

  const tokenUrl = `https://${config.domain}/ccx/oauth2/${config.tenant}/token`;

  debug('Requesting access token using refresh token grant');

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers,
    body: params
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to get access token: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const tokenResponse = await response.json() as { access_token?: string };
  const accessToken = tokenResponse.access_token;

  if (!accessToken) {
    throw new Error('Unable to generate bearer token!');
  }

  debug('Successfully obtained access token');
  return accessToken;
};

async function fetchWorkdayPage(
  config: WorkdayConfig,
  accessToken: string,
  wqlQuery: string,
  limit: number,
  offset: number
): Promise<{ total?: number; data?: unknown[] }> {
  const wqlUrl = `https://${config.domain}/api/wql/v1/${config.tenant}/data`;
  const url = new URL(wqlUrl);
  url.searchParams.set('query', wqlQuery);
  url.searchParams.set('limit', limit.toString());
  url.searchParams.set('offset', offset.toString());

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Workday API error: ${response.status} ${response.statusText} - ${errorText}`);
  }

  return response.json() as { total?: number; data?: unknown[] };
}

async function fetchRemainingPages(
  config: WorkdayConfig,
  accessToken: string,
  wqlQuery: string,
  totalCount: number,
  initialData: unknown[]
): Promise<unknown[]> {
  const maxLimit = 10000;
  const remainingCount = totalCount - initialData.length;

  if (remainingCount <= 0) {
    return [];
  }

  const additionalPages = Math.ceil(remainingCount / maxLimit);
  debug(`Fetching ${additionalPages} additional pages to get remaining ${remainingCount} records`);

  const pageRequests = [];
  for (let page = 0; page < additionalPages; page++) {
    const offset = maxLimit + (page * maxLimit);
    const limit = Math.min(maxLimit, totalCount - offset);

    const pageRequest = fetchWorkdayPage(config, accessToken, wqlQuery, limit, offset);
    pageRequests.push(pageRequest);
  }

  const pageResults = await Promise.all(pageRequests);

  // Combine all data from additional pages
  const additionalData: unknown[] = [];
  for (const pageResult of pageResults) {
    if (pageResult.data && Array.isArray(pageResult.data)) {
      additionalData.push(...pageResult.data);
    }
  }

  return additionalData;
}

export async function executeWorkdayQuery(
  config: WorkdayConfig,
  wqlQuery: string,
  options?: { requireCompleteTotal?: boolean }
): Promise<{ total?: number; data?: unknown[] }> {
  debug(`Executing WQL query on tenant: ${config.tenant}`);
  debug(`Query: ${wqlQuery}`);

  const accessToken = await getAccessToken(config);

  // Start with max limit to get as much as possible in one request
  const initialResult = await fetchWorkdayPage(config, accessToken, wqlQuery, 10000, 0);
  const reportedTotal = initialResult.total;
  const initialData = initialResult.data || [];

  debug(`Total records available: ${reportedTotal ?? 'unknown'}, got ${initialData.length} in initial request`);

  let data = initialData;
  if (typeof reportedTotal === 'number' && reportedTotal > 10000) {
    const additionalData = await fetchRemainingPages(config, accessToken, wqlQuery, reportedTotal, initialData);
    data = [...initialData, ...additionalData];
  }

  if (options?.requireCompleteTotal && typeof reportedTotal === 'number' && data.length !== reportedTotal) {
    throw new Error(`Workday query incomplete: expected ${reportedTotal} rows, got ${data.length}`);
  }

  debug(`Successfully fetched ${data.length} records total`);

  if (typeof reportedTotal !== 'number' || reportedTotal <= 10000) {
    return initialResult;
  }

  return {
    total: reportedTotal,
    data
  };
}

async function buildFinancialManagementClient(
  context: { workdayConfig: WorkdayConfig }
): Promise<any> {
  const wsdlPath = path.join(process.cwd(), 'dist', 'soap', 'Financial_Management.wsdl');
  const accessToken = await getAccessToken(context.workdayConfig);
  const strongSoap = await getStrongSoap();

  return new Promise((resolve, reject) => {
    strongSoap.createClient(wsdlPath, {}, (err: any, client: any) => {
      if (err) return reject(err);
      client.setSecurity(new strongSoap.BearerSecurity(accessToken));
      const endpoint = `https://${context.workdayConfig.domain}/ccx/service/${context.workdayConfig.tenant}/Financial_Management/v46.0`;
      client.setEndpoint(endpoint);
      resolve(client);
    });
  });
}

export interface ParsedValidationRule {
  ruleId: string;
  classification: string;
  conditionRuleId: string;
  description: string;
  comment?: string;
  suppliers?: string[];
  spendCategories?: string[];
  costCenters?: string[];
}

function extractIdsByType(obj: any, type: string): string[] {
  const results: string[] = [];
  JSON.stringify(obj, (_, value) => {
    if (value?.$attributes?.type === type) results.push(value.$value);
    return value;
  });
  return [...new Set(results)];
}

function parseValidationRules(rules: any[]): ParsedValidationRule[] {
  return rules.flatMap(r =>
    [r.Custom_Validation_Rule_Data].flatMap(d => d ?? [])
      .filter((data: any) => data?.Custom_Validation_Rule_for_Transaction === 'Supplier Invoice')
      .flatMap((data: any) =>
        [data.Custom_Validation_Data].flatMap(vd => vd ?? [])
          .map((vd: any) => vd.Condition_Rule_Data)
          .filter((crd: any) => crd?.Rule_Description)
          .map((crd: any) => ({
            ruleId: data.Custom_Validation_Rule_ID,
            classification: data.Custom_Validation_Rule_Classification,
            conditionRuleId: crd.Condition_Rule_ID,
            description: crd.Rule_Description,
            comment: crd.Comment || undefined,
            suppliers: extractIdsByType(crd, 'Supplier_Reference_ID'),
            spendCategories: extractIdsByType(crd, 'Spend_Category_ID'),
            costCenters: extractIdsByType(crd, 'Cost_Center_Reference_ID'),
          }))
      )
  );
}

export async function getCustomValidationRules(
  context: { workdayConfig: WorkdayConfig }
): Promise<ParsedValidationRule[]> {
  const client = await buildFinancialManagementClient(context);
  const response = await new Promise<any>((resolve, reject) => {
    client.Get_Custom_Validation_Rules({
      Get_Custom_Validation_Rules_Request: {
        Request_References: {
          Custom_Validation_Context_Reference: [
            { ID: [{ $attributes: { type: 'Custom_Validation_Context_ID' }, $value: 'Supplier_Invoice_Critical' }] },
            { ID: [{ $attributes: { type: 'Custom_Validation_Context_ID' }, $value: 'Supplier_Invoice_Warning' }] }
          ]
        },
        Response_Filter: { Page: 1, Count: 999 }
      }
    }, (err: any, result: any) => {
      if (err) return reject(err);
      resolve(result);
    });
  });

  const rules = response?.Response_Data?.[0]?.Custom_Validation_Rule ?? [];
  debug(`Fetched ${rules.length} total validation rules, parsing Supplier Invoice rules`);
  return parseValidationRules(rules);
}

const RELATED_WORKTAGS_PAGE_SIZE = 999;
const RELATED_WORKTAGS_BATCH_SIZE = 100;

interface RelatedWorktagsSoapClient {
  Get_Related_Worktags_for_Worktags(
    request: {
      Get_Related_Worktags_for_Worktags_Request: {
        Request_References: {
          Related_Worktag_Reference: Array<{ ID: Array<{ $attributes: { type: string }; $value: string }> }>;
        };
        Response_Filter: { Page: number; Count: number };
      };
    },
    callback: (err: unknown, result: unknown) => void
  ): void;
}

function asRelatedWorktagsClient(client: unknown): RelatedWorktagsSoapClient {
  if (
    typeof client !== 'object'
    || client == null
    || typeof (client as { Get_Related_Worktags_for_Worktags?: unknown }).Get_Related_Worktags_for_Worktags !== 'function'
  ) {
    throw new Error('Financial Management SOAP client is missing Get_Related_Worktags_for_Worktags');
  }
  return client as RelatedWorktagsSoapClient;
}

function relatedWorktagReferenceType(id: string): 'WID' | 'Cost_Center_Reference_ID' {
  if (/^CC[-_]/.test(id) || /\s/.test(id)) return 'Cost_Center_Reference_ID';
  return 'WID';
}

function fetchRelatedWorktagsPage(
  client: RelatedWorktagsSoapClient,
  costCenterIds: string[],
  page: number
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    client.Get_Related_Worktags_for_Worktags({
      Get_Related_Worktags_for_Worktags_Request: {
        Request_References: {
          Related_Worktag_Reference: costCenterIds.map(id => ({
            ID: [{ $attributes: { type: relatedWorktagReferenceType(id) }, $value: id }]
          }))
        },
        Response_Filter: { Page: page, Count: RELATED_WORKTAGS_PAGE_SIZE }
      }
    }, (err: unknown, result: unknown) => {
      if (err) return reject(err);
      resolve(result);
    });
  });
}

export async function getRelatedWorktagsForCostCenters(
  context: { workdayConfig: WorkdayConfig },
  costCenterWorkdayIds: string[]
): Promise<Map<string, RelatedLob>> {
  const relatedByKey = new Map<string, RelatedLob>();
  const workdayIds = [...new Set(costCenterWorkdayIds.filter(Boolean))];
  if (workdayIds.length === 0) return relatedByKey;

  try {
    const soapClient: unknown = await buildFinancialManagementClient(context);
    const client = asRelatedWorktagsClient(soapClient);

    for (let i = 0; i < workdayIds.length; i += RELATED_WORKTAGS_BATCH_SIZE) {
      const batch = workdayIds.slice(i, i + RELATED_WORKTAGS_BATCH_SIZE);
      let page = 1;
      let totalPages = 1;

      do {
        const response = await fetchRelatedWorktagsPage(client, batch, page);
        const parsed = parseRelatedWorktagsResponse(response);
        for (const [key, related] of parsed) {
          relatedByKey.set(key, related);
        }
        totalPages = relatedWorktagsTotalPages(response);
        page += 1;
      } while (page <= totalPages);
    }

    const usable = [...relatedByKey.values()].filter(relatedLobHasUsableValue).length;
    debug(`Fetched related worktags for ${relatedByKey.size} cost center key(s); ${usable} with related LOB`);
    return relatedByKey;
  } catch (error) {
    throw sanitizeSoapError(error);
  }
}

const getResourceManagementEndpoint = (config: WorkdayConfig): string =>
  `https://${config.domain}/ccx/service/${config.tenant}/Resource_Management/v44.1`;

async function buildResourceManagementClient(
  context: { workdayConfig: WorkdayConfig }
): Promise<any> {
  const wsdlPath = path.join(process.cwd(), 'dist', 'soap', 'Resource_Management.wsdl');

  // Get OAuth access token
  const accessToken = await getAccessToken(context.workdayConfig);

  const strongSoap = await getStrongSoap();

  return new Promise((resolve, reject) => {
    strongSoap.createClient(wsdlPath, {}, (err: any, client: any) => {
      if (err) {
        debug('Failed to create SOAP client:', err);
        return reject(err);
      }

      // Use OAuth bearer token authentication
      client.setSecurity(new strongSoap.BearerSecurity(accessToken));

      client.setEndpoint(getResourceManagementEndpoint(context.workdayConfig));

      resolve(client);
    });
  });
}

interface WorkQueueTag {
  ID: Array<{ $attributes: { type: string }; $value: string }>;
}

export interface PurchaseOrderLine {
  lineOrder: number;
  purchaseOrderLineId: string;
  purchaseOrderDocumentNumber: string;
  description?: string;
  memo?: string;
  spendCategoryReference?: any;
  extendedAmount?: number;
  quantity?: number;
  unitCost?: number;
  worktagsReference?: any[];
  shipToAddressId?: string | null;
}

export interface PurchaseOrderCompany {
  workdayId: string;
  descriptor: string;
}

export interface ParsedPurchaseOrder {
  documentNumber: string;
  company?: PurchaseOrderCompany;
  lines: PurchaseOrderLine[];
}

interface buildSubmitInvoiceDataOptions {
  currentInvoice: any;
  supplierWID?: string;
  defaultSupplierWID?: string;
  companyWID?: string;
  companyReferenceType?: string;
  workQueueTags?: WorkQueueTag[];
  notes?: string;
  memo?: string;
  invoiceDate?: string;
  paymentTermsWID?: string;
  applyFundFallback?: boolean;
  applyCostCenterFallback?: boolean;
  applySpendCategoryFallback?: boolean;
  omitEventWorktag?: boolean;
  omitLobWorktag?: boolean;
  applyLobFallback?: boolean;
  applyRelatedLob?: boolean;
  relatedLobByCostCenter?: Map<string, RelatedLob>;
  resolveCostCenterWorkdayIds?: (costCenterIds: string[]) => Promise<Map<string, string>>;
  extractedAmountDue?: string;
  suppliersInvoiceNumber?: string;
  extractedFreightAmount?: string;
  extractedTaxAmount?: string;
  filterInvoiceLines?: boolean;
  finalLines?: FinalInvoiceLine[];
  currencyWID?: string;
  attachment?: { fileName: string; contentType: string; base64Content: string };
}

type FallbackField = 'supplier' | 'invoiceDate' | 'paymentTerms' | 'worktag:fund' | 'worktag:costCenter' | 'worktag:spendCategory' | 'worktag:event' | 'worktag:lob';
const FALLBACK_FIELDS: FallbackField[] = ['supplier', 'invoiceDate', 'paymentTerms', 'worktag:fund', 'worktag:costCenter', 'worktag:spendCategory', 'worktag:event', 'worktag:lob'];

export interface AppliedFallback {
  field: FallbackField;
  label: string;
  dueToValidationError?: boolean;
}

function stripRichText(text: string): string {
  let result = text;

  // Decode HTML entities
  result = result.replace(/&lt;/g, '<');
  result = result.replace(/&gt;/g, '>');
  result = result.replace(/&amp;/g, '&');
  result = result.replace(/&quot;/g, '"');
  result = result.replace(/&apos;/g, "'");
  result = result.replace(/&#39;/g, "'");
  result = result.replace(/&nbsp;/g, ' ');

  return result.trim();
}

function getFirstDayOfCurrentMonth(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = `${now.getUTCMonth() + 1}`.padStart(2, '0');
  return `${year}-${month}-01`;
}

function normalizeInvoiceDate(invoiceDate?: string | Date | unknown): string | undefined {
  if (!invoiceDate) {
    return undefined;
  }

  if (invoiceDate instanceof Date) {
    return Number.isNaN(invoiceDate.getTime()) ? undefined : invoiceDate.toISOString().split('T')[0];
  }

  const trimmed = String(invoiceDate).trim();
  if (!trimmed) {
    return undefined;
  }

  const isoDateMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoDateMatch) {
    return isoDateMatch[1];
  }

  const parsedDate = new Date(trimmed);
  if (Number.isNaN(parsedDate.getTime())) {
    return undefined;
  }

  return parsedDate.toISOString().split('T')[0];
}

function resolveInvoiceDate(_currentInvoice: any, invoiceDate?: string): string {
  return normalizeInvoiceDate(invoiceDate) ?? getFirstDayOfCurrentMonth();
}

function createReference(type: string, value: string): { ID: Array<{ $attributes: { type: string }; $value: string }> } {
  return { ID: [{ $attributes: { type }, $value: value }] };
}

function extractLineCostCenterId(line: { costCenterId?: string | null; Worktags_Reference?: unknown } | undefined): string | null {
  if (line?.costCenterId) return line.costCenterId;
  for (const worktag of ([] as any[]).concat(line?.Worktags_Reference ?? [])) {
    const ids = ([] as any[]).concat(worktag.ID ?? []);
    const match = ids.find((id: any) => id.$attributes?.type === 'Cost_Center_Reference_ID' && id.$value);
    if (match?.$value) return String(match.$value);
  }
  return null;
}

function getConfiguredDefaultSupplierWID(options: buildSubmitInvoiceDataOptions): string | undefined {
  return process.env.WORKDAY_DEFAULT_SUPPLIER_WID ?? options.defaultSupplierWID;
}

function getAppliedFallbacks(options: buildSubmitInvoiceDataOptions): AppliedFallback[] {
  const { supplierWID, defaultSupplierWID, invoiceDate, paymentTermsWID, applyFundFallback, applyCostCenterFallback, applySpendCategoryFallback, omitEventWorktag, omitLobWorktag, applyLobFallback, applyRelatedLob } = options;
  const fallbacks: AppliedFallback[] = [];
  const configuredDefaultSupplierWID = getConfiguredDefaultSupplierWID(options);

  if (configuredDefaultSupplierWID && (supplierWID === configuredDefaultSupplierWID || (!supplierWID && defaultSupplierWID))) {
    fallbacks.push({ field: 'supplier', label: 'default supplier' });
  }

  if (!normalizeInvoiceDate(invoiceDate)) {
    fallbacks.push({ field: 'invoiceDate', label: 'default invoice date' });
  }

  if (process.env.FALLBACK_PAYMENT_TERMS_ID && paymentTermsWID === process.env.FALLBACK_PAYMENT_TERMS_ID) {
    fallbacks.push({ field: 'paymentTerms', label: 'fallback payment terms' });
  }

  if (applyFundFallback && process.env.FALLBACK_FUND_ID) {
    fallbacks.push({ field: 'worktag:fund', label: 'fallback fund' });
  }

  if (applyCostCenterFallback && process.env.FALLBACK_COST_CENTER_ID) {
    fallbacks.push({ field: 'worktag:costCenter', label: 'fallback cost center' });
  }

  if (applySpendCategoryFallback && process.env.FALLBACK_SPEND_CATEGORY_ID) {
    fallbacks.push({ field: 'worktag:spendCategory', label: 'fallback spend category' });
  }

  if (applyRelatedLob) {
    fallbacks.push({ field: 'worktag:lob', label: 'related line of business' });
  }

  if (applyLobFallback && process.env.FALLBACK_LOB_ID) {
    fallbacks.push({ field: 'worktag:lob', label: 'fallback line of business' });
  }

  if (omitEventWorktag) {
    fallbacks.push({ field: 'worktag:event', label: 'omitted Event worktag' });
  }

  if (omitLobWorktag) {
    fallbacks.push({ field: 'worktag:lob', label: 'omitted Line of Business worktag' });
  }

  return fallbacks;
}

function fallbackLobExcludeIds(): string[] {
  return [...new Set([DEFAULT_LINE_OF_BUSINESS_ID, process.env.FALLBACK_LOB_ID].filter((id): id is string => !!id))];
}

function costCenterIdsFromLines(lines: FinalInvoiceLine[] | undefined): string[] {
  return [...new Set((lines ?? []).map(line => line.costCenterId).filter((id): id is string => !!id))];
}

function linesWithRelatedLob(
  options: buildSubmitInvoiceDataOptions,
  anyAllowed = false
): FinalInvoiceLine[] | undefined {
  const lines = options.finalLines;
  const related = options.relatedLobByCostCenter;
  if (!lines?.length || !related?.size) return undefined;

  const next = applyRelatedLobWorktags(
    lines,
    related,
    process.env.FALLBACK_COST_CENTER_ID,
    { replaceIds: fallbackLobExcludeIds(), anyAllowed }
  );
  const changed = next.some((line, index) => line.lineOfBusinessId !== lines[index].lineOfBusinessId);
  return changed ? next : undefined;
}

function mergeRelatedLobLookups(
  existing: Map<string, RelatedLob>,
  fetched: Map<string, RelatedLob>,
  codeToWid: Map<string, string>
): Map<string, RelatedLob> {
  const merged = new Map(existing);
  for (const [key, related] of fetched) {
    if (relatedLobHasUsableValue(related) || !relatedLobHasUsableValue(merged.get(key))) {
      merged.set(key, related);
    }
  }
  for (const [code, wid] of codeToWid) {
    if (relatedLobHasUsableValue(merged.get(code))) continue;
    const fromWid = merged.get(wid);
    if (relatedLobHasUsableValue(fromWid) && fromWid) {
      merged.set(code, fromWid);
    }
  }
  return merged;
}

async function ensureRelatedLobByCostCenter(
  workdayConfig: WorkdayConfig,
  options: buildSubmitInvoiceDataOptions
): Promise<buildSubmitInvoiceDataOptions> {
  const existing = options.relatedLobByCostCenter ?? new Map<string, RelatedLob>();
  const missing = costCenterIdsFromLines(options.finalLines).filter(id =>
    id !== process.env.FALLBACK_COST_CENTER_ID && !relatedLobHasUsableValue(existing.get(id))
  );
  if (missing.length === 0) {
    return existing === options.relatedLobByCostCenter ? options : { ...options, relatedLobByCostCenter: existing };
  }

  let codeToWid = new Map<string, string>();
  if (options.resolveCostCenterWorkdayIds) {
    try {
      codeToWid = await options.resolveCostCenterWorkdayIds(missing);
    } catch (error) {
      debug('Failed to resolve cost center Workday ids for related LOB lookup:', error);
    }
  }

  const lookupIds = [...new Set([
    ...missing,
    ...[...codeToWid.values()].filter(Boolean),
  ])];

  try {
    const fetched = await getRelatedWorktagsForCostCenters({ workdayConfig }, lookupIds);
    const merged = mergeRelatedLobLookups(existing, fetched, codeToWid);
    debug('Loaded related Line of Business worktags for supplier invoice submit', {
      requested: missing,
      lookupIds,
      resolved: [...merged.entries()]
        .filter(([, related]) => relatedLobHasUsableValue(related))
        .map(([key]) => key),
    });
    return { ...options, relatedLobByCostCenter: merged };
  } catch (error) {
    debug(
      'Failed to fetch related Line of Business worktags during supplier invoice submit',
      summarizeSoapError(error)
    );
    return { ...options, relatedLobByCostCenter: existing };
  }
}

function getRetryableFallbackFields(options: buildSubmitInvoiceDataOptions): FallbackField[] {
  return FALLBACK_FIELDS.filter(field => getFallbackRetryBuildOptions(options, field));
}

function someLineMissingLob(options: buildSubmitInvoiceDataOptions): boolean {
  return !options.finalLines?.length || options.finalLines.some(l => !l.lineOfBusinessId);
}

function getRelatedLobRetryBuildOptions(
  options: buildSubmitInvoiceDataOptions
): { buildOptions: buildSubmitInvoiceDataOptions; fallbackLabel: string } | undefined {
  if (options.omitLobWorktag || options.applyRelatedLob) return undefined;
  const relatedLines = linesWithRelatedLob(options, true);
  if (!relatedLines) return undefined;
  return {
    buildOptions: { ...options, finalLines: relatedLines, applyRelatedLob: true },
    fallbackLabel: 'related line of business',
  };
}

function getFallbackLobRetryBuildOptions(
  options: buildSubmitInvoiceDataOptions
): { buildOptions: buildSubmitInvoiceDataOptions; fallbackLabel: string } | undefined {
  if (options.omitLobWorktag || options.applyLobFallback || !process.env.FALLBACK_LOB_ID || !someLineMissingLob(options)) {
    return undefined;
  }
  return {
    buildOptions: { ...options, applyLobFallback: true },
    fallbackLabel: 'fallback line of business',
  };
}

function getLineOfBusinessFillRetryBuildOptions(
  options: buildSubmitInvoiceDataOptions
): { buildOptions: buildSubmitInvoiceDataOptions; fallbackLabel: string } | undefined {
  return getRelatedLobRetryBuildOptions(options) ?? getFallbackLobRetryBuildOptions(options);
}

async function getValidationFallbackField(
  error: unknown,
  validationError: string,
  options: buildSubmitInvoiceDataOptions
): Promise<FallbackField | undefined> {
  const retryableFallbackFields = getRetryableFallbackFields(options);
  if (retryableFallbackFields.length === 0) {
    debug('No unused fallback values are available for this validation fault; skipping fallback retry', {
      validationError,
    });
    return undefined;
  }

  const validationText = collectWorkdayValidationErrorText(error) || validationError;
  const validation = parseWorkdayValidationDetails(error) ?? { message: validationError };

  if (isRequiredLineOfBusinessWorktagError(validationText)) {
    if (getLineOfBusinessFillRetryBuildOptions(options)) {
      debug('Validation requires Line of Business related worktags; retrying without classifier');
      return 'worktag:lob';
    }
    debug('Validation requires Line of Business related worktags but fill options are exhausted; skipping omit retry');
    return undefined;
  } else if (
    isLineOfBusinessRelatedWorktagError(validationText)
    && retryableFallbackFields.includes('worktag:lob')
  ) {
    debug('Validation is a Line of Business related-worktag restriction; retrying without classifier');
    return 'worktag:lob';
  }

  try {
    const decision = await classifyWorkdayValidationField({
      validation: {
        ...validation,
        message: validation.message || validationText,
      },
      allowedRetryFields: retryableFallbackFields,
    });

    if (decision.retryField !== 'unknown') {
      return decision.retryField;
    }

    return undefined;
  } catch (classificationError) {
    debug('Unable to classify Workday validation field; skipping fallback retry', {
      validationError,
      classificationError,
    });
    return undefined;
  }
}

function getFallbackRetryBuildOptions(
  options: buildSubmitInvoiceDataOptions,
  field: FallbackField
): { buildOptions: buildSubmitInvoiceDataOptions; fallbackLabel: string } | undefined {
  const defaultSupplierWID = getConfiguredDefaultSupplierWID(options);

  if (
    field === 'supplier'
    &&
    defaultSupplierWID
    && options.supplierWID !== defaultSupplierWID
  ) {
    return {
      buildOptions: {
        ...options,
        supplierWID: undefined,
        defaultSupplierWID,
      },
      fallbackLabel: 'default supplier',
    };
  }

  if (
    field === 'invoiceDate'
    && normalizeInvoiceDate(options.invoiceDate)
  ) {
    return {
      buildOptions: {
        ...options,
        invoiceDate: undefined,
      },
      fallbackLabel: 'default invoice date',
    };
  }

  if (
    field === 'paymentTerms'
    &&
    process.env.FALLBACK_PAYMENT_TERMS_ID
    && options.paymentTermsWID !== process.env.FALLBACK_PAYMENT_TERMS_ID
  ) {
    return {
      buildOptions: {
        ...options,
        paymentTermsWID: process.env.FALLBACK_PAYMENT_TERMS_ID,
      },
      fallbackLabel: 'fallback payment terms',
    };
  }

  if (field === 'worktag:fund' && !options.applyFundFallback && process.env.FALLBACK_FUND_ID) {
    return {
      buildOptions: { ...options, applyFundFallback: true },
      fallbackLabel: 'fallback fund',
    };
  }

  if (field === 'worktag:costCenter' && !options.applyCostCenterFallback && process.env.FALLBACK_COST_CENTER_ID) {
    return {
      buildOptions: { ...options, applyCostCenterFallback: true },
      fallbackLabel: 'fallback cost center',
    };
  }

  if (field === 'worktag:spendCategory' && !options.applySpendCategoryFallback && process.env.FALLBACK_SPEND_CATEGORY_ID) {
    return {
      buildOptions: { ...options, applySpendCategoryFallback: true },
      fallbackLabel: 'fallback spend category',
    };
  }

  if (field === 'worktag:event' && !options.omitEventWorktag && options.finalLines?.some(l => l.eventId || l.eventWid)) {
    return {
      buildOptions: { ...options, omitEventWorktag: true },
      fallbackLabel: 'omitted Event worktag',
    };
  }

  if (field === 'worktag:lob') {
    const fillRetry = getLineOfBusinessFillRetryBuildOptions(options);
    if (fillRetry) return fillRetry;

    if (!options.omitLobWorktag && options.finalLines?.some(l => l.lineOfBusinessId)) {
      return {
        buildOptions: { ...options, omitLobWorktag: true },
        fallbackLabel: 'omitted Line of Business worktag',
      };
    }
  }

  return undefined;
}

function buildSubmitInvoiceData(options: buildSubmitInvoiceDataOptions): any {
  const { currentInvoice, supplierWID, defaultSupplierWID, companyWID, companyReferenceType, workQueueTags, notes, memo, invoiceDate, paymentTermsWID, extractedAmountDue, suppliersInvoiceNumber, extractedFreightAmount, extractedTaxAmount, filterInvoiceLines, finalLines, applyFundFallback, applyCostCenterFallback, applySpendCategoryFallback, omitEventWorktag, omitLobWorktag, applyRelatedLob, currencyWID, attachment, relatedLobByCostCenter } = options;
  const controlAmountTotal = extractedAmountDue
    ? (parseExtractedAmount(extractedAmountDue) ?? currentInvoice.Control_Amount_Total)
    : currentInvoice.Control_Amount_Total;
  const providedFinalLines = finalLines !== undefined;
  // strong-soap can return a single line as an object, not an array.
  const normalizedFinalLines = providedFinalLines ? ([] as any[]).concat(finalLines as any) : [];
  const splitFinalLines = providedFinalLines ? splitFreightLines(normalizedFinalLines) : undefined;
  const merchandiseFinalLines = splitFinalLines?.merchandiseLines ?? [];
  const recoveredFreightAmount = splitFinalLines?.freightAmountFromLines;

  const ocrLines = ([] as any[]).concat(currentInvoice.Invoice_Line_Replacement_Data ?? []);
  const invoiceHadExistingLines = ocrLines.length > 0;
  const splitOcrLines = ocrLines.length ? splitFreightLines(ocrLines) : undefined;
  const merchandiseOcrLines = splitOcrLines?.merchandiseLines ?? (!providedFinalLines ? ocrLines : undefined);

  const freightAmount = extractedFreightAmount
    ? (parseExtractedAmount(extractedFreightAmount) ?? currentInvoice.Freight_Amount ?? recoveredFreightAmount ?? splitOcrLines?.freightAmountFromLines)
    : (currentInvoice.Freight_Amount ?? recoveredFreightAmount ?? splitOcrLines?.freightAmountFromLines);
  const taxAmount = extractedTaxAmount
    ? (parseExtractedAmount(extractedTaxAmount) ?? currentInvoice.Tax_Amount ?? 0)
    : (currentInvoice.Tax_Amount ?? 0);

  const fallbackFundId = process.env.FALLBACK_FUND_ID;
  const fallbackCostCenterId = process.env.FALLBACK_COST_CENTER_ID;
  const fallbackLobId = process.env.FALLBACK_LOB_ID;

  const resolvedSupplierWID = supplierWID ?? defaultSupplierWID;
  const supplierRef = resolvedSupplierWID
    ? createReference('WID', resolvedSupplierWID)
    : currentInvoice.Supplier_Reference;

  const fallbackFundRef = fallbackFundId ? createReference('Fund_ID', fallbackFundId) : null;
  const fallbackCostCenterRef = fallbackCostCenterId ? createReference('Cost_Center_Reference_ID', fallbackCostCenterId) : null;
  const defaultFallbackWorktags = [
    ...(fallbackFundRef ? [fallbackFundRef] : []),
    ...(fallbackCostCenterRef ? [fallbackCostCenterRef] : []),
  ];

  const paymentTermsRef = paymentTermsWID
    ? createReference('Payment_Terms_ID', paymentTermsWID)
    : currentInvoice.Payment_Terms_Reference;

  const fallbackLobIds = new Set(fallbackLobExcludeIds());
  const isFallbackLobId = (id?: string | null): boolean => Boolean(id && fallbackLobIds.has(id));
  const stripFallbackLobWorktags = (worktags: any[]): any[] => worktags.filter((tag: any) =>
    ([] as any[]).concat(tag.ID ?? []).every((id: any) => !fallbackLobIds.has(id?.$value ?? id?.value))
  );

  const withFallbackWorktags = (
    worktags: any[],
    costCenterId?: string | null,
    explicitLineOfBusinessId?: string | null
  ): any[] => {
    const replaceTypes = new Set([
      ...(applyFundFallback && fallbackFundRef ? ['Fund_ID'] : []),
      ...(applyCostCenterFallback && fallbackCostCenterRef ? ['Cost_Center_Reference_ID'] : []),
    ]);

    let result = worktags;
    if (replaceTypes.size > 0) {
      const remaining = worktags.filter((t: any) =>
        ([] as any[]).concat(t.ID ?? []).every((id: any) => !replaceTypes.has(id.$attributes?.type))
      );
      result = [
        ...remaining,
        ...(applyFundFallback && fallbackFundRef ? [fallbackFundRef] : []),
        ...(applyCostCenterFallback && fallbackCostCenterRef ? [fallbackCostCenterRef] : []),
      ];
    } else if (defaultFallbackWorktags.length) {
      const existingTypes = new Set(
        worktags.flatMap((t: any) =>
          ([] as any[]).concat(t.ID ?? []).map((id: any) => id.$attributes?.type)
        ).filter(Boolean)
      );
      const additions = defaultFallbackWorktags.filter(t => !existingTypes.has(t.ID[0].$attributes?.type));
      result = additions.length ? [...worktags, ...additions] : worktags;
    }

    if (!omitLobWorktag) {
      const related = relatedLobByCostCenter?.get(costCenterId ?? '');
      const extractedLob = extractLineOfBusinessId(result);
      const hasRealLineOfBusiness = (
        Boolean(explicitLineOfBusinessId) && !isFallbackLobId(explicitLineOfBusinessId)
      ) || (
        Boolean(extractedLob) && !isFallbackLobId(extractedLob)
      ) || worktagsIncludeLineOfBusiness(stripFallbackLobWorktags(result), related);

      if (!hasRealLineOfBusiness) {
        const relatedLobId = resolveRelatedLobId(
          related,
          costCenterId,
          fallbackCostCenterId,
          fallbackLobExcludeIds(),
          { anyAllowed: Boolean(applyRelatedLob) }
        );
        const lobId = relatedLobId ?? fallbackLobId;
        if (lobId) {
          const lobRef = relatedLobSoapReference(related, lobId);
          result = [...stripFallbackLobWorktags(result), createReference(lobRef.type, lobRef.value)];
        }
      }
    }
    return result;
  };

  const mappedMerchandiseFinalLines = merchandiseFinalLines.map(line => {
    const worktags = withFallbackWorktags([
      ...(line.fundId ? [createReference('Fund_ID', line.fundId)] : []),
      ...(line.costCenterId ? [createReference('Cost_Center_Reference_ID', line.costCenterId)] : []),
      ...(!omitLobWorktag && line.lineOfBusinessId ? (() => {
        const lobRef = relatedLobSoapReference(
          relatedLobByCostCenter?.get(line.costCenterId ?? ''),
          line.lineOfBusinessId
        );
        return [createReference(lobRef.type, lobRef.value)];
      })() : []),
      ...(!omitEventWorktag ? (line.eventWid ? [createReference('WID', line.eventWid)] : line.eventId ? [createReference('Organization_Reference_ID', line.eventId)] : []) : []),
    ], line.costCenterId, line.lineOfBusinessId);
    const isDiscountOverride = line.hasDiscount === true;
    return {
      Line_Order: line.lineOrder,
      Item_Description: line.description,
      ...(isDiscountOverride
        ? {
            Quantity: 0,
            Unit_Cost: 0,
            ...(line.extendedAmount != null && { Extended_Amount: line.extendedAmount }),
          }
        : {
            Quantity: line.quantity ?? 1,
            ...(line.unitCost != null && { Unit_Cost: line.unitCost }),
            ...(line.extendedAmount != null && { Extended_Amount: line.extendedAmount }),
          }
      ),
      ...(worktags.length && { Worktags_Reference: worktags }),
      ...((applySpendCategoryFallback ? process.env.FALLBACK_SPEND_CATEGORY_ID : line.spendCategoryId) && {
        Spend_Category_Reference: createReference('Spend_Category_ID', applySpendCategoryFallback ? process.env.FALLBACK_SPEND_CATEGORY_ID! : line.spendCategoryId!),
      }),
      ...(line.shipToAddressId && { 'Ship_To_Address_Reference': createReference('Address_ID', line.shipToAddressId) }),
      ...(!isDiscountOverride && line.purchaseOrderLineId && { Purchase_Order_Line_Reference: createReference('Purchase_Order_Line_ID', line.purchaseOrderLineId) }),
      ...(line.memo && { Memo: line.memo }),
    };
  });

  const mappedMerchandiseOcrLines = merchandiseOcrLines
    ?.map(({ Tax_Data: _Tax_Data, ...line }: any) => {
      const defaultSpendCategoryId = process.env.FALLBACK_SPEND_CATEGORY_ID;
      const applySpendCategory = defaultSpendCategoryId && (
        applySpendCategoryFallback
        || (filterInvoiceLines && !line.Spend_Category_Reference && !line.Item_Reference)
      );
      return {
        ...line,
        Worktags_Reference: withFallbackWorktags(([] as any[]).concat(line.Worktags_Reference ?? []), extractLineCostCenterId(line)),
        ...(applySpendCategory && {
          Spend_Category_Reference: createReference('Spend_Category_ID', defaultSpendCategoryId!),
        }),
      };
    });

  // Create has no OCR lines, so an empty merchandise list omits Invoice_Line_Replacement_Data.
  // Update falls back to OCR merchandise (freight already stripped) so all-freight finalLines
  // do not wipe goods. strong-soap drops empty repeating elements, so [] is the same as omit;
  // when OCR is also all freight, always send a remainder Invoice line so the shipping row
  // is actually replaced (amount may be 0 when control equals freight plus tax).
  let invoiceLines = providedFinalLines
    ? (mappedMerchandiseFinalLines.length > 0
        ? mappedMerchandiseFinalLines
        : (invoiceHadExistingLines ? (mappedMerchandiseOcrLines ?? []) : undefined))
    : mappedMerchandiseOcrLines;

  if (invoiceHadExistingLines && Array.isArray(invoiceLines) && invoiceLines.length === 0) {
    const soapAmount = (value: unknown): number | undefined => {
      if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value * 100) / 100;
      if (typeof value === 'string') return parseExtractedAmount(value);
      return undefined;
    };
    const control = soapAmount(controlAmountTotal);
    const freight = soapAmount(freightAmount) ?? 0;
    const tax = soapAmount(taxAmount) ?? 0;
    if (control != null) {
      const remainder = Math.max(0, Math.round((control - freight - tax) * 100) / 100);
      const remainderWorktags = withFallbackWorktags([]);
      const fallbackSpendCategoryId = (filterInvoiceLines || applySpendCategoryFallback)
        ? process.env.FALLBACK_SPEND_CATEGORY_ID
        : undefined;
      invoiceLines = [{
        Line_Order: 1,
        Item_Description: 'Invoice',
        Quantity: 1,
        Unit_Cost: remainder,
        Extended_Amount: remainder,
        ...(remainderWorktags.length && { Worktags_Reference: remainderWorktags }),
        ...(fallbackSpendCategoryId && {
          Spend_Category_Reference: createReference('Spend_Category_ID', fallbackSpendCategoryId),
        }),
      }];
    }
  }

  return {
    Submit: false,
    Company_Reference: companyWID
      ? createReference(companyReferenceType ?? 'WID', companyWID)
      : currentInvoice.Company_Reference,
    Currency_Reference: currencyWID
      ? createReference('Currency_ID', currencyWID)
      : currentInvoice.Currency_Reference ?? createReference('Currency_ID', 'USD'),
    Invoice_Date: resolveInvoiceDate(currentInvoice, invoiceDate),
    ...(currentInvoice.Invoice_Received_Date && { Invoice_Received_Date: currentInvoice.Invoice_Received_Date }),

    ...(supplierRef && { Supplier_Reference: supplierRef }),
    Invoice_Number: currentInvoice.Invoice_Number,
    ...(suppliersInvoiceNumber && { Suppliers_Invoice_Number: suppliersInvoiceNumber }),
    Control_Amount_Total: controlAmountTotal,
    Tax_Amount: taxAmount,
    Default_Tax_Option_Reference: { ID: [{ $attributes: { type: 'Tax_Option_ID' }, $value: 'ENTER_TAX_DUE' }] },
    ...(freightAmount && { Freight_Amount: freightAmount }),
    ...(currentInvoice.Other_Charges && { Other_Charges: currentInvoice.Other_Charges }),
    ...(currentInvoice.Discount_Amount_Override && { Discount_Amount_Override: currentInvoice.Discount_Amount_Override }),

    ...(currentInvoice['Ship-To_Address_Reference'] && { 'Ship-To_Address_Reference': currentInvoice['Ship-To_Address_Reference'] }),

    ...(currentInvoice.On_Hold !== undefined && { On_Hold: currentInvoice.On_Hold }),
    ...(currentInvoice.Prepaid !== undefined && { Prepaid: currentInvoice.Prepaid }),

    // Omit Currency_Rate_Data when Rate_Override is false — we never provide custom rates,
    // and sending this block causes Workday to validate Ledger_Currency against the company
    // setup, which fails for placeholder companies like Default_OCR_Company.
    ...(currentInvoice.Currency_Rate_Data?.Rate_Override === true && { Currency_Rate_Data: currentInvoice.Currency_Rate_Data }),

    ...(attachment && {
      Attachment_Data: [{
        $attributes: { Content_Type: attachment.contentType, Filename: attachment.fileName },
        File_Content: attachment.base64Content
      }]
    }),

    ...((invoiceLines?.length || (invoiceHadExistingLines && invoiceLines)) && {
      Invoice_Line_Replacement_Data: invoiceLines,
    }),

    ...((currentInvoice.Memo || memo) && { Memo: currentInvoice.Memo || memo }),

    ...(paymentTermsRef && { Payment_Terms_Reference: paymentTermsRef }),
    ...(currentInvoice.Due_Date_Override && { Due_Date_Override: currentInvoice.Due_Date_Override }),

    ...((workQueueTags || notes) && {
      Work_Queue_Information_Data: {
        ...(workQueueTags && (() => {
          const existingTags: WorkQueueTag[] = currentInvoice.Work_Queue_Information_Data?.Work_Queue_Tags_Reference ?? [];
          const existingWids = new Set(existingTags.flatMap(t => t.ID.map(id => id.$value)));
          const newTags = workQueueTags.filter(t => !existingWids.has(t.ID[0].$value));
          return { Work_Queue_Tags_Reference: [...existingTags, ...newTags] };
        })()),
        ...(notes && (() => {
          const existingNotes = currentInvoice.Work_Queue_Information_Data?.Work_Queue_Notes;
          const cleanedNotes = stripRichText(notes);
          const newNotes = existingNotes ? `${existingNotes}\n\nFINANCE AGENT:\n${cleanedNotes}` : `FINANCE AGENT:\n${cleanedNotes}`;
          return { Work_Queue_Notes: newNotes };
        })())
      }
    })
  };
}

const MAX_SUPPLIER_INVOICE_SUBMIT_ATTEMPTS = 3;

export type SupplierInvoiceSubmitPriorFailure = {
  attempt: number;
  fallback?: string;
  message: string;
};

type SanitizedSoapError = Error & {
  priorFailures?: SupplierInvoiceSubmitPriorFailure[];
};

interface SubmitSupplierInvoiceRequest {
  Submit_Supplier_Invoice_Request: {
    Supplier_Invoice_Reference?: {
      ID: Array<{ $attributes: { type: string }; $value: string }>;
    };
    Supplier_Invoice_Data: Record<string, unknown>;
  };
}

interface ResourceManagementClient {
  Submit_Supplier_Invoice: (
    request: SubmitSupplierInvoiceRequest,
    callback: (err: unknown, result: unknown) => void
  ) => void;
  lastRequest?: string;
  lastRequestHeaders?: Record<string, unknown>;
}

interface SubmitSupplierInvoiceWithRepairOptions {
  client: ResourceManagementClient;
  workdayConfig: WorkdayConfig;
  invoiceWorkdayID: string | undefined;
  currentInvoice: any;
  buildOptions: buildSubmitInvoiceDataOptions;
  buildNotes: (appliedFallbacks: AppliedFallback[]) => string;
  operationName: string;
  submitLogMessage: string;
  requestDebugLabel?: string;
}

// invoiceWorkdayID undefined => create a new Supplier Invoice; provided => update the existing one
function createSubmitSupplierInvoiceRequest(
  invoiceWorkdayID: string | undefined,
  invoiceData: Record<string, unknown>
): SubmitSupplierInvoiceRequest {
  return {
    Submit_Supplier_Invoice_Request: {
      ...(invoiceWorkdayID && {
        Supplier_Invoice_Reference: {
          ID: [{ $attributes: { type: 'WID' }, $value: invoiceWorkdayID }]
        }
      }),
      Supplier_Invoice_Data: invoiceData
    }
  };
}

function serializeSubmitSupplierInvoiceRequest(request: SubmitSupplierInvoiceRequest): string {
  return JSON.stringify(request);
}

function soapFaultMessage(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (!error || typeof error !== 'object') {
    return 'Workday SOAP error';
  }

  const soapError = error as {
    message?: string;
    faultstring?: string;
    faultString?: string;
    body?: unknown;
  };
  const fromFields = [soapError.message, soapError.faultstring, soapError.faultString]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  if (fromFields) {
    return fromFields.trim();
  }

  if (typeof soapError.body === 'string') {
    const faultstring = soapError.body.match(/<faultstring>([^<]*)<\/faultstring>/i)?.[1]?.trim();
    if (faultstring) return faultstring;
    const detailMessage = soapError.body.match(/<(?:\w+:)?Detail_Message>([^<]*)<\/(?:\w+:)?Detail_Message>/i)?.[1]?.trim();
    if (detailMessage) return detailMessage;
  }

  return 'Workday SOAP error';
}

function summarizeSoapError(error: unknown): {
  name: string;
  message: string;
  statusCode?: number;
} {
  const soapError = error as {
    name?: string;
    response?: { statusCode?: number };
  };
  const humanMessage = humanWorkdayValidationMessage(error);

  return {
    name: soapError?.name ?? 'Error',
    message: humanMessage || soapFaultMessage(error),
    statusCode: soapError?.response?.statusCode
  };
}

function priorFailureMessage(error: unknown): string {
  return humanWorkdayValidationMessage(error);
}

function appendPriorFailure(
  priorFailures: SupplierInvoiceSubmitPriorFailure[],
  attemptNumber: number,
  error: unknown,
  appliedFallbacks: Array<{ label: string; dueToValidationError?: boolean }>
): void {
  const fallbackLabel = appliedFallbacks.find(fallback => fallback.dueToValidationError)?.label;
  priorFailures.push({
    attempt: attemptNumber,
    ...(fallbackLabel ? { fallback: fallbackLabel } : {}),
    message: priorFailureMessage(error),
  });
}

function sanitizeSoapError(
  error: unknown,
  priorFailures?: SupplierInvoiceSubmitPriorFailure[]
): SanitizedSoapError {
  const summary = summarizeSoapError(error);
  const sanitizedError = new Error(summary.message) as SanitizedSoapError;
  sanitizedError.name = summary.name;
  if (priorFailures && priorFailures.length > 1) {
    sanitizedError.priorFailures = priorFailures;
  }
  return sanitizedError;
}

function submitRequestHasAttachmentData(request: SubmitSupplierInvoiceRequest): boolean {
  return Boolean(request.Submit_Supplier_Invoice_Request.Supplier_Invoice_Data.Attachment_Data);
}

function redactOutboundHttpHeaders(
  headers: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!headers) return undefined;

  return Object.fromEntries(Object.entries(headers).map(([key, value]) => {
    if (key.toLowerCase() !== 'authorization') return [key, value];
    const scheme = String(value ?? '').split(/\s+/)[0] || 'present';
    return [key, `${scheme} <redacted>`];
  }));
}

function extractSoapEnvelopeHeaderXml(envelopeXml: string | undefined): string | undefined {
  const match = envelopeXml?.match(/<(?:\w+:)?Header\b[^>]*>[\s\S]*?<\/(?:\w+:)?Header>/i);
  return match?.[0];
}

function logAttachmentSubmitDiagnostics(
  client: ResourceManagementClient,
  request: SubmitSupplierInvoiceRequest
): void {
  if (!submitRequestHasAttachmentData(request)) return;

  debug(
    'Submit_Supplier_Invoice outbound HTTP headers (attachment present)',
    redactOutboundHttpHeaders(client.lastRequestHeaders)
  );
  debug(
    'Submit_Supplier_Invoice SOAP envelope Header (attachment present)',
    extractSoapEnvelopeHeaderXml(client.lastRequest) ?? '<none>'
  );
}

async function submitSupplierInvoiceSoap(
  client: ResourceManagementClient,
  request: SubmitSupplierInvoiceRequest,
  submitLogMessage: string
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    debug(submitLogMessage);
    client.Submit_Supplier_Invoice(request, (err: unknown, result: unknown) => {
      logAttachmentSubmitDiagnostics(client, request);
      debug('Submit_Supplier_Invoice request sent', {
        requestBytes: Buffer.byteLength(client.lastRequest ?? '', 'utf8')
      });
      if (err) {
        debug('Error from Workday SOAP (Submit_Supplier_Invoice)', summarizeSoapError(err));
        return reject(err);
      }
      debug('Workday SOAP update response received');
      resolve(result);
    });
  });
}

async function submitSupplierInvoiceWithRepair({
  client,
  workdayConfig,
  invoiceWorkdayID,
  buildOptions,
  buildNotes,
  operationName,
  submitLogMessage,
  requestDebugLabel,
}: SubmitSupplierInvoiceWithRepairOptions): Promise<{
  result: unknown;
  finalBuildOptions: buildSubmitInvoiceDataOptions;
  priorFailures: SupplierInvoiceSubmitPriorFailure[];
}> {
  const invoiceLabel = invoiceWorkdayID ?? '(new invoice)';
  const relatedLines = linesWithRelatedLob(buildOptions);
  let attemptBuildOptions = relatedLines
    ? { ...buildOptions, finalLines: relatedLines }
    : { ...buildOptions };
  const failedRequestFingerprints = new Set<string>();
  const validationTriggeredFields = new Set<FallbackField>();
  const priorFailures: SupplierInvoiceSubmitPriorFailure[] = [];

  for (let attemptNumber = 1; attemptNumber <= MAX_SUPPLIER_INVOICE_SUBMIT_ATTEMPTS; attemptNumber += 1) {
    const appliedFallbacks = getAppliedFallbacks(attemptBuildOptions).map(f =>
      validationTriggeredFields.has(f.field) ? { ...f, dueToValidationError: true as const } : f
    );
    const optionsWithNotes = { ...attemptBuildOptions, notes: buildNotes(appliedFallbacks) };
    const invoiceData = buildSubmitInvoiceData(optionsWithNotes) as Record<string, unknown>;
    const request = createSubmitSupplierInvoiceRequest(invoiceWorkdayID, invoiceData);

    if (requestDebugLabel) {
      debug(requestDebugLabel, JSON.stringify(request, null, 2));
    }

    try {
      const result = await submitSupplierInvoiceSoap(client, request, submitLogMessage);
      return { result, finalBuildOptions: attemptBuildOptions, priorFailures };
    } catch (error) {
      if (!isWorkdayValidationError(error)) {
        appendPriorFailure(priorFailures, attemptNumber, error, appliedFallbacks);
        throw sanitizeSoapError(error, priorFailures);
      }

      const validationError = summarizeValidationError(error);
      appendPriorFailure(priorFailures, attemptNumber, error, appliedFallbacks);
      if (isLineOfBusinessRelatedWorktagError(error) || isLineOfBusinessRelatedWorktagError(validationError)) {
        attemptBuildOptions = await ensureRelatedLobByCostCenter(workdayConfig, attemptBuildOptions);
      }
      const validationFallbackField = await getValidationFallbackField(error, validationError, attemptBuildOptions);
      failedRequestFingerprints.add(serializeSubmitSupplierInvoiceRequest(request));
      const appliedFallbacksForField = validationFallbackField
        ? appliedFallbacks.filter(fallback => fallback.field === validationFallbackField)
        : [];

      if (appliedFallbacksForField.length > 0) {
        debug(
          `Validation fault occurred after applying fallback/default value for invoice ${invoiceLabel}; skipping repair retries`,
          { operationName, appliedFallbacks: appliedFallbacksForField.map(fallback => fallback.label), validationError }
        );
        throw sanitizeSoapError(error, priorFailures);
      }

      if (attemptNumber === MAX_SUPPLIER_INVOICE_SUBMIT_ATTEMPTS) {
        throw sanitizeSoapError(error, priorFailures);
      }

      const fallbackRetry = validationFallbackField
        ? getFallbackRetryBuildOptions(attemptBuildOptions, validationFallbackField)
        : undefined;
      if (!fallbackRetry) {
        debug(
          `Validation fault did not match a configured fallback/default retry for invoice ${invoiceLabel}; skipping repair retries`,
          { operationName, appliedFallbacks: appliedFallbacks.map(fallback => fallback.label), validationError }
        );
        throw sanitizeSoapError(error, priorFailures);
      }

      const nextBuildOptions = fallbackRetry.buildOptions;
      const nextInvoiceData = buildSubmitInvoiceData(nextBuildOptions) as Record<string, unknown>;
      const nextRequest = createSubmitSupplierInvoiceRequest(invoiceWorkdayID, nextInvoiceData);
      const nextRequestFingerprint = serializeSubmitSupplierInvoiceRequest(nextRequest);

      if (failedRequestFingerprints.has(nextRequestFingerprint)) {
        debug(
          `Fallback/default retry repeated a previously failed payload for invoice ${invoiceLabel}; skipping repair retries`,
          { operationName, fallbackLabel: fallbackRetry.fallbackLabel, validationError }
        );
        throw sanitizeSoapError(error, priorFailures);
      }

      attemptBuildOptions = nextBuildOptions;
      validationTriggeredFields.add(validationFallbackField!);
      debug(
        `Retrying Supplier Invoice submit (${attemptNumber + 1}/${MAX_SUPPLIER_INVOICE_SUBMIT_ATTEMPTS}) with ${fallbackRetry.fallbackLabel}`,
        { operationName, validationError }
      );
    }
  }

  const exceeded = new Error(`Exceeded retry loop while submitting supplier invoice ${invoiceLabel}`) as SanitizedSoapError;
  if (priorFailures.length > 1) {
    exceeded.priorFailures = priorFailures;
  }
  throw exceeded;
}


function createWorkQueueTag(tagId: string): WorkQueueTag {
  return {
    ID: [{ $attributes: { type: 'Work_Queue_Tag_ID' }, $value: tagId }]
  };
}

export async function getSupplierInvoiceWithAttachments(
  context: { workdayConfig: WorkdayConfig; s3Config: { bucketName: string } },
  workdayID: string
): Promise<{
  invoice: WorkdayInvoice;
  presignedAttachments: PresignedAttachment[];
}> {
  debug('Creating Workday SOAP client for invoice retrieval');
  debug(`WorkdayID: ${workdayID}`);
  debug(`Domain: ${context.workdayConfig.domain}`);
  debug(`Tenant: ${context.workdayConfig.tenant}`);

  const client = await buildResourceManagementClient(context);

  const soapResponse = await new Promise<SupplierInvoiceSoapResponse>((resolve, reject) => {
    const request = {
      Get_Supplier_Invoices_Request: {
        Request_References: {
          Supplier_Invoice_Reference: {
            ID: [{ $attributes: { type: 'WID' }, $value: workdayID }]
          }
        },
        Response_Group: {
          Include_Reference: true,
          Include_Attachment_Data: true
        }
      }
    };

    debug('Requesting Supplier Invoice with attachments from Workday');
    client.Get_Supplier_Invoices(request, (err: any, result: any) => {
      if (err) {
        debug('Error from Workday SOAP (Get_Supplier_Invoices):', err);
        return reject(err);
      }
      debug('Workday SOAP response received');
      debug('Full SOAP response:', JSON.stringify(result, null, 2));
      resolve(result);
    });
  });

  // Extract invoice data
  const supplierInvoiceArray = soapResponse?.Response_Data?.Supplier_Invoice;

  if (!supplierInvoiceArray || !Array.isArray(supplierInvoiceArray) || supplierInvoiceArray.length === 0) {
    throw new Error(`No invoice found for workdayID: ${workdayID}`);
  }

  const supplierInvoice = supplierInvoiceArray[0];

  const invoiceDataArray = supplierInvoice?.Supplier_Invoice_Data;
  const invoice = (Array.isArray(invoiceDataArray) && invoiceDataArray.length > 0)
    ? invoiceDataArray[0]
    : {};

  debug('Invoice data from SOAP', invoice);

  // Process attachments: upload them to S3 and preserve metadata for AI inputs
  const processedAttachments: PresignedAttachment[] = [];
  const attachmentData = invoice.Attachment_Data;

  if (attachmentData) {
    // Handle both single attachment object and array of attachments
    const attachments = Array.isArray(attachmentData) ? attachmentData : [attachmentData];

    for (let i = 0; i < attachments.length; i++) {
      const attachment = attachments[i];
      try {
        // Convert base64 content to buffer
        const buffer = Buffer.from(attachment.File_Content || '', 'base64');
        const contentType = attachment.$attributes?.Content_Type || 'application/octet-stream';
        const fileName = attachment.$attributes?.Filename || `attachment-${i}`;

        const downloadedAttachment: DownloadedAttachment = {
          id: `${workdayID}-${i}`,
          fileName: fileName,
          contentType: contentType,
          buffer: buffer,
          size: buffer.length
        };

        const { uploadAttachmentToS3 } = await import('./s3.js');
        const presignedAttachment = await uploadAttachmentToS3(context.s3Config, downloadedAttachment, workdayID);

        processedAttachments.push({
          id: presignedAttachment.id,
          fileName: fileName,
          contentType: contentType,
          presignedUrl: presignedAttachment.presignedUrl,
          expiresAt: presignedAttachment.expiresAt,
          s3Key: presignedAttachment.s3Key,
          buffer: buffer
        });

      } catch (attachmentError) {
        debug(`Error processing attachment ${attachment.$attributes?.Filename}:`, attachmentError);
        // Continue with other attachments even if one fails
      }
    }

    // Consolidated attachment processing log with presigned URLs
    const attachmentSummary = processedAttachments.map(att => ({
      fileName: att.fileName,
      contentType: att.contentType,
      presignedUrl: att.presignedUrl
    }));

    debug(`Processed ${processedAttachments.length} attachments:`, attachmentSummary);
  } else {
    debug('No attachments found for this invoice');
  }

  return {
    invoice,
    presignedAttachments: processedAttachments
  };
}

// Get an invoice without attachments (just for testing/simple queries)
export async function getSupplierInvoice(
  context: { workdayConfig: WorkdayConfig },
  workdayID: string
): Promise<any> {
  debug('Fetching Supplier Invoice via SOAP (without attachments)');
  debug(`WorkdayID: ${workdayID}`);

  const client = await buildResourceManagementClient(context);

  const soapResponse = await new Promise<SupplierInvoiceSoapResponse>((resolve, reject) => {
    const request = {
      Get_Supplier_Invoices_Request: {
        Request_References: {
          Supplier_Invoice_Reference: {
            ID: [{ $attributes: { type: 'WID' }, $value: workdayID }]
          }
        },
        Response_Group: {
          Include_Reference: true,
          Include_Attachment_Data: false
        }
      }
    };

    debug('Requesting Supplier Invoice from Workday');
    client.Get_Supplier_Invoices(request, (err: any, result: any) => {
      if (err) {
        debug('Error from Workday SOAP (Get_Supplier_Invoices):', err);
        return reject(err);
      }
      debug('Workday SOAP response received');
      resolve(result);
    });
  });

  const supplierInvoiceRaw = soapResponse?.Response_Data?.Supplier_Invoice;

  if (!supplierInvoiceRaw) {
    throw new Error(`No invoice found for workdayID: ${workdayID}`);
  }

  const supplierInvoice = Array.isArray(supplierInvoiceRaw)
    ? supplierInvoiceRaw[0]
    : supplierInvoiceRaw;

  const invoiceDataRaw = supplierInvoice?.Supplier_Invoice_Data;

  const invoice = Array.isArray(invoiceDataRaw)
    ? (invoiceDataRaw.length > 0 ? invoiceDataRaw[0] : {})
    : (invoiceDataRaw || {});

  debug('Invoice data from SOAP', invoice);

  return invoice;
}

export interface InboundEmailData {
  emailFrom?: string;
  subject?: string;
  plainTextBody?: string;
}

export async function getInboundEmailsForOCRInvoices(
  config: WorkdayConfig
): Promise<Map<string, InboundEmailData>> {
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const toSecond = tomorrow.toISOString().split('T')[0];
  const fromSecond = ninetyDaysAgo.toISOString().split('T')[0];

  const query = `
    SELECT emailFrom, subject, plainTextBody, supplierInvoices
    FROM inboundEmailInDateRange(dataSourceFilter = inboundEmailDateRangeFilterOCR, fromSecond = "${fromSecond}", toSecond = "${toSecond}")
    WHERE hasSupplierInvoice = true
  `;

  debug('Fetching inbound emails for OCR invoices');
  const result = await executeWorkdayQuery(config, query);

  debug(`Email query returned ${result.data?.length || 0} rows`);

  const emailMap = new Map<string, InboundEmailData>();

  if (result.data && Array.isArray(result.data)) {
    for (const row of result.data as any[]) {
      const emailData: InboundEmailData = {
        emailFrom: row.emailFrom,
        subject: row.subject,
        plainTextBody: row.plainTextBody,
      };

      debug('Email row:', {
        emailFrom: row.emailFrom,
        subject: row.subject,
        plainTextBodyLength: row.plainTextBody?.length || 0,
        supplierInvoices: row.supplierInvoices,
      });

      const invoices = row.supplierInvoices;
      if (Array.isArray(invoices)) {
        for (const inv of invoices) {
          debug(`Mapping invoice ID ${inv.id} (descriptor: ${inv.descriptor}) to email`);
          emailMap.set(inv.id, emailData);
        }
      } else if (invoices?.id) {
        debug(`Mapping invoice ID ${invoices.id} (descriptor: ${invoices.descriptor}) to email`);
        emailMap.set(invoices.id, emailData);
      }
    }
  }

  debug(`Built email map with ${emailMap.size} invoice-to-email mappings`);
  return emailMap;
}

export async function getWorkQueueTagWIDs(
  context: { workdayConfig: WorkdayConfig },
  tagReferenceIDs: string[]
): Promise<string[]> {
  debug('Fetching work queue tag WIDs for reference IDs:', tagReferenceIDs);

  const client = await buildResourceManagementClient(context);

  const response = await new Promise<any>((resolve, reject) => {
    const request = {
      Get_Supplier_Invoice_Work_Queue_Tags_Request: {
        Request_References: {
          Supplier_Invoice_Work_Queue_Tag_Reference: tagReferenceIDs.map(tagReferenceID => ({
            ID: [{ $attributes: { type: 'Work_Queue_Tag_ID' }, $value: tagReferenceID }]
          }))
        },
        Response_Group: {
          Include_Reference: true
        }
      }
    };

    debug('Requesting work queue tags from Workday');
    client.Get_Supplier_Invoice_Work_Queue_Tags(request, (err: any, result: any) => {
      if (err) {
        debug('Error from Workday SOAP (Get_Supplier_Invoice_Work_Queue_Tags):', err);
        return reject(err);
      }
      debug('Workday SOAP response received for work queue tags');
      resolve(result);
    });
  });

  const tags = response?.Response_Data?.Supplier_Invoice_Work_Queue_Tag;
  if (!tags || !Array.isArray(tags)) {
    throw new Error(`No work queue tags found for reference IDs: ${tagReferenceIDs.join(', ')}`);
  }

  const wids: string[] = [];
  for (const tag of tags) {
    const reference = tag?.Supplier_Invoice_Work_Queue_Tag_Reference;
    const ids = reference?.ID;
    if (Array.isArray(ids)) {
      const widEntry = ids.find((id: any) => id.$attributes?.type === 'WID');
      if (widEntry?.$value) {
        wids.push(widEntry.$value);
      }
    }
  }

  debug('Resolved work queue tag WIDs:', wids);
  return wids;
}

export interface SubmitSupplierInvoiceUpdateParams {
  invoiceWorkdayID: string;
  supplierWID?: string;
  buildNotes: (appliedFallbacks: AppliedFallback[]) => string;
  memo?: string;
  invoiceDate?: string;
  companyWID?: string;
  extractedAmountDue?: string;
  suppliersInvoiceNumber?: string;
  extractedFreightAmount?: string;
  extractedTaxAmount?: string;
  finalLines?: FinalInvoiceLine[];
  relatedLobByCostCenter?: Map<string, RelatedLob>;
  resolveCostCenterWorkdayIds?: (costCenterIds: string[]) => Promise<Map<string, string>>;
  paymentTermsId?: string;
}

export async function submitSupplierInvoiceUpdate(
  context: { workdayConfig: WorkdayConfig },
  {
    invoiceWorkdayID,
    supplierWID,
    buildNotes,
    memo,
    invoiceDate,
    companyWID,
    extractedAmountDue,
    suppliersInvoiceNumber,
    extractedFreightAmount,
    extractedTaxAmount,
    finalLines,
    relatedLobByCostCenter,
    resolveCostCenterWorkdayIds,
    paymentTermsId
  }: SubmitSupplierInvoiceUpdateParams
): Promise<{
  success: boolean;
  message?: string;
  appliedFallbacks: AppliedFallback[];
  priorFailures?: SupplierInvoiceSubmitPriorFailure[];
}> {
  debug('Updating Supplier Invoice supplier via SOAP');
  debug(`Invoice WorkdayID: ${invoiceWorkdayID}`);
  debug(`Supplier WID: ${supplierWID ?? '(none - using existing or default)'}`);
  debug(`Company override: ${companyWID ? `WID=${companyWID}` : '(none - using existing)'}`);

  debug('Fetching current invoice data');
  const currentInvoice = await getSupplierInvoice(context, invoiceWorkdayID);

  if (!currentInvoice) {
    throw new Error(`No invoice found for workdayID: ${invoiceWorkdayID}`);
  }

  debug('Current invoice data retrieved - has required fields:', {
    hasCompanyReference: !!currentInvoice.Company_Reference,
    hasCurrencyReference: !!currentInvoice.Currency_Reference,
    hasInvoiceDate: !!currentInvoice.Invoice_Date,
    hasInvoiceNumber: !!currentInvoice.Invoice_Number,
    hasControlAmount: !!currentInvoice.Control_Amount_Total
  });

  const client = await buildResourceManagementClient(context);

  const agentModifiedTagID = process.env.WORKDAY_AGENT_MODIFIED_TAG_WID;
  const workQueueTags = agentModifiedTagID ? [createWorkQueueTag(agentModifiedTagID)] : undefined;

  if (agentModifiedTagID) {
    debug(`Adding agent-modified work queue tag: ${agentModifiedTagID}`);
  }

  const { finalBuildOptions, priorFailures } = await submitSupplierInvoiceWithRepair({
    client: client as ResourceManagementClient,
    workdayConfig: context.workdayConfig,
    invoiceWorkdayID,
    currentInvoice,
    buildOptions: {
      currentInvoice,
      supplierWID,
      companyWID,
      workQueueTags,
      memo,
      invoiceDate,
      extractedAmountDue,
      suppliersInvoiceNumber,
      extractedFreightAmount,
      extractedTaxAmount,
      finalLines,
      relatedLobByCostCenter,
      resolveCostCenterWorkdayIds,
      paymentTermsWID: paymentTermsId,
      filterInvoiceLines: true
    },
    buildNotes,
    operationName: 'submitSupplierInvoiceUpdate',
    submitLogMessage: 'Submitting updated Supplier Invoice to Workday',
  });

  const appliedFallbacks = getAppliedFallbacks(finalBuildOptions);
  debug('Supplier invoice updated successfully', { appliedFallbacks, priorFailures });

  return {
    success: true,
    message: `Successfully updated invoice ${invoiceWorkdayID} with supplier ${supplierWID ?? '(existing)'}`,
    appliedFallbacks,
    ...(priorFailures.length ? { priorFailures } : {}),
  };
}

export interface SubmitNewSupplierInvoiceParams {
  supplierWID?: string;
  companyWID: string;
  companyReferenceType?: string;
  currencyWID?: string;
  buildNotes: (appliedFallbacks: AppliedFallback[]) => string;
  memo?: string;
  invoiceDate?: string;
  extractedAmountDue?: string;
  suppliersInvoiceNumber?: string;
  extractedFreightAmount?: string;
  extractedTaxAmount?: string;
  finalLines: FinalInvoiceLine[];
  relatedLobByCostCenter?: Map<string, RelatedLob>;
  resolveCostCenterWorkdayIds?: (costCenterIds: string[]) => Promise<Map<string, string>>;
  paymentTermsId?: string;
  attachment: { fileName: string; contentType: string; base64Content: string };
}

// Creates a brand-new Supplier Invoice in Workday (no Supplier_Invoice_Reference on the request)
export async function submitNewSupplierInvoice(
  context: { workdayConfig: WorkdayConfig },
  {
    supplierWID,
    companyWID,
    companyReferenceType,
    currencyWID,
    buildNotes,
    memo,
    invoiceDate,
    extractedAmountDue,
    suppliersInvoiceNumber,
    extractedFreightAmount,
    extractedTaxAmount,
    finalLines,
    relatedLobByCostCenter,
    resolveCostCenterWorkdayIds,
    paymentTermsId,
    attachment
  }: SubmitNewSupplierInvoiceParams
): Promise<{
  success: boolean;
  message?: string;
  invoiceWID?: string;
  appliedFallbacks: AppliedFallback[];
  priorFailures?: SupplierInvoiceSubmitPriorFailure[];
}> {
  debug('Creating new Supplier Invoice via SOAP');
  debug(`Supplier WID: ${supplierWID ?? '(none - using default)'}`);
  debug(`Company WID: ${companyWID}`);

  const client = await buildResourceManagementClient(context);

  const agentModifiedTagID = process.env.WORKDAY_AGENT_MODIFIED_TAG_WID;
  const workQueueTags = agentModifiedTagID ? [createWorkQueueTag(agentModifiedTagID)] : undefined;

  if (agentModifiedTagID) {
    debug(`Adding agent-modified work queue tag: ${agentModifiedTagID}`);
  }

  const { result, finalBuildOptions, priorFailures } = await submitSupplierInvoiceWithRepair({
    client: client as ResourceManagementClient,
    workdayConfig: context.workdayConfig,
    invoiceWorkdayID: undefined,
    currentInvoice: {},
    buildOptions: {
      currentInvoice: {},
      supplierWID,
      companyWID,
      companyReferenceType,
      currencyWID,
      workQueueTags,
      memo,
      invoiceDate,
      extractedAmountDue,
      suppliersInvoiceNumber,
      extractedFreightAmount,
      extractedTaxAmount,
      finalLines,
      relatedLobByCostCenter,
      resolveCostCenterWorkdayIds,
      paymentTermsWID: paymentTermsId,
      attachment
    },
    buildNotes,
    operationName: 'submitNewSupplierInvoice',
    submitLogMessage: 'Submitting new Supplier Invoice to Workday',
  });

  const appliedFallbacks = getAppliedFallbacks(finalBuildOptions);
  const invoiceWID = extractIdsByType(result, 'WID')[0];
  debug('Supplier invoice created successfully', { invoiceWID, appliedFallbacks, priorFailures });

  return {
    success: true,
    message: `Successfully created new invoice${invoiceWID ? ` ${invoiceWID}` : ''} with supplier ${supplierWID ?? '(default)'}`,
    invoiceWID,
    appliedFallbacks,
    ...(priorFailures.length ? { priorFailures } : {}),
  };
}

export interface AnnotateSupplierInvoiceParams {
  invoiceWorkdayID: string;
  notes?: string;
  memo?: string;
}

export async function annotateSupplierInvoice(
  context: { workdayConfig: WorkdayConfig },
  {
    invoiceWorkdayID,
    notes,
    memo
  }: AnnotateSupplierInvoiceParams
): Promise<{ success: boolean; message?: string }> {
  debug('Updating Supplier Invoice data (notes/memo) via SOAP');
  debug(`Agent notes: ${notes}`);
  debug(`Invoice WorkdayID: ${invoiceWorkdayID}`);

  debug('Fetching current invoice data');
  const currentInvoice = await getSupplierInvoice(context, invoiceWorkdayID);

  if (!currentInvoice) {
    throw new Error(`No invoice found for workdayID: ${invoiceWorkdayID}`);
  }

  debug('Current invoice data retrieved for update');

  const client = await buildResourceManagementClient(context);

  const agentModifiedTagID = process.env.WORKDAY_AGENT_MODIFIED_TAG_WID;
  const workQueueTags = agentModifiedTagID ? [createWorkQueueTag(agentModifiedTagID)] : undefined;

  if (agentModifiedTagID) {
    debug(`Adding agent-modified work queue tag: ${agentModifiedTagID}`);
  }

  const currentInvoiceDate = normalizeInvoiceDate(currentInvoice.Invoice_Date);
  if (!currentInvoiceDate) {
    throw new Error(`Current invoice date is required to annotate invoice ${invoiceWorkdayID} without changing its date`);
  }

  const invoiceData = buildSubmitInvoiceData({
    currentInvoice,
    workQueueTags,
    notes,
    memo,
    invoiceDate: currentInvoiceDate
  }) as Record<string, unknown>;
  const request = createSubmitSupplierInvoiceRequest(invoiceWorkdayID, invoiceData);
  const updateResponse = await submitSupplierInvoiceSoap(
    client as ResourceManagementClient,
    request,
    'Submitting updated Supplier Invoice to Workday'
  );

  debug('Supplier invoice data updated successfully', updateResponse);

  return {
    success: true,
    message: `Successfully updated invoice ${invoiceWorkdayID} with notes/memo`
  };
}

function getPurchaseOrderData(poResponse: any): any | undefined {
  const purchaseOrderRaw = poResponse?.Response_Data?.Purchase_Order;
  const purchaseOrder = Array.isArray(purchaseOrderRaw) ? purchaseOrderRaw[0] : purchaseOrderRaw;
  const poDataRaw = purchaseOrder?.Purchase_Order_Data;
  return Array.isArray(poDataRaw) ? poDataRaw[0] : poDataRaw;
}

function parsePurchaseOrderCompany(poData: any): PurchaseOrderCompany | undefined {
  const ref = poData?.Company_Reference;
  if (!ref) return undefined;
  const ids = ([] as any[]).concat(ref.ID ?? []);
  const workdayId = ids.find((id: any) => id.$attributes?.type === 'WID')?.$value;
  if (!workdayId) return undefined;
  const descriptor = ref.descriptor
    ?? ref.$attributes?.Descriptor
    ?? ids.find((id: any) => id.$attributes?.type === 'Company_Reference_ID')?.$value
    ?? workdayId;
  return { workdayId, descriptor };
}

export function parsePurchaseOrder(poResponse: any): ParsedPurchaseOrder | undefined {
  const poData = getPurchaseOrderData(poResponse);
  if (!poData?.Document_Number) return undefined;
  return {
    documentNumber: poData.Document_Number,
    company: parsePurchaseOrderCompany(poData),
    lines: parsePurchaseOrderLines(poResponse),
  };
}

export async function loadPurchaseOrder(
  context: { workdayConfig: WorkdayConfig },
  purchaseOrderNumber: string
): Promise<ParsedPurchaseOrder | undefined> {
  try {
    const response = await getPurchaseOrder(context, purchaseOrderNumber);
    const parsed = parsePurchaseOrder(response);
    if (!parsed || parsed.documentNumber !== purchaseOrderNumber) {
      debug(`PO ${purchaseOrderNumber} not found in Workday (returned: ${parsed?.documentNumber ?? 'none'}) - skipping PO processing`);
      return undefined;
    }
    return parsed;
  } catch (poError) {
    debug(`Failed to fetch PO ${purchaseOrderNumber} from Workday - skipping PO processing:`, poError);
    return undefined;
  }
}

export function parsePurchaseOrderLines(poResponse: any): PurchaseOrderLine[] {
  const poData = getPurchaseOrderData(poResponse);

  if (!poData) return [];

  const serviceLines = ([] as any[]).concat(poData.Service_Line_Data ?? []);
  const goodsLines = ([] as any[]).concat(poData.Goods_Line_Data ?? []);

  const purchaseOrderDocumentNumber = poData.Document_Number;

  const extractShipToAddressId = (shipToRef: any): string | null => {
    if (!shipToRef) return null;
    const ids = ([] as any[]).concat(shipToRef.ID ?? []);
    const addressId = ids.find((id: any) => id.$attributes?.type === 'Address_ID');
    if (addressId) return addressId.$value;
    const wid = ids.find((id: any) => id.$attributes?.type === 'WID');
    return wid?.$value ?? null;
  };

  const worktagKey = (worktags: any[]): string =>
    worktags
      .flatMap(wt => ([] as any[]).concat(wt.ID ?? []))
      .filter(id => id.$attributes?.type !== 'WID')
      .map(id => `${id.$attributes?.type}:${id.$value}`)
      .sort()
      .join('|');

  const resolveLineWorktags = (line: any, splitField: string): any[] => {
    const splits = ([] as any[]).concat(line[splitField] ?? []);
    if (!splits.length) return ([] as any[]).concat(line.Worktags_Reference ?? []);
    const firstWorktags = ([] as any[]).concat(splits[0].Worktag_Reference ?? []);
    const firstKey = worktagKey(firstWorktags);
    for (let i = 1; i < splits.length; i++) {
      const splitWorktags = ([] as any[]).concat(splits[i].Worktag_Reference ?? []);
      if (worktagKey(splitWorktags) !== firstKey) return [];
    }
    return firstWorktags;
  };

  const parsedServiceLines: PurchaseOrderLine[] = serviceLines.map((line: any) => ({
    lineOrder: line.Line_Number,
    purchaseOrderLineId: line.Service_Order_Line_ID,
    purchaseOrderDocumentNumber,
    description: line.Description,
    memo: line.Memo,
    spendCategoryReference: line.Resource_Category_Reference,
    extendedAmount: line.Extended_Amount,
    worktagsReference: resolveLineWorktags(line, 'Service_Purchase_Order_Line_Split_Data'),
    shipToAddressId: extractShipToAddressId(line.Ship_To_Address_Reference),
  }));

  const parsedGoodsLines: PurchaseOrderLine[] = goodsLines.map((line: any) => ({
    lineOrder: line.Line_Number,
    purchaseOrderLineId: line.Goods_Purchase_Order_Line_ID,
    purchaseOrderDocumentNumber,
    description: line.Item_Description,
    memo: line.Memo,
    spendCategoryReference: line.Resource_Category_Reference,
    quantity: line.Quantity !== undefined ? Number(line.Quantity) : undefined,
    unitCost: line.Unit_Cost !== undefined ? Number(line.Unit_Cost) : undefined,
    extendedAmount: line.Extended_Amount,
    worktagsReference: resolveLineWorktags(line, 'Goods_Purchase_Order_Line_Split_Data'),
    shipToAddressId: extractShipToAddressId(line.Ship_To_Address_Reference),
  }));

  return [...parsedServiceLines, ...parsedGoodsLines].sort((a, b) => a.lineOrder - b.lineOrder);
}

export async function getPurchaseOrder(
  context: { workdayConfig: WorkdayConfig },
  purchaseOrderNumber: string
): Promise<any> {
  debug(`Fetching Purchase Order: ${purchaseOrderNumber}`);

  const client = await buildResourceManagementClient(context);

  const response = await new Promise<any>((resolve, reject) => {
    const request = {
      Get_Purchase_Orders_Request: {
        Request_References: {
          Purchase_Order_Reference: {
            ID: [{ $attributes: { type: 'Document_Number' }, $value: purchaseOrderNumber }]
          }
        },
        Response_Group: {
          Include_Reference: true,
          Include_Attachment_Data: false
        }
      }
    };

    client.Get_Purchase_Orders(request, (err: any, result: any) => {
      if (err) {
        debug('Error from Workday SOAP (Get_Purchase_Orders):', err);
        return reject(err);
      }
      debug('Get_Purchase_Orders response received');
      resolve(result);
    });
  });

  return response;
}

export async function getAllPaymentTerms(
  context: { workdayConfig: WorkdayConfig }
): Promise<Array<{ paymentTermsId: string; name: string }>> {
  debug('Fetching all Payment Terms from Workday');

  const client = await buildFinancialManagementClient(context);

  const response = await new Promise<any>((resolve, reject) => {
    const request = {
      Get_Payment_Terms_Request: {
        Response_Group: {
          Include_Reference: true
        }
      }
    };

    client.Get_Payment_Terms(request, (err: any, result: any) => {
      if (err) {
        debug('Error from Workday SOAP (Get_Payment_Terms):', err);
        return reject(err);
      }
      debug('Get_Payment_Terms response received');
      resolve(result);
    });
  });

  const paymentTermsArray: any[] = ([] as any[]).concat(response?.Response_Data?.Payment_Term ?? []);

  return paymentTermsArray.flatMap((pt: any) => {
    const ids: any[] = ([] as any[]).concat(pt?.Payment_Term_Reference?.ID ?? []);
    const idEntry = ids.find((id: any) => id.$attributes?.type === 'Payment_Terms_ID');
    const paymentTermsId = idEntry?.$value;
    const name = pt?.Payment_Term_Data?.Payment_Terms_Name;
    if (!paymentTermsId || !name) return [];
    return [{ paymentTermsId, name }];
  });
}
