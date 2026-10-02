jest.mock('@pga/lambda-env', () => ({ __esModule: true, default: jest.fn().mockImplementation(async () => process.env) }));
jest.mock('@pga/logger', () => ({ debug: jest.fn() }));
jest.mock('../lib/database.js', () => ({
  getDatabaseConnection: jest.fn().mockResolvedValue({ query: jest.fn().mockResolvedValue([]), close: jest.fn() }),
}));
jest.mock('../lib/slack.js', () => ({ notifyResult: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../lib/intercom.js', () => ({
  getIntercomConfig: jest.fn().mockReturnValue({ accessToken: 't', apiBaseUrl: 'https://api.intercom.io' }),
  fetchConversationMessages: jest.fn().mockResolvedValue([]),
}));
jest.mock('../lib/workday.js', () => ({
  getWorkdayConfig: jest.fn().mockReturnValue({}),
  executeWorkdayQuery: jest.fn(),
  getSupplierInvoice: jest.fn(),
  getSupplierInvoiceEditability: jest.fn(),
}));
jest.mock('../lib/invoice_scores.js', () => ({
  ...jest.requireActual('../lib/invoice_scores.js'),
  getInvoiceScore: jest.fn(),
  upsertInvoiceScore: jest.fn(),
  listPendingScoreInvoices: jest.fn(),
  getCancelLabel: jest.fn(),
  countAgentInvoicesInConversation: jest.fn(),
  findOtherAgentInvoicesWithSameNumber: jest.fn(),
  isAgentWrittenInvoice: jest.fn(),
}));
jest.mock('../lib/invoice_snapshots.js', () => ({
  ...jest.requireActual('../lib/invoice_snapshots.js'),
  getAgentInvoiceSnapshots: jest.fn(),
}));
const mockLambdaSend = jest.fn().mockResolvedValue({});
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({ send: (...args: unknown[]) => mockLambdaSend(...args) })),
  InvokeCommand: jest.fn().mockImplementation((input) => input),
}));

import type { ProcessingContext } from '../lib/handlers.js';
import * as scores from '../lib/invoice_scores.js';
import * as snapshots from '../lib/invoice_snapshots.js';
import type { AgentInvoiceSnapshot, ScoredFields } from '../lib/invoice_snapshots.js';
import * as intercom from '../lib/intercom.js';
import * as workday from '../lib/workday.js';
import { handler, needsScoring, selectInvoicesToScore } from '../score_invoices.js';
import { scoreInvoice } from '../score_invoices_processor.js';

const ref = (type: string, value: string) => ({ ID: [{ $attributes: { type }, $value: value }] });
const wid = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const now = new Date('2026-10-10T12:00:00Z');
const context = { dbConnection: { query: jest.fn(), close: jest.fn() }, workdayConfig: {} } as unknown as ProcessingContext;

function invoice(overrides: { supplier?: string; costCenter?: string; memo?: string; amount?: string } = {}) {
  return {
    Invoice_Number: 'SUPIN-1',
    Supplier_Reference: { ID: [{ $attributes: { type: 'WID' }, $value: 'sup-wid' }, { $attributes: { type: 'Supplier_ID' }, $value: overrides.supplier ?? 'S-1' }] },
    Suppliers_Invoice_Number: 'INV-1',
    Control_Amount_Total: overrides.amount ?? '100',
    Memo: overrides.memo ?? 'AC 1. Services',
    Invoice_Line_Replacement_Data: [{
      Line_Order: '1',
      Extended_Amount: overrides.amount ?? '100',
      Worktags_Reference: [ref('Cost_Center_Reference_ID', overrides.costCenter ?? 'CC1')],
    }],
  };
}

const fieldsOf = (raw: unknown): ScoredFields => snapshots.extractScoredFields(raw);

function snapshot(overrides: Partial<AgentInvoiceSnapshot> = {}): AgentInvoiceSnapshot {
  return {
    workdayInvoiceWid: wid,
    writeSeq: 1,
    source: 'create',
    workdayInvoiceNumber: 'SUPIN-1',
    fields: fieldsOf(invoice()),
    conversationId: 'conv-1',
    attachmentKinds: ['supplier_invoice'],
    clusteringMode: 'on',
    releaseSha: 'sha-1',
    createdAt: new Date('2026-10-09T12:00:00Z'),
    ...overrides,
  };
}

