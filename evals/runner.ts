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

export type EvalMetrics = Record<string, number>;

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

export function formatEvalResults(report: EvalReport, metrics?: EvalMetrics): string {
  const lines = [
    `${report.name}: ${report.passed}/${report.total} passed (${(report.accuracy * 100).toFixed(1)}% accuracy)`,
  ];

  if (metrics) {
    for (const [label, value] of Object.entries(metrics)) {
      lines.push(`${label}: ${(value * 100).toFixed(1)}%`);
    }
  }

  for (const result of report.results.filter(r => !r.passed)) {
    lines.push(`  FAIL ${result.id}: ${result.details ?? 'no details'}`);
  }

  return lines.join('\n');
}

export function logEvalResults(report: EvalReport, metrics?: EvalMetrics): void {
  info(`\n${formatEvalResults(report, metrics)}`);
}

export function assertReport(report: EvalReport, minAccuracy: number, metrics?: EvalMetrics): void {
  logEvalResults(report, metrics);
  expect(report.accuracy).toBeGreaterThanOrEqual(minAccuracy);
}
