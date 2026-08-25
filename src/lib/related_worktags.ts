export interface RelatedWorktagId {
  type: string;
  value: string;
}

export interface RelatedLob {
  requiredOnTransaction: boolean;
  defaultReferenceId: string | null;
  allowedReferenceIds: string[];
  defaultIds?: RelatedWorktagId[];
  allowedIds?: RelatedWorktagId[];
}

export const EMPTY_RELATED_LOB: RelatedLob = {
  requiredOnTransaction: false,
  defaultReferenceId: null,
  allowedReferenceIds: [],
  defaultIds: [],
  allowedIds: [],
};

const LINE_OF_BUSINESS_ID_TYPES = new Set([
  'Organization_Reference_ID',
  'Custom_Organization_Reference_ID',
]);

const RELATED_LOB_ID_TYPES = new Set([
  'WID',
  'Organization_Reference_ID',
  'Custom_Organization_Reference_ID',
]);

const PREFERRED_RELATED_LOB_ID_TYPES = [
  'Organization_Reference_ID',
  'Custom_Organization_Reference_ID',
  'WID',
] as const;

const WORKDAY_WID = /^[0-9a-f]{32}$/i;

export function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

export const DEFAULT_LINE_OF_BUSINESS_ID = 'Default_Line_Of_Business';

export function isLineOfBusinessReferenceId(value: unknown): value is string {
  return typeof value === 'string' && (/^LOB-/i.test(value) || value === DEFAULT_LINE_OF_BUSINESS_ID);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null;
}

export function parseRelatedLob(value: unknown): RelatedLob | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.requiredOnTransaction !== 'boolean') return undefined;
  if (value.defaultReferenceId !== null && typeof value.defaultReferenceId !== 'string') return undefined;
  if (!Array.isArray(value.allowedReferenceIds) || !value.allowedReferenceIds.every(id => typeof id === 'string')) {
    return undefined;
  }
  const defaultIds = parseTypedIds(value.defaultIds)
    ?? typedIdsFromValues(value.defaultReferenceId ? [value.defaultReferenceId] : []);
  const allowedIds = parseTypedIds(value.allowedIds)
    ?? typedIdsFromValues(value.allowedReferenceIds);
  return relatedLobFromTypedIds(
    value.requiredOnTransaction,
    defaultIds,
    allowedIds,
    value.defaultReferenceId,
    value.allowedReferenceIds
  );
}

function parseTypedIds(value: unknown): RelatedWorktagId[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) return undefined;
  const ids: RelatedWorktagId[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.type !== 'string' || typeof item.value !== 'string' || !item.value) {
      return undefined;
    }
    ids.push({ type: item.type, value: item.value });
  }
  return uniqueTypedIds(ids);
}

function typedIdsFromValues(values: string[]): RelatedWorktagId[] {
  return uniqueTypedIds(values.filter(Boolean).map(value => ({
    type: WORKDAY_WID.test(value) ? 'WID' : 'Organization_Reference_ID',
    value,
  })));
}

