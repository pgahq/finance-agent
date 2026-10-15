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
import { addCentralDays, centralDayStart, centralWeekStart } from '../lib/score_touches.js';
import { postSlackChannelMessage, SLACK_POST_GAP_MS, SLACK_POST_MESSAGE_URL, type SlackBlock } from '../lib/slack.js';
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

  it('counts invoices AP entered in the week and the week before, and outcomes', () => {
    expect(summary.entered).toBe(3);
    expect(summary.enteredPrevious).toBe(3);
    expect(summary.outcomes).toEqual({ submitted_edited: 1, submitted_clean: 2, canceled: 2, deleted: 1 });
    expect(summary.stuckDrafts).toBe(1);
  });

  it('counts an invoice entered and canceled in the same week once', () => {
    const both = summarizeScores([
      score({ workdayInvoiceWid: 'same', entryReadAt: thisWeek, finalReadAt: thisWeek, terminal: true, outcome: 'canceled', cancelAttribution: 'business' }),
    ], window);
    expect(both.outcomes).toEqual({ canceled: 1 });
    expect(both.cancels.business).toBe(1);
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
    expect(text).toContain('*3* agent invoices reached AP last week (3 the week before).');
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

  it('says which cancel evidence could not be checked', () => {
    const messages = buildDailyInvoiceMessages(summarizeDay([
      score({
        workdayInvoiceWid: 'w9', workdayInvoiceNumber: 'SUPIN-9', terminal: true, finalReadAt: today, outcome: 'canceled',
        cancelAttribution: 'unattributed', cancelBasis: 'no_signal',
        cancelEvidence: { replacementLookupFailed: true, conversationReadFailed: true },
      }),
    ], since, until));
    expect(textOf(messages[0])).toContain('Could not check the replacement search and the Intercom conversation; the attribution may be missing a signal.');
  });

  it('renders invoice text inertly so it cannot mention the channel, link, or break the code span', () => {
    const messages = buildDailyInvoiceMessages(summarizeDay([
      score({
        workdayInvoiceWid: 'w1', workdayInvoiceNumber: 'SUPIN-1', entryReadAt: today, outcome: 'submitted_clean',
        entryDiff: [{ field: 'memo', before: 'AC 1 & co', after: '<!here> see `<https://x.test|here>`', category: 'convention', agentOwned: true }],
      }),
    ], since, until));
    expect(textOf(messages[0])).toContain("• Header memo: `AC 1 &amp; co` → `&lt;!here&gt; see '&lt;https://x.test|here&gt;'`");
  });

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
    expect(first).toContain('*Finance agent audit* · `SUPIN-462665` · submitted with AP edits · *4 touches*');
    expect(first).toContain('*Changed by AP*');
    expect(first).toContain('• Cost center (line 1): `CC72200` → `CC72100`');
    expect(first).toContain('• Other worktags (line 2): `(blank)` → `VENU-Frisco`');
    expect(first).toContain('• Line removed (line 3): `50.00 · Freight`');
    expect(first).toContain('*Conventions*');
    expect(first).toContain('• Line memo (line 1): `AC 1. Services` → `Services`');
    expect(first).toContain('1 other change to OCR values the agent left alone (not counted)');
    expect(textOf(messages[1])).toBe('*Finance agent audit* · `SUPIN-462667` · submitted with no material change · *0 touches*');
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
    expect(textOf(messages[messages.length - 1])).toBe('…and 3 more invoices scored since the last daily post; see the weekly digest. 1 removed by the weekly sandbox refresh (not scored).');
  });
});

/** A chat.postMessage answer: HTTP 200 with Slack's `ok` in the body. */
function slackAnswer(body: Record<string, unknown>) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => JSON.stringify(body) };
}

const AUDIT_TARGET = { token: 'xoxb-test', channel: 'C0AUDIT' };

