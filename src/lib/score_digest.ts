import type { CancelBasis, Outcome, ScoredChange } from './invoice_score.js';
import type { InvoiceScore } from './invoice_scores.js';
import type { ScoredFieldName } from './invoice_snapshots.js';
import type { SlackBlock } from './slack.js';
import { buildWorkdayObjectDeeplink } from './workday_deeplink.js';

const DAY_MS = 86_400_000;

export interface DigestWindow {
  start: Date;
  end: Date;
  previousStart: Date;
}

export function digestWindow(now: Date, days = 7): DigestWindow {
  return {
    start: new Date(now.getTime() - days * DAY_MS),
    end: now,
    previousStart: new Date(now.getTime() - 2 * days * DAY_MS),
  };
}

export interface FieldRate {
  field: ScoredFieldName;
  category: 'material' | 'convention';
  count: number;
  rate: number;
  previousRate?: number;
}

export interface ReleaseRate {
  releaseSha: string;
  entered: number;
  edited: number;
  rate: number;
}

export interface ChangeExample {
  workdayInvoiceWid: string;
  workdayInvoiceNumber?: string;
  before?: unknown;
  after?: unknown;
}

export interface InvoiceLink {
  workdayInvoiceWid: string;
  workdayInvoiceNumber?: string;
  detail: string;
}

export interface DigestSummary {
  window: DigestWindow;
  entered: number;
  enteredPrevious: number;
  outcomes: Partial<Record<Outcome, number>>;
  stuckDrafts: number;
  fieldRates: FieldRate[];
  releaseRates: ReleaseRate[];
  late: { closed: number; corrected: number };
  cancels: { agent: number; business: number; unattributed: number; agentByBasis: Partial<Record<CancelBasis, number>> };
  conventionExamples: Partial<Record<'memo' | 'suppliersInvoiceNumber', ChangeExample[]>>;
  worst: InvoiceLink[];
  unattributedCancels: InvoiceLink[];
  backlog?: Partial<Record<string, number>>;
}

function within(date: Date | undefined, start: Date, end: Date): boolean {
  return Boolean(date) && date!.getTime() >= start.getTime() && date!.getTime() < end.getTime();
}

function againstAgent(changes: ScoredChange[] | undefined): ScoredChange[] {
  return (changes ?? []).filter((change) => change.agentOwned !== false);
}

function fieldCounts(scores: InvoiceScore[]): Map<ScoredFieldName, { category: 'material' | 'convention'; count: number }> {
  const counts = new Map<ScoredFieldName, { category: 'material' | 'convention'; count: number }>();
  for (const score of scores) {
    const seen = new Set<ScoredFieldName>();
    for (const change of againstAgent(score.entryDiff)) {
      if (seen.has(change.field)) continue;
      seen.add(change.field);
      const entry = counts.get(change.field) ?? { category: change.category, count: 0 };
      entry.count += 1;
      counts.set(change.field, entry);
    }
  }
  return counts;
}

const CANCELED_OUTCOMES = new Set<Outcome>(['canceled', 'deleted']);
const MAX_EXAMPLES = 3;
const MAX_WORST = 5;

