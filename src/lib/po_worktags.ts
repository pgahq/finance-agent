export interface PurchaseOrderLineSplit {
  quantity?: number;
  extendedAmount?: number;
  memo?: string;
  worktagReference: any[];
}

const SPLIT_LINE_PASSTHROUGH_OMIT_TYPES = new Set([
  'Cost_Center_Reference_ID',
  'Fund_ID',
  'Organization_Reference_ID',
  'Custom_Organization_Reference_ID',
]);

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
  const seenTypes = new Set(
    base.map(primaryWorktagType).filter((type): type is string => Boolean(type))
  );
  const additions = passthrough.filter(tag => {
    const type = primaryWorktagType(tag);
    if (!type) {
      const identity = worktagIdentity(tag);
      return identity && !base.some(existing => worktagIdentity(existing) === identity);
    }
    return !seenTypes.has(type);
  });
  return additions.length ? [...base, ...additions] : base;
}

function roundMoney(amount: number): number {
  return Math.round(amount * 100) / 100;
}

export function mapPoSplitsToSupplierInvoiceSplitLineData(
  splits: PurchaseOrderLineSplit[] | undefined,
  invoiceLineExtendedAmount?: number | null
): any[] | undefined {
  if (!splits?.length) return undefined;
  const splitAmountSum = splits.reduce((sum, split) => sum + (split.extendedAmount ?? 0), 0);
  const targetAmount = invoiceLineExtendedAmount ?? (splitAmountSum > 0 ? splitAmountSum : null);
  if (targetAmount == null) {
    return splits.map(split => ({
      ...(split.memo && { Memo: split.memo }),
      ...(split.worktagReference.length > 0 && { Worktag_Reference: split.worktagReference }),
    }));
  }

  const scale = splitAmountSum > 0 && Math.abs(splitAmountSum - targetAmount) >= 0.01
    ? targetAmount / splitAmountSum
    : 1;

  const extendedAmounts = splits.map(split => {
    if (splitAmountSum <= 0) {
      return roundMoney(targetAmount / splits.length);
    }
    const raw = split.extendedAmount ?? 0;
    return roundMoney(raw * scale);
  });

  const amountSum = roundMoney(extendedAmounts.reduce((sum, amount) => sum + amount, 0));
  const drift = roundMoney(targetAmount - amountSum);
  if (Math.abs(drift) >= 0.01) {
    extendedAmounts[extendedAmounts.length - 1] = roundMoney(extendedAmounts[extendedAmounts.length - 1] + drift);
  }

  return splits.map((split, index) => ({
    Extended_Amount: extendedAmounts[index],
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
