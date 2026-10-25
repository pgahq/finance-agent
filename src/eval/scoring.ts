import { scoreChanges, type ScoredChange } from '../lib/invoice_score.js';
import { diffScoredFields, type ScoredFieldName, type ScoredFields } from '../lib/invoice_snapshots.js';
import type { InvoiceScore } from '../lib/invoice_scores.js';
import { TOUCH_BUCKETS, touchBucketIndex, touchCount } from '../lib/score_touches.js';

/**
 * Formatting conventions: reported on their own and left out of the coding-touch count, because AP house style for
 * memos and item descriptions is a separate conversation from coding accuracy.
 * The supplier invoice number is a convention field in the scorer too, but it is data read off the document, so it
 * stays in the coding count here.
 */
export const FORMATTING_FIELDS: ReadonlySet<ScoredFieldName> = new Set<ScoredFieldName>(['memo', 'line.memo', 'line.itemDescription']);

export type CaseStatus = 'scored' | 'error' | 'skipped';

export interface CaseScoreInput {
  id: string;
  status: CaseStatus;
  reason?: string;
  origin?: 'create' | 'enrich';
  /** AP's saved version at submit. */
  expected: ScoredFields;
  /** What the current pipeline would have sent to Workday, mapped to the scored shape. */
  replay?: ScoredFields;
  /** Enrich: the OCR invoice before the agent wrote. Fields the replay leaves as OCR had them are not the agent's. */
  baseline?: ScoredFields;
  /** The scorer's own diffs for what production actually did, for the side-by-side column. */
  production?: { entryDiff?: ScoredChange[]; lateDiff?: ScoredChange[] };
  warnings?: string[];
}

export interface CaseScore {
  id: string;
  status: CaseStatus;
  reason?: string;
  changes: ScoredChange[];
  /** Agent-owned corrections to everything except the formatting fields. Null when the pipeline errored or the case was skipped. */
  codingTouches: number | null;
  formattingTouches: number | null;
  /** Agent-owned corrections to every scored field, formatting included: the weekly digest's definition. */
  digestTouches: number | null;
  /** The digest touch count production got for this invoice (entry plus late changes), when the case carries it. */
  productionTouches?: number;
  codingFields: string[];
  formattingFields: string[];
  warnings: string[];
}

function asScore(id: string, entryDiff: ScoredChange[], lateDiff: ScoredChange[] = []): InvoiceScore {
  return { workdayInvoiceWid: id, terminal: false, entryDiff, lateDiff };
}

const REFERENCE_FIELDS = ['supplier', 'company'] as const;
const REFERENCE_LINE_FIELDS = ['purchaseOrderLine', 'spendCategory', 'costCenter', 'fund', 'lineOfBusiness'] as const;

function referenceValue(key: string | undefined): string | undefined {
  if (!key) return undefined;
  const at = key.indexOf('=');
  return at >= 0 ? key.slice(at + 1) : key;
}

/**
 * A reference reads back as `Type=value` with the type being whichever non-WID ID Workday lists first, and the
 * request names it by a type of its own choosing. When both sides carry the same value under different types, they
 * are the same reference, so take AP's spelling. A different value is never touched.
 */
export function alignReferenceKeys(replay: ScoredFields, expected: ScoredFields): ScoredFields {
  const align = (own: string | undefined, theirs: string | undefined) =>
    own !== undefined && theirs !== undefined && own !== theirs && referenceValue(own) === referenceValue(theirs) ? theirs : own;
  const result: ScoredFields = { ...replay, lines: [...replay.lines] };
  for (const field of REFERENCE_FIELDS) {
    const aligned = align(replay[field], expected[field]);
    if (aligned !== undefined) result[field] = aligned;
  }
  const peers = new Map<number, number>();
  const taken = new Set<number>();
  replay.lines.forEach((line, index) => {
    if (expected.lines[index] && expected.lines[index].amount === line.amount) {
      peers.set(index, index);
      taken.add(index);
    }
  });
  replay.lines.forEach((line, index) => {
    if (peers.has(index)) return;
    const peer = expected.lines.findIndex((candidate, candidateIndex) => !taken.has(candidateIndex) && candidate.amount === line.amount);
    if (peer >= 0) {
      peers.set(index, peer);
      taken.add(peer);
    }
  });
  result.lines = replay.lines.map((line, index) => {
    const peer = peers.has(index) ? expected.lines[peers.get(index)!] : undefined;
    if (!peer) return line;
    const next = { ...line };
    for (const field of REFERENCE_LINE_FIELDS) {
      const aligned = align(line[field], peer[field]);
      if (aligned !== undefined) next[field] = aligned;
    }
    next.otherWorktags = [...new Set(line.otherWorktags.map((tag) => {
      const sameValue = peer.otherWorktags.find((candidate) => candidate !== tag && referenceValue(candidate) === referenceValue(tag));
      return sameValue ?? tag;
    }))].sort();
    return next;
  });
  return result;
}