const status = (text: string, extra: Record<string, unknown> = {}) => ({ workdayID: wid, invoiceStatusAsText: text, isCanceled: false, invoiceIsPaid: false, invoiceIsPartiallyPaid: false, ...extra });

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.SCORE_SUPPLIERS_INVOICE_NUMBER_WQL_FIELD;
  delete process.env.INTERCOM_ACCESS_TOKEN;
  delete process.env.CANCEL_REASON_ATTRIBUTION;
  (snapshots.getAgentInvoiceSnapshots as jest.Mock).mockResolvedValue([snapshot()]);
  (scores.getInvoiceScore as jest.Mock).mockResolvedValue(undefined);
  (scores.getCancelLabel as jest.Mock).mockResolvedValue(undefined);
  (scores.countAgentInvoicesInConversation as jest.Mock).mockResolvedValue(1);
  (scores.findOtherAgentInvoicesWithSameNumber as jest.Mock).mockResolvedValue([]);
  (scores.isAgentWrittenInvoice as jest.Mock).mockResolvedValue(false);
  (workday.getSupplierInvoice as jest.Mock).mockResolvedValue(invoice());
});

describe('scoreInvoice', () => {
  it('waits on a recent Draft without writing a score', async () => {
    await expect(scoreInvoice(context, { workdayInvoiceWid: wid, status: status('Draft') }, now)).resolves.toBeUndefined();
    expect(scores.upsertInvoiceScore).not.toHaveBeenCalled();
  });

  it('marks a Draft past the cutoff as stuck without closing it', async () => {
    const later = new Date('2026-10-30T12:00:00Z');
    const score = await scoreInvoice(context, { workdayInvoiceWid: wid, status: status('Draft') }, later);
    expect(score).toEqual(expect.objectContaining({ outcome: 'stuck_draft', terminal: false }));
  });

  it('takes the entry diff when AP submits, separating material and convention changes', async () => {
    (workday.getSupplierInvoice as jest.Mock).mockResolvedValue(invoice({ costCenter: 'CC9', memo: 'Services' }));
    const score = await scoreInvoice(context, { workdayInvoiceWid: wid, status: status('In Progress') }, now);
    expect(score).toEqual(expect.objectContaining({
      outcome: 'submitted_edited',
      entryStatus: 'In Progress',
      entryReadAt: now,
      terminal: false,
      origin: 'create',
      releaseSha: 'sha-1',
      clusteringMode: 'on',
    }));
    expect(score?.entryDiff?.map((change) => [change.field, change.category])).toEqual([
      ['memo', 'convention'],
      ['line.costCenter', 'material'],
    ]);
    expect(scores.upsertInvoiceScore).toHaveBeenCalledWith(context.dbConnection, score);
  });

  it('scores an invoice submitted with only convention changes as clean', async () => {
    (workday.getSupplierInvoice as jest.Mock).mockResolvedValue(invoice({ memo: 'Services' }));
    const score = await scoreInvoice(context, { workdayInvoiceWid: wid, status: status('In Progress') }, now);
    expect(score?.outcome).toBe('submitted_clean');
  });

  it('records late corrections against the entry read at approval and closes the score', async () => {
    const entryFields = fieldsOf(invoice());
    (scores.getInvoiceScore as jest.Mock).mockResolvedValue({
      workdayInvoiceWid: wid, terminal: false, entryReadAt: new Date('2026-10-09T13:00:00Z'), entryFields, outcome: 'submitted_clean', entryDiff: [],
    });
    (workday.getSupplierInvoice as jest.Mock).mockResolvedValue(invoice({ costCenter: 'CC7' }));
    const score = await scoreInvoice(context, { workdayInvoiceWid: wid, status: status('Approved') }, now);
    expect(score).toEqual(expect.objectContaining({ finalStatus: 'Approved', terminal: true, outcome: 'submitted_clean' }));
    expect(score?.lateDiff?.map((change) => change.field)).toEqual(['line.costCenter']);
  });

  it('uses one read as entry and final when an invoice goes from Draft to Approved between runs', async () => {
    (workday.getSupplierInvoice as jest.Mock).mockResolvedValue(invoice({ costCenter: 'CC9' }));
    const score = await scoreInvoice(context, { workdayInvoiceWid: wid, status: status('Approved') }, now);
    expect(score).toEqual(expect.objectContaining({ outcome: 'submitted_edited', lateDiff: [], terminal: true }));
  });

  it('records a denied invoice as denied', async () => {
    const score = await scoreInvoice(context, { workdayInvoiceWid: wid, status: status('Denied') }, now);
    expect(score).toEqual(expect.objectContaining({ outcome: 'denied', terminal: true }));
  });

  it('does not count an AP fix to an OCR value the enrich agent left alone', async () => {
    const baselineFields = fieldsOf(invoice({ costCenter: 'CC0' }));
    (snapshots.getAgentInvoiceSnapshots as jest.Mock).mockResolvedValue([
      snapshot({ writeSeq: 1, source: 'enrich_baseline', fields: baselineFields }),
      snapshot({ writeSeq: 2, source: 'enrich' }),
    ]);
    (workday.getSupplierInvoice as jest.Mock).mockResolvedValue(invoice({ supplier: 'S-2' }));
    const score = await scoreInvoice(context, { workdayInvoiceWid: wid, status: status('In Progress') }, now);
    expect(score?.origin).toBe('enrich');
    expect(score?.entryDiff).toEqual([expect.objectContaining({ field: 'supplier', agentOwned: false })]);
    expect(score?.outcome).toBe('submitted_clean');
  });

  it('attributes a cancel to the agent when AP keyed a replacement, and diffs the replacement', async () => {
    process.env.SCORE_SUPPLIERS_INVOICE_NUMBER_WQL_FIELD = 'suppliersInvoiceNumber';
    (workday.executeWorkdayQuery as jest.Mock).mockResolvedValue({
      data: [{ workdayID: 'replacement-wid', invoiceNumber: 'SUPIN-2', supplier: { id: 'sup-wid' } }],
    });
    (workday.getSupplierInvoice as jest.Mock).mockImplementation(async (_ctx: unknown, id: string) =>
      id === 'replacement-wid' ? invoice({ costCenter: 'CC5' }) : invoice());

    const score = await scoreInvoice(context, { workdayInvoiceWid: wid, status: status('Draft', { isCanceled: true }) }, now);

    expect(score).toEqual(expect.objectContaining({
      outcome: 'canceled', cancelAttribution: 'agent', cancelBasis: 'replacement', terminal: true,
    }));
    expect(score?.cancelEvidence?.replacement).toEqual({
      workdayInvoiceWid: 'replacement-wid',
      workdayInvoiceNumber: 'SUPIN-2',
      diff: [expect.objectContaining({ field: 'line.costCenter', after: 'Cost_Center_Reference_ID=CC5' })],
    });
    expect((workday.executeWorkdayQuery as jest.Mock).mock.calls[0][1]).toContain("suppliersInvoiceNumber = 'INV-1'");
  });

  it('treats a live agent invoice with the same supplier and number as a duplicate', async () => {
    (scores.findOtherAgentInvoicesWithSameNumber as jest.Mock).mockResolvedValue([{ workdayInvoiceWid: 'other-wid' }]);
    (workday.getSupplierInvoiceEditability as jest.Mock).mockResolvedValue({ found: true, editable: true, isCanceled: false });
    const score = await scoreInvoice(context, { workdayInvoiceWid: wid, status: status('Canceled', { isCanceled: '1' }) }, now);
    expect(score).toEqual(expect.objectContaining({ cancelAttribution: 'agent', cancelBasis: 'duplicate' }));
  });

  it('attributes a canceled backup document to the agent', async () => {
    (snapshots.getAgentInvoiceSnapshots as jest.Mock).mockResolvedValue([snapshot({ attachmentKinds: ['supporting'] })]);
    const score = await scoreInvoice(context, { workdayInvoiceWid: wid, status: status('Canceled', { isCanceled: true }) }, now);
    expect(score?.cancelBasis).toBe('wrong_document');
  });

  it('attributes a cancel to the business when the supplier voided the invoice in the thread', async () => {
    process.env.INTERCOM_ACCESS_TOKEN = 'token';
    (intercom.fetchConversationMessages as jest.Mock).mockResolvedValue([
      { createdAt: Math.floor(now.getTime() / 1000), body: 'We voided that invoice and will resend.' },
    ]);
    const score = await scoreInvoice(context, { workdayInvoiceWid: wid, status: status('Canceled', { isCanceled: true }) }, now);
    expect(score).toEqual(expect.objectContaining({ cancelAttribution: 'business', cancelBasis: 'supplier_void_or_credit' }));
  });

  it('records a deleted invoice and leaves an early Draft cancel unattributed', async () => {
    const score = await scoreInvoice(context, { workdayInvoiceWid: wid, status: null }, now);
    expect(workday.getSupplierInvoice).not.toHaveBeenCalled();
    expect(score).toEqual(expect.objectContaining({
      outcome: 'deleted', finalStatus: 'Not found', cancelAttribution: 'unattributed', cancelBasis: 'early_draft_cancel', terminal: true,
    }));
  });

  describe('in a sandbox refreshed every Saturday', () => {
    const monday = new Date('2026-10-12T14:00:00Z');

    beforeEach(() => {
      process.env.SCORE_TENANT_REFRESH_WEEKDAY = '6';
    });

    afterEach(() => {
      delete process.env.SCORE_TENANT_REFRESH_WEEKDAY;
    });

    it('closes a Draft invoice the refresh removed without attributing a cancel', async () => {
      const score = await scoreInvoice(context, { workdayInvoiceWid: wid, status: null }, monday);
      expect(score).toEqual(expect.objectContaining({ outcome: 'lost_to_refresh', finalStatus: 'Lost to tenant refresh', terminal: true }));
      expect(score?.cancelAttribution).toBeUndefined();
      expect(scores.getCancelLabel).not.toHaveBeenCalled();
    });

    it('keeps the entry score of a submitted invoice the refresh removed', async () => {
      (scores.getInvoiceScore as jest.Mock).mockResolvedValue({
        workdayInvoiceWid: wid, terminal: false, entryReadAt: new Date('2026-10-09T14:00:00Z'), outcome: 'submitted_edited', entryDiff: [],
      });
      const score = await scoreInvoice(context, { workdayInvoiceWid: wid, status: null }, monday);
      expect(score).toEqual(expect.objectContaining({ outcome: 'submitted_edited', finalStatus: 'Lost to tenant refresh', terminal: true }));
    });

    it('still treats an invoice written after the refresh and then removed as deleted', async () => {
      (snapshots.getAgentInvoiceSnapshots as jest.Mock).mockResolvedValue([snapshot({ createdAt: new Date('2026-10-11T12:00:00Z') })]);
      const score = await scoreInvoice(context, { workdayInvoiceWid: wid, status: null }, monday);
      expect(score?.outcome).toBe('deleted');
    });
  });

  it('reads the cancel reason from the canceled invoice and matches it by reference ID', async () => {
    process.env.CANCEL_REASON_ATTRIBUTION = '{"business":["INVOICE_CANCEL_REASON-3-3"]}';
    (workday.getSupplierInvoice as jest.Mock).mockResolvedValue({
      ...invoice(),
      Invoice_Cancel_Reason_Reference: {
        $attributes: { Descriptor: 'Order Canceled' },
        ID: [
          { $attributes: { type: 'WID' }, $value: '706677ded2b01001faf9ba63a0d10000' },
          { $attributes: { type: 'Invoice_Cancel_Reason' }, $value: 'INVOICE_CANCEL_REASON-3-3' },
        ],
      },
    });
    const score = await scoreInvoice(context, { workdayInvoiceWid: wid, status: status('Canceled', { isCanceled: true }) }, now);
    expect(score).toEqual(expect.objectContaining({
      cancelReason: 'Order Canceled', cancelAttribution: 'business', cancelBasis: 'business_reason',
    }));
    expect(score?.cancelEvidence?.cancelReasonIds).toEqual(['706677ded2b01001faf9ba63a0d10000', 'INVOICE_CANCEL_REASON-3-3']);
  });

  it('falls back to the reference ID when the cancel reason has no display name', async () => {
    (workday.getSupplierInvoice as jest.Mock).mockResolvedValue({
      ...invoice(),
      Invoice_Cancel_Reason_Reference: { ID: [{ $attributes: { type: 'Invoice_Cancel_Reason' }, $value: 'INVOICE_CANCEL_REASON-3-1' }] },
    });
    const score = await scoreInvoice(context, { workdayInvoiceWid: wid, status: status('Canceled', { isCanceled: true }) }, now);
    expect(score?.cancelReason).toBe('INVOICE_CANCEL_REASON-3-1');
    expect(score?.cancelAttribution).toBe('unattributed');
  });

  it('lets an AP label decide the cancel', async () => {
    (scores.getCancelLabel as jest.Mock).mockResolvedValue('business');
    (snapshots.getAgentInvoiceSnapshots as jest.Mock).mockResolvedValue([snapshot({ attachmentKinds: ['supporting'] })]);
    const score = await scoreInvoice(context, { workdayInvoiceWid: wid, status: status('Canceled', { isCanceled: true }) }, now);
    expect(score).toEqual(expect.objectContaining({ cancelAttribution: 'business', cancelBasis: 'ap_label' }));
  });

  it('leaves a closed score alone', async () => {
    (scores.getInvoiceScore as jest.Mock).mockResolvedValue({ workdayInvoiceWid: wid, terminal: true, outcome: 'submitted_clean' });
    await scoreInvoice(context, { workdayInvoiceWid: wid, status: status('Approved') }, now);
    expect(scores.upsertInvoiceScore).not.toHaveBeenCalled();
    expect(workday.getSupplierInvoice).not.toHaveBeenCalled();
  });

  it('skips invoices with no agent write snapshot', async () => {
    (snapshots.getAgentInvoiceSnapshots as jest.Mock).mockResolvedValue([snapshot({ source: 'enrich_baseline' })]);
    await expect(scoreInvoice(context, { workdayInvoiceWid: wid, status: status('Approved') }, now)).resolves.toBeUndefined();
  });
});

