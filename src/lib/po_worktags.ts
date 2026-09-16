export interface PurchaseOrderLineSplit {
  quantity?: number;
  extendedAmount?: number;
  memo?: string;
  worktagReference: any[];
}

const SPLIT_LINE_PASSTHROUGH_OMIT_TYPES = new Set(['Cost_Center_Reference_ID', 'Fund_ID']);

function worktagIdentity(tag: any): string | null {
  const ids = ([] as any[]).concat(tag?.ID ?? []);
  const primary = ids.find((id: any) => id.$attributes?.type && id.$attributes.type !== 'WID');
  if (primary?.$value != null) return `${primary.$attributes.type}:${primary.$value}`;
  const wid = ids.find((id: any) => id.$attributes?.type === 'WID');
  return wid?.$value != null ? `WID:${wid.$value}` : null;
}

function primaryWorktagType(tag: any): string | null {
  const ids = ([] as any[]).concat(tag?.ID ?? []);
  const primary = ids.find((id: any) => id.$attributes?.type && id.$attributes.type !== 'WID');
  return primary?.$attributes?.type ?? null;
}

export function dedupeWorktagReferences(worktags: any[]): any[] {
  const seen = new Set<string>();
  const result: any[] = [];
  for (const tag of worktags) {
    const identity = worktagIdentity(tag);
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    result.push(tag);
  }
  return result;
}

export function worktagsFromPurchaseOrderLineAdditionalData(line: any): any[] {
  const entries = ([] as any[]).concat(line?.Purchase_Order_Line_Worktags_Data ?? []);
  return entries.flatMap(entry => ([] as any[]).concat(entry?.Worktag_Reference ?? []));
}

export function parsePurchaseOrderLineSplits(line: any, splitField: string): PurchaseOrderLineSplit[] {
  const splits = ([] as any[]).concat(line?.[splitField] ?? []);
  return splits.map(split => ({
    quantity: split.Quantity !== undefined && split.Quantity !== null ? Number(split.Quantity) : undefined,
    extendedAmount: split.Extended_Amount !== undefined && split.Extended_Amount !== null
      ? Number(split.Extended_Amount)
      : undefined,
    memo: split.Memo,
    worktagReference: ([] as any[]).concat(split?.Worktag_Reference ?? []),
  }));
}

export function mergePurchaseOrderLineWorktags(
  line: any,
  splitField: string
): {
  worktagsReference: any[];
  lineLevelWorktagsReference: any[];
  splitLineData: PurchaseOrderLineSplit[];
} {
  const lineWorktags = ([] as any[]).concat(line?.Worktags_Reference ?? []);
  const additionalWorktags = worktagsFromPurchaseOrderLineAdditionalData(line);
  const lineLevelWorktagsReference = dedupeWorktagReferences([...lineWorktags, ...additionalWorktags]);
  const splitLineData = parsePurchaseOrderLineSplits(line, splitField);
  const splitWorktags = splitLineData.flatMap(split => split.worktagReference);
  const worktagsReference = dedupeWorktagReferences([
    ...lineLevelWorktagsReference,
    ...splitWorktags,
  ]);
  return { worktagsReference, lineLevelWorktagsReference, splitLineData };
}

/** When splits carry allocation worktags, keep custom/additional tags on the parent line only. */
export function passthroughWorktagsForSplitInvoiceLine(
  passthrough: any[] | undefined,
  hasSplits: boolean
): any[] | undefined {
  if (!passthrough?.length) return passthrough;
  if (!hasSplits) return passthrough;
  return passthrough.filter(tag => {
    const type = primaryWorktagType(tag);
    return !type || !SPLIT_LINE_PASSTHROUGH_OMIT_TYPES.has(type);
  });
}

export function mergePassthroughWorktagReferences(base: any[], passthrough: any[] | undefined): any[] {
  if (!passthrough?.length) return base;
  const seen = new Set(base.map(worktagIdentity).filter((id): id is string => Boolean(id)));
  const additions = passthrough.filter(tag => {
    const identity = worktagIdentity(tag);
    return identity && !seen.has(identity);
  });
  return additions.length ? [...base, ...additions] : base;
}

export function mapPoSplitsToSupplierInvoiceSplitLineData(
  splits: PurchaseOrderLineSplit[] | undefined,
  invoiceLineExtendedAmount?: number | null
): any[] | undefined {
  if (!splits?.length) return undefined;
  const splitAmountSum = splits.reduce((sum, split) => sum + (split.extendedAmount ?? 0), 0);
  const includeSplitAmounts = invoiceLineExtendedAmount != null
    && splitAmountSum > 0
    && Math.abs(splitAmountSum - invoiceLineExtendedAmount) < 0.01;

  return splits.map(split => ({
    ...(includeSplitAmounts && split.quantity != null && { Quantity: split.quantity }),
    ...(includeSplitAmounts && split.extendedAmount != null && { Extended_Amount: split.extendedAmount }),
    ...(split.memo && { Memo: split.memo }),
    ...(split.worktagReference.length > 0 && { Worktag_Reference: split.worktagReference }),
  }));
}

export function firstNonEmptyPoLineArray(...sources: unknown[]): any[] {
  for (const source of sources) {
    const arr = ([] as any[]).concat(source ?? []);
    if (arr.length > 0) return arr;
  }
  return [];
}
