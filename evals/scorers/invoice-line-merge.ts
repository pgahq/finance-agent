import type { FinalInvoiceLine } from '../../src/lib/invoice_lines.js';

const SCORED_FIELDS = [
  'lineOrder',
  'purchaseOrderLineId',
  'costCenterId',
  'fundId',
  'spendCategoryId',
  'lineOfBusinessId',
  'eventId',
  'extendedAmount',
] as const;

type ScoredField = (typeof SCORED_FIELDS)[number];

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
  };
  expected: {
    lines: Array<Partial<FinalInvoiceLine>>;
  };
}

export interface FieldScore {
  field: ScoredField;
  expected: unknown;
  actual: unknown;
  passed: boolean;
}

export function scoreInvoiceLineMergeCase(
  testCase: InvoiceLineMergeCase,
  actualLines: FinalInvoiceLine[]
): { passed: boolean; details?: string; fieldScores: FieldScore[] } {
  const fieldScores: FieldScore[] = [];

  if (actualLines.length !== testCase.expected.lines.length) {
    return {
      passed: false,
      details: `expected ${testCase.expected.lines.length} lines, got ${actualLines.length}`,
      fieldScores,
    };
  }

  for (let index = 0; index < testCase.expected.lines.length; index++) {
    const expectedLine = testCase.expected.lines[index];
    const actualLine = actualLines[index];

    for (const field of SCORED_FIELDS) {
      if (!(field in expectedLine)) {
        continue;
      }

      const expected = expectedLine[field];
      const actual = actualLine[field];
      const passed = expected === actual;

      fieldScores.push({ field, expected, actual, passed });
    }
  }

  const scored = fieldScores.filter(score => score.expected !== undefined);
  const passed = scored.length > 0 && scored.every(score => score.passed);
  const failed = scored.filter(score => !score.passed);

  return {
    passed,
    details: failed.length
      ? failed.map(score => `${score.field}: expected ${score.expected}, got ${score.actual}`).join('; ')
      : undefined,
    fieldScores,
  };
}

export function aggregateFieldAccuracy(fieldScores: FieldScore[]): number {
  const scored = fieldScores.filter(score => score.expected !== undefined);
  if (scored.length === 0) {
    return 0;
  }

  return scored.filter(score => score.passed).length / scored.length;
}
