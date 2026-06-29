import './setup.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyWorkdayValidationField } from '../src/lib/workday_validation_field_agent.js';
import { assertReport, buildReport, type EvalCaseResult } from './runner.js';
import {
  scoreValidationFieldCase,
  type ValidationFieldCase,
} from './scorers/validation-field.js';
import { requireEvalEnv } from './setup.js';

const fixturePath = join(process.cwd(), 'evals/fixtures/validation-field-classifier.json');
const MIN_ACCURACY = 0.9;

const describeEval = process.env.RUN_EVALS === '1' ? describe : describe.skip;

describeEval('validation field classifier eval', () => {
  beforeAll(() => {
    requireEvalEnv();
  });

  it('classifies Workday validation faults into retry fields', async () => {
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
    assertReport(report, MIN_ACCURACY);
  }, 120000);
});
