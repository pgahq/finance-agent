jest.mock('@pga/logger', () => ({ debug: jest.fn() }));
jest.mock('../lib/workday.js', () => ({
  getWorkQueueTagWIDs: jest.fn(),
  executeWorkdayQuery: jest.fn(),
}));

import type { DatabaseConnection } from '../lib/database.js';
import {
  buildCoverageQuery,
  buildUpsertCoverageDaily,
  centralDayKey,
  classifyCoverage,
  countOutOfScopeInvoices,
  coverageCompanyWids,
  coverageDayParams,
  COVERAGE_BACKFILL_DAYS,
  COVERAGE_ROLLUP_DAYS,
  DEFAULT_COVERAGE_COMPANY_WIDS,
  dailyCoverage,
  loadCoverageRows,
  loadSnapshotSources,
  loadWeeklyCoverage,
  refreshCoverageDaily,
  shiftDayKey,
  summarizeCoverage,
  type CoverageRow,
} from '../lib/invoice_coverage.js';
import { AGENT_WRITE_SOURCES } from '../lib/invoice_snapshots.js';
import { digestWindow } from '../lib/score_digest.js';
import * as workday from '../lib/workday.js';

const PGA = DEFAULT_COVERAGE_COMPANY_WIDS[0];
const SECTION = 'cab0b1d2505a0000000000000000sect';
const config = {} as never;

function row(overrides: Partial<CoverageRow> & { workdayInvoiceWid: string }): CoverageRow {
  return { companyWid: PGA, hasAgentTag: false, isOcr: false, isCanceled: false, day: '2026-10-13', ...overrides };
}

describe('coverage company scope', () => {
  it('defaults to the six PGA Corp companies and can be overridden', () => {
    expect(coverageCompanyWids({})).toEqual(DEFAULT_COVERAGE_COMPANY_WIDS);
    expect(DEFAULT_COVERAGE_COMPANY_WIDS).toHaveLength(6);
    expect(coverageCompanyWids({ COVERAGE_COMPANY_WIDS: ' a, b ,,' })).toEqual(['a', 'b']);
    expect(coverageCompanyWids({ COVERAGE_COMPANY_WIDS: ' , ' })).toEqual(DEFAULT_COVERAGE_COMPANY_WIDS);
  });
});