/**
 * Scores one replayed invoice with the production scorer: the replay is diffed against AP's saved fields by
 * `diffScoredFields`, tagged by `scoreChanges`, and counted by `touchCount`. For an enrich invoice the fields the replay
 * left as the OCR baseline had them are not the agent's, exactly as `ScoreInvoices` decides it.
 */
export function scoreCase(input: CaseScoreInput): CaseScore {
  const warnings = [...(input.warnings ?? [])];
  const productionTouches = input.production
    ? touchCount(asScore(input.id, input.production.entryDiff ?? [], input.production.lateDiff ?? []))
    : undefined;
  const base = {
    id: input.id,
    status: input.status,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(productionTouches !== undefined ? { productionTouches } : {}),
    warnings,
  };
  if (input.status !== 'scored' || !input.replay) {
    return { ...base, changes: [], codingTouches: null, formattingTouches: null, digestTouches: null, codingFields: [], formattingFields: [] };
  }

  const replay = alignReferenceKeys(input.replay, input.expected);
  const owned = input.origin === 'enrich' && input.baseline
    ? diffScoredFields(input.baseline, replay).map((change) => change.field)
    : input.origin === 'enrich' ? [] : undefined;
  const changes = scoreChanges(diffScoredFields(replay, input.expected), owned);
  const agentOwned = changes.filter((change) => change.agentOwned);
  const coding = agentOwned.filter((change) => !FORMATTING_FIELDS.has(change.field));
  const formatting = agentOwned.filter((change) => FORMATTING_FIELDS.has(change.field));
  return {
    ...base,
    changes,
    codingTouches: touchCount(asScore(input.id, coding)),
    formattingTouches: touchCount(asScore(input.id, formatting)),
    digestTouches: touchCount(asScore(input.id, changes)),
    codingFields: [...new Set(coding.map((change) => change.field))].sort(),
    formattingFields: [...new Set(formatting.map((change) => change.field))].sort(),
  };
}

export interface BucketCount {
  label: string;
  count: number;
  share: number;
}

export interface FieldRate {
  /** Cases where AP had to correct this field at least once. */
  cases: number;
  /** Individual corrections (a field corrected on three lines counts three). */
  corrections: number;
  rate: number;
}

export interface CaseRecord {
  status: CaseStatus;
  reason?: string;
  /** Null when the pipeline errored. */
  codingTouches: number | null;
  digestTouches: number | null;
  productionTouches?: number;
  codingFields: string[];
  formattingFields: string[];
}

export interface EvalSummary {
  schemaVersion: 1;
  label?: string;
  releaseSha?: string;
  createdAt: string;
  /** Cases the replay ran (scored plus errored); skipped cases are listed apart. */
  attempted: number;
  scored: number;
  errored: number;
  skipped: Array<{ id: string; reason: string }>;
  /** Bucket counts over coding touches. A pipeline error counts as 21+: the AP team would have keyed the whole invoice. */
  buckets: BucketCount[];
  share0to3: number;
  /** The same over every scored field, memo and descriptions included, so it lines up with the weekly digest. */
  digestBuckets: BucketCount[];
  digestShare0to3: number;
  /** The digest buckets production got on these same invoices (entry plus late changes). */
  production?: { buckets: BucketCount[]; share0to3: number; cases: number };
  fieldRates: Record<string, FieldRate>;
  formattingRates: Record<string, FieldRate>;
  perCase: Record<string, CaseRecord>;
}

const WORST_TOUCHES = Number.MAX_SAFE_INTEGER;

function bucketCounts(touches: number[]): { buckets: BucketCount[]; share0to3: number } {
  const counts = TOUCH_BUCKETS.map(() => 0);
  for (const value of touches) counts[touchBucketIndex(value)] += 1;
  const total = touches.length;
  const buckets = TOUCH_BUCKETS.map((bucket, index) => ({
    label: bucket.label,
    count: counts[index],
    share: total ? counts[index] / total : 0,
  }));
  const within = touches.filter((value) => value <= 3).length;
  return { buckets, share0to3: total ? within / total : 0 };
}

function fieldRates(records: CaseRecord[], pick: (record: CaseRecord) => string[], changesByField: Map<string, number>): Record<string, FieldRate> {
  const scored = records.filter((record) => record.status === 'scored');
  const cases = new Map<string, number>();
  for (const record of scored) for (const field of new Set(pick(record))) cases.set(field, (cases.get(field) ?? 0) + 1);
  return Object.fromEntries([...cases.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([field, count]) => [
    field,
    { cases: count, corrections: changesByField.get(field) ?? count, rate: scored.length ? count / scored.length : 0 },
  ]));
}

