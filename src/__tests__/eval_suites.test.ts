import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareReplayEnv, REPLAY_SCRUBBED_ENV } from '../eval/env.js';
import {
  aggregateFieldAccuracy,
  buildSuiteReport,
  formatSuiteReport,
  invoiceContextOf,
  scoreInvoiceLineMergeCase,
  scoreValidationFieldCase,
  type InvoiceLineMergeCase,
  type ValidationFieldCase,
} from '../eval/suite_scorers.js';
import type { FinalInvoiceLine } from '../lib/invoice_lines.js';

const fixture = <T>(name: string): T[] => (JSON.parse(readFileSync(join(process.cwd(), 'evals/fixtures', name), 'utf8')) as { cases: T[] }).cases;

describe('suite fixtures', () => {
  const classifier = fixture<ValidationFieldCase>('validation-field-classifier.json');
  const merge = fixture<InvoiceLineMergeCase>('invoice-line-merge.json');
  const retryFields = ['supplier', 'invoiceDate', 'paymentTerms', 'worktag:fund', 'worktag:costCenter', 'worktag:spendCategory', 'worktag:event', 'worktag:lob', 'unknown'];

  it('uses only retry fields the classifier can return today', () => {
    for (const testCase of classifier) {
      expect(retryFields).toContain(testCase.expected.retryField);
      for (const field of testCase.input.allowedRetryFields) expect(retryFields).toContain(field);
    }
  });

  it('has unique case IDs', () => {
    expect(new Set(classifier.map((testCase) => testCase.id)).size).toBe(classifier.length);
    expect(new Set(merge.map((testCase) => testCase.id)).size).toBe(merge.length);
  });

  it('covers the current merge path: a case with an invoice date, a service period, a consumed PO line, and a closed PO', () => {
    expect(merge.some((testCase) => testCase.input.servicePeriod)).toBe(true);
    expect(merge.some((testCase) => testCase.input.poClosedForInvoicing)).toBe(true);
    expect(merge.some((testCase) => testCase.expected.lines.some((line) => line.omitPurchaseOrderLineReference))).toBe(true);
    expect(merge.filter((testCase) => testCase.input.purchaseOrderLines?.length && invoiceContextOf(testCase)).length).toBeGreaterThan(3);
  });

  it('holds no real data: no emails, phone numbers, account numbers, or URLs', () => {
    const text = ['validation-field-classifier.json', 'invoice-line-merge.json'].map((name) => readFileSync(join(process.cwd(), 'evals/fixtures', name), 'utf8')).join('\n');
    expect(text).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i);
    expect(text).not.toMatch(/https?:\/\//i);
    expect(text).not.toMatch(/\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/);
    expect(text).not.toMatch(/\b\d{9,}\b/);
  });
});

describe('scoreValidationFieldCase', () => {
  const testCase: ValidationFieldCase = { id: 'c', input: { validation: {}, allowedRetryFields: ['supplier'] }, expected: { retryField: 'worktag:lob' } };

  it('passes on a matching retry field and explains a miss', () => {
    expect(scoreValidationFieldCase(testCase, { retryField: 'worktag:lob', reason: 'r' })).toEqual({ id: 'c', passed: true });
    expect(scoreValidationFieldCase(testCase, { retryField: 'unknown', reason: 'r' }).details).toBe('expected retryField=worktag:lob, got unknown');
  });
});

describe('invoiceContextOf', () => {
  const base: InvoiceLineMergeCase = { id: 'm', input: { extractedInvoiceLines: [], invoiceDate: '2026-03-10', servicePeriod: 'March' }, expected: { lines: [] } };

  it('passes the context the create pipeline passes, and none for a closed PO', () => {
    expect(invoiceContextOf(base)).toEqual({ invoiceDate: '2026-03-10', servicePeriod: 'March' });
    expect(invoiceContextOf({ ...base, input: { ...base.input, poClosedForInvoicing: true } })).toBeUndefined();
  });
});

describe('scoreInvoiceLineMergeCase', () => {
  const testCase: InvoiceLineMergeCase = {
    id: 'm',
    input: { extractedInvoiceLines: [] },
    expected: { lines: [{ lineOrder: 1, purchaseOrderLineId: 'PO-1', extendedAmount: 10, omitPurchaseOrderLineReference: true }] },
  };
  const actual = (overrides: Partial<FinalInvoiceLine> = {}): FinalInvoiceLine[] => [{ lineOrder: 1, description: 'd', purchaseOrderLineId: 'PO-1', extendedAmount: 10, omitPurchaseOrderLineReference: true, ...overrides }];

  it('scores each expected field, including the consumed-PO-line flag', () => {
    expect(scoreInvoiceLineMergeCase(testCase, actual()).passed).toBe(true);
    const wrong = scoreInvoiceLineMergeCase(testCase, actual({ omitPurchaseOrderLineReference: undefined, purchaseOrderLineId: 'PO-2' }));
    expect(wrong.passed).toBe(false);
    expect(wrong.details).toContain('purchaseOrderLineId: expected PO-1, got PO-2');
    expect(aggregateFieldAccuracy(wrong.fieldScores)).toBeCloseTo(2 / 4);
  });

  it('fails a case with the wrong number of lines', () => {
    expect(scoreInvoiceLineMergeCase(testCase, []).details).toBe('expected 1 lines, got 0');
  });
});

describe('suite reports', () => {
  it('summarizes and lists failures', () => {
    const report = buildSuiteReport('s', [{ id: 'a', passed: true }, { id: 'b', passed: false, details: 'nope' }]);
    expect(report).toMatchObject({ total: 2, passed: 1, accuracy: 0.5 });
    expect(formatSuiteReport(report, { extra: 0.25 })).toBe('s: 1/2 passed (50.0%)\n  extra: 25.0%\n  FAIL b: nope');
  });
});

describe('prepareReplayEnv', () => {
  it('removes Workday, Slack, and Intercom credentials and points Workday at nothing', () => {
    const env = Object.fromEntries(REPLAY_SCRUBBED_ENV.map((name) => [name, 'secret'])) as NodeJS.ProcessEnv;
    Object.assign(env, { WORKDAY_DOMAIN: 'services1.myworkday.com', WORKDAY_TENANT: 'pgahq', INVOICE_MOD_ENABLED: 'false' });
    const { missing } = prepareReplayEnv(env);
    for (const name of REPLAY_SCRUBBED_ENV) expect(env[name]).toBeUndefined();
    expect(env).toMatchObject({ WORKDAY_DOMAIN: 'replay.invalid', INVOICE_MOD_ENABLED: 'true' });
    expect(missing).toEqual(['AI_GATEWAY_API_KEY', 'DATABASE_SECRET_ARN', 'DATABASE_CLUSTER_ENDPOINT']);
  });

  it('reports nothing missing when the required variables are set', () => {
    const env = { AI_GATEWAY_API_KEY: 'k', DATABASE_SECRET_ARN: 'a', DATABASE_CLUSTER_ENDPOINT: 'localhost' } as NodeJS.ProcessEnv;
    expect(prepareReplayEnv(env).missing).toEqual([]);
  });
});
