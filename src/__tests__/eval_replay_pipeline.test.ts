/* eslint-disable @typescript-eslint/require-await -- stubs implement async interfaces */
import { fakeS3 } from './eval_fake_s3.js';
import { caseId, replayCase } from '../eval/replay_runner.js';
import { pinCreateDocuments, pinEnrichDocuments } from '../eval/s3_documents.js';
import { assertReadOnlySql } from '../eval/readonly_db.js';
import { EVAL_CASE_SCHEMA_VERSION, type EvalCase } from '../lib/eval_cases.js';
import type { ProcessingContext } from '../lib/handlers.js';
import type { ScoredFields } from '../lib/invoice_snapshots.js';

jest.mock('@pga/logger', () => ({ debug: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
jest.mock('../lib/workday_validation_field_agent.js', () => ({ classifyWorkdayValidationField: jest.fn() }));

const enrichmentResult = {
  supplier: {
    status: 'found',
    resolvedSupplier: { workdayId: 'supplier-wid', supplierName: 'Synthetic Venue Co' },
    extractedInformation: { supplierName: 'Synthetic Venue Co', memo: 'Venue services' },
  },
  extractedInvoiceDate: '2026-10-01',
  extractedSuppliersInvoiceNumber: 'INV-1',
  extractedAmountDue: '$100.00',
  extractedInvoiceLines: [{ description: 'Venue rental', quantity: 1, unitCost: '$100.00', totalPrice: '$100.00', hasDiscount: null }],
};

jest.mock('../lib/invoice_enrichment.js', () => ({
  ...jest.requireActual<typeof import('../lib/invoice_enrichment.js')>('../lib/invoice_enrichment.js'),
  enrichInvoiceFromAttachments: jest.fn(),
}));

jest.mock('../lib/ai.js', () => ({
  getAiResponse: jest.fn(),
}));

const expected: ScoredFields = {
  supplier: 'Supplier_ID=S-1',
  company: 'Company_Reference_ID=Default_OCR_Company',
  suppliersInvoiceNumber: 'INV-1',
  invoiceDate: '2026-10-01',
  controlTotal: 100,
  memo: 'Venue services',
  lines: [{
    lineOrder: 1,
    amount: 100,
    spendCategory: 'Spend_Category_ID=SC-1',
    costCenter: 'Cost_Center_Reference_ID=CC1',
    fund: 'Fund_ID=F1',
    lineOfBusiness: 'Organization_Reference_ID=Default_Line_Of_Business',
    otherWorktags: [],
    itemDescription: 'Venue rental',
  }],
};

describe('replay through the real create pipeline', () => {
  let createPipeline: typeof import('../create_invoice.js');
  let enrichPipeline: typeof import('../enrich_invoice.js');
  const wid = 'e'.repeat(32);
  const queries: string[] = [];
  const context = {
    workdayConfig: { domain: 'replay.invalid', tenant: 'replay', clientId: '', clientSecret: '', refreshToken: '' },
    s3Config: { bucketName: 'finance-agent-1' },
    dbConnection: { query: async (sql: string) => { queries.push(sql); assertReadOnlySql(sql); return []; }, close: async () => undefined },
  } as ProcessingContext;

  beforeAll(async () => {
    Object.assign(process.env, {
      INVOICE_MOD_ENABLED: 'true',
      WORKDAY_DOMAIN: 'replay.invalid',
      WORKDAY_TENANT: 'replay',
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      AWS_SECRET_ACCESS_KEY: 'secret',
      FALLBACK_FUND_ID: 'F1',
      FALLBACK_COST_CENTER_ID: 'CC1',
      FALLBACK_SPEND_CATEGORY_ID: 'SC-1',
      FALLBACK_LOB_ID: 'Default_Line_Of_Business',
    });
    delete process.env.SLACK_WEBHOOK_URL;
    createPipeline = await import('../create_invoice.js');
    enrichPipeline = await import('../enrich_invoice.js');
    const { enrichInvoiceFromAttachments } = await import('../lib/invoice_enrichment.js');
    (enrichInvoiceFromAttachments as jest.Mock).mockResolvedValue(enrichmentResult);
    const { getAiResponse } = await import('../lib/ai.js');
    (getAiResponse as jest.Mock).mockResolvedValue({
      lines: [{ lineOrder: 1, description: 'Venue rental', quantity: 1, unitCost: 100, extendedAmount: 100, costCenterId: 'CC1', fundId: 'F1', spendCategoryId: 'SC-1' }],
    });
  });

  const buildCase = async (): Promise<EvalCase> => {
    const s3 = fakeS3([{ key: 'new-invoices/r1/0-invoice.pdf', versionId: 'v1', lastModified: '2026-10-13T14:00:00Z', body: 'pdf-bytes' }]);
    const documents = await pinCreateDocuments(s3, 'finance-agent-1', ['new-invoices/r1/0-invoice.pdf'], ['supplier_invoice']);
    return {
      schemaVersion: EVAL_CASE_SCHEMA_VERSION,
      workdayInvoiceWid: wid,
      workdayInvoiceNumber: 'SUPIN-SYNTHETIC-1',
      origin: 'create',
      documents,
      inputs: { s3Keys: ['new-invoices/r1/0-invoice.pdf'], attachmentKinds: ['supplier_invoice'], purchaseOrderLines: [], emailContext: { subject: 'Invoice', plainTextBody: 'Please find our invoice attached.' } },
      agent: expected,
      expected,
      misses: [],
      conventionChanges: [],
      entryDiff: [],
    };
  };

  it('runs processInvoiceCluster to a recorded Workday write, scores it, and writes nothing', async () => {
    const evalCase = await buildCase();
    const s3 = fakeS3([{ key: 'new-invoices/r1/0-invoice.pdf', versionId: 'v1', lastModified: '2026-10-13T14:00:00Z', body: 'pdf-bytes' }]);
    queries.length = 0;
    const result = await replayCase(evalCase, {
      s3,
      context,
      pipeline: { create: createPipeline.processInvoiceCluster, enrich: enrichPipeline.processInvoice },
      resolver: { supplierKey: async () => 'Supplier_ID=S-1', companyKey: async () => undefined },
    });
    expect(result.reason).toBeUndefined();
    expect(result.status).toBe('scored');
    expect(caseId(evalCase)).toBe('SUPIN-SYNTHETIC-1');
    expect(result.codingTouches).toBe(0);
    expect(queries.filter((sql) => !/^\s*select/i.test(sql)).every((sql) => /agent_invoice_snapshots/.test(sql))).toBe(true);
    expect(s3.commands.every((command) => /^(Head|Get|List)/.test(command))).toBe(true);
  });

  it('counts what AP corrected in the pipeline\'s payload', async () => {
    const evalCase = await buildCase();
    const s3 = fakeS3([{ key: 'new-invoices/r1/0-invoice.pdf', versionId: 'v1', lastModified: '2026-10-13T14:00:00Z' }]);
    const apDifferent: ScoredFields = { ...expected, lines: [{ ...expected.lines[0], costCenter: 'Cost_Center_Reference_ID=CC9' }] };
    const result = await replayCase({ ...evalCase, expected: apDifferent }, {
      s3,
      context,
      pipeline: { create: createPipeline.processInvoiceCluster, enrich: enrichPipeline.processInvoice },
      resolver: { supplierKey: async () => 'Supplier_ID=S-1', companyKey: async () => undefined },
    });
    expect(result.codingFields).toEqual(['line.costCenter']);
  });

  it('runs processInvoice for an enrich case from the OCR baseline and the pinned attachment', async () => {
    const baseline: ScoredFields = { company: 'Company_Reference_ID=Default_OCR_Company', invoiceDate: '2026-09-30', controlTotal: 100, lines: [] };
    const s3 = fakeS3([{ key: `attachments/${wid}/inv.pdf`, versionId: 'e1', lastModified: '2026-10-13T14:00:00Z', body: 'pdf-bytes', metadata: { 'attachment-id': `${wid}-0`, 'original-filename': 'inv.pdf' } }]);
    const documents = await pinEnrichDocuments(s3, 'finance-agent-1', wid, new Date('2026-10-13T15:00:00Z'));
    const base = await buildCase();
    const { enrichInvoiceFromAttachments } = await import('../lib/invoice_enrichment.js');
    (enrichInvoiceFromAttachments as jest.Mock).mockClear();
    const result = await replayCase({ ...base, origin: 'enrich', documents, inputs: { s3Keys: [], attachmentKinds: [], purchaseOrderLines: [], baseline, ocrEmail: { subject: 'Invoice', plainTextBody: 'attached' } } }, {
      s3,
      context,
      pipeline: { create: createPipeline.processInvoiceCluster, enrich: enrichPipeline.processInvoice },
      resolver: { supplierKey: async () => 'Supplier_ID=S-1', companyKey: async () => undefined },
    });
    expect(result.reason).toBeUndefined();
    expect(result.status).toBe('scored');
    const [invoice, attachments, , , emailContext] = (enrichInvoiceFromAttachments as jest.Mock).mock.calls[0] as [Record<string, unknown>, Array<{ fileName: string; buffer: Buffer }>, unknown, unknown, { subject: string }];
    expect(invoice.Company_Reference).toBeDefined();
    expect(attachments.map((attachment) => `${attachment.fileName}:${attachment.buffer.toString()}`)).toEqual(['inv.pdf:pdf-bytes']);
    expect(emailContext.subject).toBe('Invoice');
    expect(result.codingFields).toEqual([]);
    expect(s3.commands.every((command) => /^(Head|Get|List)/.test(command))).toBe(true);
  });
});
