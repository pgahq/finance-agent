import { info } from '@pga/logger';

export interface EvalCaseResult {
  id: string;
  passed: boolean;
  details?: string;
}

export interface EvalReport {
  name: string;
  total: number;
  passed: number;
  failed: number;
  accuracy: number;
  results: EvalCaseResult[];
}

export function buildReport(name: string, results: EvalCaseResult[]): EvalReport {
  const passed = results.filter(result => result.passed).length;
  const total = results.length;

  return {
    name,
    total,
    passed,
    failed: total - passed,
    accuracy: total === 0 ? 0 : passed / total,
    results,
  };
}

export function printReport(report: EvalReport): void {
  info(`\n=== ${report.name} ===`);
  info(`Passed: ${report.passed}/${report.total} (${(report.accuracy * 100).toFixed(1)}%)`);

  for (const result of report.results.filter(r => !r.passed)) {
    info(`  FAIL ${result.id}: ${result.details ?? 'no details'}`);
  }
}

export function assertReport(report: EvalReport, minAccuracy: number): void {
  printReport(report);
  expect(report.accuracy).toBeGreaterThanOrEqual(minAccuracy);
}
