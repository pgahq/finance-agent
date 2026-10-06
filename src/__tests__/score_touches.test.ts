import type { ScoredChange } from '../lib/invoice_score.js';
import type { InvoiceScore } from '../lib/invoice_scores.js';
import {
  countsForTouches,
  dailyTouchTrend,
  touchBucketIndex,
  touchCalloutBlocks,
  touchChartUrl,
  touchCount,
  touchPeriod,
  weeklyTouchTrend,
} from '../lib/score_touches.js';

const change = (agentOwned = true): ScoredChange => ({ field: 'line.costCenter', line: 0, before: 'a', after: 'b', category: 'material', agentOwned });
const changes = (count: number) => Array.from({ length: count }, () => change());

function entered(touches: number, at: Date, overrides: Partial<InvoiceScore> = {}): InvoiceScore {
  return {
    workdayInvoiceWid: `w-${Math.random()}`,
    terminal: false,
    entryReadAt: at,
    outcome: touches ? 'submitted_edited' : 'submitted_clean',
    entryDiff: changes(touches),
    ...overrides,
  };
}

const now = new Date('2026-10-06T14:20:00Z');
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);

describe('touch buckets', () => {
  it('buckets touches into 0, 1–3, 4–10, 11–20, and 21+', () => {
    expect([0, 1, 3, 4, 10, 11, 20, 21, 99].map(touchBucketIndex)).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it('counts agent-owned changes before and after submit, not OCR fixes the agent left alone', () => {
    expect(touchCount({ workdayInvoiceWid: 'w', terminal: true, entryDiff: [change(), change(false)], lateDiff: [change()] })).toBe(2);
  });

  it('only buckets invoices AP submitted', () => {
    expect(countsForTouches(entered(0, now))).toBe(true);
    expect(countsForTouches(entered(0, now, { outcome: 'denied' }))).toBe(true);
    expect(countsForTouches({ workdayInvoiceWid: 'w', terminal: true, outcome: 'canceled' })).toBe(false);
    expect(countsForTouches({ workdayInvoiceWid: 'w', terminal: false, outcome: 'stuck_draft' })).toBe(false);
  });
});

describe('touch periods and trends', () => {
  const scores = [
    entered(0, hoursAgo(2)),
    entered(0, hoursAgo(3)),
    entered(2, hoursAgo(4)),
    entered(12, hoursAgo(5)),
    entered(0, hoursAgo(30)),
    entered(5, hoursAgo(31)),
    entered(0, hoursAgo(24 * 9)),
    { workdayInvoiceWid: 'c', terminal: true, entryReadAt: hoursAgo(1), outcome: 'canceled' } as InvoiceScore,
  ];

  it('counts each bucket for invoices AP entered in the period', () => {
    expect(touchPeriod(scores, 'today', hoursAgo(24), now)).toEqual(expect.objectContaining({ counts: [2, 1, 0, 1, 0], total: 4 }));
  });

  it('builds 14 daily periods and 8 weekly periods, oldest first', () => {
    const daily = dailyTouchTrend(scores, now);
    expect(daily).toHaveLength(14);
    expect(daily[13]).toEqual(expect.objectContaining({ label: 'Oct 6', total: 4 }));
    expect(daily[12]).toEqual(expect.objectContaining({ label: 'Oct 5', counts: [1, 0, 1, 0, 0] }));
    const weekly = weeklyTouchTrend(scores, now);
    expect(weekly).toHaveLength(8);
    expect(weekly[7]).toEqual(expect.objectContaining({ label: 'Sep 29', total: 6 }));
    expect(weekly[6].total).toBe(1);
  });
});

describe('touchCalloutBlocks', () => {
  const trend = [
    { label: 'Oct 4', start: hoursAgo(72), end: hoursAgo(48), counts: [0, 0, 0, 0, 0], total: 0 },
    { label: 'Oct 5', start: hoursAgo(48), end: hoursAgo(24), counts: [1, 1, 0, 0, 0], total: 2 },
    { label: 'Oct 6', start: hoursAgo(24), end: now, counts: [3, 1, 0, 0, 0], total: 4 },
  ];

  it('leads with the zero-touch share as a header and compares it with the previous period', () => {
    const blocks = touchCalloutBlocks({ periodName: 'today', previousName: 'yesterday', current: trend[2], previous: trend[1], trend });
    expect(blocks[0]).toEqual({ type: 'header', text: { type: 'plain_text', text: '75% of invoices needed 0 touches today (3 of 4)' } });
    const breakdown = blocks[1].type === 'section' ? blocks[1].text.text : '';
    expect(breakdown).toContain('*▲ 25 pts better* than yesterday (50% of 2)');
    expect(breakdown).toContain('0 touches  ███████████████░░░░░    3   75%');
    expect(breakdown).toContain('21+        ░░░░░░░░░░░░░░░░░░░░    0    0%');
    const sparks = blocks[2].type === 'section' ? blocks[2].text.text : '';
    expect(sparks).toContain('*Trend* · share of invoices per bucket, Oct 4 → Oct 6 (blank = none, · = no invoices)');
    expect(sparks).toContain('0 touches  ·▄▆');
    expect(sparks).toContain('4–10       ·  ');
    expect(blocks[3]).toEqual(expect.objectContaining({ type: 'image', alt_text: 'Trend of invoices by touches required' }));
    expect(blocks[blocks.length - 1]).toEqual({ type: 'divider' });
  });

  it('says when the zero-touch share got worse and when there is nothing to compare', () => {
    const worse = touchCalloutBlocks({ periodName: 'today', previousName: 'yesterday', current: trend[1], previous: trend[2], trend: [trend[1]] });
    expect(worse[1].type === 'section' && worse[1].text.text).toContain('*▼ 25 pts worse* than yesterday');
    expect(worse.some((block) => block.type === 'image')).toBe(false);
    const first = touchCalloutBlocks({ periodName: 'this week', previousName: 'last week', current: trend[2], previous: trend[0], trend });
    expect(first[1].type === 'section' && first[1].text.text).toContain('No invoices reached AP last week to compare with.');
  });

  it('says so when no invoice reached AP', () => {
    expect(touchCalloutBlocks({ periodName: 'this week', previousName: 'last week', current: trend[0], previous: trend[0], trend }))
      .toEqual([{ type: 'header', text: { type: 'plain_text', text: 'No agent invoices reached AP this week' } }]);
  });
});

describe('touchChartUrl', () => {
  const trend = Array.from({ length: 14 }, (_, index) => ({
    label: `Oct ${index + 1}`, start: now, end: now, counts: [index, 1, 1, 0, 0], total: index + 2,
  }));

  it('builds a short QuickChart line chart URL with only percentages and labels', () => {
    const url = touchChartUrl(trend, 'Share', {});
    expect(url).toMatch(/^https:\/\/quickchart\.io\/chart\?w=700&h=320&bkg=white&c=/);
    expect(url!.length).toBeLessThanOrEqual(3000);
    const config = decodeURIComponent(url!.split('&c=')[1]);
    expect(config).toContain('"label":"0 touches"');
    expect(config).toContain('(v) => v + "%"');
  });

  it('can be turned off or pointed at another renderer', () => {
    expect(touchChartUrl(trend, 'Share', { SCORE_CHART_BASE_URL: 'none' })).toBeUndefined();
    expect(touchChartUrl(trend, 'Share', { SCORE_CHART_BASE_URL: 'https://charts.example/render' })).toMatch(/^https:\/\/charts\.example\/render\?/);
  });
});
