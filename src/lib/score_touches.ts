import type { ScoredChange } from './invoice_score.js';
import type { InvoiceScore } from './invoice_scores.js';
import type { SlackBlock } from './slack.js';

const DAY_MS = 86_400_000;

export interface TouchBucket {
  label: string;
  min: number;
  max: number;
}

/** Fields AP had to change on an invoice the agent wrote. Zero touches is the goal. */
export const TOUCH_BUCKETS: readonly TouchBucket[] = [
  { label: '0 touches', min: 0, max: 0 },
  { label: '1–3', min: 1, max: 3 },
  { label: '4–10', min: 4, max: 10 },
  { label: '11–20', min: 11, max: 20 },
  { label: '21+', min: 21, max: Number.POSITIVE_INFINITY },
];

const BUCKET_COLORS = ['#1b9e4b', '#9ccc65', '#ffb300', '#f4511e', '#b71c1c'];

function agentOwned(changes: ScoredChange[] | undefined): ScoredChange[] {
  return (changes ?? []).filter((change) => change.agentOwned !== false);
}

/** Every agent-owned field AP changed, before submit and after. OCR values the agent left alone do not count. */
export function touchCount(score: InvoiceScore): number {
  return agentOwned(score.entryDiff).length + agentOwned(score.lateDiff).length;
}

/** Only invoices AP actually submitted are bucketed; cancels and stuck Drafts are reported on their own. */
export function countsForTouches(score: InvoiceScore): boolean {
  return Boolean(score.entryReadAt) && (score.outcome === 'submitted_clean' || score.outcome === 'submitted_edited' || score.outcome === 'denied');
}

export function touchBucketIndex(touches: number): number {
  return TOUCH_BUCKETS.findIndex((bucket) => touches >= bucket.min && touches <= bucket.max);
}

export interface TouchPeriod {
  label: string;
  start: Date;
  end: Date;
  counts: number[];
  total: number;
}

export function touchPeriod(scores: InvoiceScore[], label: string, start: Date, end: Date): TouchPeriod {
  const counts = TOUCH_BUCKETS.map(() => 0);
  for (const score of scores) {
    if (!countsForTouches(score)) continue;
    const at = score.entryReadAt!.getTime();
    if (at < start.getTime() || at >= end.getTime()) continue;
    counts[touchBucketIndex(touchCount(score))] += 1;
  }
  return { label, start, end, counts, total: counts.reduce((sum, count) => sum + count, 0) };
}

const CENTRAL_TIME_ZONE = 'America/Chicago';

const centralParts = new Intl.DateTimeFormat('en-US', {
  timeZone: CENTRAL_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Central wall-clock time minus UTC at `at`, in milliseconds (negative). */
function centralOffsetMs(at: Date): number {
  const parts: Record<string, number> = {};
  for (const part of centralParts.formatToParts(at)) parts[part.type] = Number(part.value);
  const wallClock = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wallClock - Math.floor(at.getTime() / 1000) * 1000;
}

/** Midnight Central Time starting the Central calendar day that contains `at`. */
export function centralDayStart(at: Date): Date {
  const wallClock = new Date(at.getTime() + centralOffsetMs(at));
  const midnight = Date.UTC(wallClock.getUTCFullYear(), wallClock.getUTCMonth(), wallClock.getUTCDate());
  return new Date(midnight - centralOffsetMs(new Date(midnight - centralOffsetMs(at))));
}

/** The Central day start `days` calendar days from `dayStart`, across DST changes. */
export function addCentralDays(dayStart: Date, days: number): Date {
  return centralDayStart(new Date(dayStart.getTime() + days * DAY_MS + DAY_MS / 2));
}

/** Monday midnight Central starting the week that contains `at`, like Postgres `date_trunc('week', ...)`. */
export function centralWeekStart(at: Date): Date {
  const day = centralDayStart(at);
  const weekday = new Date(day.getTime() + centralOffsetMs(day)).getUTCDay();
  return addCentralDays(day, -((weekday + 6) % 7));
}

function chicagoLabel(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: CENTRAL_TIME_ZONE });
}

/** Central calendar days ending with the day that contains `now`, oldest first. */
export function dailyTouchTrend(scores: InvoiceScore[], now: Date, days = 14): TouchPeriod[] {
  const today = centralDayStart(now);
  return Array.from({ length: days }, (_, index) => {
    const start = addCentralDays(today, index - (days - 1));
    return touchPeriod(scores, chicagoLabel(start), start, addCentralDays(start, 1));
  });
}

/** Complete Monday-to-Sunday Central weeks before the week that contains `now`, oldest first, labeled by their Monday. */
export function weeklyTouchTrend(scores: InvoiceScore[], now: Date, weeks = 8): TouchPeriod[] {
  const thisWeek = centralWeekStart(now);
  return Array.from({ length: weeks }, (_, index) => {
    const start = addCentralDays(thisWeek, (index - weeks) * 7);
    return touchPeriod(scores, chicagoLabel(start), start, addCentralDays(start, 7));
  });
}

