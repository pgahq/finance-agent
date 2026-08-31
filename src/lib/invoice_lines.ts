import { debug } from '@pga/logger';
import { getAiResponse } from './ai.js';
import type { PurchaseOrderLine } from './workday.js';
import { mergeInvoiceLinesPrompt, MergeInvoiceLinesSchema, type MergeInvoiceLinesResult } from '../prompts/merge_invoice_lines_prompt.js';
import {
  extractLineOfBusinessId,
  resolveRelatedLobId,
  type RelatedLob,
} from './related_worktags.js';

export interface ExtractedInvoiceLine {
  description: string;
  quantity?: number | null;
  unitCost?: string | null;
  totalPrice?: string | null;
  hasDiscount?: boolean | null;
}

export interface FinalInvoiceLine {
  lineOrder: number;
  description: string;
  memo?: string | null;
  quantity?: number | null;
  unitCost?: number | null;
  extendedAmount?: number | null;
  hasDiscount?: boolean | null;
  costCenterId?: string | null;
  fundId?: string | null;
  spendCategoryId?: string | null;
  lineOfBusinessId?: string | null;
  eventId?: string | null;
  eventWid?: string | null;
  shipToAddressId?: string | null;
  purchaseOrderLineId?: string | null;
}

export interface LineFallbacks {
  fund: boolean;
  costCenter: boolean;
  spendCategory: boolean;
  lineOfBusiness: boolean;
}

export type InvoiceLineFallbackIds = {
  fundId?: string;
  costCenterId?: string;
  spendCategoryId?: string;
  lineOfBusinessId?: string;
};

export type RelatedLobLookup = (costCenterIds: string[]) => Promise<Map<string, RelatedLob>>;

export function parseExtractedAmount(raw: string): number | undefined {
  const parsed = parseFloat(raw.replace(/[^0-9.]/g, ''));
  return isNaN(parsed) ? undefined : Math.round(parsed * 100) / 100;
}

const FREIGHT_CORE_WORDS = new Set(['freight', 'shipping', 'handling', 'delivery', 'deliveries', 'postage']);
const FREIGHT_CARRIER_WORDS = new Set(['ups', 'fedex', 'usps', 'dhl']);
const FREIGHT_ALLOWED_WORDS = new Set([
  ...FREIGHT_CORE_WORDS,
  ...FREIGHT_CARRIER_WORDS,
  'charge', 'charges', 'fee', 'fees', 'cost', 'costs', 'and', 'inbound', 'outbound', 's', 'h',
  'ground', 'overnight', 'express',
  'standard', 'priority', 'next', 'day', 'free', 'in', 'out',
  'air', 'ocean', 'parcel', 'home', 'local', 'rush', 'misc', 'surcharge',
]);

function isAllowedFreightToken(token: string): boolean {
  return FREIGHT_ALLOWED_WORDS.has(token) || /^\d+$/.test(token);
}