describe('days', () => {
  it('uses the Central calendar day', () => {
    expect(centralDayKey(new Date('2026-10-13T03:30:00Z'))).toBe('2026-10-12');
    expect(centralDayKey(new Date('2026-10-13T12:25:06Z'))).toBe('2026-10-13');
    expect(centralDayKey(new Date('2026-01-01T05:59:00Z'))).toBe('2025-12-31');
  });

  it('shifts across month and year ends', () => {
    expect(shiftDayKey('2026-10-01', -1)).toBe('2026-09-30');
    expect(shiftDayKey('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('buildCoverageQuery', () => {
  it('pads the createdOn window by a day on each side and filters to the companies', () => {
    const wql = buildCoverageQuery('2026-10-12', '2026-10-18', ['wid-1', "wid'2"]);
    expect(wql).toContain('FROM supplierInvoices (dataSourceFilter = supplierInvoicesFilter)');
    expect(wql).toContain("createdOn >= '2026-10-11' AND createdOn <= '2026-10-19'");
    expect(wql).toContain("company1 in ('wid-1', 'wid''2')");
    for (const field of ['OCRSupplierInvoice', 'workQueueTags', 'isCanceled', 'createdDateTime', 'invoiceCreatedBy']) {
      expect(wql).toContain(field);
    }
    expect(wql).not.toContain('LIMIT');
  });

  it('drops the company filter and the detail fields for the all-company count', () => {
    const wql = buildCoverageQuery('2026-10-12', '2026-10-18');
    expect(wql).not.toContain('company1 in');
    expect(wql).not.toContain('invoiceCreatedBy');
  });

  it('refuses a malformed day', () => {
    expect(() => buildCoverageQuery("2026-10-12' OR 1=1", '2026-10-18', [])).toThrow('Invalid coverage day');
  });
});

describe('classifyCoverage', () => {
  const none = new Map<string, string[]>();

  it('checks company scope, then cancel, then agent support, then how the rest was keyed', () => {
    const rows = [
      row({ workdayInvoiceWid: 'other', companyWid: SECTION, hasAgentTag: true }),
      row({ workdayInvoiceWid: 'no-company', companyWid: undefined }),
      row({ workdayInvoiceWid: 'canceled-agent', isCanceled: true, hasAgentTag: true }),
      row({ workdayInvoiceWid: 'canceled-hand', isCanceled: true, creator: 'Lisa Esposito' }),
      row({ workdayInvoiceWid: 'tag-only', hasAgentTag: true, creator: 'McKyra Jones' }),
      row({ workdayInvoiceWid: 'tag-no-creator', hasAgentTag: true }),
      row({ workdayInvoiceWid: 'ocr', isOcr: true, creator: 'Tristan Miller' }),
      row({ workdayInvoiceWid: 'ocr-no-creator', isOcr: true }),
      row({ workdayInvoiceWid: 'hand', creator: 'Tiffany Mead [C]' }),
      row({ workdayInvoiceWid: 'integration', supplier: 'AMAZON CAPITAL SERVICES INC' }),
    ];
    expect(Object.fromEntries(classifyCoverage(rows, none).map((invoice) => [invoice.workdayInvoiceWid, invoice.category]))).toEqual({
      other: 'out_of_scope',
      'no-company': 'out_of_scope',
      'canceled-agent': 'canceled',
      'canceled-hand': 'canceled',
      'tag-only': 'agent_notes_only',
      'tag-no-creator': 'agent_notes_only',
      ocr: 'uncovered_ocr',
      'ocr-no-creator': 'uncovered_ocr',
      hand: 'uncovered_manual',
      integration: 'automated',
    });
  });

  it('counts a snapshot as agent support even when AP replaced the tag, and tells create from enrich', () => {
    const rows = [
      row({ workdayInvoiceWid: 'created' }),
      row({ workdayInvoiceWid: 'resent' }),
      row({ workdayInvoiceWid: 'enriched' }),
      row({ workdayInvoiceWid: 'both', hasAgentTag: true }),
      row({ workdayInvoiceWid: 'unknown-source' }),
    ];
    const sources = new Map([
      ['created', ['create']],
      ['resent', ['resend_update']],
      ['enriched', ['enrich']],
      ['both', ['create', 'enrich']],
      ['unknown-source', [] as string[]],
    ]);
    expect(classifyCoverage(rows, sources).map((invoice) => invoice.category)).toEqual([
      'agent_created', 'agent_created', 'agent_enriched', 'agent_created', 'agent_created',
    ]);
  });

  it('does not treat an empty creator as agent support', () => {
    expect(classifyCoverage([row({ workdayInvoiceWid: 'a' })], none)[0].category).toBe('automated');
  });
});

describe('loadSnapshotSources', () => {
  it('reads only the agent write sources, so a baseline left by a failed enrich update is not agent support', async () => {
    const query = jest.fn().mockResolvedValue([{ workday_invoice_wid: 'w1', sources: ['enrich'] }, { workday_invoice_wid: 'w2', sources: null }]);
    const sources = await loadSnapshotSources({ query } as unknown as DatabaseConnection, ['w1', 'w2', 'baseline-only']);
    expect(String((query.mock.calls[0] as unknown[])[0])).toContain('source = ANY($2::text[])');
    expect((query.mock.calls[0] as unknown[])[1]).toEqual([['w1', 'w2', 'baseline-only'], [...AGENT_WRITE_SOURCES]]);
    expect(AGENT_WRITE_SOURCES).not.toContain('enrich_baseline');
    expect([...sources.entries()]).toEqual([['w1', ['enrich']], ['w2', []]]);
    const baselineOnly = classifyCoverage([row({ workdayInvoiceWid: 'baseline-only', isOcr: true })], sources);
    expect(baselineOnly[0].category).toBe('uncovered_ocr');
  });

  it('does not query without invoices', async () => {
    const query = jest.fn();
    await expect(loadSnapshotSources({ query } as unknown as DatabaseConnection, [])).resolves.toEqual(new Map());
    expect(query).not.toHaveBeenCalled();
  });
});

describe('summarizeCoverage', () => {
  function invoices() {
    const rows: CoverageRow[] = [
      ...Array.from({ length: 3 }, (_, index) => row({ workdayInvoiceWid: `agent-${index}`, hasAgentTag: true, creator: 'McKyra Jones' })),
      row({ workdayInvoiceWid: 'enriched' }),
      ...Array.from({ length: 4 }, (_, index) => row({ workdayInvoiceWid: `tiffany-${index}`, creator: 'Tiffany Mead [C]', supplier: `Payee ${index}`, workdayInvoiceNumber: `SUPIN-T${index}` })),
      row({ workdayInvoiceWid: 'mckyra-hand', creator: 'McKyra Jones', supplier: 'UPS', workdayInvoiceNumber: 'SUPIN-M' }),
      row({ workdayInvoiceWid: 'ups-2', creator: 'Lauren Schilling', supplier: 'UPS', workdayInvoiceNumber: 'SUPIN-U' }),
      row({ workdayInvoiceWid: 'amazon-1', supplier: 'Amazon', workdayInvoiceNumber: 'SUPIN-A1' }),
      row({ workdayInvoiceWid: 'amazon-2', supplier: 'Amazon', workdayInvoiceNumber: 'SUPIN-A2' }),
      row({ workdayInvoiceWid: 'canceled', isCanceled: true }),
      row({ workdayInvoiceWid: 'section', companyWid: SECTION }),
    ];
    return classifyCoverage(rows, new Map([['enriched', ['enrich']]]));
  }

  it('leaves automated, canceled, and out-of-scope invoices out of the share', () => {
    const { totals } = summarizeCoverage(invoices());
    expect(totals.counts).toMatchObject({
      agent_created: 0,
      agent_enriched: 1,
      agent_notes_only: 3,
      uncovered_manual: 6,
      automated: 2,
      canceled: 1,
      out_of_scope: 1,
    });
    expect(totals.supported).toBe(4);
    expect(totals.invoices).toBe(10);
    expect(totals.share).toBe(0.4);
  });

  it('has no share for an empty period or one with only automated invoices', () => {
    expect(summarizeCoverage([]).totals).toMatchObject({ invoices: 0 });
    expect(summarizeCoverage([]).totals.share).toBeUndefined();
    const onlyAutomated = summarizeCoverage(classifyCoverage([row({ workdayInvoiceWid: 'xml', supplier: 'Amazon' })], new Map()));
    expect(onlyAutomated.totals).toMatchObject({ invoices: 0, counts: expect.objectContaining({ automated: 1 }) });
    expect(onlyAutomated.totals.share).toBeUndefined();
    expect(onlyAutomated.automatedSuppliers).toEqual([{ name: 'Amazon', count: 1 }]);
  });

  it('includes the previous period for comparison', () => {
    const summary = summarizeCoverage(invoices(), classifyCoverage([row({ workdayInvoiceWid: 'p1', hasAgentTag: true }), row({ workdayInvoiceWid: 'p2', creator: 'Someone' })], new Map()));
    expect(summary.previous?.share).toBe(0.5);
    expect(summarizeCoverage(invoices()).previous).toBeUndefined();
  });

  it('ranks uncovered suppliers apart from automated ones, and the people keying by hand, with their agent counts', () => {
    const summary = summarizeCoverage(invoices());
    expect(summary.topSuppliers.slice(0, 2)).toEqual([{ name: 'UPS', count: 2 }, { name: 'Payee 0', count: 1 }]);
    expect(summary.topSuppliers.map((supplier) => supplier.name)).not.toContain('Amazon');
    expect(summary.automatedSuppliers).toEqual([{ name: 'Amazon', count: 2 }]);
    expect(summary.creators).toEqual([
      { name: 'Tiffany Mead [C]', agent: 0, byHand: 4 },
      { name: 'Lauren Schilling', agent: 0, byHand: 1 },
      { name: 'McKyra Jones', agent: 3, byHand: 1 },
    ]);
    expect(summarizeCoverage(invoices(), undefined, { top: 1 }).creators).toHaveLength(1);
  });

  it('spreads the invoice links across creators instead of filling them with one batch, and skips automated invoices', () => {
    const { links } = summarizeCoverage(invoices(), undefined, { links: 4 });
    expect(links).toHaveLength(4);
    expect(links.map((link) => link.creator)).toEqual(['Tiffany Mead [C]', 'McKyra Jones', 'Lauren Schilling', 'Tiffany Mead [C]']);
    expect(links[0]).toMatchObject({ workdayInvoiceNumber: 'SUPIN-T0', supplier: 'Payee 0', category: 'uncovered_manual' });
    const all = summarizeCoverage(invoices(), undefined, { links: 100 }).links;
    expect(all).toHaveLength(6);
    expect(all.some((link) => link.category === 'automated')).toBe(false);
  });
});

describe('loadCoverageRows', () => {
  const query = workday.executeWorkdayQuery as jest.Mock;
  const tagWids = workday.getWorkQueueTagWIDs as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    tagWids.mockResolvedValue(['tag-wid']);
  });

  it('reads the tag, requires a complete page, and places each invoice on its Central day', async () => {
    query.mockResolvedValue({
      total: 6,
      data: [
        {
          workdayID: 'a', invoiceNumber: 'SUPIN-1', createdOn: '2026-10-12', createdDateTime: '2026-10-13T03:30:00.000Z',
          company1: { id: PGA, descriptor: 'PGA' }, supplier: { descriptor: 'UPS', id: 's1' },
          invoiceCreatedBy: { descriptor: 'McKyra Jones', id: 'w1' }, isCanceled: false,
          workQueueTags: [{ descriptor: 'Finance Agent Modified', id: 'tag-wid' }],
        },
        { workdayID: 'b', createdOn: '2026-10-14', company1: { id: PGA }, OCRSupplierInvoice: { descriptor: 'OCR', id: 'o1' }, workQueueTags: [{ id: 'other-tag' }], isCanceled: true },
        { workdayID: 'a', createdOn: '2026-10-12', company1: { id: PGA } },
        { workdayID: 'late', createdOn: '2026-10-19', createdDateTime: '2026-10-19T15:00:00Z', company1: { id: PGA } },
        { workdayID: 'no-date', company1: { id: PGA } },
        { invoiceNumber: 'no-wid' },
      ],
    });

    const rows = await loadCoverageRows({ workdayConfig: config }, '2026-10-12', '2026-10-18');

    expect(tagWids).toHaveBeenCalledWith({ workdayConfig: config }, ['FINAGENT-invoice-modified']);
    expect(query).toHaveBeenCalledWith(config, expect.stringContaining('company1 in ('), { requireCompleteTotal: true });
    expect(rows).toEqual([
      {
        workdayInvoiceWid: 'a', workdayInvoiceNumber: 'SUPIN-1', companyWid: PGA, supplier: 'UPS', creator: 'McKyra Jones',
        hasAgentTag: true, isOcr: false, isCanceled: false, day: '2026-10-12',
      },
      { workdayInvoiceWid: 'b', companyWid: PGA, hasAgentTag: false, isOcr: true, isCanceled: true, day: '2026-10-14' },
    ]);
  });

  it('propagates a Workday failure instead of reporting a partial count', async () => {
    query.mockRejectedValue(new Error('Workday query incomplete: expected 261 rows, got 100'));
    await expect(loadCoverageRows({ workdayConfig: config }, '2026-10-12', '2026-10-18')).rejects.toThrow('incomplete');
    tagWids.mockRejectedValue(new Error('No work queue tags found'));
    await expect(loadCoverageRows({ workdayConfig: config }, '2026-10-12', '2026-10-18')).rejects.toThrow('No work queue tags found');
  });

  it('counts the invoices created for other companies in the window', async () => {
    query.mockResolvedValue({
      data: [
        { workdayID: 'in', company1: { id: PGA }, createdOn: '2026-10-13' },
        { workdayID: 'sec-1', company1: { id: SECTION }, createdOn: '2026-10-13' },
        { workdayID: 'sec-2', company1: { id: SECTION }, createdOn: '2026-10-14', createdDateTime: '2026-10-14T15:00:00Z' },
        { workdayID: 'sec-out', company1: { id: SECTION }, createdOn: '2026-10-25' },
      ],
    });
    await expect(countOutOfScopeInvoices({ workdayConfig: config }, '2026-10-12', '2026-10-18')).resolves.toBe(2);
    expect(String((query.mock.calls[0] as unknown[])[1])).not.toContain('company1 in');
  });
});

describe('loadWeeklyCoverage', () => {
  const query = workday.executeWorkdayQuery as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    (workday.getWorkQueueTagWIDs as jest.Mock).mockResolvedValue(['tag-wid']);
  });

  it('compares the week with the week before from one query, and adds the invoices left out', async () => {
    const window = digestWindow(new Date('2026-10-19T17:00:00Z'));
    const record = (id: string, createdOn: string, extra: Record<string, unknown> = {}) =>
      ({ workdayID: id, createdOn, company1: { id: PGA }, invoiceCreatedBy: { descriptor: 'Someone' }, ...extra });
    query.mockImplementation((_config: unknown, wql: string) => Promise.resolve(wql.includes('company1 in (')
      ? { data: [
        record('now-agent', '2026-10-13', { workQueueTags: [{ id: 'tag-wid' }] }),
        record('now-hand', '2026-10-14'),
        record('before-hand', '2026-10-07'),
        record('before-hand-2', '2026-10-08'),
      ] }
      : { data: [{ workdayID: 'sec', company1: { id: SECTION }, createdOn: '2026-10-15' }] }));
    const db = { query: jest.fn().mockResolvedValue([]) } as unknown as DatabaseConnection;

    const summary = await loadWeeklyCoverage({ workdayConfig: config, dbConnection: db }, window);

    expect(summary.totals.share).toBe(0.5);
    expect(summary.previous?.share).toBe(0);
    expect(summary.outOfScope).toBe(1);
    const coverageCalls = query.mock.calls.filter(([, wql]) => String(wql).includes('company1 in ('));
    expect(coverageCalls).toHaveLength(1);
    expect(String((coverageCalls[0] as unknown[])[1])).toContain("createdOn >= '2026-10-04' AND createdOn <= '2026-10-19'");
  });

  it('still reports coverage when the all-company count fails', async () => {
    const window = digestWindow(new Date('2026-10-19T17:00:00Z'));
    query.mockImplementation((_config: unknown, wql: string) =>
      (wql.includes('company1 in (') ? Promise.resolve({ data: [] }) : Promise.reject(new Error('timeout'))));
    const db = { query: jest.fn().mockResolvedValue([]) } as unknown as DatabaseConnection;
    const summary = await loadWeeklyCoverage({ workdayConfig: config, dbConnection: db }, window);
    expect(summary.outOfScope).toBeUndefined();
    expect(summary.totals.invoices).toBe(0);
  });
});