function uniqueTypedIds(ids: RelatedWorktagId[]): RelatedWorktagId[] {
  const seen = new Set<string>();
  const unique: RelatedWorktagId[] = [];
  for (const id of ids) {
    const key = `${id.type}:${id.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(id);
  }
  return unique.sort((a, b) => a.type.localeCompare(b.type) || a.value.localeCompare(b.value));
}

function preferredSubmitValues(ids: RelatedWorktagId[]): string[] {
  const values: string[] = [];
  for (const type of PREFERRED_RELATED_LOB_ID_TYPES) {
    for (const id of ids) {
      if (id.type === type && !values.includes(id.value)) values.push(id.value);
    }
  }
  return values;
}

function relatedLobFromTypedIds(
  requiredOnTransaction: boolean,
  defaultIds: RelatedWorktagId[],
  allowedIds: RelatedWorktagId[],
  defaultReferenceId?: string | null,
  allowedReferenceIds?: string[]
): RelatedLob {
  const preferredDefault = preferredSubmitValues(defaultIds)[0] ?? defaultReferenceId ?? null;
  const preferredAllowed = preferredSubmitValues(allowedIds);
  return {
    requiredOnTransaction,
    defaultIds,
    allowedIds,
    defaultReferenceId: preferredDefault,
    allowedReferenceIds: preferredAllowed.length > 0 ? preferredAllowed : [...(allowedReferenceIds ?? [])],
  };
}

function soapAttributeType(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const attributes = value.$attributes;
  if (!isRecord(attributes) || typeof attributes.type !== 'string') return undefined;
  return attributes.type;
}

function soapValue(value: unknown): unknown {
  return isRecord(value) ? value.$value : undefined;
}

function collectIds(node: unknown, results: Array<{ type?: string; value?: string }> = []): Array<{ type?: string; value?: string }> {
  if (Array.isArray(node)) {
    for (const item of node) collectIds(item, results);
    return results;
  }
  if (!isRecord(node)) return results;

  const type = soapAttributeType(node);
  if (type && node.$value != null) {
    results.push({ type, value: String(node.$value) });
  }
  for (const child of Object.values(node)) {
    collectIds(child, results);
  }
  return results;
}

export function extractLineOfBusinessId(worktags: unknown): string | null {
  for (const worktag of asArray(worktags)) {
    const ids = isRecord(worktag) ? asArray(worktag.ID) : [];
    const match = ids.find(id =>
      LINE_OF_BUSINESS_ID_TYPES.has(soapAttributeType(id) ?? '') && isLineOfBusinessReferenceId(soapValue(id))
    );
    const matchValue = soapValue(match);
    if (isLineOfBusinessReferenceId(matchValue)) return matchValue;
  }
  return null;
}

function isTruthy(value: unknown): boolean {
  return value === true || value === 'true' || value === '1' || value === 1;
}

export function relatedLobHasUsableValue(related: RelatedLob | null | undefined): boolean {
  return Boolean(
    related?.defaultReferenceId
    || related?.allowedReferenceIds?.length
    || related?.defaultIds?.length
    || related?.allowedIds?.length
  );
}

const CUSTOM_ORGANIZATION_TYPE_ID = /^CUSTOM_ORGANIZATION_(?:0?[1-9]|10)$/i;

function soapDescriptor(node: unknown): string | undefined {
  if (!isRecord(node)) return undefined;
  const attributes = node.$attributes;
  if (isRecord(attributes) && typeof attributes.Descriptor === 'string' && attributes.Descriptor) {
    return attributes.Descriptor;
  }
  if (typeof node.Descriptor === 'string' && node.Descriptor) return node.Descriptor;
  return undefined;
}

function collectTypeSignals(node: unknown, results: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectTypeSignals(item, results);
    return results;
  }
  if (!isRecord(node)) return results;

  const descriptor = soapDescriptor(node);
  if (descriptor) results.push(descriptor);
  const type = soapAttributeType(node);
  if (type && node.$value != null) results.push(String(node.$value));
  for (const child of Object.values(node)) collectTypeSignals(child, results);
  return results;
}

function isLineOfBusinessTypeSignal(value: string): boolean {
  return /line[_\s-]*of[_\s-]*business/i.test(value) || CUSTOM_ORGANIZATION_TYPE_ID.test(value);
}

function isLineOfBusinessWorktagType(typeData: Record<string, unknown>): boolean {
  return collectTypeSignals(typeData.Worktag_Type_Reference).some(isLineOfBusinessTypeSignal);
}

function relatedWorktagIdsFrom(node: unknown, requireLobPrefix: boolean): RelatedWorktagId[] {
  return uniqueTypedIds(
    collectIds(node)
      .filter((id): id is { type: string; value: string } =>
        RELATED_LOB_ID_TYPES.has(id.type ?? '') && Boolean(id.value)
      )
      .filter(id => !requireLobPrefix || isLineOfBusinessReferenceId(id.value))
      .map(id => ({ type: id.type, value: id.value }))
  );
}

function parseRelatedLobFromTypeData(typeData: unknown): RelatedLob | null {
  if (!isRecord(typeData)) return null;
  const requireLobPrefix = !isLineOfBusinessWorktagType(typeData);
  const defaultIds = relatedWorktagIdsFrom(typeData.Default_Worktag_Data, requireLobPrefix);
  const allowedIds = relatedWorktagIdsFrom(typeData.Allowed_Worktag_Data, requireLobPrefix);
  if (defaultIds.length === 0 && allowedIds.length === 0) return null;

  return relatedLobFromTypedIds(
    isTruthy(typeData.Required_On_Transaction) || isTruthy(typeData.Required_On_Transaction_For_Validation),
    defaultIds,
    allowedIds
  );
}

function mergeRelatedLobs(parts: RelatedLob[]): RelatedLob {
  return relatedLobFromTypedIds(
    parts.some(part => part.requiredOnTransaction),
    uniqueTypedIds(parts.flatMap(part => part.defaultIds ?? [])),
    uniqueTypedIds(parts.flatMap(part => part.allowedIds ?? []))
  );
}

function costCenterKeysFromReference(reference: unknown): string[] {
  const keys: string[] = [];
  for (const id of collectIds(reference)) {
    if (id.type === 'WID' || id.type === 'Cost_Center_Reference_ID') {
      if (id.value) keys.push(id.value);
    }
  }
  return [...new Set(keys)];
}

function relatedWorktagsFromResponse(response: unknown): unknown[] {
  if (!isRecord(response)) return [];
  return asArray(response.Response_Data).flatMap(data => (
    isRecord(data) ? asArray(data.Related_Worktags) : []
  ));
}

export function parseRelatedWorktagsResponse(response: unknown): Map<string, RelatedLob> {
  const byKey = new Map<string, RelatedLob>();

  for (const entry of relatedWorktagsFromResponse(response)) {
    if (!isRecord(entry)) continue;
    const keys = costCenterKeysFromReference(entry.Related_Worktag_Reference);
    const relatedWorktagsData = isRecord(entry.Related_Worktags_Data) ? entry.Related_Worktags_Data : {};
    const typeData = asArray(relatedWorktagsData.Related_Worktags_by_Type_Data);
    const relatedParts = typeData
      .map(parseRelatedLobFromTypeData)
      .filter((part): part is RelatedLob => part != null);
    const related = relatedParts.length > 0 ? mergeRelatedLobs(relatedParts) : EMPTY_RELATED_LOB;

    for (const key of keys) {
      byKey.set(key, related);
    }
  }

  return byKey;
}

export function relatedWorktagsTotalPages(response: unknown): number {
  const results = isRecord(response) ? asArray(response.Response_Results)[0] : undefined;
  const totalPages = Number(isRecord(results) ? results.Total_Pages : 1);
  return Number.isFinite(totalPages) && totalPages > 0 ? totalPages : 1;
}

function isGlobalFallbackLobId(id: string): boolean {
  return id === DEFAULT_LINE_OF_BUSINESS_ID || id === process.env.FALLBACK_LOB_ID;
}

export function resolveRelatedLobId(
  related: RelatedLob | null | undefined,
  costCenterId?: string | null,
  fallbackCostCenterId?: string | null,
  excludeIds?: Iterable<string>
): string | null {
  if (!costCenterId || (fallbackCostCenterId && costCenterId === fallbackCostCenterId)) {
    return null;
  }
  if (!related) return null;

  const excluded = new Set(excludeIds ?? []);
  const candidates: string[] = [];
  if (related.defaultReferenceId) candidates.push(related.defaultReferenceId);
  for (const id of related.allowedReferenceIds) {
    if (!candidates.includes(id)) candidates.push(id);
  }

  const usable = candidates.filter(id => id && !excluded.has(id));
  const preferred = usable.filter(id => !isGlobalFallbackLobId(id));
  return preferred[0] ?? usable[0] ?? null;
}

export function relatedLobSoapReference(
  related: RelatedLob | null | undefined,
  id: string
): RelatedWorktagId {
  const ids = [...(related?.defaultIds ?? []), ...(related?.allowedIds ?? [])];
  for (const type of PREFERRED_RELATED_LOB_ID_TYPES) {
    const match = ids.find(item => item.type === type && item.value === id);
    if (match) return match;
  }
  const match = ids.find(item => item.value === id);
  if (match) return match;
  return {
    type: WORKDAY_WID.test(id) ? 'WID' : 'Organization_Reference_ID',
    value: id,
  };
}

export function relatedLobEquals(a: RelatedLob | null | undefined, b: RelatedLob | null | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
