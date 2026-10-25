import type { FinalInvoiceLine, InvoiceDateContext } from '../lib/invoice_lines.js';
import type { WorkdayValidationFieldDecision, WorkdayValidationFieldInput } from '../lib/workday_validation_field_agent.js';

export interface SuiteCaseResult {
  id: string;
  passed: boolean;
  details?: string;
}

export interface SuiteReport {
  name: string;
  total: number;
  passed: number;
  accuracy: number;
  results: SuiteCaseResult[];
}

export function buildSuiteReport(name: string, results: SuiteCaseResult[]): SuiteReport {
  const passed = results.filter((result) => result.passed).length;
  return { name, total: results.length, passed, accuracy: results.length ? passed / results.length : 0, results };
}

export function formatSuiteReport(report: SuiteReport, extra: Record<string, number> = {}): string {
  const lines = [`${report.name}: ${report.passed}/${report.total} passed (${(report.accuracy * 100).toFixed(1)}%)`];
  for (const [label, value] of Object.entries(extra)) lines.push(`  ${label}: ${(value * 100).toFixed(1)}%`);
  for (const result of report.results.filter((entry) => !entry.passed)) {
    lines.push(`  FAIL ${result.id}: ${result.details ?? 'no details'}`);
  }
  return lines.join('\n');
}

export interface ValidationFieldCase {
  id: string;
  input: WorkdayValidationFieldInput;
  expected: { retryField: WorkdayValidationFieldDecision['retryField'] };
}

export function scoreValidationFieldCase(testCase: ValidationFieldCase, actual: WorkdayValidationFieldDecision): SuiteCaseResult {
  const passed = actual.retryField === testCase.expected.retryField;
  return {
    id: testCase.id,
    passed,
    ...(passed ? {} : { details: `expected retryField=${testCase.expected.retryField}, got ${actual.retryField}` }),
  };
}

export const MERGE_SCORED_FIELDS = [
  'lineOrder',
  'purchaseOrderLineId',
  'costCenterId',
  'fundId',
  'spendCategoryId',
  'lineOfBusinessId',
  'eventId',
  'extendedAmount',
  'omitPurchaseOrderLineReference',
] as const;

type MergeScoredField = (typeof MERGE_SCORED_FIELDS)[number];

export interface InvoiceLineMergeCase {
  id: string;
  input: {
    extractedInvoiceLines: Array<{
      description: string;
      quantity?: number | null;
      unitCost?: string | null;
      totalPrice?: string | null;
    }>;
    purchaseOrderLines?: Array<Record<string, unknown>>;
    emailBody?: string | null;
    fallbackIds?: Record<string, string>;
    emailWorktags?: Record<string, string | null>;
    invoiceLineQuantityDisplayed?: boolean;
    /** What the create pipeline passes as `invoiceContext`: the invoice date and printed service period. */
    invoiceDate?: string | null;
    servicePeriod?: string | null;
    /** A Closed or Pending Close PO: the pipeline omits `invoiceContext`, which selects the legacy merge. */
    poClosedForInvoicing?: boolean;
  };
  expected: { lines: Array<Partial<FinalInvoiceLine>> };
}

/**
 * The `invoiceContext` argument the create and enrich pipelines pass to `buildFinalInvoiceLines`. Leaving it undefined
 * selects the legacy merge, so only a closed PO does.
 */
export function invoiceContextOf(testCase: InvoiceLineMergeCase): InvoiceDateContext | undefined {
  if (testCase.input.poClosedForInvoicing) return undefined;
  return { invoiceDate: testCase.input.invoiceDate ?? undefined, servicePeriod: testCase.input.servicePeriod ?? undefined };
}

export interface FieldScore {
  field: MergeScoredField;
  expected: unknown;
  actual: unknown;
  passed: boolean;
}

export function scoreInvoiceLineMergeCase(
  testCase: InvoiceLineMergeCase,
  actualLines: FinalInvoiceLine[]
): SuiteCaseResult & { fieldScores: FieldScore[] } {
  const fieldScores: FieldScore[] = [];
  if (actualLines.length !== testCase.expected.lines.length) {
    return {
      id: testCase.id,
      passed: false,
      details: `expected ${testCase.expected.lines.length} lines, got ${actualLines.length}`,
      fieldScores,
    };
  }
  testCase.expected.lines.forEach((expectedLine, index) => {
    for (const field of MERGE_SCORED_FIELDS) {
      if (!(field in expectedLine)) continue;
      const expected = expectedLine[field];
      const actual = actualLines[index][field];
      fieldScores.push({ field, expected, actual, passed: expected === actual });
    }
  });
  const failed = fieldScores.filter((score) => !score.passed);
  return {
    id: testCase.id,
    passed: fieldScores.length > 0 && failed.length === 0,
    ...(failed.length ? { details: failed.map((score) => `${score.field}: expected ${String(score.expected)}, got ${String(score.actual)}`).join('; ') } : {}),
    fieldScores,
  };
}

export function aggregateFieldAccuracy(fieldScores: FieldScore[]): number {
  return fieldScores.length ? fieldScores.filter((score) => score.passed).length / fieldScores.length : 0;
}
