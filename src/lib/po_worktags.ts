export interface PurchaseOrderLineSplit {
  quantity?: number;
  extendedAmount?: number;
  memo?: string;
  worktagReference: any[];
}

function worktagIdentity(tag: any): string | null {
  const ids = ([] as any[]).concat(tag?.ID ?? []);
  const primary = ids.find((id: any) => id.$attributes?.type && id.$attributes.type !== 'WID');
  if (primary?.$value != null) return `${primary.$attributes.type}:${primary.$value}`;
  const wid = ids.find((id: any) => id.$attributes?.type === 'WID');
  return wid?.$value != null ? `WID:${wid.$value}` : null;
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
): { worktagsReference: any[]; splitLineData: PurchaseOrderLineSplit[] } {
  const lineWorktags = ([] as any[]).concat(line?.Worktags_Reference ?? []);
  const additionalWorktags = worktagsFromPurchaseOrderLineAdditionalData(line);
  const splitLineData = parsePurchaseOrderLineSplits(line, splitField);
  const splitWorktags = splitLineData.flatMap(split => split.worktagReference);
  const worktagsReference = dedupeWorktagReferences([
    ...lineWorktags,
    ...additionalWorktags,
    ...splitWorktags,
  ]);
  return { worktagsReference, splitLineData };
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
  splits: PurchaseOrderLineSplit[] | undefined
): any[] | undefined {
  if (!splits?.length) return undefined;
  return splits.map(split => ({
    ...(split.quantity != null && { Quantity: split.quantity }),
    ...(split.extendedAmount != null && { Extended_Amount: split.extendedAmount }),
    ...(split.memo && { Memo: split.memo }),
    ...(split.worktagReference.length > 0 && { Worktag_Reference: split.worktagReference }),
  }));
}
