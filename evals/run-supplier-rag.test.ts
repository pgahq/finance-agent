import './setup.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { queryDocuments } from '../src/lib/rag.js';
import { getDatabaseConnection } from '../src/lib/database.js';
import { assertReport, buildReport, type EvalCaseResult } from './runner.js';
import {
  aggregateHitRate,
  scoreSupplierRagCase,
  type SupplierRagCase,
} from './scorers/supplier-rag.js';
import { requireEvalEnv } from './setup.js';

const fixturePath = join(process.cwd(), 'evals/fixtures/supplier-rag.json');
const MIN_HIT_AT_3 = 0.75;
const MIN_HIT_AT_1 = 0.60;

const describeEval = process.env.RUN_EVALS === '1' ? describe : describe.skip;

describeEval('supplier RAG eval', () => {
  beforeAll(() => {
    requireEvalEnv();

    if (!process.env.EVAL_DATABASE_URL) {
      throw new Error('supplier RAG eval requires EVAL_DATABASE_URL (run npm run eval:seed first)');
    }
  });

  afterAll(async () => {
    if (process.env.EVAL_DATABASE_URL) {
      const db = await getDatabaseConnection(process.env);
      await db.close();
    }
  });

  it('retrieves the expected supplier workday_id', async () => {
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

    console.log(`\nHit@1: ${(hitAt1 * 100).toFixed(1)}%`);
    console.log(`Hit@3: ${(hitAt3 * 100).toFixed(1)}%`);

    assertReport(report, MIN_HIT_AT_3);
    expect(hitAt1).toBeGreaterThanOrEqual(MIN_HIT_AT_1);
  }, 120000);
});
