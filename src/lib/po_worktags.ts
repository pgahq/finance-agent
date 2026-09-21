import {
  DEFAULT_LINE_OF_BUSINESS_ID,
  isLineOfBusinessReferenceId,
  relatedLobAllowsId,
  relatedLobIdsMatch,
  type RelatedLob,
} from './related_worktags.js';

export interface PurchaseOrderLineSplit {
  quantity?: number;
  extendedAmount?: number;
  memo?: string;
  worktagReference: any[];
}

export interface OrgPassthroughContext {
  relatedLob?: RelatedLob | null;
  lineOfBusinessId?: string | null;
}

const ORG_WORKTAG_ID_TYPES = new Set([
  'Organization_Reference_ID',
  'Custom_Organization_Reference_ID',
]);

export function worktagIdentity(tag: any): string | null {
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

function worktagIdValues(tag: any): string[] {
  return ([] as any[])
    .concat(tag?.ID ?? [])
    .map((id: any) => id?.$value)
    .filter((value: unknown): value is string => typeof value === 'string' && value.length > 0);
}

function worktagWid(tag: any): string | null {
  const ids = ([] as any[]).concat(tag?.ID ?? []);
  const wid = ids.find((id: any) => id.$attributes?.type === 'WID');
  return typeof wid?.$value === 'string' && wid.$value ? wid.$value : null;
}

function isOrgWorktag(tag: any): boolean {
  const type = primaryWorktagType(tag);
  return type != null && ORG_WORKTAG_ID_TYPES.has(type);
}

export function isLobWorktag(
  tag: any,
  relatedLob?: RelatedLob | null,
  lineOfBusinessId?: string | null
): boolean {
  for (const value of worktagIdValues(tag)) {
    if (isLineOfBusinessReferenceId(value)) return true;
    if (relatedLob && relatedLobAllowsId(relatedLob, value)) return true;
    if (
      lineOfBusinessId &&
      (value === lineOfBusinessId || relatedLobIdsMatch(value, lineOfBusinessId))
    ) {
      return true;
    }
  }
  return false;
}

function baseHasLobWorktag(
  base: any[],
  relatedLob?: RelatedLob | null,
  lineOfBusinessId?: string | null
): boolean {
  return base.some(tag => isOrgWorktag(tag) && isLobWorktag(tag, relatedLob, lineOfBusinessId));
}

function primaryWorktagValue(tag: any): string | null {
  const ids = ([] as any[]).concat(tag?.ID ?? []);
  const primary = ids.find((id: any) => id.$attributes?.type && id.$attributes.type !== 'WID');
  if (typeof primary?.$value === 'string' && primary.$value) return primary.$value;
  const wid = ids.find((id: any) => id.$attributes?.type === 'WID');
  return typeof wid?.$value === 'string' && wid.$value ? wid.$value : null;
}

function isFallbackFundValue(value: string | null): boolean {
  const fallback = process.env.FALLBACK_FUND_ID;
  return !!fallback && value === fallback;
}

function isFallbackCostCenterValue(value: string | null): boolean {
  const fallback = process.env.FALLBACK_COST_CENTER_ID;
  return !!fallback && value === fallback;
}

function isFallbackLobValue(value: string | null): boolean {
  if (!value) return false;
  if (value === DEFAULT_LINE_OF_BUSINESS_ID) return true;
  const fallback = process.env.FALLBACK_LOB_ID;
  if (!fallback) return false;
  return value === fallback || relatedLobIdsMatch(value, fallback);
}

function isFallbackFundTag(tag: any): boolean {
  return primaryWorktagType(tag) === 'Fund_ID' && isFallbackFundValue(primaryWorktagValue(tag));
}

function isFallbackCostCenterTag(tag: any): boolean {
  return (
    primaryWorktagType(tag) === 'Cost_Center_Reference_ID' &&
    isFallbackCostCenterValue(primaryWorktagValue(tag))
  );
}

function isFallbackLobTag(
  tag: any,
  relatedLob?: RelatedLob | null,
  lineOfBusinessId?: string | null
): boolean {
  if (!isOrgWorktag(tag) || !isLobWorktag(tag, relatedLob, lineOfBusinessId)) return false;
  return worktagIdValues(tag).some(value => isFallbackLobValue(value));
}

function worktagValuesOverlap(a: any, bWorktags: any[]): boolean {
  const aValues = new Set(worktagIdValues(a));
  if (aValues.size === 0) return false;
  for (const b of bWorktags) {
    for (const value of worktagIdValues(b)) {
      if (aValues.has(value)) return true;
    }
  }
  return false;
}

function splitHasWorktagType(splitWorktags: any[], type: string): boolean {
  return splitWorktags.some(tag => primaryWorktagType(tag) === type);
}

function splitHasLobWorktag(
  splitWorktags: any[],
  relatedLob?: RelatedLob | null,
  lineOfBusinessId?: string | null
): boolean {
  return splitWorktags.some(
    tag => isOrgWorktag(tag) && isLobWorktag(tag, relatedLob, lineOfBusinessId)
  );
}

function everySplitHasWorktagType(splits: PurchaseOrderLineSplit[], type: string): boolean {
  return splits.length > 0 && splits.every(split => splitHasWorktagType(split.worktagReference, type));
}

function everySplitHasLobWorktag(
  splits: PurchaseOrderLineSplit[],
  relatedLob?: RelatedLob | null,
  lineOfBusinessId?: string | null
): boolean {
  return (
    splits.length > 0 &&
    splits.every(split => splitHasLobWorktag(split.worktagReference, relatedLob, lineOfBusinessId))
  );
}

function isNonAllocationLineLevelTag(
  tag: any,
  relatedLob?: RelatedLob | null,
  lineOfBusinessId?: string | null
): boolean {
  const type = primaryWorktagType(tag);
  if (!type) return true;
  if (type === 'Fund_ID' || type === 'Cost_Center_Reference_ID') return false;
  if (isOrgWorktag(tag)) return !isLobWorktag(tag, relatedLob, lineOfBusinessId);
  return true;
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

/** When splits carry allocation worktags, keep custom/additional tags on the parent line only.
 * Fund, cost center, and LOB live on the splits when every split carries that dimension;
 * shared dimensions missing from splits stay on the parent. Venue/event orgs stay on the parent. */
export function passthroughWorktagsForSplitInvoiceLine(
  passthrough: any[] | undefined,
  hasSplitsOrSplits: boolean | PurchaseOrderLineSplit[],
  context?: OrgPassthroughContext
): any[] | undefined {
  if (!passthrough?.length) return passthrough;
  const splits = Array.isArray(hasSplitsOrSplits) ? hasSplitsOrSplits : undefined;
  const hasSplits = splits != null ? splits.length > 0 : hasSplitsOrSplits;
  if (!hasSplits) return passthrough;
  const stripFund = splits == null || everySplitHasWorktagType(splits, 'Fund_ID');
  const stripCostCenter =
    splits == null || everySplitHasWorktagType(splits, 'Cost_Center_Reference_ID');
  const stripLob = splits == null || everySplitHasLobWorktag(splits, context?.relatedLob, context?.lineOfBusinessId);
  return passthrough.filter(tag => {
    const type = primaryWorktagType(tag);
    if (!type) return true;
    if (type === 'Fund_ID') return !stripFund;
    if (type === 'Cost_Center_Reference_ID') return !stripCostCenter;
    if (isOrgWorktag(tag)) {
      if (!isLobWorktag(tag, context?.relatedLob, context?.lineOfBusinessId)) return true;
      return !stripLob;
    }
    return true;
  });
}

export function mergePassthroughWorktagReferences(
  base: any[],
  passthrough: any[] | undefined,
  context?: OrgPassthroughContext
): any[] {
  if (!passthrough?.length) return base;
  const relatedLob = context?.relatedLob;
  const lineOfBusinessId = context?.lineOfBusinessId;

  const baseHasRealFund = base.some(
    tag => primaryWorktagType(tag) === 'Fund_ID' && !isFallbackFundValue(primaryWorktagValue(tag))
  );
  const baseHasRealCostCenter = base.some(
    tag =>
      primaryWorktagType(tag) === 'Cost_Center_Reference_ID' &&
      !isFallbackCostCenterValue(primaryWorktagValue(tag))
  );
  const baseHasRealLob = base.some(
    tag =>
      isOrgWorktag(tag) &&
      isLobWorktag(tag, relatedLob, lineOfBusinessId) &&
      !isFallbackLobTag(tag, relatedLob, lineOfBusinessId)
  );

  const fundOverride = passthrough.find(
    tag => primaryWorktagType(tag) === 'Fund_ID' && !isFallbackFundValue(primaryWorktagValue(tag))
  );
  const costCenterOverride = passthrough.find(
    tag =>
      primaryWorktagType(tag) === 'Cost_Center_Reference_ID' &&
      !isFallbackCostCenterValue(primaryWorktagValue(tag))
  );
  const lobOverride = passthrough.find(
    tag =>
      isOrgWorktag(tag) &&
      isLobWorktag(tag, relatedLob, lineOfBusinessId) &&
      !isFallbackLobTag(tag, relatedLob, lineOfBusinessId)
  );

  let remainingBase = base;
  const overridden: any[] = [];
  if (!baseHasRealFund && fundOverride) {
    remainingBase = remainingBase.filter(tag => !isFallbackFundTag(tag));
    overridden.push(fundOverride);
  }
  if (!baseHasRealCostCenter && costCenterOverride) {
    remainingBase = remainingBase.filter(tag => !isFallbackCostCenterTag(tag));
    overridden.push(costCenterOverride);
  }
  if (!baseHasRealLob && lobOverride) {
    remainingBase = remainingBase.filter(tag => !isFallbackLobTag(tag, relatedLob, lineOfBusinessId));
    overridden.push(lobOverride);
  }

  const seenTypes = new Set(
    remainingBase.map(primaryWorktagType).filter((type): type is string => Boolean(type))
  );
  const baseIdentities = new Set(
    remainingBase.map(worktagIdentity).filter((identity): identity is string => Boolean(identity))
  );
  const baseWids = new Set(
    remainingBase.map(worktagWid).filter((wid): wid is string => Boolean(wid))
  );
  const remainingHasLob = baseHasLobWorktag(remainingBase, relatedLob, lineOfBusinessId);
  const overriddenSet = new Set(overridden);
  const additions = [...overridden];

  for (const tag of passthrough) {
    if (overriddenSet.has(tag)) continue;
    const type = primaryWorktagType(tag);
    if (!type) {
      const identity = worktagIdentity(tag);
      if (identity == null || baseIdentities.has(identity)) continue;
      baseIdentities.add(identity);
      additions.push(tag);
      continue;
    }
    if (isOrgWorktag(tag)) {
      const identity = worktagIdentity(tag);
      if (identity != null && baseIdentities.has(identity)) continue;
      const wid = worktagWid(tag);
      if (wid != null && baseWids.has(wid)) continue;
      if (isLobWorktag(tag, relatedLob, lineOfBusinessId)) {
        if (remainingHasLob || overridden.includes(lobOverride)) continue;
        if (identity != null) baseIdentities.add(identity);
        if (wid != null) baseWids.add(wid);
        additions.push(tag);
        continue;
      }
      if (identity != null) baseIdentities.add(identity);
      if (wid != null) baseWids.add(wid);
      additions.push(tag);
      continue;
    }
    if (seenTypes.has(type)) continue;
    seenTypes.add(type);
    const identity = worktagIdentity(tag);
    if (identity != null) baseIdentities.add(identity);
    additions.push(tag);
  }

  return additions.length ? [...remainingBase, ...additions] : remainingBase;
}

function roundMoney(amount: number): number {
  return Math.round(amount * 100) / 100;
}

export function enrichSplitWorktagsWithLineLevel(
  splitWorktags: any[],
  lineLevelWorktags: any[] | undefined,
  context?: OrgPassthroughContext
): any[] {
  if (!lineLevelWorktags?.length) return splitWorktags;
  const enriched = [...splitWorktags];
  for (const tag of lineLevelWorktags) {
    if (!isNonAllocationLineLevelTag(tag, context?.relatedLob, context?.lineOfBusinessId)) continue;
    const type = primaryWorktagType(tag);
    if (!type) {
      const wid = worktagWid(tag);
      if (wid == null) continue;
      const splitWids = new Set(
        enriched.map(worktagWid).filter((w): w is string => w != null)
      );
      if (!splitWids.has(wid)) enriched.push(tag);
      continue;
    }
    if (isOrgWorktag(tag)) {
      if (!worktagValuesOverlap(tag, enriched)) enriched.push(tag);
      continue;
    }
    if (!splitHasWorktagType(enriched, type)) enriched.push(tag);
  }
  return enriched;
}

export function mapPoSplitsToSupplierInvoiceSplitLineData(
  splits: PurchaseOrderLineSplit[] | undefined,
  invoiceLineExtendedAmount?: number | null,
  lineLevelWorktags?: any[],
  context?: OrgPassthroughContext
): any[] | undefined {
  if (!splits?.length) return undefined;
  const enrichedSplits = splits.map(split => ({
    ...split,
    worktagReference: enrichSplitWorktagsWithLineLevel(split.worktagReference, lineLevelWorktags, context),
  }));
  const splitAmountSum = enrichedSplits.reduce((sum, split) => sum + (split.extendedAmount ?? 0), 0);
  const targetAmount = invoiceLineExtendedAmount ?? (splitAmountSum > 0 ? splitAmountSum : null);
  if (targetAmount == null) {
    return enrichedSplits.map(split => ({
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

  return enrichedSplits.map((split, index) => ({
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
