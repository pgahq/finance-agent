jest.mock('@pga/lambda-env', () => ({ __esModule: true, default: jest.fn().mockImplementation(() => Promise.resolve(process.env)) }));
jest.mock('@pga/logger', () => ({ debug: jest.fn() }));
const mockQuery = jest.fn();
jest.mock('../lib/database.js', () => ({
  getDatabaseConnection: jest.fn().mockImplementation(() => Promise.resolve({ query: mockQuery, close: jest.fn() })),
}));
jest.mock('../lib/workday.js', () => ({
  ...jest.requireActual('../lib/workday.js'),
  getWorkdayConfig: jest.fn().mockReturnValue({}),
  getWorkQueueTagWIDs: jest.fn(),
  executeWorkdayQuery: jest.fn(),
}));

import type { InvoiceScore } from '../lib/invoice_scores.js';
import { buildDailyInvoiceMessages, buildDigestBlocks, digestWindow, MAX_DAILY_INVOICE_MESSAGES, summarizeDay, summarizeScores } from '../lib/score_digest.js';
import { postSlackBlocks } from '../lib/slack.js';
import * as workday from '../lib/workday.js';
import { handler } from '../score_digest.js';

const now = new Date('2026-10-12T14:30:00Z');
const window = digestWindow(now);
const thisWeek = new Date('2026-10-08T12:00:00Z');
const lastWeek = new Date('2026-10-01T12:00:00Z');

function score(overrides: Partial<InvoiceScore>): InvoiceScore {
  return { workdayInvoiceWid: `wid-${Math.random()}`, terminal: false, ...overrides };
}

const costCenterChange = { field: 'line.costCenter' as const, line: 0, before: 'CC1', after: 'CC2', category: 'material' as const, agentOwned: true };
const memoChange = { field: 'memo' as const, before: 'AC 1. Job 2. Services', after: 'Services', category: 'convention' as const, agentOwned: true };
const ocrSupplierChange = { field: 'supplier' as const, before: 'S-1', after: 'S-2', category: 'material' as const, agentOwned: false };

const scores: InvoiceScore[] = [
  score({ workdayInvoiceNumber: 'SUPIN-1', entryReadAt: thisWeek, outcome: 'submitted_edited', entryDiff: [costCenterChange, memoChange], releaseSha: 'aaaaaaa1' }),
  score({ workdayInvoiceNumber: 'SUPIN-2', entryReadAt: thisWeek, outcome: 'submitted_clean', entryDiff: [memoChange], releaseSha: 'bbbbbbb2' }),
  score({ workdayInvoiceNumber: 'SUPIN-3', entryReadAt: thisWeek, outcome: 'submitted_clean', entryDiff: [ocrSupplierChange], releaseSha: 'bbbbbbb2' }),
  score({ entryReadAt: lastWeek, outcome: 'submitted_edited', entryDiff: [costCenterChange, costCenterChange] }),
  score({ entryReadAt: lastWeek, outcome: 'submitted_clean', entryDiff: [] }),
  score({ workdayInvoiceNumber: 'SUPIN-4', terminal: true, entryReadAt: lastWeek, finalReadAt: thisWeek, outcome: 'submitted_clean', lateDiff: [costCenterChange] }),
  score({ workdayInvoiceNumber: 'SUPIN-5', terminal: true, finalReadAt: thisWeek, outcome: 'canceled', cancelAttribution: 'agent', cancelBasis: 'wrong_document' }),
  score({ terminal: true, finalReadAt: thisWeek, outcome: 'deleted', cancelAttribution: 'unattributed', cancelBasis: 'early_draft_cancel' }),
  score({ terminal: true, finalReadAt: thisWeek, outcome: 'canceled', cancelAttribution: 'business', cancelBasis: 'supplier_void_or_credit' }),
  score({ outcome: 'stuck_draft' }),
];

