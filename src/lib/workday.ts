import { debug } from '@pga/logger';
import path from 'path';
import { isWorkdayValidationError, parseWorkdayValidationDetails, summarizeValidationError } from './invoice_validation_failures.js';
import { classifyWorkdayValidationField } from './workday_validation_field_agent.js';
import type { FinalInvoiceLine } from './invoice_lines.js';
import { parseExtractedAmount } from './invoice_lines.js';

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
  wqlQuery: string
): Promise<{ total?: number; data?: unknown[] }> {
  debug(`Executing WQL query on tenant: ${config.tenant}`);
  debug(`Query: ${wqlQuery}`);

  const accessToken = await getAccessToken(config);

  // Start with max limit to get as much as possible in one request
  const initialResult = await fetchWorkdayPage(config, accessToken, wqlQuery, 10000, 0);
  const totalCount = initialResult.total || 0;
  const initialData = initialResult.data || [];

  debug(`Total records available: ${totalCount}, got ${initialData.length} in initial request`);

  // If we got all records in the initial request, return it
  if (totalCount <= 10000) {
    return initialResult;
  }

  // Fetch remaining pages in parallel
  const additionalData = await fetchRemainingPages(config, accessToken, wqlQuery, totalCount, initialData);

  // Combine all data
  const allData = [...initialData, ...additionalData];

  debug(`Successfully fetched ${allData.length} records total`);

  return {
    total: totalCount,
    data: allData
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

      const endpoint = `https://${context.workdayConfig.domain}/ccx/service/${context.workdayConfig.tenant}/Resource_Management/v44.1`;
      client.setEndpoint(endpoint);

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

interface buildSubmitInvoiceDataOptions {
  currentInvoice: any;
  supplierWID?: string;
  defaultSupplierWID?: string;
  companyWID?: string;
  workQueueTags?: WorkQueueTag[];
  notes?: string;
  memo?: string;
  invoiceDate?: string;
  paymentTermsWID?: string;
  applyFallbackWorktags?: boolean;
  extractedAmountDue?: string;
  suppliersInvoiceNumber?: string;
  extractedFreightAmount?: string;
  extractedTaxAmount?: string;
  filterInvoiceLines?: boolean;
  finalLines?: FinalInvoiceLine[];
}

type FallbackField = 'supplier' | 'invoiceDate' | 'paymentTerms' | 'worktags';
const FALLBACK_FIELDS: FallbackField[] = ['supplier', 'invoiceDate', 'paymentTerms', 'worktags'];

export interface AppliedFallback {
  field: FallbackField;
  label: string;
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

function getConfiguredDefaultSupplierWID(options: buildSubmitInvoiceDataOptions): string | undefined {
  return process.env.WORKDAY_DEFAULT_SUPPLIER_WID ?? options.defaultSupplierWID;
}

function getAppliedFallbacks(options: buildSubmitInvoiceDataOptions): AppliedFallback[] {
  const { supplierWID, defaultSupplierWID, invoiceDate, paymentTermsWID, applyFallbackWorktags } = options;
  const fallbacks: AppliedFallback[] = [];
  const configuredDefaultSupplierWID = getConfiguredDefaultSupplierWID(options);

  if (configuredDefaultSupplierWID && (supplierWID === configuredDefaultSupplierWID || (!supplierWID && defaultSupplierWID))) {
    fallbacks.push({ field: 'supplier', label: 'default supplier' });
  }

  if (!normalizeInvoiceDate(invoiceDate)) {
    fallbacks.push({ field: 'invoiceDate', label: 'default invoice date' });
  }

  if (
    process.env.FALLBACK_PAYMENT_TERMS_ID
    && paymentTermsWID === process.env.FALLBACK_PAYMENT_TERMS_ID
  ) {
    fallbacks.push({ field: 'paymentTerms', label: 'fallback payment terms' });
  }

  if (applyFallbackWorktags) {
    fallbacks.push({ field: 'worktags', label: 'fallback worktags' });
  }

  return fallbacks;
}

function getRetryableFallbackFields(options: buildSubmitInvoiceDataOptions): FallbackField[] {
  return FALLBACK_FIELDS.filter(field => getFallbackRetryBuildOptions(options, field));
}

async function getValidationFallbackField(
  error: unknown,
  validationError: string,
  retryableFallbackFields: FallbackField[]
): Promise<FallbackField | undefined> {
  if (retryableFallbackFields.length === 0) {
    debug('No unused fallback values are available for this validation fault; skipping fallback retry', {
      validationError,
    });
    return undefined;
  }

  const validation = parseWorkdayValidationDetails(error) ?? { message: validationError };

  try {
    const decision = await classifyWorkdayValidationField({
      validation,
      allowedRetryFields: retryableFallbackFields,
    });

    if (decision.retryField !== 'unknown') {
      return decision.retryField;
    }

    if (decision.workdayField?.includes('Worktags_Reference') && retryableFallbackFields.includes('worktags')) {
      return 'worktags';
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

  if (
    field === 'worktags'
    && !options.applyFallbackWorktags
    && (process.env.FALLBACK_FUND_ID || process.env.FALLBACK_COST_CENTER_ID)
  ) {
    return {
      buildOptions: {
        ...options,
        applyFallbackWorktags: true,
      },
      fallbackLabel: 'fallback worktags',
    };
  }

  return undefined;
}

function buildSubmitInvoiceData(options: buildSubmitInvoiceDataOptions): any {
  const { currentInvoice, supplierWID, defaultSupplierWID, companyWID, workQueueTags, notes, memo, invoiceDate, paymentTermsWID, extractedAmountDue, suppliersInvoiceNumber, extractedFreightAmount, extractedTaxAmount, filterInvoiceLines, finalLines, applyFallbackWorktags } = options;
  const controlAmountTotal = extractedAmountDue
    ? (parseExtractedAmount(extractedAmountDue) ?? currentInvoice.Control_Amount_Total)
    : currentInvoice.Control_Amount_Total;
  const freightAmount = extractedFreightAmount
    ? (parseExtractedAmount(extractedFreightAmount) ?? currentInvoice.Freight_Amount)
    : currentInvoice.Freight_Amount;
  const taxAmount = extractedTaxAmount
    ? (parseExtractedAmount(extractedTaxAmount) ?? currentInvoice.Tax_Amount ?? 0)
    : (currentInvoice.Tax_Amount ?? 0);

  const fallbackFundId = process.env.FALLBACK_FUND_ID;
  const fallbackCostCenterId = process.env.FALLBACK_COST_CENTER_ID;

  const resolvedSupplierWID = supplierWID ?? defaultSupplierWID;
  const supplierRef = resolvedSupplierWID
    ? createReference('WID', resolvedSupplierWID)
    : currentInvoice.Supplier_Reference;

  const fallbackWorktags = [
    ...(fallbackFundId ? [createReference('Fund_ID', fallbackFundId)] : []),
    ...(fallbackCostCenterId ? [createReference('Cost_Center_Reference_ID', fallbackCostCenterId)] : []),
  ];

  const paymentTermsRef = paymentTermsWID
    ? createReference('Payment_Terms_ID', paymentTermsWID)
    : currentInvoice.Payment_Terms_Reference;

  const withFallbackWorktags = (worktags: any[]): any[] => {
    if (!fallbackWorktags.length) return worktags;
    if (applyFallbackWorktags) {
      const fallbackTypes = new Set(fallbackWorktags.map(t => t.ID[0].$attributes?.type).filter(Boolean));
      const remaining = worktags.filter((t: any) =>
        ([] as any[]).concat(t.ID ?? []).every((id: any) => !fallbackTypes.has(id.$attributes?.type))
      );
      return [...remaining, ...fallbackWorktags];
    }
    const existingTypes = new Set(
      worktags.flatMap((t: any) =>
        ([] as any[]).concat(t.ID ?? []).map((id: any) => id.$attributes?.type)
      ).filter(Boolean)
    );
    const additions = fallbackWorktags.filter(t => !existingTypes.has(t.ID[0].$attributes?.type));
    return additions.length ? [...worktags, ...additions] : worktags;
  };

  const invoiceLines = finalLines?.length
    ? finalLines.map(line => {
      const worktags = withFallbackWorktags([
        ...(line.fundId ? [createReference('Fund_ID', line.fundId)] : []),
        ...(line.costCenterId ? [createReference('Cost_Center_Reference_ID', line.costCenterId)] : []),
        ...(line.lineOfBusinessId ? [createReference('Organization_Reference_ID', line.lineOfBusinessId)] : []),
        ...(line.eventWid ? [createReference('WID', line.eventWid)] : line.eventId ? [createReference('Organization_Reference_ID', line.eventId)] : []),
      ]);
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
        ...(line.spendCategoryId && { Spend_Category_Reference: createReference('Spend_Category_ID', line.spendCategoryId) }),
        ...(line.shipToAddressId && { 'Ship_To_Address_Reference': createReference('Address_ID', line.shipToAddressId) }),
        ...(line.purchaseOrderLineId && { Purchase_Order_Line_Reference: createReference('Purchase_Order_Line_ID', line.purchaseOrderLineId) }),
        ...(line.memo && { Memo: line.memo }),
      };
    })
    : currentInvoice.Invoice_Line_Replacement_Data
      ?.map(({ Tax_Data: _Tax_Data, ...line }: any) => {
        const missingSpendCategory = filterInvoiceLines && !line.Spend_Category_Reference && !line.Item_Reference;
        const defaultSpendCategoryId = process.env.FALLBACK_SPEND_CATEGORY_ID;
        return {
          ...line,
          Worktags_Reference: withFallbackWorktags(([] as any[]).concat(line.Worktags_Reference ?? [])),
          ...(missingSpendCategory && defaultSpendCategoryId && {
            Spend_Category_Reference: createReference('Spend_Category_ID', defaultSpendCategoryId),
          }),
        };
      });

  return {
    Submit: false,
    Company_Reference: companyWID
      ? { ID: [{ $attributes: { type: 'WID' }, $value: companyWID }] }
      : currentInvoice.Company_Reference,
    Currency_Reference: currentInvoice.Currency_Reference,
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

    ...(invoiceLines?.length && { Invoice_Line_Replacement_Data: invoiceLines }),

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

interface SubmitSupplierInvoiceRequest {
  Submit_Supplier_Invoice_Request: {
    Supplier_Invoice_Reference: {
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
}

interface SubmitSupplierInvoiceWithRepairOptions {
  client: ResourceManagementClient;
  invoiceWorkdayID: string;
  currentInvoice: any;
  buildOptions: buildSubmitInvoiceDataOptions;
  buildNotes: (appliedFallbacks: AppliedFallback[]) => string;
  operationName: string;
  submitLogMessage: string;
  requestDebugLabel?: string;
}

function createSubmitSupplierInvoiceRequest(
  invoiceWorkdayID: string,
  invoiceData: Record<string, unknown>
): SubmitSupplierInvoiceRequest {
  return {
    Submit_Supplier_Invoice_Request: {
      Supplier_Invoice_Reference: {
        ID: [{ $attributes: { type: 'WID' }, $value: invoiceWorkdayID }]
      },
      Supplier_Invoice_Data: invoiceData
    }
  };
}

function serializeSubmitSupplierInvoiceRequest(request: SubmitSupplierInvoiceRequest): string {
  return JSON.stringify(request);
}

async function submitSupplierInvoiceSoap(
  client: ResourceManagementClient,
  request: SubmitSupplierInvoiceRequest,
  submitLogMessage: string
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    debug(submitLogMessage);
    client.Submit_Supplier_Invoice(request, (err: unknown, result: unknown) => {
      debug('Submit_Supplier_Invoice XML:', client.lastRequest);
      if (err) {
        debug('Error from Workday SOAP (Submit_Supplier_Invoice):', err);
        return reject(err);
      }
      debug('Workday SOAP update response received');
      resolve(result);
    });
  });
}

async function submitSupplierInvoiceWithRepair({
  client,
  invoiceWorkdayID,
  buildOptions,
  buildNotes,
  operationName,
  submitLogMessage,
  requestDebugLabel,
}: SubmitSupplierInvoiceWithRepairOptions): Promise<{ result: unknown; finalBuildOptions: buildSubmitInvoiceDataOptions }> {
  let attemptBuildOptions = { ...buildOptions };
  const failedRequestFingerprints = new Set<string>();

  for (let attemptNumber = 1; attemptNumber <= MAX_SUPPLIER_INVOICE_SUBMIT_ATTEMPTS; attemptNumber += 1) {
    const appliedFallbacks = getAppliedFallbacks(attemptBuildOptions);
    const optionsWithNotes = { ...attemptBuildOptions, notes: buildNotes(appliedFallbacks) };
    const invoiceData = buildSubmitInvoiceData(optionsWithNotes) as Record<string, unknown>;
    const request = createSubmitSupplierInvoiceRequest(invoiceWorkdayID, invoiceData);

    if (requestDebugLabel) {
      debug(requestDebugLabel, JSON.stringify(request, null, 2));
    }

    try {
      const result = await submitSupplierInvoiceSoap(client, request, submitLogMessage);
      return { result, finalBuildOptions: attemptBuildOptions };
    } catch (error) {
      if (!isWorkdayValidationError(error)) {
        throw error;
      }

      const validationError = summarizeValidationError(error);
      const retryableFallbackFields = getRetryableFallbackFields(attemptBuildOptions);
      const validationFallbackField = await getValidationFallbackField(error, validationError, retryableFallbackFields);
      failedRequestFingerprints.add(serializeSubmitSupplierInvoiceRequest(request));
      const appliedFallbacksForField = validationFallbackField
        ? appliedFallbacks.filter(fallback => fallback.field === validationFallbackField)
        : [];

      if (appliedFallbacksForField.length > 0) {
        debug(
          `Validation fault occurred after applying fallback/default value for invoice ${invoiceWorkdayID}; skipping repair retries`,
          { operationName, appliedFallbacks: appliedFallbacksForField.map(fallback => fallback.label), validationError }
        );
        throw error;
      }

      if (attemptNumber === MAX_SUPPLIER_INVOICE_SUBMIT_ATTEMPTS) {
        throw error;
      }

      const fallbackRetry = validationFallbackField
        ? getFallbackRetryBuildOptions(attemptBuildOptions, validationFallbackField)
        : undefined;
      if (!fallbackRetry) {
        debug(
          `Validation fault did not match a configured fallback/default retry for invoice ${invoiceWorkdayID}; skipping repair retries`,
          { operationName, appliedFallbacks: appliedFallbacks.map(fallback => fallback.label), validationError }
        );
        throw error;
      }

      const nextBuildOptions = fallbackRetry.buildOptions;
      const nextInvoiceData = buildSubmitInvoiceData(nextBuildOptions) as Record<string, unknown>;
      const nextRequest = createSubmitSupplierInvoiceRequest(invoiceWorkdayID, nextInvoiceData);
      const nextRequestFingerprint = serializeSubmitSupplierInvoiceRequest(nextRequest);

      if (failedRequestFingerprints.has(nextRequestFingerprint)) {
        debug(
          `Fallback/default retry repeated a previously failed payload for invoice ${invoiceWorkdayID}; skipping repair retries`,
          { operationName, fallbackLabel: fallbackRetry.fallbackLabel, validationError }
        );
        throw error;
      }

      attemptBuildOptions = nextBuildOptions;
      debug(
        `Retrying Supplier Invoice submit (${attemptNumber + 1}/${MAX_SUPPLIER_INVOICE_SUBMIT_ATTEMPTS}) with ${fallbackRetry.fallbackLabel}`,
        { operationName, validationError }
      );
    }
  }

  throw new Error(`Exceeded retry loop while submitting supplier invoice ${invoiceWorkdayID}`);
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
    paymentTermsId
  }: SubmitSupplierInvoiceUpdateParams
): Promise<{ success: boolean; message?: string; appliedFallbacks: AppliedFallback[] }> {
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

  const { finalBuildOptions } = await submitSupplierInvoiceWithRepair({
    client: client as ResourceManagementClient,
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
      paymentTermsWID: paymentTermsId,
      filterInvoiceLines: true
    },
    buildNotes,
    operationName: 'submitSupplierInvoiceUpdate',
    submitLogMessage: 'Submitting updated Supplier Invoice to Workday',
  });

  const appliedFallbacks = getAppliedFallbacks(finalBuildOptions);
  debug('Supplier invoice updated successfully', { appliedFallbacks });

  return {
    success: true,
    message: `Successfully updated invoice ${invoiceWorkdayID} with supplier ${supplierWID ?? '(existing)'}`,
    appliedFallbacks,
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

export function parsePurchaseOrderLines(poResponse: any): PurchaseOrderLine[] {
  const purchaseOrderRaw = poResponse?.Response_Data?.Purchase_Order;
  const purchaseOrder = Array.isArray(purchaseOrderRaw) ? purchaseOrderRaw[0] : purchaseOrderRaw;
  const poDataRaw = purchaseOrder?.Purchase_Order_Data;
  const poData = Array.isArray(poDataRaw) ? poDataRaw[0] : poDataRaw;

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

  const parsedServiceLines: PurchaseOrderLine[] = serviceLines.map((line: any) => ({
    lineOrder: line.Line_Number,
    purchaseOrderLineId: line.Service_Order_Line_ID,
    purchaseOrderDocumentNumber,
    description: line.Description,
    memo: line.Memo,
    spendCategoryReference: line.Resource_Category_Reference,
    extendedAmount: line.Extended_Amount,
    worktagsReference: ([] as any[]).concat(line.Worktags_Reference ?? []),
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
    worktagsReference: ([] as any[]).concat(line.Worktags_Reference ?? []),
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