export function summarize(scores: CaseScore[], meta: { label?: string; releaseSha?: string; now?: Date } = {}): EvalSummary {
  const ran = scores.filter((score) => score.status !== 'skipped');
  const records: Record<string, CaseRecord> = {};
  const corrections = new Map<string, number>();
  const formattingCorrections = new Map<string, number>();
  for (const score of scores) {
    records[score.id] = {
      status: score.status,
      ...(score.reason ? { reason: score.reason } : {}),
      codingTouches: score.codingTouches,
      digestTouches: score.digestTouches,
      ...(score.productionTouches !== undefined ? { productionTouches: score.productionTouches } : {}),
      codingFields: score.codingFields,
      formattingFields: score.formattingFields,
    };
    for (const change of score.changes) {
      if (!change.agentOwned) continue;
      const target = FORMATTING_FIELDS.has(change.field) ? formattingCorrections : corrections;
      target.set(change.field, (target.get(change.field) ?? 0) + 1);
    }
  }
  const recordList = ran.map((score) => records[score.id]);
  const coding = bucketCounts(recordList.map((record) => record.codingTouches ?? WORST_TOUCHES));
  const digest = bucketCounts(recordList.map((record) => record.digestTouches ?? WORST_TOUCHES));
  const withProduction = recordList.filter((record) => record.productionTouches !== undefined);
  const production = withProduction.length
    ? { ...bucketCounts(withProduction.map((record) => record.productionTouches!)), cases: withProduction.length }
    : undefined;
  return {
    schemaVersion: 1,
    ...(meta.label ? { label: meta.label } : {}),
    ...(meta.releaseSha ? { releaseSha: meta.releaseSha } : {}),
    createdAt: (meta.now ?? new Date()).toISOString(),
    attempted: ran.length,
    scored: ran.filter((score) => score.status === 'scored').length,
    errored: ran.filter((score) => score.status === 'error').length,
    skipped: scores.filter((score) => score.status === 'skipped').map((score) => ({ id: score.id, reason: score.reason ?? 'skipped' })),
    buckets: coding.buckets,
    share0to3: coding.share0to3,
    digestBuckets: digest.buckets,
    digestShare0to3: digest.share0to3,
    ...(production ? { production: { buckets: production.buckets, share0to3: production.share0to3, cases: production.cases } } : {}),
    fieldRates: fieldRates(recordList, (record) => record.codingFields, corrections),
    formattingRates: fieldRates(recordList, (record) => record.formattingFields, formattingCorrections),
    perCase: records,
  };
}

export interface CompareOptions {
  /** A 0–3 share lower than the baseline's by more than this is a regression. Default 0. */
  shareTolerance?: number;
  /** A field rate higher than the baseline's by more than this is a regression. Default 0.02. */
  fieldTolerance?: number;
}

export interface Comparison {
  /** Cases present in both runs; every number below is recomputed over only these, so a changed case set cannot move it. */
  overlap: number;
  baselineLabel?: string;
  baselineShare0to3: number;
  currentShare0to3: number;
  regressions: string[];
  improvements: string[];
  /** Cases that were at 0–3 touches in the baseline and are not now. */
  casesNowWorse: string[];
  casesNowBetter: string[];
  ok: boolean;
}