describe('summarizeScores', () => {
  const summary = summarizeScores(scores, window, [
    score({ workdayInvoiceWid: 'u1', cancelBasis: 'no_signal' }),
    score({ workdayInvoiceWid: 'u2', workdayInvoiceNumber: 'SUPIN-9', cancelBasis: 'early_draft_cancel' }),
  ]);

  it('counts invoices AP entered this week and last week, and outcomes', () => {
    expect(summary.entered).toBe(3);
    expect(summary.enteredPrevious).toBe(3);
    expect(summary.outcomes).toEqual({ submitted_edited: 1, submitted_clean: 2, canceled: 2, deleted: 1 });
    expect(summary.stuckDrafts).toBe(1);
  });

  it('reports per-field change rates against the agent, material first, with last week for comparison', () => {
    expect(summary.fieldRates).toEqual([
      { field: 'line.costCenter', category: 'material', count: 1, rate: 1 / 3, previousRate: 1 / 3 },
      { field: 'memo', category: 'convention', count: 2, rate: 2 / 3, previousRate: 0 },
    ]);
  });

  it('breaks the edit rate out by release, late corrections, and cancels by attribution', () => {
    expect(summary.releaseRates).toEqual([
      { releaseSha: 'bbbbbbb2', entered: 2, edited: 0, rate: 0 },
      { releaseSha: 'aaaaaaa1', entered: 1, edited: 1, rate: 1 },
    ]);
    expect(summary.late).toEqual({ closed: 1, corrected: 1 });
    expect(summary.cancels).toEqual({ agent: 1, business: 1, unattributed: 1, agentByBasis: { wrong_document: 1 } });
  });

  it('lists convention examples, the worst invoices, and unattributed cancels with early Draft ones first', () => {
    expect(summary.conventionExamples.memo).toHaveLength(2);
    expect(summary.worst.map((link) => link.workdayInvoiceNumber)).toEqual(['SUPIN-5', 'SUPIN-1']);
    expect(summary.unattributedCancels.map((link) => link.workdayInvoiceWid)).toEqual(['u2', 'u1']);
  });

  it('renders Slack sections with Workday links when the UI base URL is set', () => {
    process.env.WORKDAY_UI_BASE_URL = 'https://impl.workday.com';
    process.env.WORKDAY_TENANT = 'pgahq';
    const text = buildDigestBlocks({ ...summary, backlog: { submitted: 4 } })
      .map((block) => (block.type === 'section' ? block.text.text : block.type === 'context' ? block.elements[0].text : ''))
      .join('\n');
    expect(text).toContain('*Finance agent audit*');
    expect(text).toContain('*3* agent invoices reached AP this week (3 the week before).');
    expect(text).toContain('• Cost center: 1 (33%) (was 33%)');
    expect(text).toContain('• Header memo: 2 (67%) (was 0%)');
    expect(text).toContain('*Cancels* · 1 agent, 1 business, 1 unattributed');
    expect(text).toContain('not an invoice: 1');
    expect(text).toContain('<https://impl.workday.com/pgahq/d/inst/deeplink/u2.htmld|SUPIN-9>');
    expect(text).toContain('Before snapshots (outcome only): 4 submitted');
    delete process.env.WORKDAY_UI_BASE_URL;
    delete process.env.WORKDAY_TENANT;
  });
});

