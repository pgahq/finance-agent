import { requireEvalEnv } from './setup.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyWorkdayValidationField } from '../src/lib/workday_validation_field_agent.js';
import { buildFinalInvoiceLines } from '../src/lib/invoice_lines.js';
import type { PurchaseOrderLine } from '../src/lib/workday.js';
import { queryDocuments } from '../src/lib/rag.js';
import type { DatabaseConnection } from '../src/lib/database.js';
import { getEvalDatabaseConnection } from './database.js';
import { assertReport, buildReport, logEvalResults, type EvalCaseResult, type EvalReport } from './runner.js';
import {
  aggregateFieldAccuracy,
  scoreInvoiceLineMergeCase,
  type InvoiceLineMergeCase,
} from './scorers/invoice-line-merge.js';
import {
  aggregateHitRate,
  scoreSupplierRagCase,
  type SupplierRagCase,
} from './scorers/supplier-rag.js';
import {
  scoreValidationFieldCase,
  type ValidationFieldCase,
} from './scorers/validation-field.js';

const describeEval = process.env.RUN_EVALS === '1' ? describe : describe.skip;

describeEval('live model evals', () => {
  beforeAll(() => {
    requireEvalEnv();
  });

  describe('validation field classifier', () => {
    let report: EvalReport;

    beforeAll(async () => {
      const fixturePath = join(process.cwd(), 'evals/fixtures/validation-field-classifier.json');
      const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
        cases: ValidationFieldCase[];
      };

      const results: EvalCaseResult[] = [];

      for (const testCase of fixture.cases) {
        const actual = await classifyWorkdayValidationField(testCase.input);
        const score = scoreValidationFieldCase(testCase, actual);
        results.push({
          id: testCase.id,
          passed: score.passed,
          details: score.details,
        });
      }

      report = buildReport('validation-field-classifier', results);
    }, 120000);

    it('meets retryField accuracy threshold (>= 85%)', () => {
      assertReport(report, 0.85);
    });
  });

  describe('invoice line merge', () => {
    let report: EvalReport;
    let fieldAccuracy: number;

    beforeAll(async () => {
      const fixturePath = join(process.cwd(), 'evals/fixtures/invoice-line-merge.json');
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

      report = buildReport('invoice-line-merge', results);
      fieldAccuracy = aggregateFieldAccuracy(allFieldScores);
    }, 300000);

    it('meets per-field accuracy threshold (>= 75%)', () => {
      logEvalResults(report, { 'per-field accuracy': fieldAccuracy });
      expect(fieldAccuracy).toBeGreaterThanOrEqual(0.75);
    });
  });

  describe('supplier RAG', () => {
    let db: DatabaseConnection;
    let report: EvalReport;
    let hitAt1: number;
    let hitAt3: number;

    beforeAll(async () => {
      db = await getEvalDatabaseConnection();

      const fixturePath = join(process.cwd(), 'evals/fixtures/supplier-rag.json');
      const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
        cases: SupplierRagCase[];
      };

      const results: EvalCaseResult[] = [];
      const hitScores = [];

      for (const testCase of fixture.cases) {
        const ragResults = await queryDocuments({
          query: testCase.query,
          documentType: 'supplier',
          limit: testCase.matchRank ?? 3,
          similarityThreshold: 0,
        }, db);

        const score = scoreSupplierRagCase(testCase, ragResults);
        hitScores.push(score);
        results.push({
          id: testCase.id,
          passed: score.passed,
          details: score.details,
        });
      }

      report = buildReport('supplier-rag', results);
      hitAt1 = aggregateHitRate(hitScores, 1);
      hitAt3 = aggregateHitRate(hitScores, 3);
    }, 120000);

    afterAll(async () => {
      await db.close();
    });

    it('meets Hit@3 threshold (>= 75%)', () => {
      assertReport(report, 0.75, { 'Hit@1': hitAt1, 'Hit@3': hitAt3 });
    });

    it('meets Hit@1 threshold (>= 60%)', () => {
      expect(hitAt1).toBeGreaterThanOrEqual(0.60);
    });
  });
});