describe('dailyCoverage and the rollup SQL', () => {
  const classified = classifyCoverage([
    row({ workdayInvoiceWid: 'a', day: '2026-10-12', hasAgentTag: true }),
    row({ workdayInvoiceWid: 'b', day: '2026-10-12', creator: 'X' }),
    row({ workdayInvoiceWid: 'c', day: '2026-10-14', isCanceled: true }),
    row({ workdayInvoiceWid: 'd', day: '2026-10-20' }),
  ], new Map());

  it('has one entry per day, with empty days kept and invoices outside the range ignored', () => {
    const days = dailyCoverage(classified, '2026-10-12', '2026-10-14');
    expect(days.map((day) => day.day)).toEqual(['2026-10-12', '2026-10-13', '2026-10-14']);
    expect(days[0].totals.share).toBe(0.5);
    expect(days[1].totals.invoices).toBe(0);
    expect(days[1].totals.share).toBeUndefined();
    expect(days[2].totals.counts.canceled).toBe(1);
    expect(days[2].totals.invoices).toBe(0);
  });

  it('upserts every day in one statement with a placeholder per value', () => {
    const days = dailyCoverage(classified, '2026-10-12', '2026-10-13');
    const params = coverageDayParams(days);
    expect(params).toHaveLength(20);
    expect(params.slice(0, 10)).toEqual(['2026-10-12', 2, 0, 0, 1, 0, 1, 0, 0, 0.5]);
    expect(params.slice(10)).toEqual(['2026-10-13', 0, 0, 0, 0, 0, 0, 0, 0, null]);
    const sql = buildUpsertCoverageDaily(2);
    expect(sql).toContain('INSERT INTO agent_invoice_coverage_daily');
    expect(sql).toContain('automated = EXCLUDED.automated');
    expect(sql).toContain('$20, CURRENT_TIMESTAMP)');
    expect(sql).toContain('ON CONFLICT (created_day) DO UPDATE SET');
    expect(sql).toContain('coverage_share = EXCLUDED.coverage_share');
    expect(sql).not.toContain('$21');
    expect(sql).not.toContain('uncovered_integration');
  });
});