const share = (count: number, total: number) => (total ? count / total : 0);
const percent = (rate: number) => `${Math.round(rate * 100)}%`;

function bar(rate: number, width = 20): string {
  const filled = Math.round(rate * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

const SPARK = '▁▂▃▄▅▆▇█';

function sparkline(trend: TouchPeriod[], bucket: number): string {
  return trend.map((period) => {
    if (!period.total) return '·';
    const rate = share(period.counts[bucket], period.total);
    if (rate === 0) return ' ';
    return SPARK[Math.min(SPARK.length - 1, Math.max(0, Math.ceil(rate * SPARK.length) - 1))];
  }).join('');
}

/** Chart image URL (QuickChart by default); Slack fetches it, and it carries only bucket percentages and date labels. */
export function touchChartUrl(trend: TouchPeriod[], title: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const base = (env.SCORE_CHART_BASE_URL ?? 'https://quickchart.io/chart').trim();
  if (!base || base === 'none' || !trend.some((period) => period.total)) return undefined;
  let baseUrl: URL;
  try {
    baseUrl = new URL(base);
  } catch {
    return undefined;
  }
  if (baseUrl.protocol !== 'https:' || baseUrl.search || baseUrl.hash) return undefined;
  const config = {
    type: 'line',
    data: {
      labels: trend.map((period) => period.label),
      datasets: TOUCH_BUCKETS.map((bucket, index) => ({
        label: bucket.label,
        data: trend.map((period) => (period.total ? Math.round(share(period.counts[index], period.total) * 100) : null)),
        borderColor: BUCKET_COLORS[index],
        backgroundColor: BUCKET_COLORS[index],
        borderWidth: index === 0 ? 4 : 2,
        fill: false,
        spanGaps: true,
      })),
    },
    options: {
      title: { display: true, text: title },
      scales: { yAxes: [{ ticks: { min: 0, max: 100, callback: '__PERCENT__' } }] },
    },
  };
  const json = JSON.stringify(config).replace('"__PERCENT__"', '(v) => v + "%"');
  const url = `${base}?w=700&h=320&bkg=white&c=${encodeURIComponent(json)}`;
  return url.length <= 3000 ? url : undefined;
}

export interface TouchCallout {
  /** `today` or `this week`. */
  periodName: string;
  /** `yesterday` or `last week`. */
  previousName: string;
  current: TouchPeriod;
  previous: TouchPeriod;
  trend: TouchPeriod[];
}

/** The lead of a daily or weekly audit post: share of zero-touch invoices, the bucket breakdown, and the trend. */
export function touchCalloutBlocks(callout: TouchCallout): SlackBlock[] {
  const { current, previous, trend, periodName, previousName } = callout;
  if (!current.total) {
    return [
      { type: 'header', text: { type: 'plain_text', text: `AP submitted no agent invoices ${periodName}` } },
    ];
  }

  const zeroShare = share(current.counts[0], current.total);
  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${percent(zeroShare)} of invoices needed 0 touches ${periodName} (${current.counts[0]} of ${current.total})` },
    },
  ];

  const comparison = previous.total
    ? (() => {
      const delta = Math.round((zeroShare - share(previous.counts[0], previous.total)) * 100);
      const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '■';
      const verdict = delta > 0 ? 'better' : delta < 0 ? 'worse' : 'no change';
      return `*${arrow} ${Math.abs(delta)} pts ${verdict}* than ${previousName} (${percent(share(previous.counts[0], previous.total))} of ${previous.total})`;
    })()
    : `AP submitted no agent invoices ${previousName} to compare with.`;

  const labelWidth = Math.max(...TOUCH_BUCKETS.map((bucket) => bucket.label.length));
  const breakdown = TOUCH_BUCKETS.map((bucket, index) => {
    const rate = share(current.counts[index], current.total);
    return `${bucket.label.padEnd(labelWidth)}  ${bar(rate)}  ${String(current.counts[index]).padStart(3)}  ${percent(rate).padStart(4)}`;
  });
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `${comparison}\n\`\`\`${breakdown.join('\n')}\`\`\`` } });

  const withData = trend.filter((period) => period.total);
  if (withData.length > 1) {
    const sparks = TOUCH_BUCKETS.map((bucket, index) => `${bucket.label.padEnd(labelWidth)}  ${sparkline(trend, index)}`);
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Trend* · share of invoices per bucket, ${trend[0].label} → ${trend[trend.length - 1].label} (blank = none, · = no invoices)\n\`\`\`${sparks.join('\n')}\`\`\``,
      },
    });
    const url = touchChartUrl(trend, 'Share of invoices by touches required (higher green is better)');
    if (url) blocks.push({ type: 'image', image_url: url, alt_text: 'Trend of invoices by touches required' });
  }

  blocks.push({ type: 'divider' });
  return blocks;
}
