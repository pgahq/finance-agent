export interface RelatedLob {
  requiredOnTransaction: boolean;
  defaultReferenceId: string | null;
  allowedReferenceIds: string[];
}

export const EMPTY_RELATED_LOB: RelatedLob = {
  requiredOnTransaction: false,
  defaultReferenceId: null,
  allowedReferenceIds: [],
};

const LINE_OF_BUSINESS_ID_TYPES = new Set([
  'Organization_Reference_ID',
  'Custom_Organization_Reference_ID',
]);

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
  return {
    requiredOnTransaction: value.requiredOnTransaction,
    defaultReferenceId: value.defaultReferenceId,
    allowedReferenceIds: value.allowedReferenceIds,
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

function lineOfBusinessIdsFrom(node: unknown): string[] {
  return [...new Set(
    collectIds(node)
      .filter((id): id is { type?: string; value: string } =>
        LINE_OF_BUSINESS_ID_TYPES.has(id.type ?? '') && isLineOfBusinessReferenceId(id.value)
      )
      .map(id => id.value)
  )];
}

function isTruthy(value: unknown): boolean {
  return value === true || value === 'true' || value === '1' || value === 1;
}

function parseRelatedLobFromTypeData(typeData: unknown): RelatedLob | null {
  if (!isRecord(typeData)) return null;
  const defaultIds = lineOfBusinessIdsFrom(typeData.Default_Worktag_Data);
  const allowedIds = lineOfBusinessIdsFrom(typeData.Allowed_Worktag_Data);
  if (defaultIds.length === 0 && allowedIds.length === 0) return null;

  return {
    requiredOnTransaction: isTruthy(typeData.Required_On_Transaction)
      || isTruthy(typeData.Required_On_Transaction_For_Validation),
    defaultReferenceId: defaultIds[0] ?? null,
    allowedReferenceIds: allowedIds,
  };
}

function mergeRelatedLobs(parts: RelatedLob[]): RelatedLob {
  const allowed = [...new Set(parts.flatMap(part => part.allowedReferenceIds))];
  return {
    requiredOnTransaction: parts.some(part => part.requiredOnTransaction),
    defaultReferenceId: parts.find(part => part.defaultReferenceId)?.defaultReferenceId ?? null,
    allowedReferenceIds: allowed,
  };
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

export function resolveRelatedLobId(
  related: RelatedLob | null | undefined,
  costCenterId?: string | null,
  fallbackCostCenterId?: string | null
): string | null {
  if (!costCenterId || (fallbackCostCenterId && costCenterId === fallbackCostCenterId)) {
    return null;
  }
  if (!related) return null;
  if (related.defaultReferenceId) return related.defaultReferenceId;
  if (related.allowedReferenceIds.length === 1) return related.allowedReferenceIds[0];
  return null;
}

export function relatedLobEquals(a: RelatedLob | null | undefined, b: RelatedLob | null | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
