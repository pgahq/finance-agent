import { debug } from '@pga/logger';
import { getAiResponse } from './ai.js';
import type { PurchaseOrderLine } from './workday.js';
import { mergeInvoiceLinesPrompt, MergeInvoiceLinesSchema, type MergeInvoiceLinesResult } from '../prompts/merge_invoice_lines_prompt.js';

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
}

export function parseExtractedAmount(raw: string): number | undefined {
  const parsed = parseFloat(raw.replace(/[^0-9.]/g, ''));
  return isNaN(parsed) ? undefined : Math.round(parsed * 100) / 100;
}

const FREIGHT_CORE_WORDS = new Set(['freight', 'shipping', 'handling', 'delivery', 'postage']);
const FREIGHT_ALLOWED_WORDS = new Set([
  ...FREIGHT_CORE_WORDS,
  'charge', 'charges', 'fee', 'fees', 'cost', 'costs', 'and', 'inbound', 'outbound', 's', 'h',
]);

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
  return tokens.some(token => FREIGHT_CORE_WORDS.has(token))
    && tokens.every(token => FREIGHT_ALLOWED_WORDS.has(token));
}

function lineDescription(line: { description?: string | null; Item_Description?: string | null }): string | undefined {
  return line.description ?? line.Item_Description ?? undefined;
}

function lineAmount(line: {
  totalPrice?: string | null;
  unitCost?: string | number | null;
  extendedAmount?: number | null;
  Extended_Amount?: number | string | null;
}): number | undefined {
  if (typeof line.extendedAmount === 'number') return line.extendedAmount;
  if (line.totalPrice) return parseExtractedAmount(line.totalPrice);
  if (typeof line.Extended_Amount === 'number') return line.Extended_Amount;
  if (typeof line.Extended_Amount === 'string') return parseExtractedAmount(line.Extended_Amount);
  if (typeof line.unitCost === 'number') return line.unitCost;
  if (line.unitCost) return parseExtractedAmount(line.unitCost);
  return undefined;
}

export function splitFreightLines<T extends {
  description?: string | null;
  Item_Description?: string | null;
  totalPrice?: string | null;
  unitCost?: string | number | null;
  extendedAmount?: number | null;
  Extended_Amount?: number | string | null;
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

function applyFallbacks(
  mergedLines: MergeInvoiceLinesResult['lines'],
  fallbackIds: { fundId?: string; costCenterId?: string; spendCategoryId?: string }
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

  return { lines, appliedFallbacks: { fund: fundApplied, costCenter: costCenterApplied, spendCategory: spendCategoryApplied } };
}

function buildFallbackLines(
  extractedLines: ExtractedInvoiceLine[],
  fallbackIds: { fundId?: string; costCenterId?: string; spendCategoryId?: string }
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

export interface EmailWorktags {
  costCenterId?: string | null;
  eventWid?: string | null;
  lobReferenceId?: string | null;
  fundReferenceId?: string | null;
  spendCategoryReferenceId?: string | null;
}

export async function buildFinalInvoiceLines(
  extractedLines: ExtractedInvoiceLine[],
  poLines: PurchaseOrderLine[] | undefined,
  emailBody: string | undefined,
  fallbackIds: { fundId?: string; costCenterId?: string; spendCategoryId?: string },
  emailWorktags?: EmailWorktags
): Promise<{ lines: FinalInvoiceLine[]; appliedFallbacks: LineFallbacks }> {
  const mergeInput = {
    extractedInvoiceLines: extractedLines,
    purchaseOrderLines: poLines?.map(l => {
      const worktags = ([] as any[]).concat(l.worktagsReference ?? []);
      return {
        lineOrder: l.lineOrder,
        purchaseOrderLineId: l.purchaseOrderLineId ?? null,
        description: l.description ?? null,
        memo: l.memo ?? null,
        costCenterId: extractWorktagId(worktags, 'Cost_Center_Reference_ID'),
        fundId: extractWorktagId(worktags, 'Fund_ID'),
        spendCategoryId: extractSpendCategoryId(l.spendCategoryReference),
        worktagsReference: worktags,
        shipToAddressId: l.shipToAddressId ?? null,
      };
    }),
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
    return { lines: applyEmailWorktags(fallback.lines, emailWorktags), appliedFallbacks: fallback.appliedFallbacks };
  }

  if (!mergeResult?.lines?.length) {
    debug('AI merge returned no lines, falling back to extracted lines with fallback worktags');
    const fallback = buildFallbackLines(extractedLines, fallbackIds);
    return { lines: applyEmailWorktags(fallback.lines, emailWorktags), appliedFallbacks: fallback.appliedFallbacks };
  }

  const { lines, appliedFallbacks } = applyFallbacks(mergeResult.lines, fallbackIds);
  return { lines: applyEmailWorktags(lines, emailWorktags), appliedFallbacks };
}
