import { normalizePurchaseOrderNumber } from './purchase_order.js';
import type { InvoiceEnrichmentResult } from '../prompts/enrich_invoice_prompt.js';
import type { FinalInvoiceLine } from './invoice_lines.js';

export const INVOICE_MEMO_MAX_LENGTH = 500;

export interface InvoiceMemoIdentifierFields {
  po?: string | null;
  accountNumber?: string | null;
  jobNumber?: string | null;
  customerId?: string | null;
  servicePeriod?: string | null;
}

export interface InvoiceMemoInput extends InvoiceMemoIdentifierFields {
  description?: string | null;
}

const ACCOUNT_LABEL = /^(?:account(?:\s*(?:number|#))?|acct(?:\s*#)?|ac(?:\s*#|\s+|:\s*)|customer\s+account|sold\s*to(?:\s*(?:number|#))?)\s*[:#.-]*\s*/i;
const JOB_LABEL = /^(?:job(?:\s*(?:number|#|no\.?)?)?|order(?:\s*(?:number|#))?)\s*[:#.-]*\s*/i;
const CUSTOMER_LABEL = /^(?:bill[-\s]?to\s+)?(?:customer|cust)(?:\s*(?:id|#|number))?\s*[:#.-]*\s*/i;
const SERVICE_PERIOD_LABEL = /^(?:service\s+period|billing\s+period|period\s+covered)\s*[:#.-]*\s*/i;

function blankToNull(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function stripLeadingLabel(value: string | null, label: RegExp): string | null {
  if (!value) return null;
  const stripped = value.replace(label, '').replace(/^[#:-]+\s*/, '').trim();
  return stripped || null;
}

function comparableId(value: string): string {
  return value.replace(/[\s#-]+/g, '').toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function memoIdentifiersFromEnrichment(
  result: Pick<
    InvoiceEnrichmentResult,
    | 'extractedPurchaseOrderNumber'
    | 'extractedAccountNumber'
    | 'extractedJobNumber'
    | 'extractedCustomerId'
    | 'extractedServicePeriod'
  >,
  po?: string | null
): InvoiceMemoIdentifierFields {
  return {
    po: blankToNull(po) ?? normalizePurchaseOrderNumber(result.extractedPurchaseOrderNumber) ?? null,
    accountNumber: result.extractedAccountNumber,
    jobNumber: result.extractedJobNumber,
    customerId: result.extractedCustomerId,
    servicePeriod: result.extractedServicePeriod,
  };
}

function identifierTokens(fields: InvoiceMemoIdentifierFields): string[] {
  const po = normalizePurchaseOrderNumber(fields.po) ?? null;
  const accountNumber = stripLeadingLabel(blankToNull(fields.accountNumber), ACCOUNT_LABEL);
  const jobNumber = stripLeadingLabel(blankToNull(fields.jobNumber), JOB_LABEL);
  const customerId = stripLeadingLabel(blankToNull(fields.customerId), CUSTOMER_LABEL);
  const servicePeriod = stripLeadingLabel(blankToNull(fields.servicePeriod), SERVICE_PERIOD_LABEL);

  const tokens: string[] = [];
  if (po) tokens.push(po);
  if (accountNumber) tokens.push(`AC #${accountNumber}`);
  const jobAsPo = jobNumber ? normalizePurchaseOrderNumber(jobNumber) : undefined;
  if (jobNumber && jobAsPo !== po) {
    tokens.push(`Job #${jobNumber}`);
  }
  if (customerId && (!accountNumber || comparableId(customerId) !== comparableId(accountNumber))) {
    tokens.push(`Customer ID ${customerId}`);
  }
  if (servicePeriod) tokens.push(`Service Period ${servicePeriod}`);
  return tokens;
}

export function hasMemoIdentifiers(fields: InvoiceMemoIdentifierFields): boolean {
  return identifierTokens(fields).length > 0;
}

function stripIdentifierTokensFromDescription(description: string, tokens: string[]): string {
  let result = description;
  for (const token of tokens) {
    const pattern = new RegExp(`(?:^|\\s*\\|\\s*|\\s+)${escapeRegExp(token)}(?=\\s*\\||\\s+|$)`, 'ig');
    result = result.replace(pattern, ' | ');
  }
  return result
    .replace(/\s*\|\s*/g, ' | ')
    .replace(/^(?:\s*\|\s*)+|(?:\s*\|\s*)+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function capMemo(value: string): string {
  if (value.length <= INVOICE_MEMO_MAX_LENGTH) return value;
  return value.slice(0, INVOICE_MEMO_MAX_LENGTH).trimEnd();
}

export function composeInvoiceMemo(input: InvoiceMemoInput): string | undefined {
  const tokens = identifierTokens(input);
  const prefix = tokens.join(' | ');
  let description = blankToNull(input.description) ?? '';
  if (tokens.length && description) {
    description = stripIdentifierTokensFromDescription(description, tokens);
  }

  if (!prefix && !description) return undefined;
  if (!prefix) return capMemo(description);
  if (!description) return capMemo(prefix);
  return capMemo(`${prefix} | ${description}`);
}

export function applyInvoiceMemoIdentifiersToLines(
  lines: FinalInvoiceLine[],
  identifiers: InvoiceMemoIdentifierFields
): FinalInvoiceLine[] {
  return lines.map(line => {
    const memo = composeInvoiceMemo({ ...identifiers, description: line.memo });
    if (memo == null || memo === (line.memo ?? undefined)) return line;
    return { ...line, memo };
  });
}