describe('postSlackChannelMessage', () => {
  const fetchMock = jest.fn();
  const requestOf = (call: number) => fetchMock.mock.calls[call] as [string, { headers: Record<string, string>; body: string }];
  const bodyOf = (call: number) => JSON.parse(requestOf(call)[1].body) as Record<string, unknown>;
  const leadWithChart: SlackBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: 'Lead' } },
    { type: 'image', image_url: 'https://quickchart.io/chart?c=x', alt_text: 'chart' },
  ];

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(slackAnswer({ ok: true, ts: '1700000000.000100' }));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('posts to the channel with the bot token and returns the message ts', async () => {
    const sent = await postSlackChannelMessage([{ type: 'section', text: { type: 'mrkdwn', text: '*hello*' } }], AUDIT_TARGET);
    expect(sent).toEqual({ ok: true, ts: '1700000000.000100' });
    const [url, init] = requestOf(0);
    expect(url).toBe(SLACK_POST_MESSAGE_URL);
    expect(init.headers.Authorization).toBe('Bearer xoxb-test');
    expect(bodyOf(0)).toEqual({
      channel: 'C0AUDIT',
      text: 'hello',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*hello*' } }],
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  it('replies in a thread when given its ts', async () => {
    await postSlackChannelMessage([{ type: 'section', text: { type: 'mrkdwn', text: 'reply' } }], { ...AUDIT_TARGET, threadTs: '1700000000.000100' });
    expect(bodyOf(0).thread_ts).toBe('1700000000.000100');
  });

  it('resends without the chart image when Slack rejects the message, keeping the thread', async () => {
    fetchMock
      .mockResolvedValueOnce(slackAnswer({ ok: false, error: 'invalid_blocks', response_metadata: { messages: ['[ERROR] downloading image failed [json-pointer:/blocks/1/image_url]'] } }))
      .mockResolvedValueOnce(slackAnswer({ ok: true, ts: '2.0' }));
    const sent = await postSlackChannelMessage(leadWithChart, { ...AUDIT_TARGET, threadTs: '1.0' });
    expect(sent).toEqual({ ok: true, ts: '2.0' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retried = bodyOf(1);
    expect(retried.blocks).toEqual([{ type: 'header', text: { type: 'plain_text', text: 'Lead' } }]);
    expect(retried.text).toBe('Lead');
    expect(retried.thread_ts).toBe('1.0');
  });

  it('does not resend after a server error, network failure, or other Slack error', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Server Error', text: async () => '' });
    expect(await postSlackChannelMessage(leadWithChart, AUDIT_TARGET)).toEqual({ ok: false, error: 'HTTP 500' });
    fetchMock.mockRejectedValueOnce(new Error('socket hang up'));
    expect(await postSlackChannelMessage(leadWithChart, AUDIT_TARGET)).toEqual({ ok: false, error: 'request failed' });
    fetchMock.mockResolvedValueOnce(slackAnswer({ ok: false, error: 'not_in_channel' }));
    expect(await postSlackChannelMessage(leadWithChart, AUDIT_TARGET)).toEqual({ ok: false, error: 'not_in_channel' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not drop the chart for a block error that does not name the image', async () => {
    fetchMock.mockResolvedValueOnce(slackAnswer({ ok: false, error: 'invalid_blocks', response_metadata: { messages: ['[ERROR] must be more than 0 characters [json-pointer:/blocks/0/text/text]'] } }));
    expect(await postSlackChannelMessage(leadWithChart, AUDIT_TARGET)).toMatchObject({ ok: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bounds each request with a timeout', async () => {
    await postSlackChannelMessage(leadWithChart, AUDIT_TARGET);
    expect((requestOf(0)[1] as { signal?: unknown }).signal).toBeInstanceOf(AbortSignal);
    fetchMock.mockRejectedValueOnce(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    expect(await postSlackChannelMessage(leadWithChart, AUDIT_TARGET)).toEqual({ ok: false, error: 'timeout' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never falls back to the per-invoice webhook when the token or channel is unset or blank', async () => {
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.test/per-invoice';
    const blocks: SlackBlock[] = [{ type: 'section', text: { type: 'mrkdwn', text: 'hello' } }];
    expect(await postSlackChannelMessage(blocks, { token: undefined, channel: 'C0AUDIT' })).toEqual({ ok: false, error: 'bot token or channel not set' });
    expect(await postSlackChannelMessage(blocks, { token: 'xoxb-test', channel: '' })).toMatchObject({ ok: false });
    expect(await postSlackChannelMessage(blocks, { token: '  ', channel: 'C0AUDIT' })).toMatchObject({ ok: false });
    expect(await postSlackChannelMessage(blocks, { token: 'xoxb-test', channel: ' \n' })).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
    delete process.env.SLACK_WEBHOOK_URL;
  });

  it.each([
    ['a non-boolean ok', { ok: 'false', ts: '1.0' }],
    ['malformed error details', { ok: false, error: 'invalid_blocks', errors: 'image', response_metadata: { messages: [42] } }],
  ])('treats a Slack answer with %s as not posted, without resending', async (_name, answer) => {
    fetchMock.mockResolvedValueOnce(slackAnswer(answer));
    expect(await postSlackChannelMessage(leadWithChart, AUDIT_TARGET)).toMatchObject({ ok: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a missing ts', { ok: true }],
    ['a numeric ts', { ok: true, ts: 123 }],
    ['a blank ts', { ok: true, ts: ' ' }],
    ['a ts that is not a Slack timestamp', { ok: true, ts: 'not-a-ts' }],
  ])('reports a posted message with %s as delivered but with no ts to thread under', async (_name, answer) => {
    fetchMock.mockResolvedValueOnce(slackAnswer(answer));
    const sent = await postSlackChannelMessage(leadWithChart, AUDIT_TARGET);
    expect(sent.ok).toBe(true);
    expect(sent.ts).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports only Slack error codes, never response bodies', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502, statusText: 'Bad Gateway', text: async () => '<html>SUPIN-1 memo text</html>' });
    expect(await postSlackChannelMessage(leadWithChart, AUDIT_TARGET)).toEqual({ ok: false, error: 'HTTP 502' });
    fetchMock.mockResolvedValueOnce(slackAnswer({ ok: false, error: '<!channel> SUPIN-1 memo text' }));
    expect(await postSlackChannelMessage(leadWithChart, AUDIT_TARGET)).toEqual({ ok: false, error: 'unreadable_response' });
    fetchMock.mockResolvedValueOnce(slackAnswer({
      ok: false,
      error: 'invalid_blocks',
      errors: ['SUPIN-1 memo text'],
      response_metadata: { messages: ['[ERROR] SUPIN-1 memo text [json-pointer:/blocks/0/text/text]'] },
    }));
    expect(await postSlackChannelMessage(leadWithChart, AUDIT_TARGET)).toEqual({ ok: false, error: 'invalid_blocks' });
    const { debug } = jest.requireMock('@pga/logger') as { debug: jest.Mock };
    expect(JSON.stringify(debug.mock.calls)).not.toContain('SUPIN-1 memo text');
  });

  it('refuses a thread ts that is not a Slack timestamp', async () => {
    const blocks: SlackBlock[] = [{ type: 'section', text: { type: 'mrkdwn', text: 'reply' } }];
    expect(await postSlackChannelMessage(blocks, { ...AUDIT_TARGET, threadTs: '' })).toMatchObject({ ok: false });
    expect(await postSlackChannelMessage(blocks, { ...AUDIT_TARGET, threadTs: 'C0AUDIT' })).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('waits the post gap before resending without the image', async () => {
    fetchMock
      .mockResolvedValueOnce(slackAnswer({ ok: false, error: 'invalid_blocks', response_metadata: { messages: ['[ERROR] downloading image failed'] } }))
      .mockResolvedValueOnce(slackAnswer({ ok: true, ts: '2.0' }));
    const started = Date.now();
    await postSlackChannelMessage(leadWithChart, AUDIT_TARGET);
    expect(Date.now() - started).toBeGreaterThanOrEqual(SLACK_POST_GAP_MS - 50);
  });

  it('sends trimmed credentials', async () => {
    await postSlackChannelMessage([{ type: 'section', text: { type: 'mrkdwn', text: 'hello' } }], { token: ' xoxb-test\n', channel: ' C0AUDIT ' });
    expect(requestOf(0)[1].headers.Authorization).toBe('Bearer xoxb-test');
    expect(bodyOf(0).channel).toBe('C0AUDIT');
  });
});

describe('score digest handler', () => {
  const LEAD_TS = '1700000000.000100';
  const fetchMock = jest.fn();
  /** Twelve hours before this week's Monday midnight Central: inside the last complete week the digest reports. */
  const lastSunday = new Date(centralWeekStart(new Date()).getTime() - 12 * 3_600_000);

  /** Answer each digest query by what it selects, so adding a query does not shift the others. */
  function routeQueries(rows: { digest?: unknown[]; unlabeled?: unknown[]; entered?: unknown[]; snapshots?: unknown[]; posted?: unknown[] }) {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('AS stored FROM agent_invoice_touch_daily')) return Promise.resolve([{ stored: 15 }]);
      if (sql.includes('SELECT posted_through FROM agent_invoice_audit_posts')) return Promise.resolve(rows.posted ?? []);
      if (sql.includes('label_attribution')) return Promise.resolve(rows.digest ?? []);
      if (sql.includes("cancel_attribution = 'unattributed'")) return Promise.resolve(rows.unlabeled ?? []);
      if (sql.includes('WHERE entry_read_at >= $1')) return Promise.resolve(rows.entered ?? []);
      if (sql.includes('agent_invoice_snapshots')) return Promise.resolve(rows.snapshots ?? []);
      return Promise.resolve([]);
    });
  }

  const payloadOf = (call: number) => JSON.parse((fetchMock.mock.calls[call][1] as { body: string }).body) as {
    channel: string;
    thread_ts?: string;
    text: string;
    blocks: Array<{ type: string; text?: { text: string }; elements?: Array<{ text: string }>; image_url?: string }>;
  };
  const recordedPost = () => mockQuery.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO agent_invoice_audit_posts'));

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(slackAnswer({ ok: true, ts: LEAD_TS }));
    global.fetch = fetchMock as unknown as typeof fetch;
    process.env.S3_BUCKET_NAME = 'finance-agent-test';
    process.env.AUDIT_SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.AUDIT_SLACK_CHANNEL_ID = 'C0AUDIT';
  });

  afterEach(() => {
    delete process.env.AUDIT_SLACK_BOT_TOKEN;
    delete process.env.AUDIT_SLACK_CHANNEL_ID;
  });

  it('posts the week to the audit channel as one top-level message, led by the zero-touch callout, and still posts when the backlog count fails', async () => {
    const entered = [
      { workday_invoice_wid: 'w1', entry_read_at: lastSunday, outcome: 'submitted_clean', entry_diff: [], terminal: false },
      { workday_invoice_wid: 'w2', entry_read_at: lastSunday, outcome: 'submitted_edited', entry_diff: [costCenterChange], terminal: false },
    ];
    routeQueries({ digest: entered, entered });
    (workday.getWorkQueueTagWIDs as jest.Mock).mockRejectedValue(new Error('No work queue tags found'));

    await handler({});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(SLACK_POST_MESSAGE_URL);
    const payload = payloadOf(0);
    expect(payload.channel).toBe('C0AUDIT');
    expect(payload.thread_ts).toBeUndefined();
    expect(payload.blocks[0]).toEqual({ type: 'header', text: { type: 'plain_text', text: '50% of invoices needed 0 touches last week (1 of 2)' } });
    expect(payload.text).toBe('50% of invoices needed 0 touches last week (1 of 2)');
    expect(payload.blocks.some((block) => block.text?.text.startsWith('*Finance agent audit*'))).toBe(true);
  });

  it('in daily mode leads with the touch summary, then posts one message per invoice in its thread', async () => {
    const today = [
      { workday_invoice_wid: 'w1', workday_invoice_number: 'SUPIN-1', entry_read_at: new Date(Date.now() - 60_000), outcome: 'submitted_edited', entry_diff: [costCenterChange], terminal: false },
      { workday_invoice_wid: 'w2', workday_invoice_number: 'SUPIN-2', entry_read_at: new Date(Date.now() - 60_000), outcome: 'submitted_clean', entry_diff: [], terminal: false },
    ];
    const earlier = { workday_invoice_wid: 'w0', entry_read_at: new Date(Date.now() - 3 * 86_400_000), outcome: 'submitted_clean', entry_diff: [], terminal: false };
    routeQueries({ digest: today, entered: [...today, earlier] });

    await handler({ mode: 'daily' });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every(([url]) => url === SLACK_POST_MESSAGE_URL)).toBe(true);
    expect([0, 1, 2].map((call) => payloadOf(call).channel)).toEqual(['C0AUDIT', 'C0AUDIT', 'C0AUDIT']);
    expect([0, 1, 2].map((call) => payloadOf(call).thread_ts)).toEqual([undefined, LEAD_TS, LEAD_TS]);
    const lead = payloadOf(0);
    expect(lead.blocks[0]).toEqual({ type: 'header', text: { type: 'plain_text', text: '50% of invoices needed 0 touches today (1 of 2)' } });
    expect(lead.blocks.some((block) => block.type === 'image' && block.image_url?.startsWith('https://quickchart.io/chart?'))).toBe(true);
    expect(payloadOf(1).text).toContain('Finance agent audit · `SUPIN-1` · submitted with AP edits · 1 touch');
    expect(payloadOf(2).text).toContain('`SUPIN-2` · submitted with no material change · 0 touches');
    expect(workday.getWorkQueueTagWIDs).not.toHaveBeenCalled();
  });

  it('in daily mode includes invoices scored after the previous daily post, then records the new post', async () => {
    const lastPost = new Date(centralDayStart(new Date()).getTime() - 9 * 3_600_000);
    const lateScore = new Date(lastPost.getTime() + 30 * 60_000);
    routeQueries({
      posted: [{ posted_through: lastPost }],
      digest: [{ workday_invoice_wid: 'late', workday_invoice_number: 'SUPIN-LATE', entry_read_at: lateScore, outcome: 'submitted_clean', entry_diff: [], terminal: false }],
    });
    await handler({ mode: 'daily' });
    expect(mockQuery.mock.calls.find(([sql]) => String(sql).includes('label_attribution'))?.[1]).toEqual([lastPost]);
    expect(payloadOf(1).text).toContain('`SUPIN-LATE`');
    const recorded = mockQuery.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO agent_invoice_audit_posts'));
    expect(recorded?.[1]?.[0]).toBe('daily');
  });

  it('in daily mode looks back at most a week after a long gap', async () => {
    routeQueries({ posted: [{ posted_through: new Date('2020-01-01T00:00:00Z') }] });
    await handler({ mode: 'daily' });
    const since = mockQuery.mock.calls.find(([sql]) => String(sql).includes('label_attribution'))?.[1]?.[0] as Date;
    expect(since).toEqual(addCentralDays(centralDayStart(new Date()), -7));
  });

  it('in daily mode posts nothing when no invoice was scored', async () => {
    routeQueries({});
    await handler({ mode: 'daily' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('in daily mode still reports a day when the sandbox refresh removed invoices', async () => {
    routeQueries({
      digest: [{ workday_invoice_wid: 'w1', terminal: true, final_read_at: new Date(Date.now() - 1000), outcome: 'lost_to_refresh', final_status: 'Lost to tenant refresh' }],
    });
    await handler({ mode: 'daily' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(payloadOf(1).blocks[0].elements?.[0].text).toBe('1 removed by the weekly sandbox refresh (not scored).');
    expect(payloadOf(1).thread_ts).toBe(LEAD_TS);
  });

  it('in daily mode stops at the first failed post instead of sending the rest', async () => {
    const today = [
      { workday_invoice_wid: 'w1', workday_invoice_number: 'SUPIN-1', entry_read_at: new Date(Date.now() - 60_000), outcome: 'submitted_clean', entry_diff: [], terminal: false },
      { workday_invoice_wid: 'w2', workday_invoice_number: 'SUPIN-2', entry_read_at: new Date(Date.now() - 60_000), outcome: 'submitted_clean', entry_diff: [], terminal: false },
    ];
    routeQueries({ digest: today, entered: today });
    fetchMock.mockResolvedValueOnce(slackAnswer({ ok: true, ts: LEAD_TS })).mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Server Error', text: async () => '' });
    await expect(handler({ mode: 'daily' })).rejects.toThrow('Daily audit post stopped at message 2 of 3 (HTTP 500)');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recordedPost()).toBeUndefined();
  });

  it('in daily mode sends no invoice messages when the lead has no ts to thread them under', async () => {
    const today = [
      { workday_invoice_wid: 'w1', workday_invoice_number: 'SUPIN-1', entry_read_at: new Date(Date.now() - 60_000), outcome: 'submitted_clean', entry_diff: [], terminal: false },
    ];
    routeQueries({ digest: today, entered: today });
    fetchMock.mockResolvedValueOnce(slackAnswer({ ok: true }));
    await expect(handler({ mode: 'daily' })).rejects.toThrow('Daily audit post stopped at message 1 of 2 (posted without a message ts)');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recordedPost()).toBeUndefined();
  });

  it('still posts when the stored touch rollup cannot refresh, then fails the run so the error is seen', async () => {
    routeQueries({});
    const routed = mockQuery.getMockImplementation()!;
    mockQuery.mockImplementation((sql: string) =>
      (sql.includes('INSERT INTO agent_invoice_touch_daily') ? Promise.reject(new Error('lock timeout')) : routed(sql)));
    (workday.getWorkQueueTagWIDs as jest.Mock).mockResolvedValue([]);
    await expect(handler({})).rejects.toThrow('agent_invoice_touch_daily could not be refreshed: lock timeout');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('says the pre-snapshot count is missing when the Workday query fails', async () => {
    routeQueries({});
    (workday.getWorkQueueTagWIDs as jest.Mock).mockRejectedValue(new Error('Workday down'));
    await handler({});
    const context = payloadOf(0).blocks.find((block) => block.elements)?.elements?.[0].text;
    expect(context).toBe('Before snapshots (outcome only): unavailable this week; Workday query failed.');
  });

  it('treats a weekly digest Slack posted without a usable ts as posted', async () => {
    routeQueries({});
    (workday.getWorkQueueTagWIDs as jest.Mock).mockResolvedValue([]);
    fetchMock.mockResolvedValueOnce(slackAnswer({ ok: true }));
    await expect(handler({})).resolves.not.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails the run when the audit post does not go through', async () => {
    routeQueries({});
    (workday.getWorkQueueTagWIDs as jest.Mock).mockResolvedValue([]);
    fetchMock.mockResolvedValueOnce(slackAnswer({ ok: false, error: 'not_in_channel' }));
    await expect(handler({})).rejects.toThrow('Could not post the weekly audit digest (not_in_channel)');
  });

  it('applies an AP label added after the cancel was scored', async () => {
    routeQueries({
      digest: [{
        workday_invoice_wid: 'w1', terminal: true, final_read_at: lastSunday, outcome: 'canceled',
        cancel_attribution: 'unattributed', cancel_basis: 'early_draft_cancel', label_attribution: 'agent',
      }],
    });
    (workday.getWorkQueueTagWIDs as jest.Mock).mockResolvedValue([]);

    await handler({});

    const payload = payloadOf(0);
    expect(payload.blocks[0]).toEqual({ type: 'header', text: { type: 'plain_text', text: 'AP submitted no agent invoices last week' } });
    const cancels = payload.blocks.find((block) => block.text?.text.startsWith('*Cancels*'))?.text?.text;
    expect(cancels).toContain('*Cancels* · 1 agent, 0 business, 0 unattributed');
    expect(cancels).toContain('AP label: 1');
  });

  it('in a refreshed sandbox, reports invoices the refresh removed apart and skips the pre-snapshot count', async () => {
    process.env.SCORE_TENANT_REFRESH_WEEKDAY = '6';
    routeQueries({
      digest: [
        { workday_invoice_wid: 'w1', terminal: true, final_read_at: lastSunday, outcome: 'lost_to_refresh', final_status: 'Lost to tenant refresh' },
        { workday_invoice_wid: 'w2', terminal: true, entry_read_at: lastSunday, final_read_at: lastSunday, outcome: 'submitted_clean', entry_diff: [], final_status: 'Lost to tenant refresh' },
      ],
    });

    await handler({});

    expect(workday.getWorkQueueTagWIDs).not.toHaveBeenCalled();
    const text = payloadOf(0).blocks.map((block) => block.text?.text ?? '').join('\n');
    expect(text).toContain('• 2 removed by the weekly sandbox refresh (not scored)');
    expect(text).toContain('on 0 of 0 invoices closed last week');
    expect(text).toContain('*Cancels* · 0 agent, 0 business, 0 unattributed');
    delete process.env.SCORE_TENANT_REFRESH_WEEKDAY;
  });

  it('counts pre-snapshot agent invoices by state and skips ones that have a snapshot', async () => {
    routeQueries({ snapshots: [{ workday_invoice_wid: 'has-snapshot' }] });
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
    const context = payloadOf(0).blocks.find((block) => block.elements)?.elements?.[0].text;
    expect(context).toBe('Before snapshots (outcome only): 1 approved, 1 canceled');
  });
});