describe('refreshCoverageDaily', () => {
  const query = workday.executeWorkdayQuery as jest.Mock;
  const now = new Date('2026-10-19T17:00:00Z');

  function setup(stored: number) {
    jest.clearAllMocks();
    (workday.getWorkQueueTagWIDs as jest.Mock).mockResolvedValue(['tag-wid']);
    query.mockResolvedValue({ data: [
      { workdayID: 'a', createdOn: '2026-10-19', company1: { id: PGA }, workQueueTags: [{ id: 'tag-wid' }] },
    ] });
    const dbQuery = jest.fn((sql: string) => Promise.resolve(sql.includes('AS stored') ? [{ stored }] : []));
    return { dbQuery, context: { workdayConfig: config, dbConnection: { query: dbQuery } as unknown as DatabaseConnection } };
  }

  it('recomputes the recent days when some are stored', async () => {
    const { context, dbQuery } = setup(20);
    await expect(refreshCoverageDaily(context, now)).resolves.toBe(COVERAGE_ROLLUP_DAYS);
    const upsert = dbQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO agent_invoice_coverage_daily'));
    const params = (upsert as unknown as [string, unknown[]])[1];
    expect(params[0]).toBe('2026-10-05');
    expect(params[params.length - 10]).toBe('2026-10-19');
    expect(params.slice(-10)).toEqual(['2026-10-19', 1, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(String((query.mock.calls[0] as unknown[])[1])).toContain("createdOn >= '2026-10-04'");
  });

  it('backfills the long span on request even when days are stored', async () => {
    const { context, dbQuery } = setup(20);
    await expect(refreshCoverageDaily(context, now, { backfill: true })).resolves.toBe(COVERAGE_BACKFILL_DAYS);
    expect(dbQuery.mock.calls.some(([sql]) => sql.includes('INSERT INTO agent_invoice_coverage_daily'))).toBe(true);
  });

  it('backfills on the first run', async () => {
    const { context, dbQuery } = setup(0);
    await expect(refreshCoverageDaily(context, now)).resolves.toBe(COVERAGE_BACKFILL_DAYS);
    const upsert = dbQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO agent_invoice_coverage_daily'));
    expect((upsert as unknown as [string, unknown[]])[1][0]).toBe(shiftDayKey('2026-10-19', -(COVERAGE_BACKFILL_DAYS - 1)));
  });

  it('writes nothing when Workday cannot be read', async () => {
    const { context, dbQuery } = setup(20);
    query.mockRejectedValue(new Error('Workday down'));
    await expect(refreshCoverageDaily(context, now)).rejects.toThrow('Workday down');
    expect(dbQuery.mock.calls.some(([sql]) => sql.includes('INSERT INTO'))).toBe(false);
  });
});
