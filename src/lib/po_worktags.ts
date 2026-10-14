import {
  DEFAULT_LINE_OF_BUSINESS_ID,
  isLineOfBusinessReferenceId,
  relatedLobAllowsId,
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
  /** When true, keep a fallback cost center instead of letting PO passthrough restore a rejected one. */
  lockFallbackCostCenter?: boolean;
  /** Cached organization kinds keyed by WID or reference ID, so unprefixed PO LOBs are recognized. */
  orgKinds?: Map<string, OrgWorktagKind>;
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

// Workday returns cost centers with a generic Organization_Reference_ID next to Cost_Center_Reference_ID,
// so prefer any ID type outside ORG_WORKTAG_ID_TYPES. LOBs, venues and events only carry organization
// ID types and keep resolving as organization worktags.
function primaryWorktagId(tag: any): any | undefined {
  const typed = ([] as any[])
    .concat(tag?.ID ?? [])
    .filter((id: any) => id?.$attributes?.type && id.$attributes.type !== 'WID');
  return typed.find((id: any) => !ORG_WORKTAG_ID_TYPES.has(id.$attributes.type)) ?? typed[0];
}

function primaryWorktagType(tag: any): string | null {
  return primaryWorktagId(tag)?.$attributes?.type ?? null;
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

const WORKDAY_WID_PATTERN = /^[0-9a-f]{32}$/i;

function normalizeLobValue(value: string): string {
  return value.trim().replace(/[\s_]+/g, '_').toLowerCase();
}

function lobValueAliases(value: string): string[] {
  const normalized = normalizeLobValue(value);
  if (!normalized) return [];
  const aliases = [normalized];
  if (normalized.startsWith('lob-') && !WORKDAY_WID_PATTERN.test(value.trim())) {
    aliases.push(normalized.slice(4));
  }
  return aliases;
}

function lobValuesMatch(a: string, b: string): boolean {
  const aAliases = lobValueAliases(a);
  return lobValueAliases(b).some(alias => aAliases.includes(alias));
}

export function isLobWorktag(
  tag: any,
  relatedLob?: RelatedLob | null,
  lineOfBusinessId?: string | null,
  orgKinds?: Map<string, OrgWorktagKind>
): boolean {
  for (const value of worktagIdValues(tag)) {
    if ((orgKinds?.get(value) ?? orgKinds?.get(value.toLowerCase())) === 'lob') return true;
    if (isLineOfBusinessReferenceId(value)) return true;
    if (relatedLob && relatedLobAllowsId(relatedLob, value)) return true;
    if (lineOfBusinessId && (value === lineOfBusinessId || lobValuesMatch(value, lineOfBusinessId))) {
      return true;
    }
  }
  return false;
}

function baseHasLobWorktag(
  base: any[],
  relatedLob?: RelatedLob | null,
  lineOfBusinessId?: string | null,
  orgKinds?: Map<string, OrgWorktagKind>
): boolean {
  return base.some(tag => isOrgWorktag(tag) && isLobWorktag(tag, relatedLob, lineOfBusinessId, orgKinds));
}

function primaryWorktagValue(tag: any): string | null {
  const ids = ([] as any[]).concat(tag?.ID ?? []);
  const primary = primaryWorktagId(tag);
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
  return value === fallback || lobValuesMatch(value, fallback);
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

function isCostCenterWorktag(tag: any): boolean {
  return primaryWorktagType(tag) === 'Cost_Center_Reference_ID';
}

export function replaceWorktagsOfType(
  worktags: any[] | undefined,
  type: string,
  replacement: any | null
): any[] {
  const remaining = (worktags ?? []).filter(tag => primaryWorktagType(tag) !== type);
  if (!replacement) return remaining;
  return [...remaining, replacement];
}

/** Put exactly one fallback cost center on the line: every split when any split carries CC, otherwise the parent. */
export function replaceCostCenterWorktagsWithFallback(
  parentWorktags: any[],
  splits: any[] | undefined,
  fallbackRef: any
): { worktags: any[]; supplierInvoiceSplitLineData: any[] | undefined } {
  const splitList = splits ?? [];
  const anySplitHasCostCenter = splitList.some(split =>
    ([] as any[]).concat(split?.Worktag_Reference ?? []).some(isCostCenterWorktag)
  );
  const nextSplits = anySplitHasCostCenter
    ? splitList.map(split => ({
      ...split,
      Worktag_Reference: replaceWorktagsOfType(
        ([] as any[]).concat(split?.Worktag_Reference ?? []),
        'Cost_Center_Reference_ID',
        fallbackRef
      ),
    }))
    : splits;
  return {
    worktags: replaceWorktagsOfType(
      parentWorktags,
      'Cost_Center_Reference_ID',
      anySplitHasCostCenter ? null : fallbackRef
    ),
    supplierInvoiceSplitLineData: nextSplits,
  };
}

function isFallbackLobTag(
  tag: any,
  relatedLob?: RelatedLob | null,
  lineOfBusinessId?: string | null,
  orgKinds?: Map<string, OrgWorktagKind>
): boolean {
  if (!isOrgWorktag(tag) || !isLobWorktag(tag, relatedLob, lineOfBusinessId, orgKinds)) return false;
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
  lineOfBusinessId?: string | null,
  orgKinds?: Map<string, OrgWorktagKind>
): boolean {
  return splitWorktags.some(
    tag => isOrgWorktag(tag) && isLobWorktag(tag, relatedLob, lineOfBusinessId, orgKinds)
  );
}

function everySplitHasWorktagType(splits: PurchaseOrderLineSplit[], type: string): boolean {
  return splits.length > 0 && splits.every(split => splitHasWorktagType(split.worktagReference, type));
}

function everySplitHasLobWorktag(
  splits: PurchaseOrderLineSplit[],
  relatedLob?: RelatedLob | null,
  lineOfBusinessId?: string | null,
  orgKinds?: Map<string, OrgWorktagKind>
): boolean {
  return (
    splits.length > 0 &&
    splits.every(split => splitHasLobWorktag(split.worktagReference, relatedLob, lineOfBusinessId, orgKinds))
  );
}

function isNonAllocationLineLevelTag(
  tag: any,
  relatedLob?: RelatedLob | null,
  lineOfBusinessId?: string | null,
  orgKinds?: Map<string, OrgWorktagKind>
): boolean {
  const type = primaryWorktagType(tag);
  if (!type) return true;
  if (type === 'Fund_ID' || type === 'Cost_Center_Reference_ID') return false;
  if (isOrgWorktag(tag)) return !isLobWorktag(tag, relatedLob, lineOfBusinessId, orgKinds);
  return true;
}

export type OrgWorktagKind = 'lob' | 'event';

export interface WorktagTypeContext {
  relatedLob?: RelatedLob | null;
  lineOfBusinessId?: string | null;
  /** Workday organization type keyed by WID or reference ID (reference IDs lowercased). */
  orgKinds?: Map<string, OrgWorktagKind>;
}

function orgWorktagKind(tag: any, context?: WorktagTypeContext): OrgWorktagKind | null {
  for (const value of worktagIdValues(tag)) {
    const kind = context?.orgKinds?.get(value) ?? context?.orgKinds?.get(value.toLowerCase());
    if (kind) return kind;
  }
  return isLobWorktag(tag, context?.relatedLob, context?.lineOfBusinessId, context?.orgKinds) ? 'lob' : null;
}

// Workday allows one worktag per Workday type on a line or split row. Non-organization
// types are distinct SOAP ID types. Organization tags (LOB, event, venue, ...) share
// Organization_Reference_ID, so only LOB and event can be typed; others stay as-is.
function worktagTypeKey(tag: any, context?: WorktagTypeContext): string | null {
  const type = primaryWorktagType(tag);
  if (type && !ORG_WORKTAG_ID_TYPES.has(type)) return type;
  const kind = orgWorktagKind(tag, context);
  return kind ? `org:${kind}` : null;
}

function isFallbackLobValueTag(tag: any): boolean {
  return worktagIdValues(tag).some(value => isFallbackLobValue(value));
}

/** Keep the first worktag of each Workday type, except a real LOB replaces a fallback LOB; return the rest as dropped. */
export function collapseWorktagsToOnePerType(
  worktags: any[],
  context?: WorktagTypeContext
): { worktags: any[]; dropped: any[] } {
  const keptIndexByKey = new Map<string, number>();
  const seenIdentities = new Set<string>();
  const kept: any[] = [];
  const dropped: any[] = [];
  for (const tag of worktags) {
    const identity = worktagIdentity(tag);
    if (identity && seenIdentities.has(identity)) {
      dropped.push(tag);
      continue;
    }
    const key = worktagTypeKey(tag, context);
    const keptIndex = key ? keptIndexByKey.get(key) : undefined;
    if (keptIndex !== undefined) {
      const current = kept[keptIndex];
      if (key === 'org:lob' && isFallbackLobValueTag(current) && !isFallbackLobValueTag(tag)) {
        kept[keptIndex] = tag;
        dropped.push(current);
        if (identity) seenIdentities.add(identity);
      } else {
        dropped.push(tag);
      }
      continue;
    }
    if (identity) seenIdentities.add(identity);
    if (key) keptIndexByKey.set(key, kept.length);
    kept.push(tag);
  }
  return { worktags: kept, dropped };
}

export function worktagIdValuesFromReferences(worktags: any[]): string[] {
  return worktags.flatMap(worktagIdValues);
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
  const stripLob = splits == null || everySplitHasLobWorktag(splits, context?.relatedLob, context?.lineOfBusinessId, context?.orgKinds);
  return passthrough.filter(tag => {
    const type = primaryWorktagType(tag);
    if (!type) return true;
    if (type === 'Fund_ID') return !stripFund;
    if (type === 'Cost_Center_Reference_ID') return !stripCostCenter;
    if (isOrgWorktag(tag)) {
      if (!isLobWorktag(tag, context?.relatedLob, context?.lineOfBusinessId, context?.orgKinds)) return true;
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
  const orgKinds = context?.orgKinds;
  const lockFallbackCostCenter = Boolean(context?.lockFallbackCostCenter);

  const baseHasRealFund = base.some(
    tag => primaryWorktagType(tag) === 'Fund_ID' && !isFallbackFundValue(primaryWorktagValue(tag))
  );
  const baseHasRealCostCenter = lockFallbackCostCenter || base.some(
    tag =>
      primaryWorktagType(tag) === 'Cost_Center_Reference_ID' &&
      !isFallbackCostCenterValue(primaryWorktagValue(tag))
  );
  const baseHasRealLob = base.some(
    tag =>
      isOrgWorktag(tag) &&
      isLobWorktag(tag, relatedLob, lineOfBusinessId, orgKinds) &&
      !isFallbackLobTag(tag, relatedLob, lineOfBusinessId, orgKinds)
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
      isLobWorktag(tag, relatedLob, lineOfBusinessId, orgKinds) &&
      !isFallbackLobTag(tag, relatedLob, lineOfBusinessId, orgKinds)
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
    remainingBase = remainingBase.filter(tag => !isFallbackLobTag(tag, relatedLob, lineOfBusinessId, orgKinds));
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
  const remainingHasLob = baseHasLobWorktag(remainingBase, relatedLob, lineOfBusinessId, orgKinds);
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
      if (isLobWorktag(tag, relatedLob, lineOfBusinessId, orgKinds)) {
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
    if (type === 'Cost_Center_Reference_ID' && lockFallbackCostCenter) continue;
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
    if (!isNonAllocationLineLevelTag(tag, context?.relatedLob, context?.lineOfBusinessId, context?.orgKinds)) continue;
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

/** A PO line distributed by quantity carries a positive quantity on every split row. */
export function isQuantityDistributedSplits(splits: PurchaseOrderLineSplit[] | undefined): boolean {
  return splits != null && splits.length > 0 && splits.every(split => (split.quantity ?? 0) > 0);
}

export function poLineSplitQuantityCapacity(splits: PurchaseOrderLineSplit[] | undefined): number {
  return (splits ?? []).reduce((sum, split) => sum + (split.quantity ?? 0), 0);
}

const SPLIT_QUANTITY_DECIMALS = 2;

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Share an invoice line quantity across PO splits in the PO's quantity ratio. Whole numbers are
 * preferred (largest remainder) when the quantity is whole and no split would end up with zero units.
 */
export function allocateSplitQuantities(splits: PurchaseOrderLineSplit[], invoiceQuantity: number): number[] {
  const weights = splits.map(split => split.quantity ?? 0);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const raw = weights.map(weight => (invoiceQuantity * weight) / total);

  if (raw.every(value => Math.abs(value - Math.round(value)) < 1e-9)) return raw.map(Math.round);

  if (Number.isInteger(invoiceQuantity) && invoiceQuantity >= splits.length) {
    const floors = raw.map(Math.floor);
    let remaining = invoiceQuantity - floors.reduce((sum, value) => sum + value, 0);
    const byRemainder = raw
      .map((value, index) => ({ index, remainder: value - floors[index] }))
      .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
    for (const { index } of byRemainder) {
      if (remaining <= 0) break;
      floors[index] += 1;
      remaining -= 1;
    }
    if (floors.every(value => value > 0)) return floors;
  }

  const rounded = raw.map(value => roundTo(value, SPLIT_QUANTITY_DECIMALS));
  const drift = roundTo(invoiceQuantity - rounded.reduce((sum, value) => sum + value, 0), SPLIT_QUANTITY_DECIMALS);
  rounded[rounded.length - 1] = roundTo(rounded[rounded.length - 1] + drift, SPLIT_QUANTITY_DECIMALS);
  return rounded;
}

export interface SplitQuantityContext {
  quantity: number;
  unitCost?: number | null;
}

export function mapPoSplitsToSupplierInvoiceSplitLineData(
  splits: PurchaseOrderLineSplit[] | undefined,
  invoiceLineExtendedAmount?: number | null,
  lineLevelWorktags?: any[],
  context?: OrgPassthroughContext,
  splitQuantity?: SplitQuantityContext
): any[] | undefined {
  if (!splits?.length) return undefined;
  const enrichedSplits = splits.map(split => ({
    ...split,
    worktagReference: enrichSplitWorktagsWithLineLevel(split.worktagReference, lineLevelWorktags, context),
  }));

  if (splitQuantity && splitQuantity.quantity > 0 && isQuantityDistributedSplits(splits)) {
    const quantities = allocateSplitQuantities(splits, splitQuantity.quantity);
    // Workday checks each split as quantity x unit cost, so when the line total disagrees with its own
    // quantity x unit cost, price the splits from the total and let the line-level fault handling decide.
    const impliedUnitCost = invoiceLineExtendedAmount != null ? invoiceLineExtendedAmount / splitQuantity.quantity : null;
    const lineTotalMatches = splitQuantity.unitCost != null
      && invoiceLineExtendedAmount != null
      && Math.abs(splitQuantity.unitCost * splitQuantity.quantity - invoiceLineExtendedAmount) < 0.01;
    const unitCost = splitQuantity.unitCost != null && (invoiceLineExtendedAmount == null || lineTotalMatches)
      ? splitQuantity.unitCost
      : impliedUnitCost;
    const amounts = unitCost == null ? undefined : quantities.map(quantity => roundMoney(quantity * unitCost));
    if (amounts && invoiceLineExtendedAmount != null) {
      const drift = roundMoney(invoiceLineExtendedAmount - amounts.reduce((sum, amount) => sum + amount, 0));
      if (Math.abs(drift) >= 0.01) amounts[amounts.length - 1] = roundMoney(amounts[amounts.length - 1] + drift);
    }
    return enrichedSplits.map((split, index) => ({
      Quantity: quantities[index],
      ...(amounts && { Extended_Amount: amounts[index] }),
      ...(split.memo && { Memo: split.memo }),
      ...(split.worktagReference.length > 0 && { Worktag_Reference: split.worktagReference }),
    }));
  }

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

export interface QuantityPoLineCandidate {
  lineOrder: number;
  purchaseOrderLineId?: string | null;
  quantity?: number | null;
  extendedAmount?: number | null;
  splits?: PurchaseOrderLineSplit[];
}

/**
 * When several invoice lines link to one quantity-distributed PO line, only as many as fit its
 * ordered quantity can keep the link. Larger quantities claim it first; the rest must be coded
 * from the PO without the link so Workday does not count their quantity against the PO line.
 */
export function lineOrdersExceedingQuantityPoLine(lines: QuantityPoLineCandidate[]): Set<number> {
  const unlinked = new Set<number>();
  const byPoLine = new Map<string, QuantityPoLineCandidate[]>();
  for (const line of lines) {
    if (!line.purchaseOrderLineId || !isQuantityDistributedSplits(line.splits)) continue;
    byPoLine.set(line.purchaseOrderLineId, [...(byPoLine.get(line.purchaseOrderLineId) ?? []), line]);
  }
  for (const group of byPoLine.values()) {
    if (group.length < 2) continue;
    const capacity = poLineSplitQuantityCapacity(group[0].splits);
    const ranked = [...group].sort((a, b) =>
      (b.quantity ?? 0) - (a.quantity ?? 0)
      || (b.extendedAmount ?? 0) - (a.extendedAmount ?? 0)
      || a.lineOrder - b.lineOrder
    );
    let used = 0;
    for (const line of ranked) {
      const quantity = line.quantity ?? 0;
      if (quantity > 0 && used + quantity <= capacity + 1e-9) {
        used += quantity;
      } else {
        unlinked.add(line.lineOrder);
      }
    }
  }
  return unlinked;
}

export function firstNonEmptyPoLineArray(...sources: unknown[]): any[] {
  for (const source of sources) {
    const arr = ([] as any[]).concat(source ?? []);
    if (arr.length > 0) return arr;
  }
  return [];
}
