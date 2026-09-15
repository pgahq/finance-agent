export const COST_CENTER_DNU_MATCH_PENALTY = 0.12;

const DO_NOT_USE_PREFIX = /^(zdnu|dnu)/i;

function stringField(metadata: Record<string, unknown> | undefined, key: string): string {
  const value = metadata?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function isDoNotUseCostCenter(metadata: Record<string, unknown> | undefined): boolean {
  const code = stringField(metadata, 'code');
  const name = stringField(metadata, 'name');
  return [code, name].some((field) => field.length > 0 && DO_NOT_USE_PREFIX.test(field));
}

export function shouldSkipDoNotUsePenalty(
  query: string,
  metadata: Record<string, unknown> | undefined
): boolean {
  const trimmed = query.trim();
  if (!trimmed) return false;

  const code = stringField(metadata, 'code');
  if (code && code.toLowerCase() === trimmed.toLowerCase()) {
    return true;
  }
  return DO_NOT_USE_PREFIX.test(trimmed);
}

export function adjustCostCenterSimilarity(
  similarity: number,
  metadata: Record<string, unknown> | undefined,
  query: string
): number {
  if (!isDoNotUseCostCenter(metadata)) return similarity;
  if (shouldSkipDoNotUsePenalty(query, metadata)) return similarity;
  return Math.max(0, similarity - COST_CENTER_DNU_MATCH_PENALTY);
}

export interface CostCenterReferenceFields {
  referenceId?: string;
  name?: string;
}

export function isDoNotUseCostCenterFields(fields: CostCenterReferenceFields): boolean {
  return isDoNotUseCostCenter({
    code: fields.referenceId,
    name: fields.name,
  });
}

export interface CostCenterRankableResult {
  similarity: number;
  metadata?: Record<string, unknown>;
}

export function rankCostCenterSearchResults<T extends CostCenterRankableResult>(
  results: T[],
  query: string
): T[] {
  return [...results]
    .map((result, index) => ({
      result,
      index,
      adjusted: adjustCostCenterSimilarity(result.similarity, result.metadata, query),
    }))
    .sort((left, right) => {
      if (right.adjusted !== left.adjusted) return right.adjusted - left.adjusted;
      const leftDnu = isDoNotUseCostCenter(left.result.metadata) ? 1 : 0;
      const rightDnu = isDoNotUseCostCenter(right.result.metadata) ? 1 : 0;
      if (leftDnu !== rightDnu) return leftDnu - rightDnu;
      return left.index - right.index;
    })
    .map(({ result, adjusted }) => ({
      ...result,
      similarity: adjusted,
    }));
}