/** Week summary of agent invoice scores, compared with the week before. */
export function summarizeScores(
  scores: InvoiceScore[],
  window: DigestWindow,
  unattributedCancels: InvoiceScore[] = []
): DigestSummary {
  const enteredNow = scores.filter((score) => within(score.entryReadAt, window.start, window.end));
  const enteredBefore = scores.filter((score) => within(score.entryReadAt, window.previousStart, window.start));
  const closedNow = scores.filter((score) => score.terminal && within(score.finalReadAt, window.start, window.end));

  const outcomes: Partial<Record<Outcome, number>> = {};
  const bump = (outcome: Outcome | undefined) => {
    if (outcome) outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  };
  for (const score of enteredNow) bump(score.outcome);
  for (const score of closedNow) if (score.outcome && CANCELED_OUTCOMES.has(score.outcome)) bump(score.outcome);
  const stuckDrafts = scores.filter((score) => !score.terminal && score.outcome === 'stuck_draft').length;

  const nowCounts = fieldCounts(enteredNow);
  const previousCounts = fieldCounts(enteredBefore);
  const fieldRates: FieldRate[] = [...nowCounts.entries()]
    .map(([field, { category, count }]) => ({
      field,
      category,
      count,
      rate: count / enteredNow.length,
      ...(enteredBefore.length ? { previousRate: (previousCounts.get(field)?.count ?? 0) / enteredBefore.length } : {}),
    }))
    .sort((a, b) => (a.category === b.category ? b.count - a.count : a.category === 'material' ? -1 : 1));

  const byRelease = new Map<string, { entered: number; edited: number }>();
  for (const score of enteredNow) {
    const key = score.releaseSha ?? 'unknown';
    const entry = byRelease.get(key) ?? { entered: 0, edited: 0 };
    entry.entered += 1;
    if (score.outcome === 'submitted_edited') entry.edited += 1;
    byRelease.set(key, entry);
  }
  const releaseRates = [...byRelease.entries()]
    .map(([releaseSha, { entered, edited }]) => ({ releaseSha, entered, edited, rate: edited / entered }))
    .sort((a, b) => b.entered - a.entered);

  const lateClosed = closedNow.filter((score) => score.outcome && !CANCELED_OUTCOMES.has(score.outcome));
  const late = {
    closed: lateClosed.length,
    corrected: lateClosed.filter((score) => againstAgent(score.lateDiff).some((change) => change.category === 'material')).length,
  };

  const canceledNow = closedNow.filter((score) => score.outcome && CANCELED_OUTCOMES.has(score.outcome));
  const cancels = { agent: 0, business: 0, unattributed: 0, agentByBasis: {} as Partial<Record<CancelBasis, number>> };
  for (const score of canceledNow) {
    const attribution = score.cancelAttribution ?? 'unattributed';
    cancels[attribution] += 1;
    if (attribution === 'agent' && score.cancelBasis) {
      cancels.agentByBasis[score.cancelBasis] = (cancels.agentByBasis[score.cancelBasis] ?? 0) + 1;
    }
  }

  const conventionExamples: DigestSummary['conventionExamples'] = {};
  for (const field of ['memo', 'suppliersInvoiceNumber'] as const) {
    const examples = enteredNow.flatMap((score) => againstAgent(score.entryDiff)
      .filter((change) => change.field === field)
      .map((change) => ({
        workdayInvoiceWid: score.workdayInvoiceWid,
        ...(score.workdayInvoiceNumber ? { workdayInvoiceNumber: score.workdayInvoiceNumber } : {}),
        before: change.before,
        after: change.after,
      })));
    if (examples.length) conventionExamples[field] = examples.slice(0, MAX_EXAMPLES);
  }

  const materialCount = (score: InvoiceScore) => againstAgent(score.entryDiff).filter((change) => change.category === 'material').length;
  const worst: InvoiceLink[] = [
    ...canceledNow
      .filter((score) => score.cancelAttribution === 'agent')
      .map((score) => ({ score, weight: 1000, detail: `canceled (${score.cancelBasis ?? 'agent'})` })),
    ...enteredNow
      .filter((score) => materialCount(score) > 0)
      .map((score) => ({ score, weight: materialCount(score), detail: `${materialCount(score)} material field changes` })),
  ]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_WORST)
    .map(({ score, detail }) => ({
      workdayInvoiceWid: score.workdayInvoiceWid,
      ...(score.workdayInvoiceNumber ? { workdayInvoiceNumber: score.workdayInvoiceNumber } : {}),
      detail,
    }));

  const unattributed = [...unattributedCancels]
    .sort((a, b) => Number(b.cancelBasis === 'early_draft_cancel') - Number(a.cancelBasis === 'early_draft_cancel'))
    .map((score) => ({
      workdayInvoiceWid: score.workdayInvoiceWid,
      ...(score.workdayInvoiceNumber ? { workdayInvoiceNumber: score.workdayInvoiceNumber } : {}),
      detail: score.cancelBasis === 'early_draft_cancel' ? 'canceled in Draft soon after the agent wrote it' : 'no signal',
    }));

  return {
    window,
    entered: enteredNow.length,
    enteredPrevious: enteredBefore.length,
    outcomes,
    stuckDrafts,
    fieldRates,
    releaseRates,
    late,
    cancels,
    conventionExamples,
    worst,
    unattributedCancels: unattributed,
  };
}

const FIELD_LABELS: Record<ScoredFieldName, string> = {
  supplier: 'Supplier',
  company: 'Company',
  suppliersInvoiceNumber: 'Supplier invoice number',
  invoiceDate: 'Invoice date',
  controlTotal: 'Control total',
  memo: 'Header memo',
  'line.amount': 'Line amount',
  'line.purchaseOrderLine': 'PO line',
  'line.spendCategory': 'Spend category',
  'line.costCenter': 'Cost center',
  'line.fund': 'Fund',
  'line.lineOfBusiness': 'Line of business',
  'line.otherWorktags': 'Other worktags',
  'line.memo': 'Line memo',
  'line.itemDescription': 'Item description',
  'line.added': 'Lines added',
  'line.removed': 'Lines removed',
};

const BASIS_LABELS: Partial<Record<CancelBasis, string>> = {
  replacement: 'AP keyed a replacement',
  duplicate: 'duplicate',
  duplicate_reason: 'duplicate (cancel reason)',
  wrong_document: 'not an invoice',
  per_pdf_without_clustering: 'extra PDF before clustering',
  agent_reason: 'agent cancel reason',
  agent_tag: 'agent error tag',
  ap_label: 'AP label',
};

const percent = (rate: number) => `${Math.round(rate * 100)}%`;