function normalizeLineDescription(description: string): string {
  return description
    .toLowerCase()
    .replace(/s\s*[&/]\s*h\b/g, 's and h')
    .replace(/&/g, ' and ')
    .replace(/[/_,-]+/g, ' ')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isFreightOrHandlingLine(description: string | null | undefined): boolean {
  if (!description) return false;
  const normalized = normalizeLineDescription(description);
  if (!normalized) return false;
  if (normalized === 's and h') return true;
  const tokens = normalized.split(' ');
  const hasFreightAnchor = tokens.some(token => FREIGHT_CORE_WORDS.has(token) || FREIGHT_CARRIER_WORDS.has(token));
  return hasFreightAnchor && tokens.every(isAllowedFreightToken);
}

function lineDescription(line: { description?: string | null; Item_Description?: string | null }): string | undefined {
  return line.description ?? line.Item_Description ?? undefined;
}

function lineAmount(line: {
  totalPrice?: string | null;
  unitCost?: string | number | null;
  Unit_Cost?: string | number | null;
  extendedAmount?: number | null;
  Extended_Amount?: number | string | null;
  quantity?: number | null;
  Quantity?: number | string | null;
}): number | undefined {
  if (typeof line.extendedAmount === 'number') return line.extendedAmount;
  if (line.totalPrice) return parseExtractedAmount(line.totalPrice);
  if (typeof line.Extended_Amount === 'number') return line.Extended_Amount;
  if (typeof line.Extended_Amount === 'string') return parseExtractedAmount(line.Extended_Amount);
  const rawUnitCost = line.unitCost ?? line.Unit_Cost;
  const unitCost = typeof rawUnitCost === 'number'
    ? rawUnitCost
    : (typeof rawUnitCost === 'string' ? parseExtractedAmount(rawUnitCost) : undefined);
  if (unitCost == null) return undefined;
  const rawQuantity = line.quantity ?? line.Quantity;
  const quantity = typeof rawQuantity === 'number'
    ? rawQuantity
    : (typeof rawQuantity === 'string' ? parseExtractedAmount(rawQuantity) : undefined);
  const multiplier = quantity != null && Number.isFinite(quantity) ? quantity : 1;
  return Math.round(unitCost * multiplier * 100) / 100;
}

export function splitFreightLines<T extends {
  description?: string | null;
  Item_Description?: string | null;
  totalPrice?: string | null;
  unitCost?: string | number | null;
  Unit_Cost?: string | number | null;
  extendedAmount?: number | null;
  Extended_Amount?: number | string | null;
  quantity?: number | null;
  Quantity?: number | string | null;
}>(lines: T[]): { merchandiseLines: T[]; freightLines: T[]; freightAmountFromLines?: number } {
  const merchandiseLines: T[] = [];
  const freightLines: T[] = [];
  for (const line of lines) {
    if (isFreightOrHandlingLine(lineDescription(line))) {
      freightLines.push(line);
    } else {
      merchandiseLines.push(line);
    }
  }
  let freightAmountFromLines: number | undefined;
  for (const line of freightLines) {
    const amount = lineAmount(line);
    if (amount != null) {
      freightAmountFromLines = Math.round(((freightAmountFromLines ?? 0) + amount) * 100) / 100;
    }
  }
  return { merchandiseLines, freightLines, freightAmountFromLines };
}

function extractWorktagId(worktags: any[], type: string): string | null {
  for (const worktag of worktags) {
    const ids = ([] as any[]).concat(worktag.ID ?? []);
    const match = ids.find((id: any) => id.$attributes?.type === type);
    if (match) return match.$value;
  }
  return null;
}


function extractSpendCategoryId(spendCategoryReference: any): string | null {
  if (!spendCategoryReference) return null;
  const ids = ([] as any[]).concat(spendCategoryReference.ID ?? []);
  const match = ids.find((id: any) => id.$attributes?.type === 'Spend_Category_ID');
  return match?.$value ?? null;
}

interface ParsedPoLineWorktags {
  purchaseOrderLineId: string | null;
  lineOfBusinessId: string | null;
  costCenterId: string | null;
  fundId: string | null;
  spendCategoryId: string | null;
  worktagsReference: any[];
  lineOrder: number;
  description: string | null;
  memo: string | null;
  shipToAddressId: string | null;
}

function parsePoLineWorktags(poLines: PurchaseOrderLine[] | undefined): ParsedPoLineWorktags[] {
  return (poLines ?? []).map(line => {
    const worktags = ([] as any[]).concat(line.worktagsReference ?? []);
    return {
      lineOrder: line.lineOrder,
      purchaseOrderLineId: line.purchaseOrderLineId ?? null,
      description: line.description ?? null,
      memo: line.memo ?? null,
      costCenterId: extractWorktagId(worktags, 'Cost_Center_Reference_ID'),
      fundId: extractWorktagId(worktags, 'Fund_ID'),
      spendCategoryId: extractSpendCategoryId(line.spendCategoryReference),
      lineOfBusinessId: extractLineOfBusinessId(worktags),
      worktagsReference: worktags,
      shipToAddressId: line.shipToAddressId ?? null,
    };
  });
}

function applyFallbacks(
  mergedLines: MergeInvoiceLinesResult['lines'],
  fallbackIds: InvoiceLineFallbackIds
): { lines: FinalInvoiceLine[]; appliedFallbacks: LineFallbacks } {
  let fundApplied = false;
  let costCenterApplied = false;
  let spendCategoryApplied = false;

  const lines: FinalInvoiceLine[] = mergedLines.map(line => {
    const fundId = line.fundId ?? fallbackIds.fundId ?? null;
    const costCenterId = line.costCenterId ?? fallbackIds.costCenterId ?? null;
    const spendCategoryId = line.spendCategoryId ?? fallbackIds.spendCategoryId ?? null;

    if (!line.fundId && fallbackIds.fundId) fundApplied = true;
    if (!line.costCenterId && fallbackIds.costCenterId) costCenterApplied = true;
    if (!line.spendCategoryId && fallbackIds.spendCategoryId) spendCategoryApplied = true;

    return {
      lineOrder: line.lineOrder,
      description: line.description,
      memo: line.memo ?? null,
      quantity: line.quantity,
      unitCost: line.unitCost,
      extendedAmount: line.extendedAmount,
      hasDiscount: line.hasDiscount ?? null,
      costCenterId,
      fundId,
      spendCategoryId,
      lineOfBusinessId: line.lineOfBusinessId ?? null,
      eventId: line.eventId ?? null,
      eventWid: null,
      shipToAddressId: line.shipToAddressId ?? null,
      purchaseOrderLineId: line.purchaseOrderLineId ?? null,
    };
  });

  return { lines, appliedFallbacks: { fund: fundApplied, costCenter: costCenterApplied, spendCategory: spendCategoryApplied, lineOfBusiness: false } };
}

function buildFallbackLines(
  extractedLines: ExtractedInvoiceLine[],
  fallbackIds: InvoiceLineFallbackIds
): { lines: FinalInvoiceLine[]; appliedFallbacks: LineFallbacks } {
  const lines: FinalInvoiceLine[] = extractedLines.map((line, idx) => ({
    lineOrder: idx + 1,
    description: line.description,
    quantity: line.quantity,
    unitCost: line.unitCost ? (parseExtractedAmount(line.unitCost) ?? null) : null,
    extendedAmount: line.totalPrice ? (parseExtractedAmount(line.totalPrice) ?? null) : null,
    hasDiscount: line.hasDiscount ?? null,
    costCenterId: fallbackIds.costCenterId ?? null,
    fundId: fallbackIds.fundId ?? null,
    spendCategoryId: fallbackIds.spendCategoryId ?? null,
    lineOfBusinessId: null,
    eventId: null,
    shipToAddressId: null,
  }));
  return {
    lines,
    appliedFallbacks: {
      fund: !!fallbackIds.fundId,
      costCenter: !!fallbackIds.costCenterId,
      spendCategory: !!fallbackIds.spendCategoryId,
      lineOfBusiness: false,
    },
  };
}

function applyEmailWorktags(lines: FinalInvoiceLine[], emailWorktags?: EmailWorktags): FinalInvoiceLine[] {
  if (!emailWorktags) return lines;
  return lines.map(line => ({
    ...line,
    ...(emailWorktags.costCenterId != null && { costCenterId: emailWorktags.costCenterId }),
    ...(emailWorktags.eventWid != null && { eventWid: emailWorktags.eventWid }),
    ...(emailWorktags.lobReferenceId != null && { lineOfBusinessId: emailWorktags.lobReferenceId }),
    ...(emailWorktags.fundReferenceId != null && { fundId: emailWorktags.fundReferenceId }),
    ...(emailWorktags.spendCategoryReferenceId != null && { spendCategoryId: emailWorktags.spendCategoryReferenceId }),
  }));
}

export function overlayPoLineOfBusiness(
  lines: FinalInvoiceLine[],
  poLines: ParsedPoLineWorktags[]
): FinalInvoiceLine[] {
  if (poLines.length === 0) return lines;

  const byPurchaseOrderLineId = new Map(
    poLines
      .filter(line => line.purchaseOrderLineId && line.lineOfBusinessId)
      .map(line => [line.purchaseOrderLineId as string, line.lineOfBusinessId as string])
  );
  const uniquePoLobs = [...new Set(poLines.map(line => line.lineOfBusinessId).filter((id): id is string => !!id))];

  return lines.map(line => {
    if (line.lineOfBusinessId) return line;
    if (line.purchaseOrderLineId && byPurchaseOrderLineId.has(line.purchaseOrderLineId)) {
      return { ...line, lineOfBusinessId: byPurchaseOrderLineId.get(line.purchaseOrderLineId) };
    }
    if (uniquePoLobs.length === 1) {
      return { ...line, lineOfBusinessId: uniquePoLobs[0] };
    }
    return line;
  });
}

export function applyRelatedLobWorktags(
  lines: FinalInvoiceLine[],
  relatedByCostCenterId: Map<string, RelatedLob>,
  fallbackCostCenterId?: string | null,
  options?: { replaceIds?: Iterable<string>; anyAllowed?: boolean }
): FinalInvoiceLine[] {
  const replaceIds = new Set(options?.replaceIds ?? []);
  return lines.map(line => {
    const current = line.lineOfBusinessId;
    if (current && !replaceIds.has(current)) return line;
    const resolved = resolveRelatedLobId(
      relatedByCostCenterId.get(line.costCenterId ?? ''),
      line.costCenterId,
      fallbackCostCenterId,
      replaceIds,
      { anyAllowed: Boolean(options?.anyAllowed) }
    );
    return resolved && resolved !== current ? { ...line, lineOfBusinessId: resolved } : line;
  });
}

export interface EmailWorktags {
  costCenterId?: string | null;
  eventWid?: string | null;
  lobReferenceId?: string | null;
  fundReferenceId?: string | null;
  spendCategoryReferenceId?: string | null;
}

export function applyDefaultCompanyLineWorktags(
  lines: FinalInvoiceLine[],
  fallbackIds: InvoiceLineFallbackIds
): FinalInvoiceLine[] {
  return lines.map(line => ({
    ...line,
    costCenterId: fallbackIds.costCenterId ?? null,
    fundId: fallbackIds.fundId ?? null,
    spendCategoryId: fallbackIds.spendCategoryId ?? null,
    lineOfBusinessId: fallbackIds.lineOfBusinessId ?? null,
    purchaseOrderLineId: null,
    eventId: null,
    eventWid: null,
    shipToAddressId: null,
  }));
}

export function applyFallbackLineOfBusiness(
  lines: FinalInvoiceLine[],
  fallbackLineOfBusinessId?: string | null
): { lines: FinalInvoiceLine[]; applied: boolean } {
  if (!fallbackLineOfBusinessId) return { lines, applied: false };
  let applied = false;
  const next = lines.map(line => {
    if (line.lineOfBusinessId) return line;
    applied = true;
    return { ...line, lineOfBusinessId: fallbackLineOfBusinessId };
  });
  return { lines: next, applied };
}

export async function buildFinalInvoiceLines(
  extractedLines: ExtractedInvoiceLine[],
  poLines: PurchaseOrderLine[] | undefined,
  emailBody: string | undefined,
  fallbackIds: InvoiceLineFallbackIds,
  emailWorktags?: EmailWorktags,
  relatedLobLookup?: RelatedLobLookup
): Promise<{ lines: FinalInvoiceLine[]; appliedFallbacks: LineFallbacks; relatedLobByCostCenter: Map<string, RelatedLob> }> {
  const parsedPoLines = parsePoLineWorktags(poLines);
  const mergeInput = {
    extractedInvoiceLines: extractedLines,
    purchaseOrderLines: parsedPoLines.map(line => ({
      lineOrder: line.lineOrder,
      purchaseOrderLineId: line.purchaseOrderLineId,
      description: line.description,
      memo: line.memo,
      costCenterId: line.costCenterId,
      fundId: line.fundId,
      spendCategoryId: line.spendCategoryId,
      lineOfBusinessId: line.lineOfBusinessId,
      worktagsReference: line.worktagsReference,
      shipToAddressId: line.shipToAddressId,
    })),
    emailBody: emailBody ?? null,
  };

  let mergeResult: MergeInvoiceLinesResult;
  try {
    mergeResult = await getAiResponse({
      prompt: mergeInvoiceLinesPrompt,
      schema: MergeInvoiceLinesSchema,
      messages: [{ role: 'user', content: JSON.stringify(mergeInput, null, 2) }],
      tools: {},
    }) as MergeInvoiceLinesResult;
  } catch (error) {
    debug('Failed to merge invoice lines via AI, falling back to extracted lines with fallback worktags:', error);
    const fallback = buildFallbackLines(extractedLines, fallbackIds);
    return finalizeInvoiceLines(fallback.lines, fallback.appliedFallbacks, parsedPoLines, emailWorktags, relatedLobLookup, fallbackIds);
  }

  if (!mergeResult?.lines?.length) {
    debug('AI merge returned no lines, falling back to extracted lines with fallback worktags');
    const fallback = buildFallbackLines(extractedLines, fallbackIds);
    return finalizeInvoiceLines(fallback.lines, fallback.appliedFallbacks, parsedPoLines, emailWorktags, relatedLobLookup, fallbackIds);
  }

  const { lines, appliedFallbacks } = applyFallbacks(mergeResult.lines, fallbackIds);
  return finalizeInvoiceLines(lines, appliedFallbacks, parsedPoLines, emailWorktags, relatedLobLookup, fallbackIds);
}

async function finalizeInvoiceLines(
  lines: FinalInvoiceLine[],
  appliedFallbacks: LineFallbacks,
  parsedPoLines: ParsedPoLineWorktags[],
  emailWorktags: EmailWorktags | undefined,
  relatedLobLookup: RelatedLobLookup | undefined,
  fallbackIds: InvoiceLineFallbackIds
): Promise<{ lines: FinalInvoiceLine[]; appliedFallbacks: LineFallbacks; relatedLobByCostCenter: Map<string, RelatedLob> }> {
  const withPoLob = overlayPoLineOfBusiness(lines, parsedPoLines);
  const withEmail = applyEmailWorktags(withPoLob, emailWorktags);
  const { lines: withRelated, relatedByCostCenterId } = await fillRelatedLobs(withEmail, relatedLobLookup);
  const fallbackLob = applyFallbackLineOfBusiness(withRelated, fallbackIds.lineOfBusinessId);
  return {
    lines: fallbackLob.lines,
    appliedFallbacks: {
      ...appliedFallbacks,
      lineOfBusiness: appliedFallbacks.lineOfBusiness || fallbackLob.applied,
    },
    relatedLobByCostCenter: relatedByCostCenterId,
  };
}

async function fillRelatedLobs(
  lines: FinalInvoiceLine[],
  relatedLobLookup?: RelatedLobLookup
): Promise<{ lines: FinalInvoiceLine[]; relatedByCostCenterId: Map<string, RelatedLob> }> {
  const empty = new Map<string, RelatedLob>();
  if (!relatedLobLookup) return { lines, relatedByCostCenterId: empty };

  const fallbackCostCenterId = process.env.FALLBACK_COST_CENTER_ID;
  const costCenterIds = [...new Set(
    lines
      .filter(line => line.costCenterId && line.costCenterId !== fallbackCostCenterId)
      .map(line => line.costCenterId)
      .filter((id): id is string => !!id)
  )];
  if (costCenterIds.length === 0) return { lines, relatedByCostCenterId: empty };

  try {
    const relatedByCostCenterId = await relatedLobLookup(costCenterIds);
    return {
      lines: applyRelatedLobWorktags(lines, relatedByCostCenterId, fallbackCostCenterId),
      relatedByCostCenterId,
    };
  } catch (error) {
    debug('Failed to look up related Line of Business worktags for cost centers:', error);
    return { lines, relatedByCostCenterId: empty };
  }
}
