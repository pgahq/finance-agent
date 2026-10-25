/* eslint-disable @typescript-eslint/require-await -- stubs implement async interfaces */
import { fakeS3 } from './eval_fake_s3.js';
import { caseId, parseCases, replayCase, type ReplayPipeline } from '../eval/replay_runner.js';
import { pinCreateDocuments, pinEnrichDocuments } from '../eval/s3_documents.js';
import { EVAL_CASE_SCHEMA_VERSION, type EvalCase } from '../lib/eval_cases.js';
import type { ProcessingContext } from '../lib/handlers.js';
import type { ScoredFields } from '../lib/invoice_snapshots.js';
import {
  getSupplierInvoiceWithAttachments,
  getWorkdayConfig,
  submitNewSupplierInvoice,
  submitSupplierInvoiceUpdate,
} from '../lib/workday.js';

jest.mock('@pga/logger', () => ({ debug: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
jest.mock('../lib/workday_validation_field_agent.js', () => ({ classifyWorkdayValidationField: jest.fn() }));

const wid = 'd'.repeat(32);
const workdayConfig = getWorkdayConfig({ WORKDAY_DOMAIN: 'replay.invalid', WORKDAY_TENANT: 'replay' } as NodeJS.ProcessEnv);
const context = { workdayConfig, s3Config: { bucketName: 'b' }, dbConnection: { query: async () => [], close: async () => undefined } } as ProcessingContext;

const expected: ScoredFields = {
  supplier: 'Supplier_ID=S-1',
  company: 'Company_Reference_ID=912',
  suppliersInvoiceNumber: 'INV-1',
  invoiceDate: '2026-10-01',
  controlTotal: 100,
  lines: [{
    lineOrder: 1,
    amount: 100,
    spendCategory: 'Spend_Category_ID=SC-1',
    costCenter: 'Cost_Center_Reference_ID=CC1',
    fund: 'Fund_ID=F1',
    otherWorktags: [],
    itemDescription: 'Venue rental',
  }],
};

const baseCase = (overrides: Partial<EvalCase> = {}): EvalCase => ({
  schemaVersion: EVAL_CASE_SCHEMA_VERSION,
  workdayInvoiceWid: wid,
  workdayInvoiceNumber: 'SUPIN-1',
  origin: 'create',
  documents: [],
  inputs: { s3Keys: [], attachmentKinds: [], purchaseOrderLines: [] },
  agent: expected,
  expected,
  misses: [],
  conventionChanges: [],
  entryDiff: [],
  ...overrides,
});

const s3 = () => fakeS3([
  { key: 'new-invoices/r1/0-invoice.pdf', versionId: 'v1', lastModified: '2026-10-13T14:00:00Z', body: 'create-pdf' },
  { key: `attachments/${wid}/inv.pdf`, versionId: 'e1', lastModified: '2026-10-13T14:00:00Z', body: 'enrich-pdf', metadata: { 'attachment-id': `${wid}-0`, 'original-filename': 'inv.pdf' } },
]);

const line = (overrides: Record<string, unknown> = {}) => ({
  lineOrder: 1, description: 'Venue rental', quantity: 1, unitCost: 100, extendedAmount: 100, costCenterId: 'CC1', fundId: 'F1', spendCategoryId: 'SC-1', ...overrides,
});

const deps = (pipeline: ReplayPipeline, bucket = s3()) => ({
  s3: bucket,
  context,
  pipeline,
  resolver: { supplierKey: async () => 'Supplier_ID=S-1', companyKey: async () => undefined },
});

const createPipeline = (lines = [line()]): ReplayPipeline => ({
  create: async (ctx, input) => {
    expect(input.preloadedBuffers?.get('new-invoices/r1/0-invoice.pdf')?.toString()).toBe('create-pdf');
    expect(input.conversationId).toBeUndefined();
    await submitNewSupplierInvoice(ctx, {
      supplierWID: 'supplier-wid',
      companyWID: '912',
      companyReferenceType: 'Company_Reference_ID',
      buildNotes: () => '',
      invoiceDate: '2026-10-01',
      extractedAmountDue: '$100.00',
      suppliersInvoiceNumber: 'INV-1',
      finalLines: lines as never,
      attachments: [],
    });
  },
  enrich: async () => undefined,
});

describe('replayCase (create)', () => {
  it('replays the pinned documents through the pipeline and scores the write it would have made', async () => {
    const bucket = s3();
    const documents = await pinCreateDocuments(bucket, 'b', ['new-invoices/r1/0-invoice.pdf'], ['supplier_invoice']);
    const result = await replayCase(baseCase({ documents }), deps(createPipeline(), bucket));
    expect(result).toMatchObject({ id: 'SUPIN-1', status: 'scored', codingTouches: 0, digestTouches: 0 });
    expect(bucket.commands.filter((command) => command.startsWith('GetObjectCommand'))).toEqual(['GetObjectCommand new-invoices/r1/0-invoice.pdf?versionId=v1']);
  });

  it('counts the corrections AP made to what the replay wrote', async () => {
    const bucket = s3();
    const documents = await pinCreateDocuments(bucket, 'b', ['new-invoices/r1/0-invoice.pdf']);
    const result = await replayCase(baseCase({ documents }), deps(createPipeline([line({ costCenterId: 'CC9', description: 'Rental' })]), bucket));
    expect(result.codingFields).toEqual(['line.costCenter']);
    expect(result.formattingFields).toEqual(['line.itemDescription']);
    expect(result.codingTouches).toBe(1);
  });

  it('warns when the agent coded against a PO the case did not capture', async () => {
    const bucket = s3();
    const documents = await pinCreateDocuments(bucket, 'b', ['new-invoices/r1/0-invoice.pdf']);
    const result = await replayCase(baseCase({ documents, inputs: { s3Keys: [], attachmentKinds: [], purchaseOrderLines: ['Purchase_Order_Line_ID=PO-123456-1'] } }), deps(createPipeline(), bucket));
    expect(result.warnings.join(' ')).toContain('PO-123456, which this case did not capture');
  });

  it('reports the production touches carried by the case', async () => {
    const bucket = s3();
    const documents = await pinCreateDocuments(bucket, 'b', ['new-invoices/r1/0-invoice.pdf']);
    const change = { field: 'line.costCenter' as const, line: 0, before: 'CC9', after: 'CC1', category: 'material' as const, agentOwned: true };
    const result = await replayCase(baseCase({ documents, entryDiff: [change], lateDiff: [change] }), deps(createPipeline(), bucket));
    expect(result.productionTouches).toBe(2);
  });

  it('skips a case with no documents or an unreadable one without running the pipeline', async () => {
    const pipeline = { create: jest.fn(), enrich: jest.fn() };
    expect((await replayCase(baseCase(), deps(pipeline))).reason).toContain('no documents');
    const missing = await replayCase(baseCase({ documents: [{ bucket: 'b', key: 'new-invoices/gone', status: 'missing', source: 'snapshot' }] }), deps(pipeline));
    expect(missing).toMatchObject({ status: 'skipped' });
    expect(missing.reason).toContain('new-invoices/gone is missing');
    expect(pipeline.create).not.toHaveBeenCalled();
  });

  it('skips a case whose pinned version no longer matches its ETag', async () => {
    const bucket = s3();
    const [ref] = await pinCreateDocuments(bucket, 'b', ['new-invoices/r1/0-invoice.pdf']);
    const result = await replayCase(baseCase({ documents: [{ ...ref, etag: '"stale"' }] }), deps(createPipeline(), bucket));
    expect(result.status).toBe('skipped');
    expect(result.reason).toContain('ETag');
  });

  it('counts a pipeline error as an error and still removes the Workday hook', async () => {
    const bucket = s3();
    const documents = await pinCreateDocuments(bucket, 'b', ['new-invoices/r1/0-invoice.pdf']);
    const failing: ReplayPipeline = { create: async () => { throw new Error('model refused'); }, enrich: async () => undefined };
    const result = await replayCase(baseCase({ documents }), deps(failing, bucket));
    expect(result).toMatchObject({ status: 'error', reason: 'model refused' });
    const global = jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 500, statusText: '', text: async () => '' } as Response);
    const { executeWorkdayQuery } = await import('../lib/workday.js');
    await expect(executeWorkdayQuery(workdayConfig, 'SELECT 1')).rejects.toThrow('Failed to get access token');
    global.mockRestore();
  });

  it('reports a run that built no Workday write', async () => {
    const bucket = s3();
    const documents = await pinCreateDocuments(bucket, 'b', ['new-invoices/r1/0-invoice.pdf']);
    const result = await replayCase(baseCase({ documents }), deps({ create: async () => undefined, enrich: async () => undefined }, bucket));
    expect(result).toMatchObject({ status: 'error' });
    expect(result.reason).toContain('without building a Workday write');
  });

  it('times a case out', async () => {
    const bucket = s3();
    const documents = await pinCreateDocuments(bucket, 'b', ['new-invoices/r1/0-invoice.pdf']);
    const hanging: ReplayPipeline = {
      create: (_ctx, _input, _run, signal) => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason))),
      enrich: async () => undefined,
    };
    const result = await replayCase(baseCase({ documents }), { ...deps(hanging, bucket), perCaseTimeoutMs: 20 });
    expect(result).toMatchObject({ status: 'error' });
    expect(result.reason).toContain('timed out');
  });
});