describe('summarizeDay', () => {
  const until = new Date('2026-10-02T14:20:00Z');
  const since = new Date('2026-10-01T14:20:00Z');
  const today = new Date('2026-10-02T14:00:49Z');

  it('lists each invoice scored in the last day with its outcome and the changes AP made', () => {
    const summary = summarizeDay([
      score({ workdayInvoiceWid: 'w1', workdayInvoiceNumber: 'SUPIN-462667', entryReadAt: today, outcome: 'submitted_edited', entryDiff: [costCenterChange, memoChange, ocrSupplierChange] }),
      score({ workdayInvoiceWid: 'w2', workdayInvoiceNumber: 'SUPIN-462665', entryReadAt: today, outcome: 'submitted_clean', entryDiff: [] }),
      score({ workdayInvoiceWid: 'w3', terminal: true, entryReadAt: lastWeek, finalReadAt: today, finalStatus: 'Approved', outcome: 'submitted_clean', lateDiff: [costCenterChange] }),
      score({ workdayInvoiceWid: 'w4', terminal: true, finalReadAt: today, outcome: 'canceled', cancelAttribution: 'agent', cancelBasis: 'wrong_document' }),
      score({ workdayInvoiceWid: 'w5', terminal: true, finalReadAt: today, finalStatus: 'Lost to tenant refresh', outcome: 'lost_to_refresh' }),
      score({ workdayInvoiceWid: 'w6', outcome: 'stuck_draft', updatedAt: today }),
      score({ workdayInvoiceWid: 'w7', entryReadAt: lastWeek, outcome: 'submitted_edited', entryDiff: [costCenterChange] }),
    ], since, until);

    expect(summary.lines.map((line) => [line.workdayInvoiceWid, line.text])).toEqual([
      ['w1', 'submitted with AP edits'],
      ['w2', 'submitted with no material change'],
      ['w3', 'approved'],
      ['w4', 'canceled · agent (not an invoice)'],
      ['w6', 'stuck in Draft'],
    ]);
    expect(summary.lines[0]).toEqual(expect.objectContaining({ entryChanges: [costCenterChange, memoChange], ocrOnlyChanges: 1 }));
    expect(summary.lines[2].lateChanges).toEqual([costCenterChange]);
    expect(summary.lostToRefresh).toBe(1);
  });
});

describe('buildDailyInvoiceMessages', () => {
  const until = new Date('2026-10-02T14:20:00Z');
  const since = new Date('2026-10-01T14:20:00Z');
  const today = new Date('2026-10-02T14:00:49Z');
  const textOf = (blocks: ReturnType<typeof buildDailyInvoiceMessages>[number]) =>
    blocks.map((block) => (block.type === 'section' ? block.text.text : block.type === 'context' ? block.elements[0].text : '')).join('\n');

  it('posts one message per invoice with before and after values for each change', () => {
    const messages = buildDailyInvoiceMessages(summarizeDay([
      score({
        workdayInvoiceWid: 'w1', workdayInvoiceNumber: 'SUPIN-462665', entryReadAt: today, outcome: 'submitted_edited',
        entryDiff: [
          { field: 'line.costCenter', line: 0, before: 'Cost_Center_Reference_ID=CC72200', after: 'Cost_Center_Reference_ID=CC72100', category: 'material', agentOwned: true },
          { field: 'line.otherWorktags', line: 1, before: [], after: ['Organization_Reference_ID=VENU-Frisco'], category: 'material', agentOwned: true },
          { field: 'line.removed', line: 2, before: { amount: 50, itemDescription: 'Freight', otherWorktags: [] }, category: 'material', agentOwned: true },
          { field: 'line.memo', line: 0, before: 'AC 1. Services', after: 'Services', category: 'convention', agentOwned: true },
          ocrSupplierChange,
        ],
      }),
      score({ workdayInvoiceWid: 'w2', workdayInvoiceNumber: 'SUPIN-462667', entryReadAt: today, outcome: 'submitted_clean', entryDiff: [] }),
    ], since, until));

    expect(messages).toHaveLength(2);
    const first = textOf(messages[0]);
    expect(first).toContain('*Finance agent audit* · `SUPIN-462665` · submitted with AP edits');
    expect(first).toContain('*Changed by AP*');
    expect(first).toContain('• Cost center (line 1): `CC72200` → `CC72100`');
    expect(first).toContain('• Other worktags (line 2): `(blank)` → `VENU-Frisco`');
    expect(first).toContain('• Line removed (line 3): `50.00 · Freight`');
    expect(first).toContain('*Conventions*');
    expect(first).toContain('• Line memo (line 1): `AC 1. Services` → `Services`');
    expect(first).toContain('1 other change to OCR values the agent left alone (not counted)');
    expect(textOf(messages[1])).toBe('*Finance agent audit* · `SUPIN-462667` · submitted with no material change');
  });

  it('shows late changes and how an AP replacement differs from a canceled invoice', () => {
    const messages = buildDailyInvoiceMessages(summarizeDay([
      score({ workdayInvoiceWid: 'w3', terminal: true, entryReadAt: lastWeek, finalReadAt: today, finalStatus: 'Approved', outcome: 'submitted_clean', lateDiff: [costCenterChange] }),
      score({
        workdayInvoiceWid: 'w4', terminal: true, finalReadAt: today, outcome: 'canceled', cancelAttribution: 'agent', cancelBasis: 'replacement',
        cancelEvidence: { replacement: { workdayInvoiceWid: 'r1', diff: [{ field: 'supplier', before: 'Supplier_ID=S-1', after: 'Supplier_ID=S-2' }] } },
      }),
    ], since, until));
    expect(textOf(messages[0])).toContain('*Changed after submit*\n• Cost center (line 1): `CC1` → `CC2`');
    expect(textOf(messages[1])).toContain('*AP replacement differs*\n• Supplier: `S-1` → `S-2`');
  });

  it('caps the messages on a busy day and notes the sandbox refresh', () => {
    const many = Array.from({ length: MAX_DAILY_INVOICE_MESSAGES + 3 }, (_, index) =>
      score({ workdayInvoiceWid: `w${index}`, entryReadAt: today, outcome: 'submitted_clean', entryDiff: [] }));
    many.push(score({ workdayInvoiceWid: 'lost', terminal: true, finalReadAt: today, finalStatus: 'Lost to tenant refresh', outcome: 'lost_to_refresh' }));
    const messages = buildDailyInvoiceMessages(summarizeDay(many, since, until));
    expect(messages).toHaveLength(MAX_DAILY_INVOICE_MESSAGES + 1);
    expect(textOf(messages[messages.length - 1])).toBe('…and 3 more invoices scored today; see the weekly digest. 1 removed by the weekly sandbox refresh (not scored).');
  });
});

