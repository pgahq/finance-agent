export interface SupplierRagCase {
  id: string;
  query: string;
  expectedWorkdayId: string;
  matchRank?: number;
}

export interface SupplierRagResult {
  workday_id: string;
  similarity?: number;
}

export function scoreSupplierRagCase(
  testCase: SupplierRagCase,
  results: SupplierRagResult[]
): { passed: boolean; details?: string; hitAt1: boolean; hitAt3: boolean } {
  const matchRank = testCase.matchRank ?? 3;
  const topResults = results.slice(0, matchRank);
  const hitAt1 = results[0]?.workday_id === testCase.expectedWorkdayId;
  const hitAt3 = topResults.some(result => result.workday_id === testCase.expectedWorkdayId);

  return {
    passed: hitAt3,
    hitAt1,
    hitAt3,
    details: hitAt3
      ? undefined
      : `expected ${testCase.expectedWorkdayId} in top ${matchRank}, got ${topResults.map(r => r.workday_id).join(', ') || 'no results'}`,
  };
}

export function aggregateHitRate(
  scores: Array<{ hitAt1: boolean; hitAt3: boolean }>,
  rank: 1 | 3
): number {
  if (scores.length === 0) {
    return 0;
  }

  const key = rank === 1 ? 'hitAt1' : 'hitAt3';
  return scores.filter(score => score[key]).length / scores.length;
}