describe('replayCase (enrich)', () => {
  const baseline: ScoredFields = { company: 'Company_Reference_ID=912', invoiceDate: '2026-09-30', controlTotal: 100, lines: [] };

  const enrichPipeline = (assert: (attachments: string[]) => void, supplierWID = 'supplier-wid'): ReplayPipeline => ({
    create: async () => undefined,
    enrich: async (ctx, invoice) => {
      expect(invoice.workdayID).toBe(wid);
      expect(invoice.emailContext?.subject).toBe('Invoice attached');
      const loaded = await getSupplierInvoiceWithAttachments({ workdayConfig: ctx.workdayConfig, s3Config: ctx.s3Config }, wid);
      assert(loaded.presignedAttachments.map((attachment) => `${attachment.fileName}:${attachment.buffer?.toString()}`));
      await submitSupplierInvoiceUpdate(ctx, {
        invoiceWorkdayID: wid,
        supplierWID,
        buildNotes: () => '',
        invoiceDate: '2026-10-01',
        extractedAmountDue: '$100.00',
        suppliersInvoiceNumber: 'INV-1',
        finalLines: [line()] as never,
      });
    },
  });

  it('feeds the pipeline the pinned attachments and the OCR invoice, and scores only what the agent changed', async () => {
    const bucket = s3();
    const documents = await pinEnrichDocuments(bucket, 'b', wid, new Date('2026-10-13T15:00:00Z'));
    let seen: string[] = [];
    const result = await replayCase(
      baseCase({ origin: 'enrich', documents, inputs: { s3Keys: [], attachmentKinds: [], purchaseOrderLines: [], baseline, ocrEmail: { subject: 'Invoice attached' } } }),
      deps(enrichPipeline((attachments) => { seen = attachments; }), bucket)
    );
    expect(seen).toEqual(['inv.pdf:enrich-pdf']);
    expect(result.status).toBe('scored');
    expect(result.codingTouches).toBe(0);
  });

  it('skips an enrich case with no OCR baseline', async () => {
    const bucket = s3();
    const documents = await pinEnrichDocuments(bucket, 'b', wid, new Date('2026-10-13T15:00:00Z'));
    const result = await replayCase(baseCase({ origin: 'enrich', documents }), deps(enrichPipeline(() => undefined), bucket));
    expect(result).toMatchObject({ status: 'skipped' });
    expect(result.reason).toContain('no OCR baseline');
  });

  it('skips an enrich case with image attachments', async () => {
    const bucket = fakeS3([{ key: `attachments/${wid}/scan.png`, versionId: 'i1', lastModified: '2026-10-13T14:00:00Z', contentType: 'image/png' }]);
    const documents = await pinEnrichDocuments(bucket, 'b', wid, new Date('2026-10-13T15:00:00Z'));
    const result = await replayCase(baseCase({ origin: 'enrich', documents, inputs: { s3Keys: [], attachmentKinds: [], purchaseOrderLines: [], baseline } }), deps(enrichPipeline(() => undefined), bucket));
    expect(result.reason).toContain('image attachments');
  });
});

describe('parseCases', () => {
  it('reads JSON Lines and rejects the old case format', () => {
    const line = JSON.stringify(baseCase());
    expect(parseCases(`${line}\n\n${line}\n`)).toHaveLength(2);
    expect(() => parseCases(JSON.stringify({ workdayInvoiceWid: 'x' }))).toThrow('schemaVersion 2');
  });

  it('names a case by its Workday invoice number, else its WID', () => {
    expect(caseId({ workdayInvoiceWid: wid, workdayInvoiceNumber: 'SUPIN-9' })).toBe('SUPIN-9');
    expect(caseId({ workdayInvoiceWid: wid })).toBe(wid);
  });
});
