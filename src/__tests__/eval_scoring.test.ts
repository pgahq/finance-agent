import type { ScoredFields, ScoredLine } from '../lib/invoice_snapshots.js';
import { diffScoredFields } from '../lib/invoice_snapshots.js';
import { scoreChanges } from '../lib/invoice_score.js';
import { touchCount } from '../lib/score_touches.js';
import {
  alignReferenceKeys,
  compareToBaseline,
  formatSummary,
  scoreCase,
  summarize,
  type CaseScore,
} from '../eval/scoring.js';

const line = (overrides: Partial<ScoredLine> = {}): ScoredLine => ({
  lineOrder: 1,
  amount: 100,
  purchaseOrderLine: 'Purchase_Order_Line_ID=PO-1-1',
  spendCategory: 'Spend_Category_ID=SC-1',
  costCenter: 'Cost_Center_Reference_ID=CC1',
  fund: 'Fund_ID=F1',
  lineOfBusiness: 'Organization_Reference_ID=LOB-Golf',
  otherWorktags: [],
  memo: 'M',
  itemDescription: 'Desc',
  ...overrides,
});

const fields = (overrides: Partial<ScoredFields> = {}, lines: ScoredLine[] = [line()]): ScoredFields => ({
  supplier: 'Supplier_ID=S-1',
  company: 'Company_Reference_ID=912',
  suppliersInvoiceNumber: 'INV-1',
  invoiceDate: '2026-10-01',
  controlTotal: 100,
  memo: 'Header memo',
  lines,
  ...overrides,
});

const score = (replay: ScoredFields, expected: ScoredFields, extra: Partial<Parameters<typeof scoreCase>[0]> = {}) =>
  scoreCase({ id: 'SUPIN-1', status: 'scored', origin: 'create', expected, replay, ...extra });

describe('scoreCase', () => {
  it('scores zero touches for a replay that matches AP', () => {
    const result = score(fields(), fields());
    expect(result).toMatchObject({ codingTouches: 0, formattingTouches: 0, digestTouches: 0, codingFields: [], formattingFields: [] });
  });

  it('counts coding corrections and keeps memo, line memo, and item description apart', () => {
    const replay = fields({ memo: 'Other memo' }, [line({ costCenter: 'Cost_Center_Reference_ID=CC9', memo: 'x', itemDescription: 'y' })]);
    const result = score(replay, fields());
    expect(result.codingTouches).toBe(1);
    expect(result.formattingTouches).toBe(3);
    expect(result.digestTouches).toBe(4);
    expect(result.codingFields).toEqual(['line.costCenter']);
    expect(result.formattingFields).toEqual(['line.itemDescription', 'line.memo', 'memo']);
  });

  it('uses the production scorer: digestTouches equals touchCount over scoreChanges(diffScoredFields)', () => {
    const replay = fields({ supplier: 'Supplier_ID=S-2', invoiceDate: '2026-10-02' }, [line({ amount: 90, fund: 'Fund_ID=F2' })]);
    const expected = fields();
    const production = touchCount({
      workdayInvoiceWid: 'x',
      terminal: false,
      entryDiff: scoreChanges(diffScoredFields(replay, expected)),
    });
    expect(score(replay, expected).digestTouches).toBe(production);
  });

  it('counts the supplier invoice number as coding, not formatting', () => {
    const result = score(fields({ suppliersInvoiceNumber: 'INV-2' }), fields());
    expect(result.codingTouches).toBe(1);
    expect(result.codingFields).toEqual(['suppliersInvoiceNumber']);
  });

  it('counts a line AP had to remove and a line AP had to add as coding touches', () => {
    const extra = score(fields({}, [line(), line({ lineOrder: 2, amount: 5 })]), fields());
    expect(extra.codingFields).toEqual(['line.removed']);
    expect(extra.codingTouches).toBe(1);
    const missing = score(fields(), fields({}, [line(), line({ lineOrder: 2, amount: 5 })]));
    expect(missing.codingFields).toEqual(['line.added']);
  });

  it('does not count fields the replay left as the OCR baseline had them (enrich)', () => {
    const baseline = fields({ supplier: 'Supplier_ID=S-OCR', invoiceDate: '2026-09-30' });
    const replay = fields({ supplier: 'Supplier_ID=S-OCR', invoiceDate: '2026-09-30' });
    const expected = fields({ supplier: 'Supplier_ID=S-1', invoiceDate: '2026-10-01' });
    const result = score(replay, expected, { origin: 'enrich', baseline });
    expect(result.codingTouches).toBe(0);
    const changed = score(fields({ supplier: 'Supplier_ID=S-3' }), expected, { origin: 'enrich', baseline });
    expect(changed.codingFields).toContain('supplier');
  });

  it('owns nothing on an enrich case without a baseline', () => {
    expect(score(fields({ supplier: 'Supplier_ID=S-2' }), fields(), { origin: 'enrich' }).codingTouches).toBe(0);
  });

  it('reports what production got on the same invoice, entry plus late changes', () => {
    const entry = scoreChanges(diffScoredFields(fields({ supplier: 'Supplier_ID=S-2' }), fields()));
    const late = scoreChanges(diffScoredFields(fields(), fields({ memo: 'Changed' })));
    expect(score(fields(), fields(), { production: { entryDiff: entry, lateDiff: late } }).productionTouches).toBe(2);
  });

  it('returns no touches for errored and skipped cases', () => {
    expect(scoreCase({ id: 'a', status: 'error', reason: 'boom', expected: fields() })).toMatchObject({ codingTouches: null, digestTouches: null });
    expect(scoreCase({ id: 'a', status: 'skipped', reason: 'no docs', expected: fields() }).codingTouches).toBeNull();
  });
});