function restrict(summary: EvalSummary, ids: string[]): EvalSummary {
  const records = ids.map((id) => ({ id, record: summary.perCase[id] }));
  const scores: CaseScore[] = records.map(({ id, record }) => ({
    id,
    status: record.status,
    changes: [],
    codingTouches: record.codingTouches,
    formattingTouches: null,
    digestTouches: record.digestTouches,
    codingFields: record.codingFields,
    formattingFields: record.formattingFields,
    warnings: [],
  }));
  return summarize(scores);
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

/** Compares a run with a saved baseline over the cases both ran. */
export function compareToBaseline(current: EvalSummary, baseline: EvalSummary, options: CompareOptions = {}): Comparison {
  const shareTolerance = options.shareTolerance ?? 0;
  const fieldTolerance = options.fieldTolerance ?? 0.02;
  const ids = Object.keys(current.perCase).filter((id) =>
    baseline.perCase[id] && current.perCase[id].status !== 'skipped' && baseline.perCase[id].status !== 'skipped'
  );
  const now = restrict(current, ids);
  const before = restrict(baseline, ids);
  const regressions: string[] = [];
  const improvements: string[] = [];

  if (now.share0to3 < before.share0to3 - shareTolerance) {
    regressions.push(`0–3 touch share fell from ${pct(before.share0to3)} to ${pct(now.share0to3)}`);
  } else if (now.share0to3 > before.share0to3) {
    improvements.push(`0–3 touch share rose from ${pct(before.share0to3)} to ${pct(now.share0to3)}`);
  }

  const compareRates = (kind: string, after: Record<string, FieldRate>, prior: Record<string, FieldRate>) => {
    for (const field of new Set([...Object.keys(after), ...Object.keys(prior)])) {
      const was = prior[field]?.rate ?? 0;
      const is = after[field]?.rate ?? 0;
      if (is > was + fieldTolerance) regressions.push(`${kind} ${field} correction rate rose from ${pct(was)} to ${pct(is)}`);
      else if (is < was - fieldTolerance) improvements.push(`${kind} ${field} correction rate fell from ${pct(was)} to ${pct(is)}`);
    }
  };
  compareRates('field', now.fieldRates, before.fieldRates);
  compareRates('formatting field', now.formattingRates, before.formattingRates);

  const within = (record: CaseRecord) => (record.codingTouches ?? WORST_TOUCHES) <= 3;
  const casesNowWorse = ids.filter((id) => within(baseline.perCase[id]) && !within(current.perCase[id]));
  const casesNowBetter = ids.filter((id) => !within(baseline.perCase[id]) && within(current.perCase[id]));

  return {
    overlap: ids.length,
    ...(baseline.label ? { baselineLabel: baseline.label } : {}),
    baselineShare0to3: before.share0to3,
    currentShare0to3: now.share0to3,
    regressions,
    improvements,
    casesNowWorse,
    casesNowBetter,
    ok: regressions.length === 0,
  };
}

function bucketLines(buckets: BucketCount[]): string[] {
  const width = Math.max(...buckets.map((bucket) => bucket.label.length));
  return buckets.map((bucket) => `  ${bucket.label.padEnd(width)}  ${String(bucket.count).padStart(3)}  ${pct(bucket.share).padStart(6)}`);
}

function rateLines(rates: Record<string, FieldRate>): string[] {
  const entries = Object.entries(rates).sort(([, a], [, b]) => b.rate - a.rate);
  if (!entries.length) return ['  (none)'];
  const width = Math.max(...entries.map(([field]) => field.length));
  return entries.map(([field, rate]) => `  ${field.padEnd(width)}  ${pct(rate.rate).padStart(6)}  (${rate.cases} cases, ${rate.corrections} corrections)`);
}

export function formatSummary(summary: EvalSummary, comparison?: Comparison): string {
  const lines = [
    `Replay of ${summary.attempted} cases${summary.label ? ` (${summary.label})` : ''}: ${summary.scored} scored, ${summary.errored} pipeline errors, ${summary.skipped.length} skipped`,
    '',
    `Coding touches (memo, line memo, item description excluded): ${pct(summary.share0to3)} of cases at 0–3`,
    ...bucketLines(summary.buckets),
    '',
    `Digest-style touches (all scored fields): ${pct(summary.digestShare0to3)} of cases at 0–3`,
    ...bucketLines(summary.digestBuckets),
  ];
  if (summary.production) {
    lines.push('', `Production on the same ${summary.production.cases} invoices (entry plus late changes, as the weekly digest counts): ${pct(summary.production.share0to3)} at 0–3`, ...bucketLines(summary.production.buckets));
  }
  lines.push('', 'Per-field correction rate (share of scored cases where AP had to change the field):', ...rateLines(summary.fieldRates));
  lines.push('', 'Formatting conventions, reported apart from the coding count:', ...rateLines(summary.formattingRates));
  if (summary.errored) {
    lines.push('', 'Pipeline errors (counted as 21+):', ...Object.entries(summary.perCase).filter(([, record]) => record.status === 'error').map(([id, record]) => `  ${id}: ${record.reason ?? 'error'}`));
  }
  if (summary.skipped.length) {
    lines.push('', 'Skipped (not the pipeline\'s fault; not counted):', ...summary.skipped.map((entry) => `  ${entry.id}: ${entry.reason}`));
  }
  if (comparison) {
    lines.push(
      '',
      `Baseline${comparison.baselineLabel ? ` ${comparison.baselineLabel}` : ''} over ${comparison.overlap} shared cases: 0–3 share ${pct(comparison.baselineShare0to3)} -> ${pct(comparison.currentShare0to3)}`,
      comparison.ok ? 'No regressions.' : 'REGRESSIONS:',
      ...comparison.regressions.map((entry) => `  - ${entry}`),
    );
    if (comparison.improvements.length) lines.push('Improvements:', ...comparison.improvements.map((entry) => `  - ${entry}`));
    if (comparison.casesNowWorse.length) lines.push(`Cases that dropped out of 0–3: ${comparison.casesNowWorse.join(', ')}`);
    if (comparison.casesNowBetter.length) lines.push(`Cases that moved into 0–3: ${comparison.casesNowBetter.join(', ')}`);
  }
  return lines.join('\n');
}