describe('postSlackBlocks', () => {
  const fetchMock = jest.fn().mockResolvedValue({ ok: true });

  beforeEach(() => {
    fetchMock.mockClear();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('posts to the given webhook', async () => {
    await postSlackBlocks([{ type: 'section', text: { type: 'mrkdwn', text: 'hello' } }], 'https://hooks.slack.test/audit', 'AUDIT_SLACK_WEBHOOK_URL');
    expect(fetchMock).toHaveBeenCalledWith('https://hooks.slack.test/audit', expect.anything());
  });

  it('never falls back to the per-invoice channel when the audit webhook is unset', async () => {
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.test/per-invoice';
    await postSlackBlocks([{ type: 'section', text: { type: 'mrkdwn', text: 'hello' } }], undefined, 'AUDIT_SLACK_WEBHOOK_URL');
    expect(fetchMock).not.toHaveBeenCalled();
    delete process.env.SLACK_WEBHOOK_URL;
  });
});

describe('score digest handler', () => {
  const fetchMock = jest.fn().mockResolvedValue({ ok: true });

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock as unknown as typeof fetch;
    process.env.S3_BUCKET_NAME = 'finance-agent-test';
    process.env.AUDIT_SLACK_WEBHOOK_URL = 'https://hooks.slack.test/audit';
  });

  afterEach(() => {
    delete process.env.AUDIT_SLACK_WEBHOOK_URL;
  });

  it('posts the week to the audit webhook and still posts when the backlog count fails', async () => {
    mockQuery
      .mockResolvedValueOnce([{ workday_invoice_wid: 'w1', entry_read_at: new Date(Date.now() - 1000), outcome: 'submitted_clean', entry_diff: [], terminal: false }])
      .mockResolvedValueOnce([]);
    (workday.getWorkQueueTagWIDs as jest.Mock).mockRejectedValue(new Error('No work queue tags found'));

    await handler({});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://hooks.slack.test/audit');
    const payload = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as { text: string };
    expect(payload.text).toContain('Finance agent audit');
  });

  it('in daily mode posts one message per invoice scored in the last day to the audit webhook', async () => {
    mockQuery.mockResolvedValueOnce([
      { workday_invoice_wid: 'w1', workday_invoice_number: 'SUPIN-1', entry_read_at: new Date(Date.now() - 60_000), outcome: 'submitted_edited', entry_diff: [costCenterChange], terminal: false },
      { workday_invoice_wid: 'w2', workday_invoice_number: 'SUPIN-2', entry_read_at: new Date(Date.now() - 60_000), outcome: 'submitted_clean', entry_diff: [], terminal: false },
    ]);

    await handler({ mode: 'daily' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) => url === 'https://hooks.slack.test/audit')).toBe(true);
    const payload = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as { text: string };
    expect(payload.text).toContain('Finance agent audit · `SUPIN-1` · submitted with AP edits');
    expect(workday.getWorkQueueTagWIDs).not.toHaveBeenCalled();
  });

  it('in daily mode posts nothing when no invoice was scored', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await handler({ mode: 'daily' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('applies an AP label added after the cancel was scored', async () => {
    mockQuery
      .mockResolvedValueOnce([{
        workday_invoice_wid: 'w1', terminal: true, final_read_at: new Date(Date.now() - 1000), outcome: 'canceled',
        cancel_attribution: 'unattributed', cancel_basis: 'early_draft_cancel', label_attribution: 'agent',
      }])
      .mockResolvedValueOnce([]);
    (workday.getWorkQueueTagWIDs as jest.Mock).mockResolvedValue([]);

    await handler({});

    const payload = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as { blocks: Array<{ text?: { text: string } }> };
    const cancels = payload.blocks.find((block) => block.text?.text.startsWith('*Cancels*'))?.text?.text;
    expect(cancels).toContain('*Cancels* · 1 agent, 0 business, 0 unattributed');
    expect(cancels).toContain('AP label: 1');
  });

  it('in a refreshed sandbox, reports invoices the refresh removed apart and skips the pre-snapshot count', async () => {
    process.env.SCORE_TENANT_REFRESH_WEEKDAY = '6';
    mockQuery
      .mockResolvedValueOnce([
        { workday_invoice_wid: 'w1', terminal: true, final_read_at: new Date(Date.now() - 1000), outcome: 'lost_to_refresh', final_status: 'Lost to tenant refresh' },
        { workday_invoice_wid: 'w2', terminal: true, entry_read_at: new Date(Date.now() - 5000), final_read_at: new Date(Date.now() - 1000), outcome: 'submitted_clean', entry_diff: [], final_status: 'Lost to tenant refresh' },
      ])
      .mockResolvedValueOnce([]);

    await handler({});

    expect(workday.getWorkQueueTagWIDs).not.toHaveBeenCalled();
    const payload = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as { blocks: Array<{ type: string; text?: { text: string } }> };
    const text = payload.blocks.map((block) => block.text?.text ?? '').join('\n');
    expect(text).toContain('• 2 removed by the weekly sandbox refresh (not scored)');
    expect(text).toContain('on 0 of 0 invoices closed this week');
    expect(text).toContain('*Cancels* · 0 agent, 0 business, 0 unattributed');
    delete process.env.SCORE_TENANT_REFRESH_WEEKDAY;
  });

  it('counts pre-snapshot agent invoices by state and skips ones that have a snapshot', async () => {
    mockQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ workday_invoice_wid: 'has-snapshot' }]);
    (workday.getWorkQueueTagWIDs as jest.Mock).mockResolvedValue(['tag-wid']);
    (workday.executeWorkdayQuery as jest.Mock).mockResolvedValue({
      data: [
        { workdayID: 'has-snapshot', invoiceStatusAsText: 'Draft' },
        { workdayID: 'old-1', invoiceStatusAsText: 'Approved' },
        { workdayID: 'old-2', invoiceStatusAsText: 'Draft', isCanceled: true },
      ],
    });

    await handler({});

    expect((workday.executeWorkdayQuery as jest.Mock).mock.calls[0][1]).toContain("workQueueTags in ('tag-wid')");
    const payload = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as { blocks: Array<{ elements?: Array<{ text: string }> }> };
    const context = payload.blocks.find((block) => block.elements)?.elements?.[0].text;
    expect(context).toBe('Before snapshots (outcome only): 1 approved, 1 canceled');
  });
});