describe('alignReferenceKeys', () => {
  it('takes AP\'s spelling of a reference with the same value under a different ID type', () => {
    const aligned = alignReferenceKeys(
      fields({ supplier: 'Supplier_ID=S-1' }, [line({ costCenter: 'Organization_Reference_ID=CC1' })]),
      fields({ supplier: 'Supplier_Reference_ID=S-1' })
    );
    expect(aligned.supplier).toBe('Supplier_Reference_ID=S-1');
    expect(aligned.lines[0].costCenter).toBe('Cost_Center_Reference_ID=CC1');
  });

  it('never touches a different value', () => {
    const aligned = alignReferenceKeys(fields({ supplier: 'Supplier_ID=S-2' }), fields({ supplier: 'Supplier_Reference_ID=S-1' }));
    expect(aligned.supplier).toBe('Supplier_ID=S-2');
  });

  it('pairs lines by amount, so a reordered line is aligned with its own peer', () => {
    const aligned = alignReferenceKeys(
      fields({}, [line({ lineOrder: 1, amount: 5, fund: 'Other_Type=F2' }), line({ lineOrder: 2, amount: 100, fund: 'Other_Type=F1' })]),
      fields({}, [line({ amount: 100, fund: 'Fund_ID=F1' }), line({ lineOrder: 2, amount: 5, fund: 'Fund_ID=F2' })])
    );
    expect(aligned.lines.map((entry) => entry.fund)).toEqual(['Fund_ID=F2', 'Fund_ID=F1']);
  });
});

const caseScore = (id: string, coding: number | null, fieldsTouched: string[] = [], overrides: Partial<CaseScore> = {}): CaseScore => ({
  id,
  status: coding === null ? 'error' : 'scored',
  changes: [],
  codingTouches: coding,
  formattingTouches: 0,
  digestTouches: coding,
  codingFields: fieldsTouched,
  formattingFields: [],
  warnings: [],
  ...overrides,
});

describe('summarize', () => {
  const scores = [
    caseScore('a', 0),
    caseScore('b', 2, ['line.costCenter']),
    caseScore('c', 3, ['line.costCenter', 'supplier']),
    caseScore('d', 5, ['line.fund']),
    caseScore('e', 12, ['line.fund']),
    caseScore('f', 40, ['line.fund']),
  ];

  it('buckets coding touches 0 / 1–3 / 4–10 / 11–20 / 21+ and reports the 0–3 share', () => {
    const summary = summarize(scores);
    expect(summary.buckets.map((bucket) => [bucket.label, bucket.count])).toEqual([
      ['0 touches', 1], ['1–3', 2], ['4–10', 1], ['11–20', 1], ['21+', 1],
    ]);
    expect(summary.share0to3).toBeCloseTo(3 / 6);
  });

  it('reports per-field correction rates over scored cases', () => {
    const { fieldRates } = summarize(scores);
    expect(fieldRates['line.costCenter']).toMatchObject({ cases: 2, rate: 2 / 6 });
    expect(fieldRates['line.fund']).toMatchObject({ cases: 3, rate: 3 / 6 });
  });

  it('counts a pipeline error as 21+ and leaves skipped cases out', () => {
    const summary = summarize([caseScore('a', 0), caseScore('b', null, [], { reason: 'boom' }), caseScore('c', null, [], { status: 'skipped', reason: 'no docs' })]);
    expect(summary).toMatchObject({ attempted: 2, scored: 1, errored: 1 });
    expect(summary.buckets[4].count).toBe(1);
    expect(summary.share0to3).toBe(0.5);
    expect(summary.skipped).toEqual([{ id: 'c', reason: 'no docs' }]);
  });

  it('tracks formatting fields separately from coding fields', () => {
    const summary = summarize([caseScore('a', 0, [], { formattingFields: ['memo', 'line.memo'], changes: [] })]);
    expect(summary.formattingRates.memo.cases).toBe(1);
    expect(summary.fieldRates).toEqual({});
  });

  it('compares with production on the same invoices', () => {
    const summary = summarize([caseScore('a', 0, [], { productionTouches: 12 }), caseScore('b', 1, [], { productionTouches: 0 })]);
    expect(summary.production?.share0to3).toBe(0.5);
    expect(summary.production?.cases).toBe(2);
  });

  it('formats a report with the buckets, the field rates, and the formatting split', () => {
    const text = formatSummary(summarize(scores));
    expect(text).toContain('Coding touches (memo, line memo, item description excluded): 50.0% of cases at 0–3');
    expect(text).toContain('line.fund');
    expect(text).toContain('Formatting conventions');
  });
});

