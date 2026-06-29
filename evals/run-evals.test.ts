import { info } from '@pga/logger';
import './setup.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyWorkdayValidationField } from '../src/lib/workday_validation_field_agent.js';
import { buildFinalInvoiceLines } from '../src/lib/invoice_lines.js';
import type { PurchaseOrderLine } from '../src/lib/workday.js';
import { queryDocuments } from '../src/lib/rag.js';
import { getDatabaseConnection } from '../src/lib/database.js';
import { assertReport, buildReport, printReport, type EvalCaseResult } from './runner.js';
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
import { requireEvalEnv } from './setup.js';

const describeEval = process.env.RUN_EVALS === '1' ? describe : describe.skip;

describeEval('live model evals', () => {
  beforeAll(() => {
    requireEvalEnv();
  });

  describe('validation field classifier', () => {
    it('classifies Workday validation faults into retry fields', async () => {
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

      const report = buildReport('validation-field-classifier', results);
      assertReport(report, 0.85);
    }, 120000);
  });

  describe('invoice line merge', () => {
    it('maps extracted invoice lines to PO worktags', async () => {
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

      const report = buildReport('invoice-line-merge', results);
      const fieldAccuracy = aggregateFieldAccuracy(allFieldScores);
      info(`\nPer-field accuracy: ${(fieldAccuracy * 100).toFixed(1)}%`);
      printReport(report);
      expect(fieldAccuracy).toBeGreaterThanOrEqual(0.75);
    }, 300000);
  });

  describe('supplier RAG', () => {
    beforeAll(() => {
      if (!process.env.DATABASE_URL) {
        throw new Error('supplier RAG eval requires EVAL_DATABASE_URL (run npm run eval:seed first)');
      }
    });

    afterAll(async () => {
      if (process.env.DATABASE_URL) {
        const db = await getDatabaseConnection(process.env);
        await db.close();
      }
    });

    it('retrieves the expected supplier workday_id', async () => {
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
        });

        const score = scoreSupplierRagCase(testCase, ragResults);
        hitScores.push(score);
        results.push({
          id: testCase.id,
          passed: score.passed,
          details: score.details,
        });
      }

      const report = buildReport('supplier-rag', results);
      const hitAt1 = aggregateHitRate(hitScores, 1);
      const hitAt3 = aggregateHitRate(hitScores, 3);

      info(`\nHit@1: ${(hitAt1 * 100).toFixed(1)}%`);
      info(`Hit@3: ${(hitAt3 * 100).toFixed(1)}%`);

      assertReport(report, 0.75);
      expect(hitAt1).toBeGreaterThanOrEqual(0.60);
    }, 120000);
  });
});
