import { info } from '@pga/logger';
import './setup.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildFinalInvoiceLines } from '../src/lib/invoice_lines.js';
import type { PurchaseOrderLine } from '../src/lib/workday.js';
import { buildReport, printReport, type EvalCaseResult } from './runner.js';
import {
  aggregateFieldAccuracy,
  scoreInvoiceLineMergeCase,
  type InvoiceLineMergeCase,
} from './scorers/invoice-line-merge.js';
import { requireEvalEnv } from './setup.js';

const fixturePath = join(process.cwd(), 'evals/fixtures/invoice-line-merge.json');
const MIN_FIELD_ACCURACY = 0.75;

const describeEval = process.env.RUN_EVALS === '1' ? describe : describe.skip;

describeEval('invoice line merge eval', () => {
  beforeAll(() => {
    requireEvalEnv();
  });

  it('maps extracted invoice lines to PO worktags', async () => {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      cases: InvoiceLineMergeCase[];
    };

    const results: EvalCaseResult[] = [];
    const allFieldScores = [];

    for (const testCase of fixture.cases) {
      const { lines } = await buildFinalInvoiceLines(
        testCase.input.extractedInvoiceLines,
        testCase.input.purchaseOrderLines as PurchaseOrderLine[] | undefined,
        testCase.input.emailBody ?? undefined,
        testCase.input.fallbackIds ?? {},
        testCase.input.emailWorktags
      );

      const score = scoreInvoiceLineMergeCase(testCase, lines);
      allFieldScores.push(...score.fieldScores);
      results.push({
        id: testCase.id,
        passed: score.passed,
        details: score.details,
      });
    }

    const report = buildReport('invoice-line-merge', results);
    const fieldAccuracy = aggregateFieldAccuracy(allFieldScores);
    printFieldAccuracy(allFieldScores);
    printReport(report);
    expect(fieldAccuracy).toBeGreaterThanOrEqual(MIN_FIELD_ACCURACY);
  }, 300000);
});

function printFieldAccuracy(fieldScores: ReturnType<typeof scoreInvoiceLineMergeCase>['fieldScores']): void {
  const accuracy = aggregateFieldAccuracy(fieldScores);
  info(`\nPer-field accuracy: ${(accuracy * 100).toFixed(1)}%`);
}
