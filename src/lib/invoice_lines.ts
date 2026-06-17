import { debug } from '@pga/logger';
import { getAiResponse } from './ai.js';
import type { PurchaseOrderLine } from './workday.js';
import { mergeInvoiceLinesPrompt, MergeInvoiceLinesSchema, type MergeInvoiceLinesResult } from '../prompts/merge_invoice_lines_prompt.js';

export interface ExtractedInvoiceLine {
  description: string;
  quantity?: number | null;
  unitCost?: string | null;
  totalPrice?: string | null;
}

export interface FinalInvoiceLine {
  lineOrder: number;
  description: string;
  quantity?: number | null;
  unitCost?: number | null;
  extendedAmount?: number | null;
  costCenterId?: string | null;
  fundId?: string | null;
  spendCategoryId?: string | null;
  lineOfBusinessId?: string | null;
  eventId?: string | null;
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
      quantity: line.quantity,
      unitCost: line.unitCost,
      extendedAmount: line.extendedAmount,
      costCenterId,
      fundId,
      spendCategoryId,
      lineOfBusinessId: line.lineOfBusinessId ?? null,
      eventId: line.eventId ?? null,
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

export async function buildFinalInvoiceLines(
  extractedLines: ExtractedInvoiceLine[],
  poLines: PurchaseOrderLine[] | undefined,
  emailBody: string | undefined,
  fallbackIds: { fundId?: string; costCenterId?: string; spendCategoryId?: string }
): Promise<{ lines: FinalInvoiceLine[]; appliedFallbacks: LineFallbacks }> {
  const mergeInput = {
    extractedInvoiceLines: extractedLines,
    purchaseOrderLines: poLines?.map(l => {
      const worktags = ([] as any[]).concat(l.worktagsReference ?? []);
      return {
        lineOrder: l.lineOrder,
        purchaseOrderLineId: l.purchaseOrderLineId ?? null,
        description: l.description ?? null,
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
    return buildFallbackLines(extractedLines, fallbackIds);
  }

  if (!mergeResult?.lines?.length) {
    debug('AI merge returned no lines, falling back to extracted lines with fallback worktags');
    return buildFallbackLines(extractedLines, fallbackIds);
  }

  return applyFallbacks(mergeResult.lines, fallbackIds);
}