function shortDate(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' });
}

function quote(value: unknown): string {
  const text = value == null || value === '' ? '(blank)' : String(value);
  return `\`${text.length > 80 ? `${text.slice(0, 79)}…` : text}\``;
}

function invoiceLink(link: { workdayInvoiceWid: string; workdayInvoiceNumber?: string }): string {
  const label = link.workdayInvoiceNumber ?? link.workdayInvoiceWid;
  const url = buildWorkdayObjectDeeplink(link.workdayInvoiceWid);
  return url ? `<${url}|${label}>` : `\`${label}\``;
}

function section(text: string): SlackBlock {
  return { type: 'section', text: { type: 'mrkdwn', text: text.length > 2900 ? `${text.slice(0, 2899)}…` : text } };
}

const OUTCOME_LABELS: Record<Outcome, string> = {
  submitted_clean: 'submitted with no material change',
  submitted_edited: 'submitted with AP edits',
  denied: 'denied',
  canceled: 'canceled',
  deleted: 'deleted',
  stuck_draft: 'stuck in Draft',
};

export function buildDigestBlocks(summary: DigestSummary): SlackBlock[] {
  const { window } = summary;
  const blocks: SlackBlock[] = [
    section(`*Finance agent audit* · ${shortDate(window.start)} – ${shortDate(window.end)}`),
  ];

  const outcomeLines = (Object.keys(OUTCOME_LABELS) as Outcome[])
    .filter((outcome) => outcome !== 'stuck_draft' && summary.outcomes[outcome])
    .map((outcome) => `• ${summary.outcomes[outcome]} ${OUTCOME_LABELS[outcome]}`);
  const enteredLine = `*${summary.entered}* agent invoices reached AP this week (${summary.enteredPrevious} the week before).`;
  blocks.push(section([enteredLine, ...outcomeLines, `• ${summary.stuckDrafts} still in Draft past the cutoff`].join('\n')));

  if (summary.fieldRates.length) {
    const line = (rate: FieldRate) => {
      const trend = rate.previousRate != null ? ` (was ${percent(rate.previousRate)})` : '';
      return `• ${FIELD_LABELS[rate.field]}: ${rate.count} (${percent(rate.rate)})${trend}`;
    };
    const material = summary.fieldRates.filter((rate) => rate.category === 'material');
    const convention = summary.fieldRates.filter((rate) => rate.category === 'convention');
    blocks.push(section([
      '*Fields AP changed before submitting*',
      ...(material.length ? ['_Coding and extraction_', ...material.map(line)] : []),
      ...(convention.length ? ['_Conventions (memo, descriptions, invoice number)_', ...convention.map(line)] : []),
    ].join('\n')));
  }

  if (summary.releaseRates.length > 1) {
    blocks.push(section([
      '*By release*',
      ...summary.releaseRates.map((rate) => `• \`${rate.releaseSha.slice(0, 7)}\`: ${rate.edited} of ${rate.entered} edited (${percent(rate.rate)})`),
    ].join('\n')));
  }

  blocks.push(section(
    `*Late corrections* · ${summary.late.corrected} of ${summary.late.closed} invoices that closed this week had coding changed after AP submitted them.`
  ));

  const { cancels } = summary;
  const basisLines = Object.entries(cancels.agentByBasis)
    .map(([basis, count]) => `   ◦ ${BASIS_LABELS[basis as CancelBasis] ?? basis}: ${count}`);
  blocks.push(section([
    `*Cancels* · ${cancels.agent} agent, ${cancels.business} business, ${cancels.unattributed} unattributed`,
    ...basisLines,
  ].join('\n')));

  const exampleLines = (Object.entries(summary.conventionExamples) as Array<[keyof typeof summary.conventionExamples, ChangeExample[]]>)
    .flatMap(([field, examples]) => [
      `_${field === 'memo' ? 'Header memo' : 'Supplier invoice number'}_`,
      ...examples.map((example) => `• ${invoiceLink(example)}: ${quote(example.before)} → ${quote(example.after)}`),
    ]);
  if (exampleLines.length) blocks.push(section(['*How AP rewrote conventions*', ...exampleLines].join('\n')));

  if (summary.worst.length) {
    blocks.push(section(['*Invoices to look at*', ...summary.worst.map((link) => `• ${invoiceLink(link)}: ${link.detail}`)].join('\n')));
  }

  if (summary.unattributedCancels.length) {
    blocks.push(section([
      '*Cancels AP can label* (agent or business)',
      ...summary.unattributedCancels.map((link) => `• ${invoiceLink(link)}: ${link.detail}`),
    ].join('\n')));
  }

  if (summary.backlog && Object.keys(summary.backlog).length) {
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `Before snapshots (outcome only): ${Object.entries(summary.backlog).map(([state, count]) => `${count} ${state}`).join(', ')}`,
      }],
    });
  }

  return blocks;
}