describe('compareToBaseline', () => {
  const baseline = summarize([
    caseScore('a', 0), caseScore('b', 2, ['line.costCenter']), caseScore('c', 8, ['line.fund']), caseScore('d', 1),
  ], { label: 'release-1' });

  it('passes when nothing got worse', () => {
    const comparison = compareToBaseline(baseline, baseline);
    expect(comparison.ok).toBe(true);
    expect(comparison.regressions).toEqual([]);
  });

  it('flags a lower 0–3 share', () => {
    const current = summarize([caseScore('a', 0), caseScore('b', 6, ['line.costCenter']), caseScore('c', 8, ['line.fund']), caseScore('d', 1)]);
    const comparison = compareToBaseline(current, baseline);
    expect(comparison.ok).toBe(false);
    expect(comparison.regressions[0]).toContain('0–3 touch share fell from 75.0% to 50.0%');
    expect(comparison.casesNowWorse).toEqual(['b']);
  });

  it('honors the share tolerance', () => {
    const current = summarize([caseScore('a', 0), caseScore('b', 6, ['line.costCenter']), caseScore('c', 8, ['line.fund']), caseScore('d', 1)]);
    expect(compareToBaseline(current, baseline, { shareTolerance: 0.3 }).regressions.some((entry) => entry.includes('0–3 touch share'))).toBe(false);
  });

  it('flags a worse field rate beyond the tolerance and not within it', () => {
    const current = summarize([caseScore('a', 0), caseScore('b', 2, ['line.costCenter']), caseScore('c', 8, ['line.fund', 'line.spendCategory']), caseScore('d', 1)]);
    const strict = compareToBaseline(current, baseline, { fieldTolerance: 0.02 });
    expect(strict.regressions).toEqual(['field line.spendCategory correction rate rose from 0.0% to 25.0%']);
    expect(compareToBaseline(current, baseline, { fieldTolerance: 0.3 }).ok).toBe(true);
  });

  it('reports improvements', () => {
    const current = summarize([caseScore('a', 0), caseScore('b', 0), caseScore('c', 2, ['line.fund']), caseScore('d', 1)]);
    const comparison = compareToBaseline(current, baseline);
    expect(comparison.ok).toBe(true);
    expect(comparison.improvements.join(' ')).toContain('0–3 touch share rose from 75.0% to 100.0%');
    expect(comparison.casesNowBetter).toEqual(['c']);
  });

  it('compares only the cases both runs have, so a changed case set cannot move the result', () => {
    const current = summarize([caseScore('a', 0), caseScore('b', 2, ['line.costCenter']), caseScore('z', 50, ['supplier'])]);
    const comparison = compareToBaseline(current, baseline);
    expect(comparison.overlap).toBe(2);
    expect(comparison.ok).toBe(true);
  });

  it('shows the comparison in the report', () => {
    const current = summarize([caseScore('a', 0), caseScore('b', 6, ['line.costCenter']), caseScore('c', 8, ['line.fund']), caseScore('d', 1)]);
    const text = formatSummary(current, compareToBaseline(current, baseline));
    expect(text).toContain('Baseline release-1 over 4 shared cases');
    expect(text).toContain('REGRESSIONS:');
  });
});