describe('selecting invoices to score', () => {
  const pending = (overrides: Partial<scores.PendingScoreRow> = {}): scores.PendingScoreRow => ({
    workdayInvoiceWid: wid, lastWriteAt: new Date('2026-10-09T12:00:00Z'), ...overrides,
  });

  it('only sends invoices that reached a stage they have not been scored for', () => {
    expect(needsScoring(pending(), 'draft', now, 14)).toBe(false);
    expect(needsScoring(pending(), 'draft', new Date('2026-10-30T12:00:00Z'), 14)).toBe(true);
    expect(needsScoring(pending({ outcome: 'stuck_draft' }), 'draft', new Date('2026-10-30T12:00:00Z'), 14)).toBe(false);
    expect(needsScoring(pending(), 'entry', now, 14)).toBe(true);
    expect(needsScoring(pending({ entryReadAt: now }), 'entry', now, 14)).toBe(false);
    expect(needsScoring(pending({ entryReadAt: now }), 'approved', now, 14)).toBe(true);
    expect(needsScoring(pending(), 'canceled', now, 14)).toBe(true);
    expect(needsScoring(pending(), 'not_found', now, 14)).toBe(true);
  });

  it('pairs each selected invoice with its status, or null when Workday no longer has it', () => {
    const items = selectInvoicesToScore(
      [pending(), pending({ workdayInvoiceWid: 'gone' }), pending({ workdayInvoiceWid: 'draft-wid' })],
      new Map([
        [wid, status('In Progress')],
        ['draft-wid', { ...status('Draft'), workdayID: 'draft-wid' }],
      ]),
      now,
      14
    );
    expect(items).toEqual([
      { workdayInvoiceWid: wid, status: status('In Progress') },
      { workdayInvoiceWid: 'gone', status: null },
    ]);
  });

  it('skips the run on the sandbox refresh day', async () => {
    process.env.S3_BUCKET_NAME = 'finance-agent-test';
    process.env.SCORE_TENANT_REFRESH_WEEKDAY = String(new Date().getUTCDay());
    await handler({});
    expect(scores.listPendingScoreInvoices).not.toHaveBeenCalled();
    delete process.env.SCORE_TENANT_REFRESH_WEEKDAY;
  });

  it('batches the status query and dispatches the processor in groups', async () => {
    process.env.AWS_STACK_NAME = 'finance-agent';
    process.env.S3_BUCKET_NAME = 'finance-agent-test';
    const rows = Array.from({ length: 45 }, (_, index) => pending({ workdayInvoiceWid: `wid-${index}` }));
    (scores.listPendingScoreInvoices as jest.Mock).mockResolvedValue(rows);
    (workday.executeWorkdayQuery as jest.Mock).mockResolvedValue({ data: [] });

    await handler({});

    expect(workday.executeWorkdayQuery).toHaveBeenCalledTimes(1);
    expect((workday.executeWorkdayQuery as jest.Mock).mock.calls[0][1]).toContain("workdayID in ('wid-0', 'wid-1'");
    expect(mockLambdaSend).toHaveBeenCalledTimes(3);
    expect(mockLambdaSend.mock.calls[0][0]).toEqual(expect.objectContaining({
      FunctionName: 'finance-agent-ScoreInvoicesProcessor',
      InvocationType: 'Event',
    }));
    expect(JSON.parse(mockLambdaSend.mock.calls[2][0].Payload).data).toHaveLength(5);
  });
});
