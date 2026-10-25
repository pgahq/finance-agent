#!/usr/bin/env node
/**
 * Runs the synthetic model suites against the live models (Vercel AI Gateway): the Workday validation-field classifier
 * and the invoice line merge. Fixtures are fully synthetic and live in evals/fixtures. Needs AI_GATEWAY_API_KEY.
 *
 * Usage: npm run eval:suites [-- --suite classifier|merge]
 */
import * as dotenv from 'dotenv';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PurchaseOrderLine } from '../lib/workday.js';
import {
  aggregateFieldAccuracy,
  buildSuiteReport,
  formatSuiteReport,
  invoiceContextOf,
  scoreInvoiceLineMergeCase,
  scoreValidationFieldCase,
  type FieldScore,
  type InvoiceLineMergeCase,
  type SuiteCaseResult,
  type ValidationFieldCase,
} from './suite_scorers.js';

dotenv.config();
process.env.LOG_LEVEL ??= 'INFO';

export const CLASSIFIER_MIN_ACCURACY = 0.85;
export const MERGE_MIN_FIELD_ACCURACY = 0.75;

function fixture<T>(name: string): T[] {
  const path = join(process.cwd(), 'evals/fixtures', name);
  return (JSON.parse(readFileSync(path, 'utf8')) as { cases: T[] }).cases;
}

async function runClassifier(): Promise<boolean> {
  const { classifyWorkdayValidationField } = await import('../lib/workday_validation_field_agent.js');
  const results: SuiteCaseResult[] = [];
  for (const testCase of fixture<ValidationFieldCase>('validation-field-classifier.json')) {
    results.push(scoreValidationFieldCase(testCase, await classifyWorkdayValidationField(testCase.input)));
  }
  const report = buildSuiteReport('validation-field-classifier', results);
  console.log(formatSuiteReport(report));
  return report.accuracy >= CLASSIFIER_MIN_ACCURACY;
}

async function runMerge(): Promise<boolean> {
  const { buildFinalInvoiceLines } = await import('../lib/invoice_lines.js');
  const results: SuiteCaseResult[] = [];
  const fieldScores: FieldScore[] = [];
  for (const testCase of fixture<InvoiceLineMergeCase>('invoice-line-merge.json')) {
    const { lines } = await buildFinalInvoiceLines(
      testCase.input.extractedInvoiceLines,
      testCase.input.purchaseOrderLines as unknown as PurchaseOrderLine[] | undefined,
      testCase.input.emailBody ?? undefined,
      testCase.input.fallbackIds ?? {},
      testCase.input.emailWorktags as never,
      undefined,
      testCase.input.invoiceLineQuantityDisplayed,
      invoiceContextOf(testCase)
    );
    const score = scoreInvoiceLineMergeCase(testCase, lines);
    fieldScores.push(...score.fieldScores);
    results.push({ id: score.id, passed: score.passed, details: score.details });
  }
  const report = buildSuiteReport('invoice-line-merge', results);
  const fieldAccuracy = aggregateFieldAccuracy(fieldScores);
  console.log(formatSuiteReport(report, { 'per-field accuracy': fieldAccuracy }));
  return fieldAccuracy >= MERGE_MIN_FIELD_ACCURACY;
}

async function main() {
  if (!process.env.AI_GATEWAY_API_KEY) {
    console.error('Missing environment: AI_GATEWAY_API_KEY');
    process.exit(1);
  }
  const index = process.argv.indexOf('--suite');
  const only = index >= 0 ? process.argv[index + 1] : undefined;
  if (only && only !== 'classifier' && only !== 'merge') {
    console.error('Usage: npm run eval:suites [-- --suite classifier|merge]');
    process.exit(1);
  }
  const passes: boolean[] = [];
  if (!only || only === 'classifier') passes.push(await runClassifier());
  if (!only || only === 'merge') passes.push(await runMerge());
  process.exit(passes.every(Boolean) ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
