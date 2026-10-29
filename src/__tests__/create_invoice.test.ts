import ExcelJS from 'exceljs';
// create_invoice.ts reads WORKDAY_DEFAULT_COMPANY_NAME / WORKDAY_DEFAULT_SUPPLIER_WID /
// INVOICE_MOD_ENABLED as module-level constants at import time. Each test sets the env
// vars it needs, resets the module registry, and re-requires the module (and its mocked
// dependencies) fresh so those constants are re-evaluated against the current env.

import { supin471692Header, supin471692Payments, supin471692Rows } from './fixtures/supin_471692.js';
import { supin472062CorrectedEsignRow, supin472062EsignRow, supin472062Header, supin472062Rows } from './fixtures/supin_472062.js';
import { supin470584Header, supin470584PoLines, supin470584ProductionRows, supin470584Rows } from './fixtures/supin_470584.js';

jest.mock('@pga/lambda-env', () => ({
  __esModule: true,
  default: jest.fn().mockResolvedValue({})
}));

jest.mock('@pga/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn()
}));

jest.mock('../lib/workday.js', () => ({
  getWorkdayConfig: jest.fn().mockReturnValue({
    domain: 'test.workday.com',
    tenant: 'test-tenant',
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    refreshToken: 'test-refresh-token'
  }),
  getPurchaseOrder: jest.fn(),
  parsePurchaseOrderLines: jest.fn().mockReturnValue([]),
  parsePurchaseOrder: jest.fn(),
  loadPurchaseOrder: jest.fn().mockResolvedValue(undefined),
  isPurchaseOrderClosedForInvoicing: jest.requireActual('../lib/workday.js').isPurchaseOrderClosedForInvoicing,
  closedPurchaseOrderLineNote: jest.requireActual('../lib/workday.js').closedPurchaseOrderLineNote,
  consumedPurchaseOrderLinesNote: jest.requireActual('../lib/workday.js').consumedPurchaseOrderLinesNote,
  markPurchaseOrderLineAvailability: jest.requireActual('../lib/workday.js').markPurchaseOrderLineAvailability,
  formatPurchaseOrderLineFallbackNotes: jest.requireActual('../lib/workday.js').formatPurchaseOrderLineFallbackNotes,
  isPurchaseOrderLineFallback: jest.requireActual('../lib/workday.js').isPurchaseOrderLineFallback,
  purchaseOrderLineFallbackNote: jest.requireActual('../lib/workday.js').purchaseOrderLineFallbackNote,
  CONSUMED_PO_LINE_REFERENCE_LABEL: jest.requireActual('../lib/workday.js').CONSUMED_PO_LINE_REFERENCE_LABEL,
  OMITTED_PO_LINE_REFERENCE_LABEL: jest.requireActual('../lib/workday.js').OMITTED_PO_LINE_REFERENCE_LABEL,
  submitNewSupplierInvoice: jest.fn().mockResolvedValue({ success: true, invoiceWID: 'new-invoice-wid', invoiceNumber: 'SUPIN-412727', appliedFallbacks: [] }),
  submitSupplierInvoiceUpdate: jest.fn().mockResolvedValue({ success: true, appliedFallbacks: [] }),
  getSupplierInvoiceEditability: jest.fn(),
}));

jest.mock('../lib/employees.js', () => ({
  ...jest.requireActual('../lib/employees.js'),
  getEmployeeWidByEmail: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../lib/database.js', () => ({
  getDatabaseConnection: jest.fn().mockResolvedValue({
    query: jest.fn().mockResolvedValue([]),
    close: jest.fn().mockResolvedValue({})
  }),
  searchSimilarDocuments: jest.fn().mockResolvedValue([]),
  searchDocumentsByTypes: jest.fn().mockResolvedValue([]),
  findDocumentsByReferenceId: jest.fn().mockResolvedValue([]),
  findDocumentsByReferenceIds: jest.fn().mockResolvedValue(new Map()),
  getCostCenterRelatedLobsByCodes: jest.fn().mockResolvedValue(new Map()),
  getCostCenterWorkdayIdsByCodes: jest.fn().mockResolvedValue(new Map()),
  getOrgWorktagKindsByIds: jest.fn().mockResolvedValue(new Map()),
  getDocumentsByWorkdayIds: jest.fn().mockResolvedValue([]),
  findCompanyByName: jest.fn().mockResolvedValue({
    workdayId: 'pga-america-wid',
    companyName: 'The Professional Golfers Association of America'
  })
}));

jest.mock('../lib/rag.js', () => ({
  createEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3])
}));

jest.mock('../lib/s3.js', () => ({
  getS3Config: jest.fn().mockReturnValue({
    bucketName: 'test-bucket'
  }),
  getBinaryFromS3: jest.fn().mockResolvedValue(Buffer.from('fake-pdf-content')),
  getPresignedUrl: jest.fn().mockResolvedValue('https://example.com/invoice.pdf')
}));

jest.mock('../lib/slack.js', () => ({
  notifyResult: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../lib/invoice_validation_failures.js', () => ({
  getInvoiceValidationFailuresConfig: jest.fn().mockReturnValue(undefined)
}));

jest.mock('../lib/invoice_enrichment.js', () => {
  const actual = jest.requireActual('../lib/invoice_enrichment.js');
  return {
    ...actual,
    enrichInvoiceFromAttachments: jest.fn()
  };
});

jest.mock('../lib/invoice_lines.js', () => {
  const actual = jest.requireActual('../lib/invoice_lines.js');
  return {
    ...actual,
    buildFinalInvoiceLines: jest.fn()
  };
});

jest.mock('../lib/invoice_attachment_clustering.js', () => {
  const actual = jest.requireActual('../lib/invoice_attachment_clustering.js');
  return {
    ...actual,
    isInvoiceAttachmentClusteringEnabled: jest.fn(
      (env: NodeJS.ProcessEnv = process.env) => env.INVOICE_ATTACHMENT_CLUSTERING_ENABLED === 'true'
    ),
    parseAndClusterInvoiceAttachments: jest.fn(),
  };
});

jest.mock('../lib/conversation_invoices.js', () => ({
  getConversationSupplierInvoice: jest.fn(),
  upsertConversationSupplierInvoice: jest.fn(),
  acquireConversationInvoiceClaim: jest.fn().mockResolvedValue(true),
  releaseConversationInvoiceClaim: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../lib/invoice_cluster_plans.js', () => ({
  createInvoiceClusterPlan: jest.fn().mockResolvedValue(undefined),
  claimInvoiceCluster: jest.fn().mockResolvedValue(true),
  finishInvoiceCluster: jest.fn().mockResolvedValue(undefined),
  markInvoiceClusterUndispatched: jest.fn().mockResolvedValue(undefined),
  releaseInvoiceCluster: jest.fn().mockResolvedValue(undefined),
}));

const mockLambdaSend = jest.fn().mockResolvedValue({});
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({
    send: (...args: unknown[]) => mockLambdaSend(...args),
  })),
  InvokeCommand: jest.fn(),
}));

const baseEnrichmentResult = {
  supplier: {
    status: 'found',
    confidence: 0.9,
    extractedInformation: {
      supplierName: 'Test Supplier',
      memo: 'Office supplies'
    },
    resolvedSupplier: {
      workdayId: 'supplier-wid-1',
      supplierName: 'Test Supplier',
      confidence: 0.9,
      reason: 'Exact match'
    },
    potentialDuplicateSuppliers: null,
    recommendation: {
      action: 'update_invoice',
      reason: 'High confidence match'
    },
    reason: 'High confidence match'
  },
  companyVerification: {
    status: 'matching',
    confidence: 0.85,
    extractedInformation: {},
    recommended: null,
    reason: 'Company matches default assignment'
  },
  extractedInvoiceDate: '2026-01-15',
  extractedAmountDue: '$100.00',
  extractedSuppliersInvoiceNumber: 'INV-001',
  extractedFreightAmount: null,
  extractedTaxAmount: null,
  extractedPurchaseOrderNumber: null,
  extractedPaymentTerms: null,
  invoiceLineQuantityDisplayed: true,
  extractedInvoiceLines: [
    { description: 'Widgets', quantity: 2, unitCost: '50.00', totalPrice: '100.00', hasDiscount: false }
  ],
  emailWorktags: null,
  emailBudgetSplits: null,
  emailSummary: null
};

const defaultFinalLines = {
  lines: [{ lineOrder: 1, description: 'Widgets', quantity: 2, unitCost: 50 }],
  appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false }
};

// Resets the module registry and re-requires create_invoice.js and its mocked dependencies,
// so module-level env constants (e.g. WORKDAY_DEFAULT_COMPANY_NAME) reflect the current env.
function freshRequire() {
  jest.resetModules();
  const { processor } = require('../create_invoice.js');
  return {
    processor,
    workday: require('../lib/workday.js'),
    employees: require('../lib/employees.js'),
    slack: require('../lib/slack.js'),
    invoiceEnrichment: require('../lib/invoice_enrichment.js'),
    invoiceLines: require('../lib/invoice_lines.js'),
    database: require('../lib/database.js'),
    clustering: require('../lib/invoice_attachment_clustering.js'),
    s3: require('../lib/s3.js'),
    registry: require('../lib/conversation_invoices.js'),
    plans: require('../lib/invoice_cluster_plans.js'),
    lambda: require('@aws-sdk/client-lambda'),
    loadEnv: require('@pga/lambda-env').default,
  };
}

function attachmentRequest(s3Key: string, fileName = 'invoice.pdf') {
  return { s3Key, fileName, contentType: 'application/pdf' };
}

describe('create_invoice', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.WORKDAY_DEFAULT_COMPANY_NAME;
    delete process.env.WORKDAY_DEFAULT_COMPANY_WID;
    delete process.env.WORKDAY_DEFAULT_SUPPLIER_WID;
    delete process.env.INVOICE_MOD_ENABLED;
    delete process.env.INTERCOM_APP_ID;
    delete process.env.INVOICE_ATTACHMENT_CLUSTERING_ENABLED;
    delete process.env.AWS_STACK_NAME;
  });

  afterEach(() => {
    delete process.env.WORKDAY_DEFAULT_COMPANY_NAME;
    delete process.env.WORKDAY_DEFAULT_COMPANY_WID;
    delete process.env.WORKDAY_DEFAULT_SUPPLIER_WID;
    delete process.env.INVOICE_MOD_ENABLED;
    delete process.env.INTERCOM_APP_ID;
    delete process.env.INVOICE_ATTACHMENT_CLUSTERING_ENABLED;
    delete process.env.AWS_STACK_NAME;
    delete process.env.FALLBACK_FUND_ID;
    delete process.env.FALLBACK_COST_CENTER_ID;
    delete process.env.FALLBACK_SPEND_CATEGORY_ID;
    delete process.env.FALLBACK_LOB_ID;
  });

  it('passes the Lambda deadline signal to enrichment and line building', async () => {
    process.env.INVOICE_MOD_ENABLED = 'true';
    const { processor, invoiceEnrichment, invoiceLines } = freshRequire();
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);

    await processor(
      { data: [attachmentRequest('new-invoices/req-1/invoice.pdf')] } as any,
      { getRemainingTimeInMillis: () => 120_000 } as any
    );

    const enrichSignal = invoiceEnrichment.enrichInvoiceFromAttachments.mock.calls[0][7];
    expect(enrichSignal).toBeInstanceOf(AbortSignal);
    expect(enrichSignal.aborted).toBe(false);
    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][8]).toBe(enrichSignal);
  });

  it('passes assigneeWID when the AP agent employee cache matches assigneeEmail', async () => {
    process.env.INVOICE_MOD_ENABLED = 'true';
    const { processor, workday, slack, invoiceEnrichment, invoiceLines, employees } = freshRequire();
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
    employees.getEmployeeWidByEmail.mockResolvedValue({
      workdayId: 'wid-jcarey',
      name: 'Joseph A Carey Jr.',
      preferredName: 'Joe Carey',
    });

    await processor({
      data: [{
        ...attachmentRequest('new-invoices/req-1/invoice.pdf'),
        assigneeEmail: 'jcarey@pgahq.com',
      }],
    } as any);

    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.assigneeWID).toBe('wid-jcarey');
    expect(employees.getEmployeeWidByEmail).toHaveBeenCalledWith(expect.anything(), 'jcarey@pgahq.com');
    expect(submitArgs.buildNotes([])).toContain('Work queue assignee: Joe Carey (jcarey@pgahq.com)');
    expect(slack.notifyResult).toHaveBeenCalledWith(
      'create_invoice',
      'success',
      expect.any(Number),
      expect.objectContaining({
        assigneeEmail: 'jcarey@pgahq.com',
        assigneeWorkdayId: 'wid-jcarey',
        assigneeName: 'Joe Carey',
      }),
    );
  });

  describe('IBS invoice 1026465 printed due date', () => {
    // Invoice Date 10/10/26, Due Date 11/11/26, PO-413821, Net 30.
    const ibsEnrichmentResult = {
      ...baseEnrichmentResult,
      extractedInvoiceDate: '2026-10-10',
      extractedDueDate: '2026-11-11',
      extractedSuppliersInvoiceNumber: '1026465',
      extractedPurchaseOrderNumber: 'PO-413821',
      extractedPaymentTerms: { name: 'Net 30', workdayId: 'NET_30' },
    };

    it('sends the due date with the invoice date and payment terms, and shows it in the note and Slack', async () => {
      process.env.INVOICE_MOD_ENABLED = 'true';
      const { processor, workday, slack, invoiceEnrichment, invoiceLines } = freshRequire();
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(ibsEnrichmentResult);

      await processor({ data: [attachmentRequest('new-invoices/req-1/invoice.pdf')] } as any);

      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(submitArgs).toMatchObject({ invoiceDate: '2026-10-10', dueDate: '2026-11-11', paymentTermsId: 'NET_30' });
      const notes = submitArgs.buildNotes([]);
      expect(notes).toContain('Invoice Date (from document): 2026-10-10\n\nDue Date (from document): 2026-11-11');
      expect(notes).toContain('Payment Terms (from document): Net 30');
      expect(slack.notifyResult).toHaveBeenCalledWith(
        'create_invoice',
        'success',
        expect.any(Number),
        expect.objectContaining({
          extracted: expect.objectContaining({ invoiceDate: '2026-10-10', dueDate: '2026-11-11', paymentTerms: 'Net 30' }),
        }),
      );
      expect(slack.notifyResult.mock.calls[0][3].extracted).not.toHaveProperty('dueDateNotApplied');
    });

    it('notes a due date removed on retry once, not again under fallback values, and marks it in Slack', async () => {
      process.env.INVOICE_MOD_ENABLED = 'true';
      const { processor, workday, slack, invoiceEnrichment, invoiceLines } = freshRequire();
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(ibsEnrichmentResult);
      const omitted = { field: 'dueDate', label: 'omitted due date', dueToValidationError: true };
      workday.submitNewSupplierInvoice.mockResolvedValueOnce({
        success: true,
        invoiceWID: 'new-invoice-wid',
        invoiceNumber: 'SUPIN-470100',
        appliedFallbacks: [omitted],
      });

      await processor({ data: [attachmentRequest('new-invoices/req-1/invoice.pdf')] } as any);

      const notes = workday.submitNewSupplierInvoice.mock.calls[0][1].buildNotes([omitted]);
      expect(notes).toContain('Due Date (from document): 2026-11-11 (Workday rejected it, so the retry kept the invoice\'s current due date)');
      expect(notes).not.toContain('Fallback values applied: omitted due date');
      expect(slack.notifyResult).toHaveBeenCalledWith(
        'create_invoice',
        'success',
        expect.any(Number),
        expect.objectContaining({
          extracted: expect.objectContaining({ dueDate: '2026-11-11', dueDateNotApplied: true }),
          appliedFallbacks: ['omitted due date'],
        }),
      );
    });

    it('notes a due date earlier than the invoice date as not applied', async () => {
      process.env.INVOICE_MOD_ENABLED = 'true';
      const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({ ...ibsEnrichmentResult, extractedDueDate: '2026-10-01' });

      await processor({ data: [attachmentRequest('new-invoices/req-1/invoice.pdf')] } as any);

      const notes = workday.submitNewSupplierInvoice.mock.calls[0][1].buildNotes([
        { field: 'dueDate', label: 'due date not applied (2026-10-01 is earlier than invoice date 2026-10-10)' },
      ]);
      expect(notes).toContain('Due Date (from document): 2026-10-01 (not sent because it is earlier than the invoice date)');
      expect(notes).not.toContain('Fallback values applied');
    });

    it('validates the due date before sending or noting it', async () => {
      process.env.INVOICE_MOD_ENABLED = 'true';
      const { processor, workday, slack, invoiceEnrichment, invoiceLines } = freshRequire();
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({ ...ibsEnrichmentResult, extractedDueDate: '2026-02-30' });

      await processor({ data: [attachmentRequest('new-invoices/req-1/invoice.pdf')] } as any);

      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(submitArgs.dueDate).toBeUndefined();
      expect(submitArgs.buildNotes([])).toContain('Due Date (from document): unreadable, not sent');
      expect(slack.notifyResult.mock.calls[0][3].extracted.dueDate).toBeUndefined();
    });

    it('tells AP when the printed dates only make sense read day/month/year', async () => {
      process.env.INVOICE_MOD_ENABLED = 'true';
      const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...ibsEnrichmentResult,
        extractedInvoiceDate: '2026-05-10',
        extractedDueDate: '2026-04-11',
      });

      await processor({ data: [attachmentRequest('new-invoices/req-1/invoice.pdf')] } as any);

      const notes = workday.submitNewSupplierInvoice.mock.calls[0][1].buildNotes([
        { field: 'dueDate', label: 'due date not applied (2026-04-11 is earlier than invoice date 2026-05-10)' },
      ]);
      expect(notes).toContain('not sent because it is earlier than the invoice date) The printed dates may be day/month/year: read that way, the invoice date is 2026-10-05 and the due date is 2026-11-04. Check the invoice.');
      const ordinary = workday.submitNewSupplierInvoice.mock.calls[0][1].buildNotes([]);
      expect(ordinary).toContain('Due Date (from document): 2026-04-11 The printed dates may be day/month/year');
    });

    it('sends no due date when none is printed', async () => {
      process.env.INVOICE_MOD_ENABLED = 'true';
      const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({ ...ibsEnrichmentResult, extractedDueDate: null });

      await processor({ data: [attachmentRequest('new-invoices/req-1/invoice.pdf')] } as any);

      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(submitArgs.dueDate).toBeUndefined();
      expect(submitArgs.buildNotes([])).not.toContain('Due Date');
    });
  });

  it('uses legal name on Slack when preferredName is not cached', async () => {
    process.env.INVOICE_MOD_ENABLED = 'true';
    const { processor, slack, invoiceEnrichment, invoiceLines, employees } = freshRequire();
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
    employees.getEmployeeWidByEmail.mockResolvedValue({
      workdayId: 'wid-jcarey',
      name: 'Joseph A Carey Jr.',
    });

    await processor({
      data: [{
        ...attachmentRequest('new-invoices/req-1/invoice.pdf'),
        assigneeEmail: 'jcarey@pgahq.com',
      }],
    } as any);

    expect(slack.notifyResult).toHaveBeenCalledWith(
      'create_invoice',
      'success',
      expect.any(Number),
      expect.objectContaining({
        assigneeName: 'Joseph A Carey Jr.',
      }),
    );
  });

  it('should create a new supplier invoice from an uploaded attachment', async () => {
    const { processor, workday, slack, invoiceEnrichment, invoiceLines } = freshRequire();
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

    const emailContext = {
      emailFrom: 'ap@vendor.com',
      subject: 'Please process',
      plainTextBody: 'Invoice attached',
    };
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      emailWorktags: {
        costCenter: { extracted: 'Technology', name: 'Technology', code: '72200' },
        event: { extracted: 'Championship', workdayId: 'event-wid' },
        lineOfBusiness: { extracted: 'Championships', referenceId: 'lob-id' },
        fund: { extracted: 'General', referenceId: 'fund-id' },
        spendCategory: { extracted: 'Services', name: 'Services', referenceId: 'spend-id' },
      },
    });
    const event = {
      data: [{
        ...attachmentRequest('new-invoices/req-1/invoice.pdf'),
        emailContext,
      }]
    };

    await expect(processor(event as any)).resolves.not.toThrow();

    expect(invoiceEnrichment.enrichInvoiceFromAttachments).toHaveBeenCalledTimes(1);
    expect(invoiceEnrichment.enrichInvoiceFromAttachments.mock.calls[0][4]).toEqual(emailContext);
    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][2]).toBe('Invoice attached');
    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][4]).toBeUndefined();

    expect(workday.submitNewSupplierInvoice).toHaveBeenCalledTimes(1);
    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.supplierWID).toBe('supplier-wid-1');
    expect(submitArgs.companyWID).toBe('Default_OCR_Company');
    expect(submitArgs.companyReferenceType).toBe('Company_Reference_ID');
    expect(submitArgs.attachments).toEqual([{
      fileName: 'invoice.pdf',
      contentType: 'application/pdf',
      base64Content: Buffer.from('fake-pdf-content').toString('base64')
    }]);
    expect(submitArgs.assigneeWID).toBeUndefined();

    expect(slack.notifyResult).toHaveBeenCalledWith(
      'create_invoice',
      'success',
      expect.any(Number),
      expect.objectContaining({
        invoiceWID: 'new-invoice-wid',
        invoiceNumber: 'SUPIN-412727',
        attachment: {
          fileName: 'invoice.pdf',
          contentType: 'application/pdf',
          sizeBytes: Buffer.byteLength('fake-pdf-content'),
          includedInline: true,
        }
      })
    );
  });

  it('snapshots the created invoice for scoring from the read-back create already did', async () => {
    const { processor, workday, slack, invoiceEnrichment, invoiceLines, database } = freshRequire();
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
    workday.submitNewSupplierInvoice.mockResolvedValueOnce({
      success: true,
      invoiceWID: 'new-invoice-wid',
      invoiceNumber: 'SUPIN-412727',
      appliedFallbacks: [],
      createdInvoice: {
        Invoice_Number: 'SUPIN-412727',
        Supplier_Reference: { ID: [{ $attributes: { type: 'Supplier_ID' }, $value: 'S-1' }] },
        Control_Amount_Total: '100',
      },
    });

    await processor({ data: [{ ...attachmentRequest('new-invoices/req-1/invoice.pdf'), conversationId: 'conv-1' }] } as any);

    const db = await database.getDatabaseConnection();
    const insert = db.query.mock.calls.find(([sql]: [string]) => sql.includes('INSERT INTO agent_invoice_snapshots'));
    expect(insert).toBeDefined();
    const params = insert[1];
    expect(params[0]).toBe('new-invoice-wid');
    expect(params[1]).toBe('create');
    expect(params[2]).toBe('SUPIN-412727');
    expect(JSON.parse(params[3])).toEqual({ supplier: 'Supplier_ID=S-1', controlTotal: 100, lines: [] });
    expect(params[4]).toBe('conv-1');
    expect(JSON.parse(params[5])).toEqual(['new-invoices/req-1/invoice.pdf']);
    expect(params[8]).toBe('off');
    expect(slack.notifyResult).toHaveBeenCalledWith(
      'create_invoice',
      'success',
      expect.any(Number),
      expect.not.objectContaining({ snapshotSync: 'failed' }),
    );
  });

  it('still reports the created invoice when the scoring snapshot cannot be saved', async () => {
    const { processor, workday, slack, invoiceEnrichment, invoiceLines, database } = freshRequire();
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
    workday.submitNewSupplierInvoice.mockResolvedValueOnce({
      success: true,
      invoiceWID: 'new-invoice-wid',
      invoiceNumber: 'SUPIN-412727',
      appliedFallbacks: [],
      createdInvoice: { Invoice_Number: 'SUPIN-412727' },
    });
    const db = await database.getDatabaseConnection();
    db.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO agent_invoice_snapshots')) throw new Error('db down');
      return [];
    });

    await expect(processor({ data: [attachmentRequest('new-invoices/req-1/invoice.pdf')] } as any)).resolves.not.toThrow();

    expect(slack.notifyResult).toHaveBeenCalledWith(
      'create_invoice',
      'success',
      expect.any(Number),
      expect.objectContaining({ invoiceWID: 'new-invoice-wid', snapshotSync: 'failed' }),
    );
    db.query.mockReset();
    db.query.mockResolvedValue([]);
  });

  describe('Word and Excel attachments', () => {
    const xlsxType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const docxType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

    async function workbookBuffer(): Promise<Buffer> {
      const workbook = new ExcelJS.Workbook();
      workbook.addWorksheet('Hours').addRow(['Golfer', 'Hours']);
      return Buffer.from(await workbook.xlsx.writeBuffer());
    }

    it('attaches an Excel upload to Workday as the original file and hands enrichment the same bytes', async () => {
      const { processor, workday, s3, invoiceEnrichment, invoiceLines } = freshRequire();
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      const original = await workbookBuffer();
      s3.getBinaryFromS3.mockResolvedValue(original);

      await processor({
        data: [{ s3Key: 'new-invoices/req-xlsx/1-Timesheet.xlsx', fileName: 'Timesheet.xlsx', contentType: xlsxType }],
      } as any);

      const enrichmentAttachments = invoiceEnrichment.enrichInvoiceFromAttachments.mock.calls[0][1];
      expect(enrichmentAttachments[0]).toMatchObject({ fileName: 'Timesheet.xlsx', contentType: xlsxType });
      expect(enrichmentAttachments[0].buffer).toBe(original);
      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(submitArgs.attachments).toEqual([{
        fileName: 'Timesheet.xlsx',
        contentType: xlsxType,
        base64Content: original.toString('base64'),
      }]);
    });

    it('stops with an error and creates nothing when the invoice file cannot be opened', async () => {
      const { processor, workday, slack, invoiceEnrichment } = freshRequire();
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);

      await expect(processor({
        data: [{ s3Key: 'new-invoices/req-docx/1-Invoice.docx', fileName: 'Invoice.docx', contentType: docxType }],
      } as any)).rejects.toThrow('Invoice.docx could not be opened');

      expect(invoiceEnrichment.enrichInvoiceFromAttachments).not.toHaveBeenCalled();
      expect(workday.submitNewSupplierInvoice).not.toHaveBeenCalled();
      expect(slack.notifyResult).toHaveBeenCalledWith(
        'create_invoice',
        'error',
        expect.any(Number),
        expect.anything(),
        expect.objectContaining({ message: expect.stringContaining('Invoice.docx could not be opened') }),
      );
    });

    it('still creates the invoice when only a backup file cannot be opened and names it in Slack', async () => {
      const { processor, workday, slack, s3, clustering, invoiceEnrichment, invoiceLines, loadEnv } = freshRequire();
      loadEnv.mockResolvedValue({ INVOICE_ATTACHMENT_CLUSTERING_ENABLED: 'true' });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      s3.getBinaryFromS3.mockImplementation(async (_config: unknown, key: string) =>
        key.endsWith('.docx') ? Buffer.from('not a docx') : Buffer.from('fake-pdf-content')
      );
      const invoice = { s3Key: 'new-invoices/req-1/1-invoice.pdf', fileName: 'invoice.pdf', contentType: 'application/pdf', kind: 'supplier_invoice', confidence: 0.9 };
      const backup = { s3Key: 'new-invoices/req-1/2-backup.docx', fileName: 'backup.docx', contentType: docxType, kind: 'supporting', confidence: 0 };
      clustering.parseAndClusterInvoiceAttachments.mockResolvedValue({
        classified: [invoice, backup],
        clustering: { clusters: [{ primary: invoice, supporting: [backup], fallback: false }], unrelated: [] },
      });

      await processor({ data: [{ conversationId: '1234567890', attachments: [invoice, backup] }] } as any);

      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(submitArgs.attachments.map((att: { fileName: string }) => att.fileName)).toEqual(['invoice.pdf', 'backup.docx']);
      expect(slack.notifyResult).toHaveBeenCalledWith(
        'create_invoice',
        'success',
        expect.any(Number),
        expect.objectContaining({ unreadableAttachments: ['backup.docx'] }),
      );
    });
  });

  it('attaches the conversation transcript without sending it to enrichment', async () => {
    const { processor, workday, slack, invoiceEnrichment, invoiceLines } = freshRequire();
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
    const transcriptName = 'pga_corp_accounts_payable_2026_09_21_215476033237026.pdf';

    await processor({
      data: [{
        ...attachmentRequest('new-invoices/req-transcript/invoice.pdf'),
        conversationPdf: {
          s3Key: 'new-invoices/req-transcript/pga_corp_accounts_payable_2026_09_21_215476033237026.pdf',
          fileName: transcriptName,
        },
      }],
    } as any);

    const enrichmentAttachments = invoiceEnrichment.enrichInvoiceFromAttachments.mock.calls[0][1];
    expect(enrichmentAttachments).toHaveLength(1);
    expect(enrichmentAttachments[0].fileName).toBe('invoice.pdf');

    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.attachments).toEqual([
      {
        fileName: 'invoice.pdf',
        contentType: 'application/pdf',
        base64Content: Buffer.from('fake-pdf-content').toString('base64'),
      },
      {
        fileName: transcriptName,
        contentType: 'application/pdf',
        base64Content: Buffer.from('fake-pdf-content').toString('base64'),
      },
    ]);
    expect(slack.notifyResult).toHaveBeenCalledWith(
      'create_invoice',
      'success',
      expect.any(Number),
      expect.objectContaining({ conversationTranscriptFileName: transcriptName }),
    );
  });

  it('should create one invoice for each processor record', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

    await processor({
      data: [
        attachmentRequest('new-invoices/req-1/invoice.pdf'),
        attachmentRequest('new-invoices/req-1/support.pdf', 'support.pdf'),
      ]
    } as any);

    expect(workday.submitNewSupplierInvoice).toHaveBeenCalledTimes(2);
  });

  it('concatenates Hashrocket Activity and Description into Workday line item description', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      extractedAmountDue: '$4,960.00',
      extractedPurchaseOrderNumber: 'PO-413898',
      extractedServicePeriod: '9/7/26 - 9/13/26',
      extractedInvoiceLines: [
        {
          description: 'Project Management',
          descriptionCells: ['', 'Ryan Poland', 'Project Management', '32', '155.00', '4,960.00'],
          quantity: 32,
          unitCost: '155.00',
          totalPrice: '4,960.00',
          hasDiscount: false,
        }
      ]
    });
    invoiceLines.buildFinalInvoiceLines.mockImplementation(async (extracted: typeof baseEnrichmentResult.extractedInvoiceLines) => ({
      lines: [{
        lineOrder: 1,
        description: extracted[0].description,
        memo: 'Project management services for Ryan Poland',
        quantity: 32,
        unitCost: 155,
        extendedAmount: 4960,
      }],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false },
      relatedLobByCostCenter: new Map(),
    }));

    await processor({
      data: [attachmentRequest('new-invoices/req-hashrocket/invoice.pdf')]
    } as any);

    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0][0].description).toBe(
      'Ryan Poland - Project Management'
    );
    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.finalLines[0].description).toBe('Ryan Poland - Project Management');
    expect(submitArgs.finalLines[0].memo).toBe(
      'PO-413898 Svc Prd 09/07/26 - 09/13/26 project management services for Ryan Poland'
    );
    expect(submitArgs.finalLines[0].description).not.toContain('PO-413898');
  });

  it('should exclude freight/shipping extracted lines from merge and still submit Freight_Amount', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      extractedAmountDue: '$115.00',
      extractedFreightAmount: '$15.00',
      extractedInvoiceLines: [
        { description: 'Widgets', quantity: 2, unitCost: '50.00', totalPrice: '100.00', hasDiscount: false },
        { description: 'Shipping', quantity: 1, unitCost: '15.00', totalPrice: '15.00', hasDiscount: false }
      ]
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

    await processor({
      data: [attachmentRequest('new-invoices/req-freight/invoice.pdf')]
    } as any);

    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0]).toEqual([
      { description: 'Widgets', quantity: 2, unitCost: '50.00', totalPrice: '100.00', hasDiscount: false }
    ]);
    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.extractedFreightAmount).toBe('$15.00');
  });

  it('classifies freight from the original Description column before composing row text', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      extractedAmountDue: '$115.00',
      extractedFreightAmount: '$15.00',
      extractedInvoiceLines: [
        { description: 'Widgets', quantity: 2, unitCost: '50.00', totalPrice: '100.00', hasDiscount: false },
        {
          description: 'Shipping',
          descriptionCells: ['Ryan Poland', 'Shipping'],
          quantity: 1,
          unitCost: '15.00',
          totalPrice: '15.00',
          hasDiscount: false,
        }
      ]
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

    await processor({
      data: [attachmentRequest('new-invoices/req-freight-cells/invoice.pdf')]
    } as any);

    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0]).toEqual([
      { description: 'Widgets', quantity: 2, unitCost: '50.00', totalPrice: '100.00', hasDiscount: false }
    ]);
    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.extractedFreightAmount).toBe('$15.00');
  });

  it('should submit amount-only lines with quantity zero when the invoice has no quantity column', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      invoiceLineQuantityDisplayed: false,
      extractedInvoiceLines: [
        { description: 'Janitorial', quantity: null, unitCost: null, totalPrice: '1250.00', hasDiscount: false }
      ]
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue({
      lines: [{ lineOrder: 1, description: 'Janitorial', quantity: null, unitCost: null, extendedAmount: 1250 }],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false },
      relatedLobByCostCenter: new Map()
    });

    await processor({
      data: [attachmentRequest('new-invoices/req-no-qty/invoice.pdf')]
    } as any);

    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][6]).toBe(false);
    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.invoiceLineQuantityDisplayed).toBe(false);
    expect(submitArgs.finalLines[0]).toMatchObject({
      quantity: 0,
      unitCost: 0,
      extendedAmount: 1250,
    });
  });

  it('should submit amount-only lines when quantity times unit cost does not equal extended amount', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      invoiceLineQuantityDisplayed: true,
      extractedInvoiceLines: [
        { description: 'Sintra Signs', quantity: 37, unitCost: '29.88', totalPrice: '1105.49', hasDiscount: false }
      ]
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue({
      lines: [{ lineOrder: 1, description: 'Sintra Signs', quantity: 37, unitCost: 29.88, extendedAmount: 1105.49 }],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false },
      relatedLobByCostCenter: new Map()
    });

    await processor({
      data: [attachmentRequest('new-invoices/req-qty-mismatch/invoice.pdf')]
    } as any);

    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.invoiceLineQuantityDisplayed).toBeUndefined();
    expect(submitArgs.finalLines[0]).toMatchObject({
      quantity: 0,
      unitCost: 0,
      extendedAmount: 1105.49,
    });
  });

  it('should round the LevelBlue unit cost, keep the line total, and note the doubled line sum', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      extractedAmountDue: '$5,500.00',
      extractedTaxAmount: '$0.00',
      extractedTaxLabel: 'Tax',
      invoiceLineQuantityDisplayed: true,
      extractedInvoiceLines: [
        { description: 'PSO-RISK-ADVISORY - Consultant', quantity: 24.45, unitCost: '$224.9488753', totalPrice: '$5,500.00', hasDiscount: null },
        { description: "PSO-RISK-ADVISORY - Sep'26 - 5,500 per month", quantity: 1, unitCost: '5,500.00', totalPrice: '5,500.00', hasDiscount: null }
      ]
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue({
      lines: [
        { lineOrder: 1, description: 'PSO-RISK-ADVISORY - Consultant', quantity: 24.45, unitCost: 224.9488753, extendedAmount: 5500 },
        { lineOrder: 2, description: "PSO-RISK-ADVISORY - Sep'26 - 5,500 per month", quantity: 1, unitCost: 5500, extendedAmount: 5500 }
      ],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false },
      relatedLobByCostCenter: new Map()
    });

    await processor({
      data: [attachmentRequest('new-invoices/req-levelblue/invoice.pdf')]
    } as any);

    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.extractedAmountDue).toBe('$5,500.00');
    expect(submitArgs.finalLines[0]).toMatchObject({ quantity: 24.45, unitCost: 224.948875, extendedAmount: 5500 });
    expect(submitArgs.buildNotes([])).toContain(
      'Line total review: Invoice lines total $11,000.00, but the amount due $5,500.00 less freight $0.00 and tax $0.00 is $5,500.00. Check for a duplicated or summary line, or a payment, credit, or discount applied outside the lines, before approving.'
    );
  });

  describe('SUPIN-471803 single price beside a quantity', () => {
    const participants = {
      description: 'Bank of America x Golf with Us/First Tee Programming Participant Fees',
      quantity: 9,
      unitCost: null,
      totalPrice: '$75.00',
      hasDiscount: false
    };
    const built = {
      lines: [{ lineOrder: 1, description: participants.description, quantity: 9, unitCost: 75, extendedAmount: 675 }],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false },
      relatedLobByCostCenter: new Map()
    };

    it('books the price as the unit cost when quantity x price is the amount due', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, slack } = freshRequire();
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...baseEnrichmentResult,
        extractedAmountDue: '$675.00',
        extractedInvoiceLines: [participants]
      });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(built);

      await processor({ data: [attachmentRequest('new-invoices/req-single-price/invoice.pdf')] } as any);

      expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0]).toEqual([
        { ...participants, unitCost: '$75.00', totalPrice: '$675.00' }
      ]);
      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(submitArgs.finalLines[0]).toMatchObject({ quantity: 9, unitCost: 75, extendedAmount: 675 });
      const notes = submitArgs.buildNotes([]);
      expect(notes).toContain('Line price review: "Bank of America x Golf with Us/First Tee Programming Part..." prints quantity 9 and one price of $75.00.');
      expect(notes).toContain('Qty: 9 | Total: $75.00');
      expect(notes).not.toContain('Amount check');
      expect(notes).not.toContain('Line total review');
      const slackDetails = slack.notifyResult.mock.calls[0][3];
      expect(slackDetails.lineReview).toEqual([expect.stringContaining('Line price review:')]);
      expect(slackDetails.chargeCheck).toBeUndefined();
    });

    it('keeps the line total when it is the amount due', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...baseEnrichmentResult,
        extractedAmountDue: '$75.00',
        extractedInvoiceLines: [participants]
      });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(built);

      await processor({ data: [attachmentRequest('new-invoices/req-single-price-total/invoice.pdf')] } as any);

      expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0]).toEqual([participants]);
      expect(workday.submitNewSupplierInvoice.mock.calls[0][1].buildNotes([])).not.toContain('Line price review');
    });

    it('keeps the amount mismatch when neither reading reconciles', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...baseEnrichmentResult,
        extractedAmountDue: '$700.00',
        extractedInvoiceLines: [participants]
      });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(built);

      await processor({ data: [attachmentRequest('new-invoices/req-single-price-neither/invoice.pdf')] } as any);

      expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0]).toEqual([participants]);
      expect(workday.submitNewSupplierInvoice.mock.calls[0][1].buildNotes([])).not.toContain('Line price review');
    });
  });

  describe('SUPIN-472062 line total read as the tax-inclusive amount due', () => {
    const esign = supin472062EsignRow;
    const built = {
      lines: [{ lineOrder: 1, description: esign.description, quantity: 23, unitCost: 1.25, extendedAmount: 28.75 }],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false },
      relatedLobByCostCenter: new Map()
    };
    const enrichment = (overrides: Record<string, unknown> = {}) => ({
      ...baseEnrichmentResult,
      ...supin472062Header,
      extractedInvoiceLines: supin472062Rows,
      ...overrides
    });

    it('sets the line total to quantity x unit price so the lines and tax match the amount due', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, slack } = freshRequire();
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(enrichment());
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(built);

      await processor({ data: [attachmentRequest('new-invoices/req-esign-total/invoice.pdf')] } as any);

      expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0]).toEqual([supin472062CorrectedEsignRow]);
      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(submitArgs.finalLines[0]).toMatchObject({ quantity: 23, unitCost: 1.25, extendedAmount: 28.75 });
      const notes = submitArgs.buildNotes([]);
      expect(notes).toContain('Line price review: "eSign Non 8879" prints quantity 23 at $1.25 ($28.75) but a line total of $30.65.');
      expect(notes).not.toContain('Amount check');
      expect(notes).not.toContain('Line total review');
      expect(notes).not.toContain('Line subtotal review');
      const slackDetails = slack.notifyResult.mock.calls[0][3];
      expect(slackDetails.lineReview).toEqual([expect.stringContaining('Line price review:')]);
      expect(slackDetails.chargeCheck).toBeUndefined();
    });

    it('keeps the printed line total when a deposit or payment is printed', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(enrichment({
        extractedPriorPayments: [{ label: 'Payments Received', amount: '$5.00' }]
      }));
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(built);

      await processor({ data: [attachmentRequest('new-invoices/req-esign-payments/invoice.pdf')] } as any);

      expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0]).toEqual([supin472062EsignRow]);
      expect(workday.submitNewSupplierInvoice.mock.calls[0][1].buildNotes([])).not.toContain('Line price review');
    });

    it('keeps the amount mismatch when quantity x unit price does not reconcile either', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(enrichment({ extractedAmountDue: '$40.00' }));
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(built);

      await processor({ data: [attachmentRequest('new-invoices/req-esign-neither/invoice.pdf')] } as any);

      expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0]).toEqual([supin472062EsignRow]);
      expect(workday.submitNewSupplierInvoice.mock.calls[0][1].buildNotes([])).not.toContain('Line price review');
    });
  });

  it('should not add a line total review note when lines match the amount due', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      extractedAmountDue: '$5,500.00',
      invoiceLineQuantityDisplayed: true,
      extractedInvoiceLines: [
        { description: 'PSO-RISK-ADVISORY - Consultant', quantity: 24.45, unitCost: '$224.9488753', totalPrice: '$5,500.00', hasDiscount: null }
      ]
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue({
      lines: [{ lineOrder: 1, description: 'PSO-RISK-ADVISORY - Consultant', quantity: 24.45, unitCost: 224.9488753, extendedAmount: 5500 }],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false },
      relatedLobByCostCenter: new Map()
    });

    await processor({
      data: [attachmentRequest('new-invoices/req-levelblue-single/invoice.pdf')]
    } as any);

    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.buildNotes([])).not.toContain('Line total review');
  });

  it('should drop the LevelBlue table that repeats the charge and keep the Sep\'26 row (SUPIN-465991)', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines, slack } = freshRequire();
    const monthly = { description: "PSO-RISK-ADVISORY - Sep'26 - 5,500 per month", quantity: 1, unitCost: '5,500.00', totalPrice: '5,500.00', hasDiscount: null, tableNumber: 2 };
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      extractedAmountDue: '$5,500.00',
      extractedTaxAmount: '$0.00',
      extractedTaxLabel: 'Tax',
      invoiceLineQuantityDisplayed: true,
      extractedInvoiceLines: [
        { description: 'PSO-RISK-ADVISORY - Consultant', quantity: 24.45, unitCost: '$224.9488753', totalPrice: '$5,500.00', hasDiscount: null, tableNumber: 1 },
        monthly,
      ]
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue({
      lines: [{ lineOrder: 1, description: monthly.description, quantity: 1, unitCost: 5500, extendedAmount: 5500 }],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false },
      relatedLobByCostCenter: new Map()
    });

    await processor({
      data: [attachmentRequest('new-invoices/req-levelblue-repeat/invoice.pdf')]
    } as any);

    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0]).toEqual([monthly]);
    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.finalLines).toHaveLength(1);
    const notes = submitArgs.buildNotes([]);
    expect(notes).toContain(
      'Repeated line review: Removed line "PSO-RISK-ADVISORY - Consultant" ($5,500.00) because table 1 repeats the charges in table 2: each table totals $5,500.00, the amount due less freight and tax. Kept table 2 because its lines state the service period.'
    );
    expect(notes).not.toContain('Line total review');
    expect(slack.notifyResult.mock.calls[0][3].lineReview).toEqual([
      expect.stringMatching(/^Repeated line review: Removed line "PSO-RISK-ADVISORY - Consultant"/),
    ]);
  });

  describe('SUPIN-471364 timekeeper summary beside the time entries', () => {
    const summaryRows = [
      { description: 'Deutsch, Ben', quantity: 0.9, unitCost: '1,828.00', totalPrice: null, hasDiscount: false, tableNumber: 1 },
      { description: 'Oram, Jon', quantity: 0.3, unitCost: '2,525.00', totalPrice: null, hasDiscount: false, tableNumber: 1 },
    ];
    const entryRows = [
      { description: '09/09/26 - Deutsch, Ben - Update meeting.', quantity: 0.4, unitCost: '1,828.00', totalPrice: null, hasDiscount: false, tableNumber: 2 },
      { description: '09/09/26 - Oram, Jon - Conf call with working group', quantity: 0.3, unitCost: '2,525.00', totalPrice: null, hasDiscount: false, tableNumber: 2 },
      { description: '09/15/26 - Deutsch, Ben - Review of partner add-on deck.', quantity: 0.5, unitCost: '1,828.00', totalPrice: null, hasDiscount: false, tableNumber: 2 },
    ];
    const mergedEntries = [
      { lineOrder: 1, description: entryRows[0].description, quantity: 0.4, unitCost: 1828, extendedAmount: 731.2 },
      { lineOrder: 2, description: entryRows[1].description, quantity: 0.3, unitCost: 2525, extendedAmount: 757.5 },
      { lineOrder: 3, description: entryRows[2].description, quantity: 0.5, unitCost: 1828, extendedAmount: 914 },
    ];

    function arrange(extractedInvoiceLines: unknown[], extractedLineSubtotal = { label: 'Total Legal Fees', amount: '$2,402.70' }) {
      const mocks = freshRequire();
      mocks.invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...baseEnrichmentResult,
        extractedAmountDue: '$2,402.70',
        extractedLineSubtotal,
        invoiceLineQuantityDisplayed: true,
        extractedInvoiceLines,
      });
      mocks.invoiceLines.buildFinalInvoiceLines.mockResolvedValue({
        lines: mergedEntries,
        appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false },
        relatedLobByCostCenter: new Map()
      });
      return mocks;
    }

    it('submits only the dated time entries and explains the removed summary rows', async () => {
      const { processor, workday, invoiceLines, slack } = arrange([...summaryRows, ...entryRows]);

      await processor({ data: [attachmentRequest('new-invoices/req-law-firm/invoice.pdf')] } as any);

      expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0]).toEqual(entryRows);
      const notes = workday.submitNewSupplierInvoice.mock.calls[0][1].buildNotes([]);
      expect(notes).toContain(
        'Repeated line review: Removed lines "Deutsch, Ben" ($1,645.20), "Oram, Jon" ($757.50) because table 1 repeats the charges in table 2: each table totals $2,402.70, the amount due less freight and tax. Kept table 2 because its lines state the service period.'
      );
      expect(notes).not.toContain('Line total review');
      expect(notes).not.toContain('Line subtotal review');
      expect(slack.notifyResult.mock.calls[0][3].lineReview).toEqual([
        expect.stringMatching(/^Repeated line review: Removed lines "Deutsch, Ben"/),
      ]);
    });

    it('keeps the undated time entries on the same hours at the same rates', async () => {
      const undated = entryRows.map(row => ({ ...row, description: row.description.replace(/^\d\d\/\d\d\/\d\d - /, '') }));
      const { processor, workday, invoiceLines } = arrange([...summaryRows, ...undated]);

      await processor({ data: [attachmentRequest('new-invoices/req-law-firm-undated/invoice.pdf')] } as any);

      expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0]).toEqual(undated);
      expect(workday.submitNewSupplierInvoice.mock.calls[0][1].buildNotes([])).toContain(
        'Kept table 2 because its rows itemize the same hours at the same rates as table 1.'
      );
    });

    it.each([
      ['dated', (row: { description: string }) => row],
      ['undated', (row: { description: string }) => ({ ...row, description: row.description.replace(/^\d\d\/\d\d\/\d\d - /, '') })],
    ])('keeps every line and warns AP when the printed line total disagrees with %s time entries', async (_label, toEntry) => {
      const entries = entryRows.map(toEntry);
      const { processor, workday, invoiceLines } = arrange(
        [...summaryRows, ...entries],
        { label: 'Total Legal Fees', amount: '$4,805.40' }
      );
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue({
        lines: [...mergedEntries, { lineOrder: 4, description: 'Deutsch, Ben', quantity: 0.9, unitCost: 1828, extendedAmount: 1645.2 }],
        appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false },
        relatedLobByCostCenter: new Map()
      });

      await processor({ data: [attachmentRequest('new-invoices/req-law-firm-subtotal/invoice.pdf')] } as any);

      expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0]).toEqual([...summaryRows, ...entries]);
      const notes = workday.submitNewSupplierInvoice.mock.calls[0][1].buildNotes([]);
      expect(notes).not.toContain('Repeated line review');
      expect(notes).toContain('Line total review:');
    });

    it('submits only the priced summary when the time entries print no rate or amount', async () => {
      const unpriced = entryRows.map(row => ({ ...row, unitCost: null, totalPrice: null }));
      const { processor, workday, invoiceLines } = arrange([...summaryRows, ...unpriced]);
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue({
        lines: [
          { lineOrder: 1, description: 'Deutsch, Ben', quantity: 0.9, unitCost: 1828, extendedAmount: 1645.2 },
          { lineOrder: 2, description: 'Oram, Jon', quantity: 0.3, unitCost: 2525, extendedAmount: 757.5 },
        ],
        appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false },
        relatedLobByCostCenter: new Map()
      });

      await processor({ data: [attachmentRequest('new-invoices/req-law-firm-unpriced/invoice.pdf')] } as any);

      expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0]).toEqual(summaryRows);
      const notes = workday.submitNewSupplierInvoice.mock.calls[0][1].buildNotes([]);
      expect(notes).not.toContain('Line total review');
      expect(notes).not.toContain('Repeated line review');
    });
  });

  it('should keep both LevelBlue tables when extraction dropped a row without an amount', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
    const consultantRow = { description: 'PSO-RISK-ADVISORY - Consultant', quantity: 24.45, unitCost: '$224.9488753', totalPrice: '$5,500.00', hasDiscount: null, tableNumber: 1 };
    const monthly = { description: "PSO-RISK-ADVISORY - Sep'26 - 5,500 per month", quantity: 1, unitCost: '5,500.00', totalPrice: '5,500.00', hasDiscount: null, tableNumber: 2 };
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      extractedAmountDue: '$5,500.00',
      invoiceLineQuantityDisplayed: true,
      extractedInvoiceLines: [
        consultantRow,
        { description: 'Travel', quantity: null, unitCost: null, totalPrice: null, hasDiscount: null, tableNumber: 1 },
        monthly,
      ]
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue({
      lines: [
        { lineOrder: 1, description: consultantRow.description, quantity: 24.45, unitCost: 224.948875, extendedAmount: 5500 },
        { lineOrder: 2, description: monthly.description, quantity: 1, unitCost: 5500, extendedAmount: 5500 },
      ],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false },
      relatedLobByCostCenter: new Map()
    });

    await processor({
      data: [attachmentRequest('new-invoices/req-levelblue-dropped-row/invoice.pdf')]
    } as any);

    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0]).toEqual([consultantRow, monthly]);
    const notes = workday.submitNewSupplierInvoice.mock.calls[0][1].buildNotes([]);
    expect(notes).not.toContain('Repeated line review');
    expect(notes).toContain('Line total review: Invoice lines total $11,000.00');
  });

  it('should keep every line of a valid multi-line invoice from one table', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines, slack } = freshRequire();
    const extracted = [
      { description: 'Router', quantity: 2, unitCost: '250.00', totalPrice: '500.00', hasDiscount: null, tableNumber: 1 },
      { description: 'Install', quantity: 1, unitCost: '100.00', totalPrice: '100.00', hasDiscount: null, tableNumber: 1 },
    ];
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      extractedAmountDue: '$600.00',
      invoiceLineQuantityDisplayed: true,
      extractedInvoiceLines: extracted,
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue({
      lines: [
        { lineOrder: 1, description: 'Router', quantity: 2, unitCost: 250, extendedAmount: 500 },
        { lineOrder: 2, description: 'Install', quantity: 1, unitCost: 100, extendedAmount: 100 },
      ],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false },
      relatedLobByCostCenter: new Map()
    });

    await processor({
      data: [attachmentRequest('new-invoices/req-multi-line/invoice.pdf')]
    } as any);

    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0]).toEqual(extracted);
    const notes = workday.submitNewSupplierInvoice.mock.calls[0][1].buildNotes([]);
    expect(notes).not.toContain('Repeated line review');
    expect(notes).not.toContain('Line total review');
    expect(slack.notifyResult.mock.calls[0][3]).not.toHaveProperty('lineReview');
  });

  it('should create the invoice with every line and flag AP when the line total cannot be reconciled', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines, slack } = freshRequire();
    const extracted = [
      { description: 'Consulting', quantity: 1, unitCost: '5,500.00', totalPrice: '5,500.00', hasDiscount: null, tableNumber: 1 },
      { description: 'Out-of-scope work', quantity: 1, unitCost: '1,250.00', totalPrice: '1,250.00', hasDiscount: null, tableNumber: 2 },
    ];
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      extractedAmountDue: '$5,000.00',
      invoiceLineQuantityDisplayed: true,
      extractedInvoiceLines: extracted,
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue({
      lines: [
        { lineOrder: 1, description: 'Consulting', quantity: 1, unitCost: 5500, extendedAmount: 5500 },
        { lineOrder: 2, description: 'Out-of-scope work', quantity: 1, unitCost: 1250, extendedAmount: 1250 },
      ],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false },
      relatedLobByCostCenter: new Map()
    });

    await processor({
      data: [attachmentRequest('new-invoices/req-unreconciled/invoice.pdf')]
    } as any);

    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0]).toEqual(extracted);
    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.finalLines).toHaveLength(2);
    const notes = submitArgs.buildNotes([]);
    expect(notes).not.toContain('Repeated line review');
    expect(notes).toContain('Line total review: Invoice lines total $6,750.00, but the amount due $5,000.00');
    expect(slack.notifyResult.mock.calls[0][3].lineReview).toEqual([
      expect.stringMatching(/^Line total review: Invoice lines total \$6,750\.00/),
    ]);
  });

  it('submits a freight-only invoice as a coded freight line with no header freight', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
    const shipping = { description: 'Shipping', quantity: 1, unitCost: '15.00', totalPrice: '15.00', hasDiscount: false };
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      extractedAmountDue: '$15.00',
      extractedFreightAmount: '$15.00',
      extractedInvoiceLines: [shipping]
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue({
      lines: [{ lineOrder: 1, description: 'Shipping', quantity: 1, unitCost: 15, extendedAmount: 15, spendCategoryId: 'SC-Freight' }],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false },
      relatedLobByCostCenter: new Map()
    });

    await processor({
      data: [attachmentRequest('new-invoices/req-freight-only/invoice.pdf')]
    } as any);

    expect(invoiceLines.buildFinalInvoiceLines).toHaveBeenCalledTimes(1);
    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0]).toEqual([shipping]);
    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.extractedFreightAmount).toBe('$15.00');
    expect(submitArgs.freightAsLines).toBe(true);
    expect(submitArgs.finalLines).toEqual([
      expect.objectContaining({ description: 'Shipping', extendedAmount: 15 })
    ]);
  });

  it('withholds an unparseable extracted freight instead of submitting the freight row as the line', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
    const shipping = { description: 'Shipping', quantity: 1, unitCost: '15.00', totalPrice: '15.00', hasDiscount: false };
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      extractedAmountDue: '$15.00',
      extractedFreightAmount: 'n/a',
      extractedInvoiceLines: [shipping]
    });
    invoiceLines.buildFinalInvoiceLines
      .mockResolvedValueOnce({ lines: [], appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false }, relatedLobByCostCenter: new Map() })
      .mockResolvedValueOnce({
        lines: [{ lineOrder: 1, description: 'Invoice', quantity: 1, unitCost: 15, extendedAmount: 15 }],
        appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false },
        relatedLobByCostCenter: new Map()
      });

    await processor({
      data: [attachmentRequest('new-invoices/req-freight-na/invoice.pdf')]
    } as any);

    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0]).toEqual([]);
    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.freightAsLines).toBe(false);
    expect(submitArgs.extractedFreightAmount).toBeUndefined();
    expect(submitArgs.buildNotes([])).toContain('Freight/Tax review');
  });

  it('submits header-only freight as a synthesized freight line when no rows were extracted', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      extractedAmountDue: '$4,595.00',
      extractedFreightAmount: '$4,595.00',
      invoiceLineQuantityDisplayed: false,
      extractedInvoiceLines: null
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue({
      lines: [{ lineOrder: 1, description: 'Freight', quantity: null, unitCost: null, extendedAmount: 4595 }],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false },
      relatedLobByCostCenter: new Map()
    });

    await processor({
      data: [attachmentRequest('new-invoices/req-freight-header-only/invoice.pdf')]
    } as any);

    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0]).toEqual([
      { description: 'Freight', quantity: null, unitCost: null, totalPrice: '4595', hasDiscount: null }
    ]);
    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.extractedFreightAmount).toBe('$4,595.00');
    expect(submitArgs.freightAsLines).toBe(true);
  });

  describe('header freight already on an invoice line', () => {
    const myFreightWorldEnrichment = {
      ...baseEnrichmentResult,
      extractedAmountDue: '$4,595.00',
      extractedSuppliersInvoiceNumber: 'FRN52118INV2',
      extractedFreightAmount: '$4,595.00',
      extractedTaxAmount: null,
      invoiceLineQuantityDisplayed: false,
      extractedInvoiceLines: [
        { description: 'FRN52118A - Freight Charge - 42,000.00 Pounds', quantity: 0, unitCost: null, totalPrice: '$4595.00', hasDiscount: null }
      ]
    };
    const carrierLine = {
      lines: [{ lineOrder: 1, description: 'FRN52118A - Freight Charge - 42,000.00 Pounds', quantity: 0, unitCost: 0, extendedAmount: 4595, spendCategoryId: 'SC-Freight' }],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false },
      relatedLobByCostCenter: new Map()
    };
    const allFreightNote = 'All-freight invoice: freight $4,595.00 submitted as an invoice line so it carries the line coding; header Freight_Amount is not set.';

    it('submits the MyFreightWorld carrier invoice (SUPIN-465729) as one coded freight line with no header freight', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, slack } = freshRequire();
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(myFreightWorldEnrichment);
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(carrierLine);

      await processor({
        data: [attachmentRequest('new-invoices/req-myfreightworld/invoice.pdf')]
      } as any);

      expect(invoiceLines.buildFinalInvoiceLines).toHaveBeenCalledTimes(1);
      expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0]).toEqual(myFreightWorldEnrichment.extractedInvoiceLines);
      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(submitArgs.extractedAmountDue).toBe('$4,595.00');
      expect(submitArgs.extractedFreightAmount).toBe('$4,595.00');
      expect(submitArgs.freightAsLines).toBe(true);
      expect(submitArgs.finalLines).toEqual([
        expect.objectContaining({ description: 'FRN52118A - Freight Charge - 42,000.00 Pounds', extendedAmount: 4595 })
      ]);
      expect(submitArgs.buildNotes([])).toContain(`Amount check: ${allFreightNote}`);
      expect(slack.notifyResult.mock.calls[0][3].chargeCheck).toEqual([allFreightNote]);
    });

    it('rebuilds the coded freight line without the PO when the PO merge returns none', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(myFreightWorldEnrichment);
      invoiceLines.buildFinalInvoiceLines
        .mockResolvedValueOnce({ lines: [], appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false }, relatedLobByCostCenter: new Map() })
        .mockResolvedValueOnce(carrierLine);

      await processor({
        data: [attachmentRequest('new-invoices/req-myfreightworld-empty-merge/invoice.pdf')]
      } as any);

      expect(invoiceLines.buildFinalInvoiceLines).toHaveBeenCalledTimes(2);
      expect(invoiceLines.buildFinalInvoiceLines.mock.calls[1][0]).toEqual(myFreightWorldEnrichment.extractedInvoiceLines);
      expect(invoiceLines.buildFinalInvoiceLines.mock.calls[1][1]).toBeUndefined();
      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(submitArgs.freightAsLines).toBe(true);
      expect(submitArgs.finalLines).toEqual([
        expect.objectContaining({ description: 'FRN52118A - Freight Charge - 42,000.00 Pounds', extendedAmount: 4595 })
      ]);
    });

    it('drops the freight-as-line sentence when submit reports the header-freight fallback', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(myFreightWorldEnrichment);
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(carrierLine);

      await processor({
        data: [attachmentRequest('new-invoices/req-myfreightworld-fallback/invoice.pdf')]
      } as any);

      const fallback = {
        field: 'chargeReconciliation',
        label: 'Freight could not be submitted as the invoice line after merge, so it was submitted as header Freight_Amount.',
      };
      const notes = workday.submitNewSupplierInvoice.mock.calls[0][1].buildNotes([fallback]);
      expect(notes).toContain(`Amount check: ${fallback.label}`);
      expect(notes).not.toContain(allFreightNote);
    });

    it('keeps an unrecognized single carrier line that equals header freight as the freight line', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
      const linehaul = { description: 'PRO 52118 - Linehaul - 42,000 lbs', quantity: 0, unitCost: null, totalPrice: '$4595.00', hasDiscount: null };
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...myFreightWorldEnrichment,
        extractedInvoiceLines: [linehaul]
      });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue({
        ...carrierLine,
        lines: [{ ...carrierLine.lines[0], description: linehaul.description }]
      });

      await processor({
        data: [attachmentRequest('new-invoices/req-linehaul/invoice.pdf')]
      } as any);

      expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0]).toEqual([linehaul]);
      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(submitArgs.extractedFreightAmount).toBe('$4,595.00');
      expect(submitArgs.freightAsLines).toBe(true);
      expect(submitArgs.buildNotes([])).toContain(
        'Header freight equals the only line ($4,595.00), so header Freight_Amount is not set. Check the extracted freight.'
      );
      expect(submitArgs.buildNotes([])).not.toContain('Removed invoice line');
      expect(submitArgs.buildNotes([])).not.toContain('Line total review');
    });

    it('keeps header freight and drops a tax row that repeats header tax on a goods invoice', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, slack } = freshRequire();
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...baseEnrichmentResult,
        extractedAmountDue: '$121.00',
        extractedFreightAmount: '$15.00',
        extractedTaxAmount: '$6.00',
        extractedInvoiceLines: [
          { description: 'Widgets', quantity: 2, unitCost: '50.00', totalPrice: '100.00', hasDiscount: false },
          { description: 'Shipping', quantity: 1, unitCost: '15.00', totalPrice: '15.00', hasDiscount: false },
          { description: 'Sales Tax', quantity: null, unitCost: null, totalPrice: '6.00', hasDiscount: false }
        ]
      });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

      await processor({
        data: [attachmentRequest('new-invoices/req-mixed-duplicate/invoice.pdf')]
      } as any);

      expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0].map((l: { description: string }) => l.description))
        .toEqual(['Widgets']);
      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(submitArgs.extractedFreightAmount).toBe('$15.00');
      expect(submitArgs.extractedTaxAmount).toBe('$6.00');
      expect(submitArgs.freightAsLines).toBe(false);
      const removal = 'Removed invoice line "Sales Tax" ($6.00): that amount is already on the header Tax_Amount.';
      expect(submitArgs.buildNotes([])).toContain(`Amount check: ${removal}`);
      expect(slack.notifyResult.mock.calls[0][3].chargeCheck).toEqual([removal]);
    });

    it('reports the submit-time amount check under Amount check instead of fallbacks', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, slack } = freshRequire();
      const mismatch = 'Lines $4,695.00 + freight $4,595.00 + tax $0.00 = $9,290.00, but the amount due is $4,695.00. Review lines and header charges.';
      const amountCheck = { field: 'chargeReconciliation', label: mismatch };
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...baseEnrichmentResult,
        extractedAmountDue: '$4,695.00',
        extractedFreightAmount: '$4,595.00',
        extractedInvoiceLines: [
          { description: 'Widgets', quantity: 1, unitCost: '4595.00', totalPrice: '4595.00', hasDiscount: false },
          { description: 'Gadgets', quantity: 1, unitCost: '100.00', totalPrice: '100.00', hasDiscount: false }
        ]
      });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      workday.submitNewSupplierInvoice.mockResolvedValueOnce({
        success: true, invoiceWID: 'new-invoice-wid', invoiceNumber: 'SUPIN-412727', appliedFallbacks: [amountCheck]
      });

      await processor({
        data: [attachmentRequest('new-invoices/req-unreconciled/invoice.pdf')]
      } as any);

      expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0].map((l: { description: string }) => l.description))
        .toEqual(['Widgets', 'Gadgets']);
      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(submitArgs.extractedFreightAmount).toBe('$4,595.00');
      expect(submitArgs.buildNotes([])).not.toContain('Amount check');
      const notes = submitArgs.buildNotes([amountCheck]);
      expect(notes).toContain(`Amount check: ${mismatch}`);
      expect(notes).not.toContain('Fallback values applied');
      const slackDetails = slack.notifyResult.mock.calls[0][3];
      expect(slackDetails.chargeCheck).toEqual([mismatch]);
      expect(slackDetails.appliedFallbacks).toEqual([]);
    });
  });

  it('should synthesize a merchandise remainder on create when shipping is the only extracted line and amount due is larger', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      extractedAmountDue: '$115.00',
      extractedFreightAmount: '$15.00',
      extractedInvoiceLines: [
        { description: 'Shipping', quantity: 1, unitCost: '15.00', totalPrice: '15.00', hasDiscount: false }
      ]
    });
    invoiceLines.buildFinalInvoiceLines
      .mockResolvedValueOnce({
        lines: [],
        appliedFallbacks: { fund: false, costCenter: false, spendCategory: false }
      })
      .mockResolvedValueOnce({
        lines: [{ lineOrder: 1, description: 'Office supplies', quantity: 1, unitCost: 100 }],
        appliedFallbacks: { fund: false, costCenter: false, spendCategory: false }
      });

    await processor({
      data: [attachmentRequest('new-invoices/req-freight-remainder/invoice.pdf')]
    } as any);

    expect(invoiceLines.buildFinalInvoiceLines).toHaveBeenCalledTimes(2);
    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0]).toEqual([]);
    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[1][0]).toEqual([{
      description: 'Invoice',
      quantity: 1,
      unitCost: '100',
      totalPrice: '100',
      hasDiscount: null,
    }]);
    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.extractedFreightAmount).toBe('$15.00');
    expect(submitArgs.finalLines).toEqual([
      expect.objectContaining({ lineOrder: 1, description: 'Office supplies', quantity: 1, unitCost: 100 })
    ]);
  });

  describe('SUPIN-467011 printed environmental charge', () => {
    const incidentLines = [
      { description: 'KING tickets', quantity: null, unitCost: '180.50', totalPrice: '180.50', hasDiscount: false },
      { description: 'KARLESKNT tickets', quantity: null, unitCost: '162.00', totalPrice: '162.00', hasDiscount: false },
    ];
    const incidentFinalLines = {
      lines: [
        { lineOrder: 1, description: 'KING tickets', quantity: 0, unitCost: 0, extendedAmount: 180.5 },
        { lineOrder: 2, description: 'KARLESKNT tickets', quantity: 0, unitCost: 0, extendedAmount: 162 },
      ],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false }
    };
    const incident = {
      extractedAmountDue: '$387.76',
      extractedTaxAmount: '$28.26',
      extractedTaxLabel: 'Sales Tax',
      extractedInvoiceLines: incidentLines,
    };

    it('adds the EnvChg Tax row to header tax so lines + freight + tax equal the amount due', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, slack } = freshRequire();
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...baseEnrichmentResult,
        ...incident,
        extractedOtherCharges: [{ label: 'EnvChg Tax', amount: '$17.00' }],
      });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(incidentFinalLines);

      await processor({ data: [attachmentRequest('new-invoices/req-envchg/invoice.pdf')] } as any);

      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(submitArgs.extractedTaxAmount).toBe('45.26');
      expect(submitArgs.taxCleared).toBe(false);
      expect(submitArgs.extractedAmountDue).toBe('$387.76');
      const added = 'Added "EnvChg Tax" $17.00 to header Tax_Amount so lines, freight, and tax equal the amount due.';
      const notes = submitArgs.buildNotes([]);
      expect(notes).toContain('Tax Amount (from document): 45.26 ("Sales Tax" $28.26 + "EnvChg Tax" $17.00)');
      expect(notes).toContain(`Amount check: ${added}`);
      expect(notes).not.toContain('Line total review');
      expect(notes).not.toContain('but the amount due is');
      expect(slack.notifyResult.mock.calls[0][3].chargeCheck).toEqual([added]);
      expect(slack.notifyResult.mock.calls[0][3].amountMismatch).toBeUndefined();
    });

    it('keeps tax at 28.26 and flags the $17.00 gap when no charge explains it', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, slack } = freshRequire();
      const mismatch = 'Lines $342.50 + freight $0.00 + tax $28.26 = $370.76, but the amount due is $387.76. Review lines and header charges.';
      const amountCheck = { field: 'chargeReconciliation', label: mismatch };
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({ ...baseEnrichmentResult, ...incident, extractedOtherCharges: null });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(incidentFinalLines);
      workday.submitNewSupplierInvoice.mockResolvedValueOnce({
        success: true, invoiceWID: 'new-invoice-wid', invoiceNumber: 'SUPIN-467011', appliedFallbacks: [amountCheck]
      });

      await processor({ data: [attachmentRequest('new-invoices/req-envchg-missing/invoice.pdf')] } as any);

      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(submitArgs.extractedTaxAmount).toBe('$28.26');
      const notes = submitArgs.buildNotes([amountCheck]);
      expect(notes.startsWith(`Amount check: ${mismatch}`)).toBe(true);
      expect(notes.match(/Amount check:/g)).toHaveLength(1);
      const slackDetails = slack.notifyResult.mock.calls[0][3];
      expect(slackDetails.chargeCheck).toEqual([mismatch]);
      expect(slackDetails.amountMismatch).toBe(true);
    });

    it('leaves the gap alone when the printed charge is not the missing amount', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...baseEnrichmentResult,
        ...incident,
        extractedOtherCharges: [{ label: 'EnvChg Tax', amount: '$17.13' }],
      });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(incidentFinalLines);

      await processor({ data: [attachmentRequest('new-invoices/req-envchg-rate/invoice.pdf')] } as any);

      expect(workday.submitNewSupplierInvoice.mock.calls[0][1].extractedTaxAmount).toBe('$28.26');
    });
  });

  describe('totals-block charges (SUPIN-470485, SUPIN-467235)', () => {
    const appliedFallbacks = { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false };
    const mergeAsExtracted = (lines: Array<{ description: string; totalPrice: string | null }>) => Promise.resolve({
      lines: lines.map((line, index) => ({
        lineOrder: index + 1,
        description: line.description,
        quantity: null,
        unitCost: null,
        extendedAmount: Number(line.totalPrice),
      })),
      appliedFallbacks,
    });
    // Summit Golf Brands 1654146: Merchandise $282.50, Decoration $5.00, S&H $25.18, TOTAL $312.68.
    const summit = {
      extractedAmountDue: '$312.68',
      extractedFreightAmount: '$25.18',
      extractedFreightLabel: 'S&H',
      invoiceLineQuantityDisplayed: false,
      extractedInvoiceLines: [
        { description: 'Polo - Navy', quantity: null, unitCost: null, totalPrice: '180.00', hasDiscount: null },
        { description: 'Cap - White', quantity: null, unitCost: null, totalPrice: '102.50', hasDiscount: null },
      ],
      extractedSummaryCharges: [
        { label: 'Merchandise', amount: '$282.50' },
        { label: 'Decoration', amount: '$5.00' },
        { label: 'Sub Total', amount: '$287.50' },
        { label: 'TOTAL', amount: '$312.68' },
      ],
    };

    it('submits the SUPIN-470485 Decoration $5.00 as a line so the draft totals $312.68', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, slack } = freshRequire();
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({ ...baseEnrichmentResult, ...summit });
      invoiceLines.buildFinalInvoiceLines.mockImplementation(mergeAsExtracted);

      await processor({ data: [attachmentRequest('new-invoices/req-summit/invoice.pdf')] } as any);

      expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0].map((line: any) => [line.description, line.totalPrice]))
        .toEqual([['Polo - Navy', '180.00'], ['Cap - White', '102.50'], ['Decoration', '5.00']]);
      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(submitArgs.finalLines.map((line: any) => [line.description, line.extendedAmount]))
        .toEqual([['Polo - Navy', 180], ['Cap - White', 102.5], ['Decoration', 5]]);
      expect(submitArgs.extractedFreightAmount).toBe('$25.18');
      const added = 'Added "Decoration" $5.00 from the invoice totals as an invoice line so lines, freight, and tax equal the amount due.';
      const notes = submitArgs.buildNotes([]);
      expect(notes).toContain(`Amount check: ${added}`);
      expect(notes).not.toContain('Line total review');
      expect(notes).not.toContain('Totals charge review');
      expect(slack.notifyResult.mock.calls[0][3].chargeCheck).toEqual([added]);
      expect(slack.notifyResult.mock.calls[0][3]).not.toHaveProperty('lineReview');
    });

    it('still names the Decoration row when two email budgets rewrite the lines', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, slack } = freshRequire();
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({ ...baseEnrichmentResult, ...summit });
      // applyEmailBudgetSplits replaces the lines with one line per budget once they total the $287.50 budget base.
      const combined = 'Polo - Navy, Cap - White, Decoration';
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue({
        lines: [
          { lineOrder: 1, description: combined, quantity: null, unitCost: null, extendedAmount: 150, costCenterId: 'CC-Recruitment' },
          { lineOrder: 2, description: combined, quantity: null, unitCost: null, extendedAmount: 137.5, costCenterId: 'CC-Brand' },
        ],
        appliedFallbacks,
      });

      await processor({ data: [attachmentRequest('new-invoices/req-summit-budgets/invoice.pdf')] } as any);

      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(submitArgs.finalLines.map((line: any) => line.extendedAmount)).toEqual([150, 137.5]);
      const added = 'Added "Decoration" $5.00 from the invoice totals so lines, freight, and tax equal the amount due. "Decoration" $5.00 is included in the submitted lines but not as a separate line.';
      expect(submitArgs.buildNotes([])).toContain(`Amount check: ${added}`);
      expect(slack.notifyResult.mock.calls[0][3].chargeCheck).toEqual([added]);
    });

    it('submits the SUPIN-467235 Merchandise Discount as a -$13.80 line when the credit makes $70.20', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...baseEnrichmentResult,
        extractedAmountDue: '$70.20',
        extractedFreightAmount: '$10.00',
        extractedFreightLabel: 'Freight',
        invoiceLineQuantityDisplayed: false,
        extractedInvoiceLines: [
          { description: 'Towel - Tri-fold', quantity: null, unitCost: null, totalPrice: '69.00', hasDiscount: null },
          { description: 'Decoration', quantity: null, unitCost: null, totalPrice: '5.00', hasDiscount: null },
        ],
        extractedSummaryCharges: [{ label: 'Decoration', amount: '$5.00' }, { label: 'Merchandise Discount', amount: '$13.80' }],
      });
      invoiceLines.buildFinalInvoiceLines.mockImplementation(mergeAsExtracted);

      await processor({ data: [attachmentRequest('new-invoices/req-summit-discount/invoice.pdf')] } as any);

      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(submitArgs.finalLines.map((line: any) => [line.description, line.extendedAmount]))
        .toEqual([['Towel - Tri-fold', 69], ['Decoration', 5], ['Merchandise Discount', -13.8]]);
      expect(submitArgs.buildNotes([])).toContain('Added "Merchandise Discount" -$13.80 from the invoice totals as an invoice line');
    });

    it('submits the lines as read and gives both readings when only the charge reading adds up', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, slack } = freshRequire();
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...baseEnrichmentResult,
        extractedAmountDue: '$97.80',
        extractedFreightAmount: '$10.00',
        extractedFreightLabel: 'Freight',
        invoiceLineQuantityDisplayed: false,
        extractedInvoiceLines: [
          { description: 'Towel - Tri-fold', quantity: null, unitCost: null, totalPrice: '74.00', hasDiscount: null },
        ],
        extractedSummaryCharges: [{ label: 'Merchandise Discount', amount: '$13.80' }],
      });
      invoiceLines.buildFinalInvoiceLines.mockImplementation(mergeAsExtracted);

      await processor({ data: [attachmentRequest('new-invoices/req-summit-ambiguous/invoice.pdf')] } as any);

      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(submitArgs.finalLines).toHaveLength(1);
      const review = '"Merchandise Discount" $13.80 was not added: as a credit, lines, freight, and tax would total $70.20; as a charge, $97.80, which matches the amount due. Check which it is before approving.';
      const notes = submitArgs.buildNotes([]);
      expect(notes).toContain(`Totals charge review: ${review}`);
      expect(notes).toContain('Line total review');
      expect(notes).not.toContain('from the invoice totals as an invoice line');
      expect(slack.notifyResult.mock.calls[0][3].lineReview).toEqual(expect.arrayContaining([`Totals charge review: ${review}`]));
    });
  });

  it('moves a mislabeled sales-tax amount from freight to tax before submit', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      extractedAmountDue: '$9,025.24',
      extractedFreightAmount: '510.86',
      extractedFreightLabel: 'Sales Tax',
      extractedTaxAmount: '0',
      extractedInvoiceLines: [
        { description: 'Widgets', quantity: 1, unitCost: '3913.54', totalPrice: '3913.54', hasDiscount: false },
        { description: 'Gadgets', quantity: 1, unitCost: '3625.00', totalPrice: '3625.00', hasDiscount: false },
        { description: 'Accessories', quantity: 1, unitCost: '975.84', totalPrice: '975.84', hasDiscount: false },
      ]
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue({
      lines: [
        { lineOrder: 1, description: 'Widgets', quantity: 1, unitCost: 3913.54 },
        { lineOrder: 2, description: 'Gadgets', quantity: 1, unitCost: 3625.00 },
        { lineOrder: 3, description: 'Accessories', quantity: 1, unitCost: 975.84 },
      ],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false }
    });

    await processor({
      data: [attachmentRequest('new-invoices/req-sales-tax-as-freight/invoice.pdf')]
    } as any);

    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.extractedFreightAmount).toBeUndefined();
    expect(submitArgs.extractedTaxAmount).toBe('510.86');
    expect(submitArgs.freightCleared).toBe(true);
    expect(submitArgs.taxCleared).toBe(false);
  });

  it('submits freight rows as header freight when the header printed a zero freight', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      extractedAmountDue: '$125.00',
      extractedFreightAmount: '0.00',
      extractedFreightLabel: 'Shipping and Handling',
      extractedInvoiceLines: [
        { description: 'Radio', quantity: 1, unitCost: '100.00', totalPrice: '$100.00', hasDiscount: false },
        { description: 'Freight', quantity: 1, unitCost: '25.00', totalPrice: '$25.00', hasDiscount: false },
      ]
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue({
      lines: [{ lineOrder: 1, description: 'Radio', quantity: 1, unitCost: 100 }],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false }
    });

    await processor({
      data: [attachmentRequest('new-invoices/req-zero-header-freight/invoice.pdf')]
    } as any);

    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0]).toEqual([
      expect.objectContaining({ description: 'Radio' })
    ]);
    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.extractedFreightAmount).toBe('25');
    expect(submitArgs.freightCleared).toBe(false);
    expect(submitArgs.freightAsLines).toBeFalsy();
    expect(submitArgs.buildNotes([])).toContain(
      'Amount check: Header freight printed as zero, but the freight rows ($25.00) make up the rest of the amount due, so they count as the invoice freight.'
    );
  });

  it('does not attach a PO line id or splits to a synthesized remainder line', async () => {
    const venue = {
      ID: [
        { $attributes: { type: 'WID' }, $value: 'wid-VENU-Contestant_Indirect' },
        { $attributes: { type: 'Organization_Reference_ID' }, $value: 'VENU-Contestant_Indirect' }
      ]
    };
    const fundA = {
      ID: [
        { $attributes: { type: 'WID' }, $value: 'wid-FUND-A' },
        { $attributes: { type: 'Fund_ID' }, $value: 'FUND-A' }
      ]
    };
    const fundB = {
      ID: [
        { $attributes: { type: 'WID' }, $value: 'wid-FUND-B' },
        { $attributes: { type: 'Fund_ID' }, $value: 'FUND-B' }
      ]
    };
    const parsedPo = {
      documentNumber: 'PO-414498',
      company: {
        workdayId: 'pga-company-wid',
        descriptor: 'The Professional Golfers Association of America'
      },
      lines: [
        {
          lineOrder: 1,
          purchaseOrderLineId: 'POL-1',
          purchaseOrderDocumentNumber: 'PO-414498',
          description: 'Summit ENG',
          worktagsReference: [venue, fundA],
          lineLevelWorktagsReference: [venue, fundA],
          splitLineData: [{ extendedAmount: 100, worktagReference: [fundA] }]
        },
        {
          lineOrder: 2,
          purchaseOrderLineId: 'POL-2',
          purchaseOrderDocumentNumber: 'PO-414498',
          description: 'Hospitality',
          worktagsReference: [venue, fundB],
          lineLevelWorktagsReference: [venue, fundB],
          splitLineData: []
        }
      ]
    };

    const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
    workday.loadPurchaseOrder.mockResolvedValue(parsedPo);
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      extractedAmountDue: '$115.00',
      extractedFreightAmount: '$15.00',
      extractedPurchaseOrderNumber: 'PO-414498',
      extractedInvoiceLines: [
        { description: 'Shipping', quantity: 1, unitCost: '15.00', totalPrice: '15.00', hasDiscount: false }
      ]
    });
    invoiceLines.buildFinalInvoiceLines
      .mockResolvedValueOnce({
        lines: [],
        appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false }
      })
      .mockResolvedValueOnce({
        lines: [{
          lineOrder: 1,
          description: 'Invoice',
          quantity: 1,
          unitCost: 100,
          purchaseOrderLineId: 'POL-1',
          supplierInvoiceSplitLineData: [{ extendedAmount: 100, worktagReference: [fundA] }]
        }],
        appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false }
      });

    await processor({
      data: [{
        ...attachmentRequest('new-invoices/req-freight-remainder-po/invoice.pdf'),
        emailContext: { plainTextBody: 'Please process PO-414498' }
      }]
    } as any);

    expect(invoiceLines.buildFinalInvoiceLines).toHaveBeenCalledTimes(2);
    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[1][1]).toBeUndefined();
    const remainderSubmitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(remainderSubmitArgs.finalLines).toEqual([
      expect.objectContaining({
        lineOrder: 1,
        description: 'Invoice',
        purchaseOrderLineId: null,
        poPassthroughWorktagsReference: [venue]
      })
    ]);
    expect(remainderSubmitArgs.finalLines[0].supplierInvoiceSplitLineData).toBeUndefined();
  });

  it('should fall back to the default supplier WID when none is resolved', async () => {
    process.env.WORKDAY_DEFAULT_SUPPLIER_WID = 'default-supplier-wid';

    const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      supplier: { ...baseEnrichmentResult.supplier, status: 'not_found', resolvedSupplier: null }
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

    const event = {
      data: [attachmentRequest('new-invoices/req-2/invoice.pdf')]
    };

    await expect(processor(event as any)).resolves.not.toThrow();

    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.supplierWID).toBe('default-supplier-wid');
  });

  it('should synthesize a single invoice line when none can be extracted or matched to a PO', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      extractedInvoiceLines: null
    });
    invoiceLines.buildFinalInvoiceLines
      .mockResolvedValueOnce({ lines: [], appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false } })
      .mockResolvedValueOnce({
        lines: [{ lineOrder: 1, description: 'Office supplies', quantity: 1, unitCost: 100 }],
        appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false }
      });

    const event = {
      data: [attachmentRequest('new-invoices/req-3/invoice.pdf')]
    };

    await expect(processor(event as any)).resolves.not.toThrow();

    expect(invoiceLines.buildFinalInvoiceLines).toHaveBeenCalledTimes(2);
    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[1][0]).toEqual([{
      description: 'Invoice',
      quantity: 1,
      unitCost: '100',
      totalPrice: '100',
      hasDiscount: null,
    }]);
    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.finalLines).toEqual([
      expect.objectContaining({ lineOrder: 1, description: 'Office supplies', quantity: 1, unitCost: 100 })
    ]);
  });

  it('should notify an error and not submit when enrichment returns an error status', async () => {
    const { processor, workday, slack, invoiceEnrichment } = freshRequire();
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      supplier: { ...baseEnrichmentResult.supplier, status: 'error', reason: 'AI failure' }
    });

    const event = {
      data: [attachmentRequest('new-invoices/req-4/invoice.pdf')]
    };

    await expect(processor(event as any)).rejects.toThrow('Invoice enrichment returned error status');

    expect(workday.submitNewSupplierInvoice).not.toHaveBeenCalled();
    expect(slack.notifyResult).toHaveBeenCalledWith(
      'create_invoice',
      'error',
      expect.any(Number),
      expect.objectContaining({ s3Key: 'new-invoices/req-4/invoice.pdf' }),
      expect.any(Error)
    );
  });

  it('names the person who triggered a failed create on the Slack error', async () => {
    const { processor, slack, invoiceEnrichment, employees } = freshRequire();
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      supplier: { ...baseEnrichmentResult.supplier, status: 'error', reason: 'AI failure' }
    });
    employees.getEmployeeWidByEmail.mockResolvedValue({
      workdayId: 'wid-jcarey',
      name: 'Joseph A Carey Jr.',
      preferredName: 'Joe Carey',
    });

    await expect(processor({
      data: [{ ...attachmentRequest('new-invoices/req-4/invoice.pdf'), assigneeEmail: 'jcarey@pgahq.com' }]
    } as any)).rejects.toThrow('Invoice enrichment returned error status');

    expect(employees.getEmployeeWidByEmail).toHaveBeenCalledWith(expect.anything(), 'jcarey@pgahq.com');
    expect(slack.notifyResult).toHaveBeenCalledWith(
      'create_invoice',
      'error',
      expect.any(Number),
      expect.objectContaining({ triggeredByEmail: 'jcarey@pgahq.com', triggeredByName: 'Joe Carey' }),
      expect.any(Error)
    );
  });

  it('still Slacks the create error with the trigger email when the employee query fails', async () => {
    const { processor, slack, invoiceEnrichment, employees, database } = freshRequire();
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      supplier: { ...baseEnrichmentResult.supplier, status: 'error', reason: 'AI failure' }
    });
    employees.getEmployeeWidByEmail.mockImplementation(jest.requireActual('../lib/employees.js').getEmployeeWidByEmail);
    const query = jest.fn((sql: string) => sql.includes("type = 'employee'")
      ? Promise.reject(new Error('database unavailable'))
      : Promise.resolve([]));
    database.getDatabaseConnection.mockResolvedValue({ query, close: jest.fn().mockResolvedValue({}) });

    await expect(processor({
      data: [{ ...attachmentRequest('new-invoices/req-4/invoice.pdf'), assigneeEmail: 'jcarey@pgahq.com' }]
    } as any)).rejects.toThrow('Invoice enrichment returned error status');

    expect(query).toHaveBeenCalledWith(expect.stringContaining("type = 'employee'"), ['jcarey@pgahq.com']);
    expect(slack.notifyResult).toHaveBeenCalledTimes(1);
    const details = slack.notifyResult.mock.calls[0][3];
    expect(details).toMatchObject({ triggeredByEmail: 'jcarey@pgahq.com' });
    expect(details).not.toHaveProperty('triggeredByName');
  });

  it('reuses the assignee lookup for the trigger name when the create fails after it', async () => {
    process.env.INVOICE_MOD_ENABLED = 'true';
    const { processor, workday, slack, invoiceEnrichment, invoiceLines, employees } = freshRequire();
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
    employees.getEmployeeWidByEmail.mockResolvedValue({ workdayId: 'wid-jcarey', preferredName: 'Joe Carey' });
    workday.submitNewSupplierInvoice.mockRejectedValue(new Error('Workday down'));

    await expect(processor({
      data: [{ ...attachmentRequest('new-invoices/req-4/invoice.pdf'), assigneeEmail: 'jcarey@pgahq.com' }]
    } as any)).rejects.toThrow('Workday down');

    expect(employees.getEmployeeWidByEmail).toHaveBeenCalledTimes(1);
    expect(slack.notifyResult).toHaveBeenCalledWith(
      'create_invoice',
      'error',
      expect.any(Number),
      expect.objectContaining({ triggeredByEmail: 'jcarey@pgahq.com', triggeredByName: 'Joe Carey' }),
      expect.any(Error)
    );
  });

  it('includes conversation link and priorFailures on Slack success details', async () => {
    process.env.INTERCOM_APP_ID = 'c722leqk';
    const { processor, workday, slack, invoiceEnrichment, invoiceLines } = freshRequire();
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
    workday.submitNewSupplierInvoice.mockResolvedValue({
      success: true,
      invoiceWID: 'new-invoice-wid',
      invoiceNumber: 'SUPIN-412727',
      appliedFallbacks: [],
      priorFailures: [
        { attempt: 1, message: "Enter a Supplier's Invoice Number that isn't already in use..." },
      ],
    });

    await expect(processor({
      data: [{
        ...attachmentRequest('new-invoices/req-conv/invoice.pdf'),
        conversationId: '1234567890',
        intercomAppId: 'sandbox-app',
      }]
    } as any)).resolves.not.toThrow();

    expect(slack.notifyResult).toHaveBeenCalledWith(
      'create_invoice',
      'success',
      expect.any(Number),
      expect.objectContaining({
        invoiceWID: 'new-invoice-wid',
        invoiceNumber: 'SUPIN-412727',
        conversationId: '1234567890',
        conversationUrl: 'https://app.intercom.com/a/inbox/c722leqk/inbox/conversation/1234567890',
        priorFailures: [
          { attempt: 1, message: "Enter a Supplier's Invoice Number that isn't already in use..." },
        ],
      })
    );
    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.conversationUrl).toBe('https://app.intercom.com/a/inbox/c722leqk/inbox/conversation/1234567890');
    expect(submitArgs.conversationUrl).toBe(slack.notifyResult.mock.calls[0][3].conversationUrl);
  });

  it('does not pass a conversation URL to Workday without a conversationId', async () => {
    process.env.INTERCOM_APP_ID = 'c722leqk';
    const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

    await processor({ data: [attachmentRequest('new-invoices/req-no-conv/invoice.pdf')] } as any);

    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs).not.toHaveProperty('conversationUrl');
  });

  it('forwards conversationCreatedAt as invoiceReceivedDate to Workday submit', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
    await processor({
      data: [{
        ...attachmentRequest('new-invoices/req-received/invoice.pdf'),
        conversationId: '1234567890',
        conversationCreatedAt: '2024-03-15',
      }]
    } as any);

    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.invoiceReceivedDate).toBe('2024-03-15');
  });

  it('includes conversationId on Slack error details', async () => {
    process.env.INTERCOM_APP_ID = 'c722leqk';
    const { processor, slack, invoiceEnrichment } = freshRequire();
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      supplier: { ...baseEnrichmentResult.supplier, status: 'error', reason: 'AI failure' }
    });

    await expect(processor({
      data: [{
        ...attachmentRequest('new-invoices/req-conv-err/invoice.pdf'),
        conversationId: '1234567890',
        intercomAppId: 'sandbox-app',
      }]
    } as any)).rejects.toThrow('Invoice enrichment returned error status');

    expect(slack.notifyResult).toHaveBeenCalledWith(
      'create_invoice',
      'error',
      expect.any(Number),
      expect.objectContaining({
        s3Key: 'new-invoices/req-conv-err/invoice.pdf',
        conversationId: '1234567890',
        conversationUrl: 'https://app.intercom.com/a/inbox/c722leqk/inbox/conversation/1234567890',
      }),
      expect.any(Error)
    );
  });

  it('should not submit when invoice modification is disabled', async () => {
    process.env.INVOICE_MOD_ENABLED = 'false';

    const { processor, workday, slack } = freshRequire();

    const event = {
      data: [attachmentRequest('new-invoices/req-5/invoice.pdf')]
    };

    await expect(processor(event as any)).resolves.not.toThrow();

    expect(workday.submitNewSupplierInvoice).not.toHaveBeenCalled();
    expect(slack.notifyResult).toHaveBeenCalledWith(
      'create_invoice',
      'error',
      expect.any(Number),
      expect.objectContaining({ s3Key: 'new-invoices/req-5/invoice.pdf' }),
      expect.any(Error)
    );
  });

  it('should use the recommended company WID (type WID) when company verification finds a different company', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      companyVerification: {
        status: 'different',
        confidence: 0.9,
        extractedInformation: {},
        recommended: { workdayId: 'company-wid-1', companyName: 'Real Company', confidence: 0.9, reason: 'Better match' },
        reason: 'Extracted company differs from the default placeholder'
      }
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

    const event = {
      data: [attachmentRequest('new-invoices/req-6/invoice.pdf')]
    };

    await expect(processor(event as any)).resolves.not.toThrow();

    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.companyWID).toBe('company-wid-1');
    expect(submitArgs.companyReferenceType).toBe('WID');
  });

  it('should use Default OCR Company when no PO is present', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines, database } = freshRequire();
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

    const event = {
      data: [attachmentRequest('new-invoices/req-7/invoice.pdf')]
    };

    await expect(processor(event as any)).resolves.not.toThrow();

    expect(database.findCompanyByName).not.toHaveBeenCalled();
    expect(invoiceEnrichment.enrichInvoiceFromAttachments.mock.calls[0][3]).toEqual({
      descriptor: 'Default OCR Company',
      id: 'Default_OCR_Company'
    });
    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.companyWID).toBe('Default_OCR_Company');
    expect(submitArgs.companyReferenceType).toBe('Company_Reference_ID');
  });

  it('should fetch a PO from email before enrichment and use the PO company', async () => {
    const parsedPo = {
      documentNumber: 'PO-414498',
      company: {
        workdayId: 'pga-company-wid',
        descriptor: 'The Professional Golfers Association of America'
      },
      lines: [{
        lineOrder: 1,
        purchaseOrderLineId: 'POL-1',
        purchaseOrderDocumentNumber: 'PO-414498',
        description: 'Summit ENG'
      }]
    };

    const { processor, workday, invoiceEnrichment, invoiceLines, database } = freshRequire();
    workday.loadPurchaseOrder.mockResolvedValue(parsedPo);
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      companyVerification: {
        ...baseEnrichmentResult.companyVerification,
        status: 'matching',
        reason: 'Bill-to matches the PO company'
      },
      extractedPurchaseOrderNumber: 'PO-414498'
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

    await processor({
      data: [{
        ...attachmentRequest('new-invoices/req-8/invoice.pdf'),
        emailContext: { plainTextBody: 'Please process PO-414498' }
      }]
    } as any);

    expect(workday.loadPurchaseOrder).toHaveBeenCalledWith(expect.anything(), 'PO-414498');
    expect(workday.loadPurchaseOrder.mock.invocationCallOrder[0])
      .toBeLessThan(invoiceEnrichment.enrichInvoiceFromAttachments.mock.invocationCallOrder[0]);
    expect(database.findCompanyByName).not.toHaveBeenCalled();
    expect(invoiceEnrichment.enrichInvoiceFromAttachments.mock.calls[0][3]).toEqual({
      descriptor: 'The Professional Golfers Association of America',
      id: 'pga-company-wid'
    });
    expect(invoiceEnrichment.enrichInvoiceFromAttachments.mock.calls[0][5]).toEqual({
      documentNumber: 'PO-414498',
      company: {
        workdayId: 'pga-company-wid',
        name: 'The Professional Golfers Association of America'
      },
      lines: [{
        lineOrder: 1,
        purchaseOrderLineId: 'POL-1',
        description: 'Summit ENG',
        memo: undefined
      }]
    });
    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][1]).toEqual(
      parsedPo.lines.map((line) => ({ ...line, availableForInvoicing: true }))
    );

    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.companyWID).toBe('pga-company-wid');
    expect(submitArgs.companyReferenceType).toBe('WID');
    expect(submitArgs.omitPurchaseOrderLineReference).toBeUndefined();
  });

  describe('deposit invoice (SUPIN-470584)', () => {
    const appliedFallbacks = { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false };
    const parsedPo = (lines: any[] = supin470584PoLines) => ({
      documentNumber: 'PO-414712',
      company: { workdayId: 'pga-company-wid', descriptor: 'The Professional Golfers Association of America' },
      lines,
    });
    const depositEnrichment = (rows: any[]) => ({
      ...baseEnrichmentResult,
      ...supin470584Header,
      extractedInvoiceLines: rows,
    });
    const mergeAsExtracted = (lines: any[]) => Promise.resolve({
      lines: lines.map((line, index) => ({
        lineOrder: index + 1,
        description: line.description,
        quantity: line.quantity,
        unitCost: Number(String(line.unitCost).replace(/[$,]/g, '')),
        extendedAmount: Number(String(line.totalPrice).replace(/[$,]/g, '')),
        ...(lines.length === 1 ? { purchaseOrderLineId: 'ITEM_ORDER_LINE-3-29976' } : {}),
      })),
      appliedFallbacks,
    });
    const run = async (rows: any[], po: any = parsedPo()) => {
      const mocks = freshRequire();
      mocks.workday.loadPurchaseOrder.mockResolvedValue(po);
      mocks.invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(depositEnrichment(rows));
      mocks.invoiceLines.buildFinalInvoiceLines.mockImplementation(mergeAsExtracted);
      await mocks.processor({ data: [attachmentRequest('new-invoices/req-deposit/invoice.pdf')] } as any);
      return mocks;
    };

    it('submits one $34,429.50 line on the deposit PO line, with no amount mismatch', async () => {
      const { workday, invoiceLines, slack } = await run(supin470584Rows);

      const [candidates, poLines, , , , , quantityDisplayed] = invoiceLines.buildFinalInvoiceLines.mock.calls[0];
      expect(candidates).toEqual([expect.objectContaining({
        description: 'Advance Deposit Due (90% of $38,255.00)',
        quantity: 1,
        unitCost: '$34,429.50',
        totalPrice: '$34,429.50',
      })]);
      expect(poLines.map((line: any) => line.purchaseOrderLineId)).toEqual(['ITEM_ORDER_LINE-3-29976']);
      expect(quantityDisplayed).toBe(true);

      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(submitArgs.finalLines).toEqual([expect.objectContaining({
        description: 'Advance Deposit Due (90% of $38,255.00)',
        quantity: 1,
        unitCost: 34429.5,
        extendedAmount: 34429.5,
        purchaseOrderLineId: 'ITEM_ORDER_LINE-3-29976',
      })]);
      expect(submitArgs.extractedAmountDue).toBe('$34,429.50');
      expect(submitArgs.extractedFreightAmount).toBeUndefined();

      const notes = submitArgs.buildNotes([]);
      expect(notes).toContain('Deposit invoice: "Advance Deposit Due" $34,429.50 is 90% of $38,255.00 for the contract total (28 printed lines).');
      expect(notes).toContain('Invoice Lines (from document)');
      expect(notes).toContain('Fresh Cut Floral Centerpieces');
      expect(notes).not.toContain('Amount check');
      expect(notes).not.toContain('Line total review');
      expect(notes).not.toContain('Line subtotal review');

      const slackDetails = slack.notifyResult.mock.calls[0][3];
      expect(slackDetails.deposit).toEqual(['Advance Deposit Due: $34,429.50 is 90% of $38,255.00. Submitted as one deposit line, not the printed lines.']);
      expect(slackDetails.extracted.amountDueNote).toBe('90% deposit of $38,255.00');
      expect(slackDetails).not.toHaveProperty('chargeCheck');
      expect(slackDetails).not.toHaveProperty('amountMismatch');
      expect(slackDetails).not.toHaveProperty('lineReview');
      expect(slackDetails.lineCount).toBe(1);
    });

    it('still bills the deposit when the model dropped the repeated floral row, and asks AP to check the lines', async () => {
      const { workday, invoiceLines, slack } = await run(supin470584ProductionRows);

      expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0]).toHaveLength(1);
      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(submitArgs.finalLines).toHaveLength(1);
      const review = 'The extracted lines total $34,205.00, but the document prints $38,255.00 as "Total Cost of Contracted Services".'
        + ' The $4,050.00 difference equals "Fresh Cut Floral Centerpieces"; check whether that row is printed more than once.';
      expect(submitArgs.buildNotes([])).toContain(`Line subtotal review: ${review}`);
      expect(slack.notifyResult.mock.calls[0][3].lineReview).toEqual([`Line subtotal review: ${review}`]);
    });

    it('tells AP which rows a second OCR read added', async () => {
      const mocks = freshRequire();
      mocks.workday.loadPurchaseOrder.mockResolvedValue(parsedPo());
      mocks.invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...depositEnrichment(supin470584Rows),
        extractedPartialPayment: null,
        extractedAmountDue: '$38,255.00',
        extractedRowsAddedOnSecondRead: [{ description: 'Fresh Cut Floral Centerpieces', totalPrice: '$4,050.00' }],
      });
      mocks.invoiceLines.buildFinalInvoiceLines.mockImplementation(mergeAsExtracted);

      await mocks.processor({ data: [attachmentRequest('new-invoices/req-second-read/invoice.pdf')] } as any);

      const note = 'A second read of the document added a row the first read missed: "Fresh Cut Floral Centerpieces" $4,050.00. Check it against the PDF.';
      expect(mocks.workday.submitNewSupplierInvoice.mock.calls[0][1].buildNotes([])).toContain(`Line subtotal review: ${note}`);
      expect(mocks.slack.notifyResult.mock.calls[0][3].lineReview).toEqual([`Line subtotal review: ${note}`]);
    });

    it('submits the printed lines unchanged and says why when no PO line is the deposit', async () => {
      const { workday, invoiceLines, slack } = await run(supin470584Rows, parsedPo([supin470584PoLines[1]]));

      expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0]).toHaveLength(28);
      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(submitArgs.finalLines).toHaveLength(28);
      const reason = 'no PO line is for $34,429.50';
      expect(submitArgs.buildNotes([])).toContain(`Deposit invoice: "Advance Deposit Due" looks like a deposit or partial payment, but ${reason}, so the printed lines were submitted unchanged.`);
      const slackDetails = slack.notifyResult.mock.calls[0][3];
      expect(slackDetails.deposit).toEqual([`Deposit or partial payment not applied: ${reason}.`]);
      expect(slackDetails.extracted).not.toHaveProperty('amountDueNote');
    });

    it('keeps two identical rows printed under different headings when the invoice is not a deposit', async () => {
      const mocks = freshRequire();
      const rows = [
        { description: 'Fresh Cut Floral Centerpieces', quantity: 30, unitCost: '$135.00', totalPrice: '$4,050.00', hasDiscount: null, tableNumber: 1, sectionLabel: 'Tuesday' },
        { description: 'Fresh Cut Floral Centerpieces', quantity: 30, unitCost: '$135.00', totalPrice: '$4,050.00', hasDiscount: null, tableNumber: 1, sectionLabel: 'Wednesday' },
      ];
      mocks.invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...baseEnrichmentResult,
        extractedAmountDue: '$8,100.00',
        extractedLineSubtotal: { label: 'Total', amount: '$8,100.00' },
        extractedPartialPayment: null,
        extractedInvoiceLines: rows,
      });
      mocks.invoiceLines.buildFinalInvoiceLines.mockImplementation(mergeAsExtracted);

      await mocks.processor({ data: [attachmentRequest('new-invoices/req-twin-rows/invoice.pdf')] } as any);

      expect(mocks.invoiceLines.buildFinalInvoiceLines.mock.calls[0][0]).toHaveLength(2);
      const submitArgs = mocks.workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(submitArgs.finalLines.map((line: any) => line.extendedAmount)).toEqual([4050, 4050]);
      const notes = submitArgs.buildNotes([]);
      expect(notes).not.toContain('Deposit invoice');
      expect(notes).not.toContain('Line subtotal review');
      expect(mocks.slack.notifyResult.mock.calls[0][3]).not.toHaveProperty('deposit');
    });
  });

  describe('remaining-balance invoice (SUPIN-471692)', () => {
    const appliedFallbacks = { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false };
    const balanceEnrichment = (overrides: Record<string, unknown> = {}) => ({
      ...baseEnrichmentResult,
      ...supin471692Header,
      extractedInvoiceLines: supin471692Rows,
      ...overrides,
    });
    const mergeAsExtracted = (lines: any[]) => Promise.resolve({
      lines: lines.map((line, index) => ({
        lineOrder: index + 1,
        description: line.description,
        quantity: line.quantity,
        unitCost: Number(String(line.unitCost).replace(/[$,]/g, '')),
        extendedAmount: Number(String(line.totalPrice).replace(/[$,]/g, '')),
      })),
      appliedFallbacks,
    });
    const run = async (enrichment: Record<string, unknown>, po?: any) => {
      const mocks = freshRequire();
      mocks.workday.loadPurchaseOrder.mockResolvedValue(po);
      mocks.invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(enrichment);
      mocks.invoiceLines.buildFinalInvoiceLines.mockImplementation(mergeAsExtracted);
      await mocks.processor({ data: [attachmentRequest('new-invoices/req-balance/invoice.pdf')] } as any);
      return mocks;
    };

    it('submits one $5,909.50 line as a draft instead of the $23,887.00 contract lines', async () => {
      const { workday, invoiceLines, slack } = await run(balanceEnrichment());

      const [candidates, , , , , , quantityDisplayed] = invoiceLines.buildFinalInvoiceLines.mock.calls[0];
      expect(candidates).toEqual([expect.objectContaining({
        description: 'Total Contract Price (balance due of $23,887.00)',
        quantity: 1,
        totalPrice: '$5,909.50',
      })]);
      expect(quantityDisplayed).toBe(true);

      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(submitArgs.finalLines).toEqual([expect.objectContaining({ extendedAmount: 5909.5 })]);
      expect(submitArgs.extractedAmountDue).toBe('$5,909.50');

      const notes = submitArgs.buildNotes([]);
      expect(notes).toContain('Balance invoice: "Total Contract Price" is $23,887.00 but the amount due is $5,909.50, and the email calls $5,909.50 the remaining balance (3 printed lines).');
      expect(notes).toContain('Invoice Lines (from document)');
      expect(notes).not.toContain('Deposit invoice');
      expect(notes).not.toContain('Amount check');
      expect(notes).not.toContain('Line total review');

      const slackDetails = slack.notifyResult.mock.calls[0][3];
      expect(slackDetails.balanceInvoice).toEqual(['Total Contract Price: $23,887.00 contract total, $5,909.50 due (remaining balance per the email). Submitted as one balance line, not the printed lines.']);
      expect(slackDetails.extracted.amountDueNote).toBe('remaining balance of $23,887.00');
      expect(slackDetails).not.toHaveProperty('chargeCheck');
      expect(slackDetails.lineCount).toBe(1);
    });

    it('applies from printed payments that account for the gap, with no email signal', async () => {
      const { workday, invoiceLines } = await run(balanceEnrichment({ emailBalanceDue: null, extractedPriorPayments: supin471692Payments }));

      expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0]).toHaveLength(1);
      expect(workday.submitNewSupplierInvoice.mock.calls[0][1].buildNotes([])).toContain('Balance invoice: "Total Contract Price" is $23,887.00, and $17,977.50 was already paid');
    });

    it('leaves the printed lines alone with no payment or email signal', async () => {
      const { workday, invoiceLines, slack } = await run(balanceEnrichment({ emailBalanceDue: null }));

      expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0]).toHaveLength(3);
      const notes = workday.submitNewSupplierInvoice.mock.calls[0][1].buildNotes([]);
      expect(notes).not.toContain('Balance invoice');
      expect(slack.notifyResult.mock.calls[0][3]).not.toHaveProperty('balanceInvoice');
    });

    it('submits the printed lines and says why when the PO has no line for the balance', async () => {
      const po = {
        documentNumber: 'PO-472750',
        company: { workdayId: 'pga-company-wid', descriptor: 'The Professional Golfers Association of America' },
        lines: [{ lineOrder: 1, purchaseOrderLineId: 'L1', purchaseOrderDocumentNumber: 'PO-472750', quantity: 1, unitCost: 23887 }],
      };
      const { workday, invoiceLines, slack } = await run(balanceEnrichment({ extractedPurchaseOrderNumber: 'PO-472750' }), po);

      expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0]).toHaveLength(3);
      expect(workday.submitNewSupplierInvoice.mock.calls[0][1].buildNotes([])).toContain('Balance invoice: This looks like a remaining-balance invoice, but no PO line is for $5,909.50, so the printed lines were submitted unchanged.');
      expect(slack.notifyResult.mock.calls[0][3].balanceInvoice).toEqual(['Remaining-balance invoice not applied: no PO line is for $5,909.50.']);
    });

    it('still books the balance when the PO could not be loaded', async () => {
      const { invoiceLines } = await run(balanceEnrichment({ extractedPurchaseOrderNumber: 'PO-472750' }), undefined);
      expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0]).toEqual([expect.objectContaining({ totalPrice: '$5,909.50' })]);
    });

    it('does not apply to a deposit invoice, which keeps its own plan', async () => {
      const { workday } = await run(balanceEnrichment({
        extractedAmountDue: '$21,498.30',
        extractedPartialPayment: { label: 'Deposit Due', percent: '90%', amount: '$21,498.30' },
        emailBalanceDue: { amount: '$21,498.30', phrase: 'remaining balance' },
      }));
      const notes = workday.submitNewSupplierInvoice.mock.calls[0][1].buildNotes([]);
      expect(notes).toContain('Deposit invoice:');
      expect(notes).not.toContain('Balance invoice');
    });
  });

  describe('PO supplier', () => {
    const poWithSupplier = {
      documentNumber: 'PO-414373',
      company: { workdayId: 'pga-company-wid', descriptor: 'The Professional Golfers Association of America' },
      supplier: { workdayId: 'club-pro-wid', descriptor: 'CLUB PRO GOLF GROUP LLC' },
      lines: [{ lineOrder: 1, purchaseOrderLineId: 'ITEM_ORDER_LINE-3-29143', purchaseOrderDocumentNumber: 'PO-414373', description: 'Cart' }],
    };
    const poLinkedLines = [{ lineOrder: 1, description: 'Cart', quantity: 1, unitCost: 100, extendedAmount: 100, purchaseOrderLineId: 'ITEM_ORDER_LINE-3-29143' }];
    const enrichmentFor = (supplierName: string) => ({
      ...baseEnrichmentResult,
      supplier: {
        ...baseEnrichmentResult.supplier,
        extractedInformation: { supplierName, memo: 'Carts' },
        resolvedSupplier: { workdayId: 'golf-gear-wid', supplierName: 'GOLF GEAR LTD', confidence: 0.9, reason: 'Letterhead' },
      },
      extractedPurchaseOrderNumber: 'PO-414373',
    });
    const run = async (supplierName: string) => {
      const loaded = freshRequire();
      loaded.workday.loadPurchaseOrder.mockResolvedValue(poWithSupplier);
      loaded.invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(enrichmentFor(supplierName));
      loaded.invoiceLines.buildFinalInvoiceLines.mockResolvedValue({ lines: poLinkedLines, appliedFallbacks: {}, relatedLobByCostCenter: new Map() });
      return loaded;
    };

    const submitted = (workday: any) => workday.submitNewSupplierInvoice.mock.calls[0][1];

    it('submits the PO supplier up front when the invoice names the same company', async () => {
      const { processor, workday } = await run('Club Pro Golf Group');

      await processor({ data: [{ ...attachmentRequest('new-invoices/req-po-supplier/invoice.pdf'), emailContext: { plainTextBody: 'PO-414373' } }] } as any);

      expect(workday.submitNewSupplierInvoice).toHaveBeenCalledTimes(1);
      expect(submitted(workday).supplierWID).toBe('club-pro-wid');
      expect(submitted(workday).buildNotes([])).toContain(
        'Supplier from PO: Set to CLUB PRO GOLF GROUP LLC, the supplier on PO-414373. The invoice names GOLF GEAR LTD (name "Club Pro Golf Group" matches "CLUB PRO GOLF GROUP LLC").'
      );
    });

    it('submits the PO supplier for PO-414373 and asks AP to confirm the PO number when the invoice names an unrelated company', async () => {
      const { processor, workday, slack } = await run('GOLF GEAR LTD');

      await processor({ data: [{ ...attachmentRequest('new-invoices/req-po-supplier-2/invoice.pdf'), emailContext: { plainTextBody: 'PO-414373' } }] } as any);

      expect(submitted(workday).supplierWID).toBe('club-pro-wid');
      expect(submitted(workday).buildNotes([])).toContain(
        'The invoice names GOLF GEAR LTD, which does not look like the same company; confirm the PO number.'
      );
      const details = slack.notifyResult.mock.calls.find((call: any[]) => call[1] === 'success')?.[3];
      expect(details.supplier).toEqual({
        status: 'po',
        resolvedName: 'CLUB PRO GOLF GROUP LLC',
        isDefault: false,
        purchaseOrderNumber: 'PO-414373',
        review: 'Supplier set from PO-414373 (CLUB PRO GOLF GROUP LLC); the invoice names GOLF GEAR LTD, which does not look like the same company. Confirm the PO number.',
      });
    });

    it('submits the PO supplier when the invoice supplier was not resolved', async () => {
      const loaded = await run('Club Pro Golf');
      loaded.invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...enrichmentFor('Club Pro Golf'),
        supplier: { ...enrichmentFor('Club Pro Golf').supplier, status: 'not_found', resolvedSupplier: undefined },
      });

      await loaded.processor({ data: [{ ...attachmentRequest('new-invoices/req-po-supplier-3/invoice.pdf'), emailContext: { plainTextBody: 'PO-414373' } }] } as any);

      expect(submitted(loaded.workday).supplierWID).toBe('club-pro-wid');
      const details = loaded.slack.notifyResult.mock.calls.find((call: any[]) => call[1] === 'success')?.[3];
      expect(details.supplier).toEqual(expect.objectContaining({ status: 'po', isDefault: false }));
    });

    it('adds no supplier note when the invoice already resolved to the PO supplier', async () => {
      const loaded = await run('Club Pro Golf Group');
      loaded.invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...enrichmentFor('Club Pro Golf Group'),
        supplier: {
          ...enrichmentFor('Club Pro Golf Group').supplier,
          resolvedSupplier: { workdayId: 'club-pro-wid', supplierName: 'CLUB PRO GOLF GROUP LLC', confidence: 0.9, reason: 'Letterhead' },
        },
      });

      await loaded.processor({ data: [{ ...attachmentRequest('new-invoices/req-po-supplier-4/invoice.pdf'), emailContext: { plainTextBody: 'PO-414373' } }] } as any);

      expect(submitted(loaded.workday).supplierWID).toBe('club-pro-wid');
      expect(submitted(loaded.workday).buildNotes([])).not.toContain('Supplier from PO');
    });

    it('keeps the invoice supplier when the PO is not found in Workday', async () => {
      const { processor, workday } = await run('GOLF GEAR LTD');
      workday.loadPurchaseOrder.mockResolvedValue(undefined);

      await processor({ data: [{ ...attachmentRequest('new-invoices/req-po-supplier-5/invoice.pdf'), emailContext: { plainTextBody: 'PO-414373' } }] } as any);

      expect(submitted(workday).supplierWID).toBe('golf-gear-wid');
      expect(submitted(workday).buildNotes([])).not.toContain('Supplier from PO');
    });
  });

  it('should keep PO company and line coding but omit PO line refs for a Closed PO', async () => {
    const parsedPo = {
      documentNumber: 'PO-414498',
      company: { workdayId: 'pga-company-wid', descriptor: 'The Professional Golfers Association of America' },
      documentStatus: { id: 'CLOSED', descriptor: 'Closed' },
      lines: [{ lineOrder: 1, purchaseOrderLineId: 'POL-1', purchaseOrderDocumentNumber: 'PO-414498', description: 'Summit ENG' }]
    };
    const poCodedLines = [{
      lineOrder: 1,
      description: 'Summit ENG',
      quantity: 1,
      unitCost: 100,
      extendedAmount: 100,
      purchaseOrderLineId: 'POL-1',
      costCenterId: 'CC-PO',
      spendCategoryId: 'SC-PO',
    }];

    const { processor, workday, slack, invoiceEnrichment, invoiceLines } = freshRequire();
    workday.loadPurchaseOrder.mockResolvedValue(parsedPo);
    workday.submitNewSupplierInvoice.mockResolvedValue({
      success: true,
      invoiceWID: 'new-invoice-wid',
      invoiceNumber: 'SUPIN-412727',
      appliedFallbacks: [{ field: 'purchaseOrderLine', label: 'omitted PO line reference (PO closed or pending close)' }],
    });
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      extractedPurchaseOrderNumber: 'PO-414498'
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue({ lines: poCodedLines, appliedFallbacks: {}, relatedLobByCostCenter: new Map() });

    await processor({
      data: [{
        ...attachmentRequest('new-invoices/req-closed-po/invoice.pdf'),
        emailContext: { plainTextBody: 'Please process PO-414498' }
      }]
    } as any);

    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][1]).toEqual(parsedPo.lines);
    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.companyWID).toBe('pga-company-wid');
    expect(slack.notifyResult.mock.calls[0][3].extracted.purchaseOrderNumber).toBe('PO-414498');
    expect(submitArgs.omitPurchaseOrderLineReference).toBe(true);
    expect(submitArgs.finalLines[0]).toEqual(expect.objectContaining({
      purchaseOrderLineId: 'POL-1',
      costCenterId: 'CC-PO',
      spendCategoryId: 'SC-PO',
    }));

    const closedNote = 'PO-414498 is Closed or Pending Close; invoice lines were coded from the PO but not linked to PO lines.';
    const closedNotes = submitArgs.buildNotes([{ field: 'purchaseOrderLine', label: 'omitted PO line reference (PO closed or pending close)' }]);
    expect(closedNotes).toContain(closedNote);
    expect(closedNotes).not.toContain('omitted PO line reference');
    expect(submitArgs.buildNotes([])).not.toContain('Closed or Pending Close');
    expect(slack.notifyResult.mock.calls[0][3].appliedFallbacks).toEqual([closedNote]);
  });

  const monthlyPoLines = (fullyInvoicedThrough: number) => Array.from({ length: 12 }, (_, index) => {
    const month = index + 1;
    const mm = String(month).padStart(2, '0');
    return {
      lineOrder: month,
      purchaseOrderLineId: `POL-${mm}`,
      purchaseOrderDocumentNumber: 'PO-414498',
      description: 'Monthly retainer',
      startDate: `2026-${mm}-01`,
      endDate: `2026-${mm}-28`,
      ...(month <= fullyInvoicedThrough ? { invoiceStatus: { id: 'FULLY_INVOICED', descriptor: 'Fully Invoiced' } } : {}),
    };
  });

  it('should send every PO line, flagged by availability, with the invoice date and service period, to the line merge', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
    workday.loadPurchaseOrder.mockResolvedValue({
      documentNumber: 'PO-414498',
      company: { workdayId: 'pga-company-wid', descriptor: 'PGA of America' },
      lines: monthlyPoLines(8),
    });
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      extractedPurchaseOrderNumber: 'PO-414498',
      extractedInvoiceDate: '2026-09-05',
      extractedServicePeriod: 'September 2026',
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

    await processor({
      data: [{ ...attachmentRequest('new-invoices/req-monthly-po/invoice.pdf'), emailContext: { subject: 'PO-414498' } }]
    } as any);

    const mergeCall = invoiceLines.buildFinalInvoiceLines.mock.calls[0];
    expect(mergeCall[1]).toHaveLength(12);
    expect(mergeCall[1].filter((line: any) => line.availableForInvoicing).map((line: any) => line.purchaseOrderLineId))
      .toEqual(['POL-09', 'POL-10', 'POL-11', 'POL-12']);
    expect(mergeCall[7]).toEqual({ invoiceDate: '2026-09-05', servicePeriod: 'September 2026' });
    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.omitPurchaseOrderLineReference).toBeUndefined();
  });

  it('should keep every line of a Closed PO as coding context and skip date-based selection', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
    const lines = monthlyPoLines(8);
    workday.loadPurchaseOrder.mockResolvedValue({
      documentNumber: 'PO-414498',
      company: { workdayId: 'pga-company-wid', descriptor: 'PGA of America' },
      documentStatus: { id: 'CLOSED', descriptor: 'Closed' },
      lines,
    });
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      extractedPurchaseOrderNumber: 'PO-414498',
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

    await processor({
      data: [{ ...attachmentRequest('new-invoices/req-closed-consumed-po/invoice.pdf'), emailContext: { subject: 'PO-414498' } }]
    } as any);

    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][1]).toEqual(lines);
    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][7]).toBeUndefined();
    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.omitPurchaseOrderLineReference).toBe(true);
    expect(submitArgs.buildNotes([{ field: 'purchaseOrderLine', label: 'omitted PO line reference (PO closed or pending close)' }]))
      .toContain('PO-414498 is Closed or Pending Close');

    const bothNotes = submitArgs.buildNotes([
      { field: 'purchaseOrderLine', label: 'omitted PO line reference (PO closed or pending close)' },
      { field: 'consumedPurchaseOrderLine', label: 'omitted PO line reference (PO line fully invoiced or closed)' },
    ]);
    expect(bothNotes.match(/Purchase order lines: /g)).toHaveLength(2);
    expect(bothNotes).toContain('PO-414498 is Closed or Pending Close');
    expect(bothNotes).toContain('Invoice lines that matched lines on PO-414498 already fully invoiced');
    expect(bothNotes).not.toContain('Fallback values applied');
  });

  it('should keep consumed PO lines for coding and report the dropped references by their own note', async () => {
    const { processor, workday, slack, invoiceEnrichment, invoiceLines } = freshRequire();
    const allInvoiced = monthlyPoLines(12);
    workday.loadPurchaseOrder.mockResolvedValue({
      documentNumber: 'PO-414498',
      company: { workdayId: 'pga-company-wid', descriptor: 'PGA of America' },
      lines: allInvoiced,
    });
    const consumedFallback = { field: 'consumedPurchaseOrderLine', label: 'omitted PO line reference (PO line fully invoiced or closed)' };
    workday.submitNewSupplierInvoice.mockResolvedValue({
      success: true,
      invoiceWID: 'new-invoice-wid',
      invoiceNumber: 'SUPIN-412727',
      appliedFallbacks: [consumedFallback],
    });
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      extractedPurchaseOrderNumber: 'PO-414498',
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

    await processor({
      data: [{ ...attachmentRequest('new-invoices/req-consumed-po/invoice.pdf'), emailContext: { subject: 'PO-414498' } }]
    } as any);

    const mergedPoLines = invoiceLines.buildFinalInvoiceLines.mock.calls[0][1];
    expect(mergedPoLines.map((line: any) => line.purchaseOrderLineId)).toEqual(allInvoiced.map((line) => line.purchaseOrderLineId));
    expect(mergedPoLines.every((line: any) => line.availableForInvoicing === false)).toBe(true);
    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.omitPurchaseOrderLineReference).toBeUndefined();
    const consumedNote = 'Invoice lines that matched lines on PO-414498 already fully invoiced or closed were coded from the PO but not linked to PO lines.';
    const notes = submitArgs.buildNotes([consumedFallback]);
    expect(notes).toContain(consumedNote);
    expect(notes).not.toContain('Closed or Pending Close');
    expect(notes).not.toContain('Fallback values applied');
    expect(slack.notifyResult.mock.calls[0][3].appliedFallbacks).toEqual([consumedNote]);
  });

  describe('PO named in an Intercom note', () => {
    const arrowNote = "<p>Don't use the PO on the invoice. use PO-413672 Line 7</p>";
    const notePo = {
      documentNumber: 'PO-413672',
      company: { workdayId: 'pga-company-wid', descriptor: 'PGA of America' },
      lines: Array.from({ length: 8 }, (_, index) => ({
        lineOrder: index + 1,
        purchaseOrderLineId: `POL-413672-${index + 1}`,
        purchaseOrderDocumentNumber: 'PO-413672',
        description: 'Pest control service',
      })),
    };
    const invoicePo = {
      documentNumber: 'PO-411406',
      company: { workdayId: 'pga-company-wid', descriptor: 'PGA of America' },
      lines: [{
        lineOrder: 1,
        purchaseOrderLineId: 'POL-411406-1',
        purchaseOrderDocumentNumber: 'PO-411406',
        description: 'Pest control service',
        invoiceStatus: { id: 'FULLY_INVOICED', descriptor: 'Fully Invoiced' },
      }],
    };
    const loadArrowPos = (workday: any, available: Record<string, unknown> = { 'PO-413672': notePo, 'PO-411406': invoicePo }) => {
      workday.loadPurchaseOrder.mockImplementation(async (_ctx: unknown, poNumber: string) => available[poNumber]);
    };
    const arrowRequest = (key: string, emailContext: Record<string, string>) => ({
      ...attachmentRequest(`new-invoices/${key}/invoice.pdf`),
      emailContext: { subject: 'ARROW EXTERMINATORS INC invoice 69962682', plainTextBody: 'Invoice attached', ...emailContext },
    });

    it('uses the note PO and line over the stale invoice PO (Arrow Exterminators)', async () => {
      const { processor, workday, slack, invoiceEnrichment, invoiceLines } = freshRequire();
      loadArrowPos(workday);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...baseEnrichmentResult,
        extractedPurchaseOrderNumber: '411406',
      });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

      await processor({
        data: [arrowRequest('req-arrow-note-po', { conversationParts: arrowNote, adminConversationParts: arrowNote })]
      } as any);

      expect(workday.loadPurchaseOrder.mock.calls.map((call: unknown[]) => call[1])).toEqual(['PO-413672']);
      expect(invoiceEnrichment.enrichInvoiceFromAttachments.mock.calls[0][5]).toEqual(
        expect.objectContaining({ documentNumber: 'PO-413672' })
      );
      expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][1]).toEqual([
        expect.objectContaining({ lineOrder: 7, purchaseOrderLineId: 'POL-413672-7' })
      ]);
      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(slack.notifyResult.mock.calls[0][3].extracted.purchaseOrderNumber).toBe('PO-413672');
      expect(submitArgs.buildNotes([])).toContain(
        'Purchase order: Used PO-413672 Line 7 from the Intercom note instead of PO-411406 on the invoice.'
      );
      expect(slack.notifyResult.mock.calls[0][3].extracted).toEqual(expect.objectContaining({
        purchaseOrderNumber: 'PO-413672',
        purchaseOrderSource: 'note',
        purchaseOrderLine: 7,
        invoicePurchaseOrderNumber: 'PO-411406',
      }));
      expect(slack.notifyResult.mock.calls[0][3].extracted.purchaseOrderNotLinked).toBeUndefined();
    });

    it('uses the note PO when the note also names the invoice PO it rejects', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, slack } = freshRequire();
      loadArrowPos(workday);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...baseEnrichmentResult,
        extractedPurchaseOrderNumber: 'PO-411406',
      });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      const note = 'Not PO 411406 — use PO-413672';

      await processor({
        data: [arrowRequest('req-note-rejects-invoice-po', { conversationParts: note, adminConversationParts: note })]
      } as any);

      expect(slack.notifyResult.mock.calls[0][3].extracted.purchaseOrderNumber).toBe('PO-413672');
      expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][1]).toHaveLength(8);
    });

    it('uses the note PO tied to this invoice when the note covers several invoices', async () => {
      const { processor, workday, slack, invoiceEnrichment, invoiceLines } = freshRequire();
      loadArrowPos(workday);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...baseEnrichmentResult,
        extractedSuppliersInvoiceNumber: '69962682',
        extractedPurchaseOrderNumber: 'PO-411406',
      });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      const note = 'PO 413672 Line 7 for invoice 69962682; PO-411406 for invoice 69962699';

      await processor({
        data: [arrowRequest('req-note-po-for-this-invoice', { conversationParts: note, adminConversationParts: note })]
      } as any);

      expect(slack.notifyResult.mock.calls[0][3].extracted.purchaseOrderNumber).toBe('PO-413672');
      expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][1]).toEqual([
        expect.objectContaining({ lineOrder: 7, purchaseOrderLineId: 'POL-413672-7' })
      ]);
      expect(slack.notifyResult.mock.calls[0][3].extracted).toEqual(expect.objectContaining({
        purchaseOrderSource: 'note',
        purchaseOrderLine: 7,
      }));
    });

    it('keeps the invoice PO for an invoice the note does not name', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, slack } = freshRequire();
      loadArrowPos(workday);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...baseEnrichmentResult,
        extractedSuppliersInvoiceNumber: '69962699',
        extractedPurchaseOrderNumber: 'PO-411406',
      });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      const note = 'Invoice 69962682: use PO-413672 Line 7';

      await processor({
        data: [arrowRequest('req-note-names-other-invoice', { conversationParts: note, adminConversationParts: note })]
      } as any);

      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(slack.notifyResult.mock.calls[0][3].extracted.purchaseOrderNumber).toBe('PO-411406');
      expect(submitArgs.buildNotes([])).toContain(
        'Purchase order: The Intercom note names PO-413672 for invoice 69962682, not this invoice (69962699); kept PO-411406.'
      );
    });

    it('says the note PO was for another invoice when the invoice number was not read', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, slack } = freshRequire();
      loadArrowPos(workday);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...baseEnrichmentResult,
        extractedSuppliersInvoiceNumber: null,
        extractedPurchaseOrderNumber: 'PO-411406',
      });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      const note = 'use PO-413672 Line 7 for invoice 69962682';

      await processor({
        data: [arrowRequest('req-note-invoice-number-unread', { conversationParts: note, adminConversationParts: note })]
      } as any);

      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(slack.notifyResult.mock.calls[0][3].extracted.purchaseOrderNumber).toBe('PO-411406');
      expect(submitArgs.buildNotes([])).toContain(
        'Purchase order: The Intercom note names PO-413672 for invoice 69962682, not this invoice; kept PO-411406.'
      );
    });

    it('keeps the invoice PO when the note confirms it for this invoice', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, slack } = freshRequire();
      loadArrowPos(workday);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...baseEnrichmentResult,
        extractedSuppliersInvoiceNumber: '69962699',
        extractedPurchaseOrderNumber: 'PO-411406',
      });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      const note = 'PO 413672 Line 7 for invoice 69962682; PO-411406 for invoice 69962699';

      await processor({
        data: [arrowRequest('req-note-confirms-invoice-po', { conversationParts: note, adminConversationParts: note })]
      } as any);

      expect(workday.loadPurchaseOrder.mock.calls.map((call: unknown[]) => call[1])).toEqual(['PO-411406']);
      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(slack.notifyResult.mock.calls[0][3].extracted.purchaseOrderNumber).toBe('PO-411406');
      expect(submitArgs.buildNotes([])).not.toContain('Intercom note');
    });

    describe('one PO with a different line for each invoice (Clean Scapes)', () => {
      const cleanScapesPo = {
        documentNumber: 'PO-413785',
        company: { workdayId: 'pga-company-wid', descriptor: 'PGA of America' },
        lines: Array.from({ length: 19 }, (_, index) => ({
          lineOrder: index + 1,
          purchaseOrderLineId: `POL-413785-${index + 1}`,
          purchaseOrderDocumentNumber: 'PO-413785',
          description: 'Landscaping Maintenance',
        })),
      };
      const tristanNote = '<p>Both invoices go to PO-413785 - make invoice 101535 go to line 8, make invoice 101547 go to line 15</p>';
      const processInvoice = async (invoiceNumber: string, note: string, key: string) => {
        const modules = freshRequire();
        modules.workday.loadPurchaseOrder.mockImplementation(async (_ctx: unknown, poNumber: string) => (
          poNumber === 'PO-413785' ? cleanScapesPo : undefined
        ));
        modules.invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
          ...baseEnrichmentResult,
          extractedSuppliersInvoiceNumber: invoiceNumber,
          extractedPurchaseOrderNumber: null,
        });
        modules.invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
        await modules.processor({
          data: [{
            ...attachmentRequest(`new-invoices/${key}/invoice.pdf`),
            emailContext: {
              subject: `Clean Scapes invoice ${invoiceNumber}`,
              plainTextBody: 'Invoice attached',
              conversationParts: note,
              adminConversationParts: note,
            },
          }]
        } as any);
        return modules;
      };

      it.each([['101535', 8], ['101547', 15]])('gives invoice %s PO-413785 line %i from the same note', async (invoiceNumber, line) => {
        const { workday, slack, invoiceEnrichment, invoiceLines } = await processInvoice(invoiceNumber, tristanNote, `req-both-${invoiceNumber}`);

        expect(workday.loadPurchaseOrder.mock.calls.map((call: unknown[]) => call[1])).toEqual(['PO-413785']);
        expect(invoiceEnrichment.enrichInvoiceFromAttachments.mock.calls[0][5]).toEqual(
          expect.objectContaining({ documentNumber: 'PO-413785' })
        );
        expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][1]).toEqual([
          expect.objectContaining({ lineOrder: line, purchaseOrderLineId: `POL-413785-${line}` })
        ]);
        expect(slack.notifyResult.mock.calls[0][3].extracted).toEqual(expect.objectContaining({
          purchaseOrderNumber: 'PO-413785',
          purchaseOrderSource: 'note',
          purchaseOrderLine: line,
        }));
        const notes = workday.submitNewSupplierInvoice.mock.calls[0][1].buildNotes([]);
        expect(notes).toContain(`Purchase order: Used PO-413785 Line ${line} from the Intercom note.`);
        expect(notes).not.toContain('not this invoice');
      });

      it('uses the PO for an invoice whose number was not read when the note gives it to both invoices', async () => {
        const { slack } = await processInvoice('', tristanNote, 'req-both-unread');

        expect(slack.notifyResult.mock.calls[0][3].extracted.purchaseOrderNumber).toBe('PO-413785');
      });

      it('says no line was pinned when the note gives this invoice conflicting lines', async () => {
        const note = 'Invoice 101535: use PO-413785 Line 8, not Line 9';
        const { workday, invoiceLines, slack } = await processInvoice('101535', note, 'req-conflicting-lines');

        expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][1]).toHaveLength(19);
        expect(slack.notifyResult.mock.calls[0][3].extracted.purchaseOrderLine).toBeUndefined();
        expect(workday.submitNewSupplierInvoice.mock.calls[0][1].buildNotes([])).toContain(
          'Purchase order: Used PO-413785 from the Intercom note. The note gives this invoice conflicting PO lines, so no line was pinned and every PO line was considered.'
        );
      });

      it('names the missing line when the invoice line is not on the PO', async () => {
        const { workday, invoiceLines } = await processInvoice('101547', 'Invoice 101547: PO-413785 Line 40', 'req-line-not-on-po');

        expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][1]).toHaveLength(19);
        expect(workday.submitNewSupplierInvoice.mock.calls[0][1].buildNotes([])).toContain(
          'The note names Line 40, which is not on PO-413785, so every PO line was considered.'
        );
      });
    });

    it('uses the PO named in the supplier reply that carried the invoice over the invoice PO', async () => {
      const { processor, workday, slack, invoiceEnrichment, invoiceLines } = freshRequire();
      loadArrowPos(workday);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...baseEnrichmentResult,
        extractedPurchaseOrderNumber: 'PO-411406',
      });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

      await processor({
        data: [arrowRequest('req-supplier-reply-po', {
          plainTextBody: 'Invoice attached\n\nPlease use PO-413672',
          conversationParts: 'Please use PO-413672',
          messageBody: '<p>Please use PO-413672</p>',
        })]
      } as any);

      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(slack.notifyResult.mock.calls[0][3].extracted.purchaseOrderNumber).toBe('PO-413672');
      expect(submitArgs.buildNotes([])).toContain(
        'Purchase order: Used PO-413672 from the email or conversation instead of PO-411406 on the invoice.'
      );
      expect(slack.notifyResult.mock.calls[0][3].extracted).toEqual(expect.objectContaining({
        purchaseOrderNumber: 'PO-413672',
        purchaseOrderSource: 'conversation',
        invoicePurchaseOrderNumber: 'PO-411406',
      }));
    });

    it('keeps the invoice PO when only an older message in the thread names another PO', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, slack } = freshRequire();
      loadArrowPos(workday);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...baseEnrichmentResult,
        extractedPurchaseOrderNumber: 'PO-411406',
      });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      const olderReply = 'Please reference PO-413672 on future invoices';

      await processor({
        data: [arrowRequest('req-older-message-po', {
          plainTextBody: `Invoice attached\n\n${olderReply}\n\nNew invoice attached`,
          conversationParts: `${olderReply}\n\nNew invoice attached`,
          messageBody: 'New invoice attached',
        })]
      } as any);

      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(slack.notifyResult.mock.calls[0][3].extracted.purchaseOrderNumber).toBe('PO-411406');
      expect(submitArgs.buildNotes([])).not.toContain('from the email or conversation');
    });

    it('ignores the thread subject for an invoice attached to a later reply', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, slack } = freshRequire();
      loadArrowPos(workday);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...baseEnrichmentResult,
        extractedPurchaseOrderNumber: 'PO-413672',
      });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

      await processor({
        data: [arrowRequest('req-stale-subject-po', {
          subject: 'Re: Invoice 1182, PO-411406',
          plainTextBody: 'Invoice 1182 attached\n\nOctober invoice attached',
          conversationParts: 'October invoice attached',
          messageBody: 'October invoice attached',
        })]
      } as any);

      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(slack.notifyResult.mock.calls[0][3].extracted.purchaseOrderNumber).toBe('PO-413672');
      expect(submitArgs.buildNotes([])).not.toContain('from the email or conversation');
    });

    it('uses the PO in the subject of the source email that carried the invoice', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
      loadArrowPos(workday);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...baseEnrichmentResult,
        extractedPurchaseOrderNumber: 'PO-411406',
      });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

      await processor({
        data: [arrowRequest('req-source-subject-po', {
          subject: 'Invoice 69962682 for PO-413672',
          messageSubject: 'Invoice 69962682 for PO-413672',
          messageBody: '',
        })]
      } as any);

      expect(workday.submitNewSupplierInvoice.mock.calls[0][1].buildNotes([])).toContain(
        'Purchase order: Used PO-413672 from the email or conversation instead of PO-411406 on the invoice.'
      );
    });

    it('keeps the invoice PO when the email and conversation name several POs', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, slack } = freshRequire();
      loadArrowPos(workday);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...baseEnrichmentResult,
        extractedPurchaseOrderNumber: 'PO-411406',
      });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

      await processor({
        data: [arrowRequest('req-supplier-reply-two-pos', {
          plainTextBody: 'Invoices attached for PO-411406 and PO-413672\n\nThanks',
          conversationParts: 'Thanks',
        })]
      } as any);

      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(slack.notifyResult.mock.calls[0][3].extracted.purchaseOrderNumber).toBe('PO-411406');
      expect(submitArgs.buildNotes([])).not.toContain('from the email or conversation');
    });

    it('falls back to the invoice PO when the conversation PO is not in Workday', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, slack } = freshRequire();
      loadArrowPos(workday, { 'PO-411406': invoicePo });
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...baseEnrichmentResult,
        extractedPurchaseOrderNumber: 'PO-411406',
      });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

      await processor({
        data: [arrowRequest('req-supplier-reply-po-missing', {
          plainTextBody: 'Invoice attached\n\nPlease use PO-413672',
          conversationParts: 'Please use PO-413672',
          messageBody: 'Please use PO-413672',
        })]
      } as any);

      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(slack.notifyResult.mock.calls[0][3].extracted.purchaseOrderNumber).toBe('PO-411406');
      expect(submitArgs.buildNotes([])).toContain(
        'Purchase order: PO-413672 from the email or conversation was not found in Workday; used PO-411406 instead.'
      );
    });

    it('falls back to the invoice PO when the note PO is not in Workday', async () => {
      const { processor, workday, slack, invoiceEnrichment, invoiceLines } = freshRequire();
      loadArrowPos(workday, { 'PO-411406': invoicePo });
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...baseEnrichmentResult,
        extractedPurchaseOrderNumber: 'PO-411406',
      });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

      await processor({
        data: [arrowRequest('req-note-po-missing', { conversationParts: arrowNote, adminConversationParts: arrowNote })]
      } as any);

      expect(workday.loadPurchaseOrder.mock.calls.map((call: unknown[]) => call[1])).toEqual(['PO-413672', 'PO-411406']);
      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(slack.notifyResult.mock.calls[0][3].extracted.purchaseOrderNumber).toBe('PO-411406');
      expect(submitArgs.buildNotes([])).toContain(
        'Purchase order: PO-413672 from the Intercom note was not found in Workday; used PO-411406 instead.'
      );
      expect(slack.notifyResult.mock.calls[0][3].extracted.purchaseOrderSource).toBeUndefined();
    });

    it('falls back to the subject PO when the note PO is not in Workday and the PDF has no PO', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, slack } = freshRequire();
      loadArrowPos(workday, { 'PO-411406': invoicePo });
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

      await processor({
        data: [arrowRequest('req-note-po-missing-subject-po', {
          subject: 'ARROW EXTERMINATORS INC invoice 69962682 PO-411406',
          conversationParts: arrowNote,
          adminConversationParts: arrowNote,
        })]
      } as any);

      expect(workday.loadPurchaseOrder.mock.calls.map((call: unknown[]) => call[1])).toEqual(['PO-413672', 'PO-411406']);
      expect(invoiceEnrichment.enrichInvoiceFromAttachments.mock.calls[0][5]).toEqual(
        expect.objectContaining({ documentNumber: 'PO-411406' })
      );
      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(slack.notifyResult.mock.calls[0][3].extracted.purchaseOrderNumber).toBe('PO-411406');
      expect(submitArgs.buildNotes([])).toContain(
        'Purchase order: PO-413672 from the Intercom note was not found in Workday; used PO-411406 instead.'
      );
    });

    it('picks the note PO that is not the subject PO when the PDF has no PO', async () => {
      const { processor, workday, slack, invoiceEnrichment, invoiceLines } = freshRequire();
      loadArrowPos(workday);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      const note = 'use PO-413672, not PO 411406';

      await processor({
        data: [arrowRequest('req-note-two-pos-subject-po', {
          subject: 'ARROW EXTERMINATORS INC invoice 69962682 PO-411406',
          conversationParts: note,
          adminConversationParts: note,
        })]
      } as any);

      expect(workday.loadPurchaseOrder.mock.calls.map((call: unknown[]) => call[1])).toEqual(['PO-413672']);
      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(slack.notifyResult.mock.calls[0][3].extracted.purchaseOrderNumber).toBe('PO-413672');
      expect(submitArgs.buildNotes([])).toContain(
        'Purchase order: Used PO-413672 from the Intercom note instead of PO-411406 in the email.'
      );
      expect(slack.notifyResult.mock.calls[0][3].extracted).toEqual(expect.objectContaining({
        purchaseOrderNumber: 'PO-413672',
        emailPurchaseOrderNumber: 'PO-411406',
      }));
    });

    it('does not read note text as the supplier PO when the source body boundary is missing', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
      loadArrowPos(workday);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      const note = 'use PO-413672, not PO 411406';

      await processor({
        data: [arrowRequest('req-note-two-pos-no-boundary', {
          plainTextBody: `PO 411406 per AP: ${note}`,
          conversationParts: note,
          adminConversationParts: note,
        })]
      } as any);

      expect(workday.loadPurchaseOrder).not.toHaveBeenCalled();
    });

    it('loads neither PO when a note names two and the invoice and email name none', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
      loadArrowPos(workday);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      const note = 'not PO 411406, use PO-413672';

      await processor({
        data: [arrowRequest('req-note-two-pos-no-invoice-po', {
          plainTextBody: `Invoice attached\n\n${note}`,
          conversationParts: note,
          adminConversationParts: note,
        })]
      } as any);

      expect(workday.loadPurchaseOrder).not.toHaveBeenCalled();
      expect(workday.submitNewSupplierInvoice.mock.calls[0][1].buildNotes([])).not.toContain('Intercom note');
    });

    it('does not claim the note line when the default company codes no PO lines', async () => {
      const { processor, workday, slack, invoiceEnrichment, invoiceLines } = freshRequire();
      const { company: _company, ...notePoWithoutCompany } = notePo;
      loadArrowPos(workday, { 'PO-413672': notePoWithoutCompany, 'PO-411406': invoicePo });
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...baseEnrichmentResult,
        extractedPurchaseOrderNumber: 'PO-411406',
      });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

      await processor({
        data: [arrowRequest('req-note-po-default-company', { conversationParts: arrowNote, adminConversationParts: arrowNote })]
      } as any);

      const notes = workday.submitNewSupplierInvoice.mock.calls[0][1].buildNotes([]);
      expect(notes).toContain('Purchase order: Used PO-413672 from the Intercom note instead of PO-411406 on the invoice.');
      expect(notes).not.toContain('Line 7');
      expect(slack.notifyResult.mock.calls[0][3].extracted).toEqual(expect.objectContaining({
        purchaseOrderNumber: 'PO-413672',
        purchaseOrderSource: 'note',
      }));
      expect(slack.notifyResult.mock.calls[0][3].extracted.purchaseOrderLine).toBeUndefined();
    });

    it('matches against every note PO line when the named line is not on the PO', async () => {
      const { processor, workday, slack, invoiceEnrichment, invoiceLines } = freshRequire();
      loadArrowPos(workday);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...baseEnrichmentResult,
        extractedPurchaseOrderNumber: 'PO-411406',
      });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      const note = 'use PO-413672 Line 12';

      await processor({
        data: [arrowRequest('req-note-line-missing', { conversationParts: note, adminConversationParts: note })]
      } as any);

      expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][1]).toHaveLength(8);
      expect(workday.submitNewSupplierInvoice.mock.calls[0][1].buildNotes([])).toContain(
        'Purchase order: Used PO-413672 from the Intercom note instead of PO-411406 on the invoice. The note names Line 12, which is not on PO-413672, so every PO line was considered.'
      );
      expect(slack.notifyResult.mock.calls[0][3].extracted.purchaseOrderLine).toBeUndefined();
    });

    it('flags the Slack PO as not linked when the note PO line is consumed', async () => {
      const { processor, workday, slack, invoiceEnrichment, invoiceLines } = freshRequire();
      loadArrowPos(workday);
      workday.submitNewSupplierInvoice.mockResolvedValue({
        success: true,
        invoiceWID: 'new-invoice-wid',
        invoiceNumber: 'SUPIN-465824',
        appliedFallbacks: [{ field: 'consumedPurchaseOrderLine', label: 'omitted PO line reference (PO line fully invoiced or closed)' }],
      });
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...baseEnrichmentResult,
        extractedPurchaseOrderNumber: 'PO-411406',
      });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

      await processor({
        data: [arrowRequest('req-note-line-consumed', { conversationParts: arrowNote, adminConversationParts: arrowNote })]
      } as any);

      expect(slack.notifyResult.mock.calls[0][3].extracted).toEqual(expect.objectContaining({
        purchaseOrderNumber: 'PO-413672',
        purchaseOrderNotLinked: true,
      }));
    });
  });

  it('should keep the PO company over a recommended PDF company', async () => {
    const { processor, workday, slack, invoiceEnrichment, invoiceLines } = freshRequire();
    workday.loadPurchaseOrder.mockResolvedValue({
      documentNumber: 'PO-414498',
      company: { workdayId: 'pga-company-wid', descriptor: 'PGA of America' },
      lines: []
    });
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      companyVerification: {
        status: 'different',
        confidence: 0.9,
        extractedInformation: {},
        recommended: { workdayId: 'section-wid', companyName: 'Tennessee Section PGA of America', confidence: 0.9, reason: 'Bill-to is the section' },
        reason: 'Invoice bills a different company than the PO'
      },
      extractedPurchaseOrderNumber: 'PO-414498'
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

    await processor({
      data: [{
        ...attachmentRequest('new-invoices/req-9/invoice.pdf'),
        emailContext: { subject: 'PO-414498' }
      }]
    } as any);

    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.companyWID).toBe('pga-company-wid');
    expect(submitArgs.companyReferenceType).toBe('WID');
    expect(submitArgs.buildNotes([])).not.toContain('Changed to:');
    expect(slack.notifyResult).toHaveBeenCalledWith(
      'create_invoice',
      'success',
      expect.any(Number),
      expect.objectContaining({
        company: expect.objectContaining({
          appliedFrom: 'po',
          appliedId: 'pga-company-wid',
          appliedName: 'PGA of America',
        }),
      })
    );
  });

  it('should use a PO extracted during enrichment when email and filename have none', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
    workday.loadPurchaseOrder.mockResolvedValue({
      documentNumber: 'PO-414498',
      company: { workdayId: 'pga-company-wid', descriptor: 'PGA of America' },
      lines: []
    });
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      companyVerification: {
        ...baseEnrichmentResult.companyVerification,
        status: 'uncertain',
        recommended: null
      },
      extractedPurchaseOrderNumber: 'PO-414498'
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

    await processor({
      data: [attachmentRequest('new-invoices/req-10/invoice.pdf')]
    } as any);

    expect(workday.loadPurchaseOrder).toHaveBeenCalledWith(expect.anything(), 'PO-414498');
    expect(invoiceEnrichment.enrichInvoiceFromAttachments.mock.invocationCallOrder[0])
      .toBeLessThan(workday.loadPurchaseOrder.mock.invocationCallOrder[0]);

    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.companyWID).toBe('pga-company-wid');
    expect(submitArgs.companyReferenceType).toBe('WID');
  });

  it('should prefer a late-fetched PO company over a recommendation made without PO context', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
    workday.loadPurchaseOrder.mockResolvedValue({
      documentNumber: 'PO-414498',
      company: { workdayId: 'pga-company-wid', descriptor: 'PGA of America' },
      lines: []
    });
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      companyVerification: {
        status: 'different',
        confidence: 0.9,
        extractedInformation: {},
        recommended: { workdayId: 'section-wid', companyName: 'Tennessee Section PGA of America', confidence: 0.9, reason: 'Guessed from short name' },
        reason: 'Bill-to is ambiguous without PO context'
      },
      extractedPurchaseOrderNumber: 'PO-414498'
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

    await processor({
      data: [attachmentRequest('new-invoices/req-late-po/invoice.pdf')]
    } as any);

    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.companyWID).toBe('pga-company-wid');
    expect(submitArgs.buildNotes([])).not.toContain('Changed to:');
  });

  it('should keep a recommended company when a late-fetched PO has no company', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
    workday.loadPurchaseOrder.mockResolvedValue({
      documentNumber: 'PO-414498',
      company: undefined,
      lines: []
    });
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      companyVerification: {
        status: 'different',
        confidence: 0.9,
        extractedInformation: {},
        recommended: { workdayId: 'section-wid', companyName: 'Tennessee Section PGA of America', confidence: 0.9, reason: 'Bill-to is the section' },
        reason: 'Extracted company differs from the default'
      },
      extractedPurchaseOrderNumber: 'PO-414498'
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

    await processor({
      data: [attachmentRequest('new-invoices/req-late-po-no-company/invoice.pdf')]
    } as any);

    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.companyWID).toBe('section-wid');
    expect(submitArgs.buildNotes([])).toContain('Changed to: Tennessee Section PGA of America');
  });

  it('should use the email PO and its company when the invoice names a different PO', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
    workday.loadPurchaseOrder.mockImplementation(async (_ctx: unknown, poNumber: string) => {
      if (poNumber === 'PO-111111') {
        return {
          documentNumber: 'PO-111111',
          company: { workdayId: 'early-po-wid', descriptor: 'Early PO Company' },
          lines: [{ lineOrder: 1, purchaseOrderLineId: 'POL-A', purchaseOrderDocumentNumber: 'PO-111111' }]
        };
      }
      return {
        documentNumber: 'PO-222222',
        company: { workdayId: 'late-po-wid', descriptor: 'Late PO Company' },
        lines: [{ lineOrder: 1, purchaseOrderLineId: 'POL-B', purchaseOrderDocumentNumber: 'PO-222222' }]
      };
    });
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      companyVerification: {
        status: 'different',
        confidence: 0.9,
        extractedInformation: {},
        recommended: { workdayId: 'section-wid', companyName: 'Tennessee Section PGA of America', confidence: 0.9, reason: 'Guessed from the early PO' },
        reason: 'Bill-to differs from the email PO company'
      },
      extractedPurchaseOrderNumber: 'PO-222222'
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

    await processor({
      data: [{
        ...attachmentRequest('new-invoices/req-po-mismatch/invoice.pdf'),
        emailContext: { plainTextBody: 'Please process PO-111111' }
      }]
    } as any);

    expect(workday.loadPurchaseOrder.mock.calls.map((call: unknown[]) => call[1])).toEqual(['PO-111111']);
    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.companyWID).toBe('early-po-wid');
    expect(submitArgs.buildNotes([])).not.toContain('Changed to:');
    expect(submitArgs.buildNotes([])).toContain('Purchase order: Used PO-111111 from the email or conversation instead of PO-222222 on the invoice.');
    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][1]).toEqual([
      expect.objectContaining({ purchaseOrderLineId: 'POL-A' })
    ]);
  });

  it('should use the invoice PO when the email PO fails to load', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
    workday.loadPurchaseOrder.mockImplementation(async (_ctx: unknown, poNumber: string) => {
      if (poNumber === 'PO-222222') {
        return {
          documentNumber: 'PO-222222',
          company: { workdayId: 'late-po-wid', descriptor: 'Late PO Company' },
          lines: [{ lineOrder: 1, purchaseOrderLineId: 'POL-B', purchaseOrderDocumentNumber: 'PO-222222' }]
        };
      }
      return undefined;
    });
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      companyVerification: {
        ...baseEnrichmentResult.companyVerification,
        status: 'matching',
        recommended: null
      },
      extractedPurchaseOrderNumber: 'PO-222222'
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

    await processor({
      data: [{
        ...attachmentRequest('new-invoices/req-po-mismatch-miss/invoice.pdf'),
        emailContext: { plainTextBody: 'Please process PO-111111' }
      }]
    } as any);

    expect(workday.loadPurchaseOrder.mock.calls.map((call: unknown[]) => call[1])).toEqual(['PO-111111', 'PO-222222']);
    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.companyWID).toBe('late-po-wid');
    expect(submitArgs.buildNotes([])).toContain('Purchase order: PO-111111 from the email or conversation was not found in Workday; used PO-222222 instead.');
    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][1]).toEqual([
      expect.objectContaining({ purchaseOrderLineId: 'POL-B' })
    ]);
  });

  it('should submit Default OCR Company when no email, PO, or PDF company is selected', async () => {
    const { processor, workday, slack, invoiceEnrichment, invoiceLines, database } = freshRequire();
    database.findCompanyByName.mockResolvedValue(undefined);
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

    await expect(processor({
      data: [attachmentRequest('new-invoices/req-11/invoice.pdf')]
    } as any)).resolves.not.toThrow();

    expect(database.findCompanyByName).not.toHaveBeenCalled();
    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.companyWID).toBe('Default_OCR_Company');
    expect(submitArgs.companyReferenceType).toBe('Company_Reference_ID');
    expect(slack.notifyResult).toHaveBeenCalledWith(
      'create_invoice',
      'success',
      expect.any(Number),
      expect.objectContaining({
        company: expect.objectContaining({
          appliedFrom: 'default',
          appliedId: 'Default_OCR_Company',
          appliedName: 'Default OCR Company',
        }),
      })
    );
  });

  it('should force Default OCR line worktags when the default company is used', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines, loadEnv } = freshRequire();
    loadEnv.mockResolvedValue({
      FALLBACK_FUND_ID: 'Default_OCR_Fund',
      FALLBACK_COST_CENTER_ID: 'Default_OCR_Cost_Center',
      FALLBACK_SPEND_CATEGORY_ID: 'Default_OCR_Spend_Category',
      FALLBACK_LOB_ID: 'Default_Line_Of_Business',
    });
    workday.loadPurchaseOrder.mockResolvedValue({
      documentNumber: 'PO-222222',
      company: undefined,
      lines: [{
        lineOrder: 1,
        purchaseOrderLineId: 'POL-B',
        purchaseOrderDocumentNumber: 'PO-222222',
        description: 'Summit ENG',
      }]
    });
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      extractedPurchaseOrderNumber: 'PO-222222',
      emailWorktags: {
        costCenter: { extracted: 'Technology', name: 'Technology', code: '72200' },
        event: { extracted: 'Championship', workdayId: 'event-wid' },
        lineOfBusiness: { extracted: 'Championships', referenceId: 'lob-id' },
        fund: { extracted: 'General', referenceId: 'fund-id' },
        spendCategory: { extracted: 'Services', name: 'Services', referenceId: 'spend-id' },
      },
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue({
      lines: [{
        lineOrder: 1,
        description: 'Widgets',
        quantity: 2,
        unitCost: 50,
        costCenterId: '72200',
        fundId: 'fund-id',
        spendCategoryId: 'spend-id',
        lineOfBusinessId: 'lob-id',
        eventWid: 'event-wid',
        shipToAddressId: 'ADDR-1',
        purchaseOrderLineId: 'POL-B',
      }],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false },
      relatedLobByCostCenter: new Map(),
    });

    await processor({
      data: [{
        ...attachmentRequest('new-invoices/req-default-lines/invoice.pdf'),
        emailContext: { plainTextBody: 'Please process PO-222222' },
      }]
    } as any);

    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][1]).toBeUndefined();
    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][4]).toBeUndefined();
    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.companyWID).toBe('Default_OCR_Company');
    expect(submitArgs.finalLines).toEqual([
      expect.objectContaining({
        description: 'Widgets',
        quantity: 2,
        unitCost: 50,
        costCenterId: 'Default_OCR_Cost_Center',
        fundId: 'Default_OCR_Fund',
        spendCategoryId: 'Default_OCR_Spend_Category',
        lineOfBusinessId: 'Default_Line_Of_Business',
        purchaseOrderLineId: null,
        eventId: null,
        eventWid: null,
        shipToAddressId: null,
      }),
    ]);
    const notes = submitArgs.buildNotes([]);
    expect(notes).not.toContain('Email Worktags:');
    expect(notes).toContain('Line worktags: Default OCR fallback coding applied; email worktags were not used on this invoice.');
  });

  it('should submit WORKDAY_DEFAULT_COMPANY_WID as a WID when set', async () => {
    process.env.WORKDAY_DEFAULT_COMPANY_WID = 'ocr-company-wid';
    process.env.WORKDAY_DEFAULT_COMPANY_NAME = 'Default OCR Company';
    const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

    await expect(processor({
      data: [attachmentRequest('new-invoices/req-default-wid/invoice.pdf')]
    } as any)).resolves.not.toThrow();

    expect(invoiceEnrichment.enrichInvoiceFromAttachments.mock.calls[0][3]).toEqual({
      descriptor: 'Default OCR Company',
      id: 'ocr-company-wid',
    });
    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.companyWID).toBe('ocr-company-wid');
    expect(submitArgs.companyReferenceType).toBe('WID');
  });

  it('should submit the email-coded company WID when emailWorktags.company.workdayId is set', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
    const { findDocumentsByReferenceIds } = require('../lib/database.js');
    findDocumentsByReferenceIds.mockResolvedValue(new Map([
      ['912', [{
        workday_id: 'email-company-wid',
        type: 'company',
        content: 'PGA Company',
        metadata: { companyReferenceId: '912', companyName: 'PGA Company' },
      }]],
      ['72200', []],
    ]));
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      emailWorktags: {
        company: { extracted: '912', name: 'PGA Company', workdayId: 'email-company-wid', referenceId: '912' },
        costCenter: { extracted: 'Technology', name: 'Technology', code: '72200' },
        event: { extracted: 'Championship', workdayId: 'event-wid' },
        lineOfBusiness: { extracted: 'Championships', referenceId: 'lob-id' },
        fund: { extracted: 'General', referenceId: 'fund-id' },
        spendCategory: { extracted: 'Services', name: 'Services', referenceId: 'spend-id' },
      },
    });

    await expect(processor({
      data: [{
        ...attachmentRequest('new-invoices/req-8/invoice.pdf'),
        emailContext: { emailFrom: 'ap@pga.org', subject: 'Coding', plainTextBody: '912 / 72200' },
      }]
    } as any)).resolves.not.toThrow();

    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.companyWID).toBe('email-company-wid');
    expect(submitArgs.companyReferenceType).toBe('WID');
    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][4]).toEqual(expect.objectContaining({
      costCenterId: '72200',
    }));
  });

  it('should still submit an email-coded company when the PGA cache lookup misses', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines, database } = freshRequire();
    database.findCompanyByName.mockResolvedValue(undefined);
    const { findDocumentsByReferenceIds } = require('../lib/database.js');
    findDocumentsByReferenceIds.mockResolvedValue(new Map([
      ['912', [{
        workday_id: 'email-company-wid',
        type: 'company',
        content: 'PGA Company',
        metadata: { companyReferenceId: '912', companyName: 'PGA Company' },
      }]],
    ]));
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      emailWorktags: {
        company: { extracted: '912', name: 'PGA Company', workdayId: 'email-company-wid', referenceId: '912' },
      },
    });

    await expect(processor({
      data: [{
        ...attachmentRequest('new-invoices/req-cache-miss-email/invoice.pdf'),
        emailContext: { plainTextBody: '912' },
      }]
    } as any)).resolves.not.toThrow();

    expect(invoiceEnrichment.enrichInvoiceFromAttachments).toHaveBeenCalled();
    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.companyWID).toBe('email-company-wid');
  });

  it('should submit the cached company WID when email coding only has Company_Reference_ID 912', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
    const { findDocumentsByReferenceIds } = require('../lib/database.js');
    findDocumentsByReferenceIds.mockResolvedValue(new Map([
      ['912', [{
        workday_id: 'cached-company-wid',
        type: 'company',
        content: 'PGA Company',
        metadata: { companyReferenceId: '912', companyName: 'PGA Company' },
      }]],
    ]));
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      emailWorktags: {
        company: { extracted: '912', name: 'PGA Company', workdayId: null, referenceId: '912' },
      },
    });

    await expect(processor({
      data: [attachmentRequest('new-invoices/req-9/invoice.pdf')]
    } as any)).resolves.not.toThrow();

    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.companyWID).toBe('cached-company-wid');
    expect(submitArgs.companyReferenceType).toBe('WID');
  });

  it('should prefer the email-coded company over a PDF companyVerification recommendation', async () => {
    const { processor, workday, slack, invoiceEnrichment, invoiceLines } = freshRequire();
    const { findDocumentsByReferenceIds } = require('../lib/database.js');
    findDocumentsByReferenceIds.mockResolvedValue(new Map([
      ['912', [{
        workday_id: 'email-company-wid',
        type: 'company',
        content: 'PGA Company',
        metadata: { companyReferenceId: '912', companyName: 'PGA Company' },
      }]],
    ]));
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      companyVerification: {
        status: 'different',
        confidence: 0.9,
        extractedInformation: {},
        recommended: { workdayId: 'pdf-company-wid', companyName: 'PDF Company', confidence: 0.9, reason: 'Better match' },
        reason: 'Extracted company differs from the default placeholder'
      },
      emailWorktags: {
        company: { extracted: '912', name: 'PGA Company', workdayId: 'email-company-wid', referenceId: '912' },
      },
    });

    await expect(processor({
      data: [attachmentRequest('new-invoices/req-10/invoice.pdf')]
    } as any)).resolves.not.toThrow();

    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.companyWID).toBe('email-company-wid');
    expect(submitArgs.companyReferenceType).toBe('WID');
    expect(slack.notifyResult).toHaveBeenCalledWith(
      'create_invoice',
      'success',
      expect.any(Number),
      expect.objectContaining({
        company: expect.objectContaining({
          status: 'email_resolved',
          appliedFromEmail: true,
          appliedName: 'PGA Company',
          appliedReferenceId: '912',
        }),
      })
    );
  });

  it('should submit the verified bill-to company when the only number in the email is the supplier address (KMRD SUPIN-466170)', async () => {
    const { processor, workday, slack, invoiceEnrichment, invoiceLines } = freshRequire();
    const { findDocumentsByReferenceIds } = require('../lib/database.js');
    findDocumentsByReferenceIds.mockImplementation((_db: unknown, codes: string[]) => Promise.resolve(new Map(
      codes.map((code) => [code, code === '2600' ? [{
        workday_id: 'cab0b1d2505a012c97d7da178227ceea',
        type: 'company',
        content: 'Kentucky Section PGA of America',
        metadata: { companyReferenceId: '2600', companyName: 'Kentucky Section PGA of America' },
      }] : []])
    )));
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      companyVerification: {
        status: 'different',
        confidence: 0.98,
        extractedInformation: { companyName: 'PGA of America', address: '1916 PGA Parkway, Frisco, TX 75033' },
        recommended: {
          workdayId: 'cab0b1d2505a01338fcd651982277bec',
          companyName: 'The Professional Golfers Association of America',
          confidence: 0.98,
          reason: 'Bill-to PGA of America matches an exact alias.',
        },
        reason: 'The invoice clearly bills PGA of America.',
      },
      emailWorktags: {
        company: {
          extracted: 'PGA of America',
          name: 'The Professional Golfers Association of America',
          workdayId: 'cab0b1d2505a01338fcd651982277bec',
          referenceId: '310',
        },
      },
    });

    await expect(processor({
      data: [{
        ...attachmentRequest('new-invoices/req-kmrd/invoice.pdf'),
        emailContext: {
          emailFrom: 'tquinn@kmrdpartners.com',
          subject: 'PGA - Invoice attached for October 2026 Monthly HRO Support Services',
          plainTextBody: 'Attached is an invoice.\nTheresa Quinn, CISR\n+1 267.482.8292\n2600 KELLY ROAD, SUITE 120 , WARRINGTON, PA 18976 USA',
        },
      }]
    } as any)).resolves.not.toThrow();

    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.companyWID).toBe('cab0b1d2505a01338fcd651982277bec');
    expect(submitArgs.companyReferenceType).toBe('WID');
    expect(slack.notifyResult).toHaveBeenCalledWith(
      'create_invoice',
      'success',
      expect.any(Number),
      expect.objectContaining({
        company: expect.objectContaining({
          appliedFrom: 'recommended',
          appliedName: 'The Professional Golfers Association of America',
        }),
      })
    );
    expect(findDocumentsByReferenceIds).not.toHaveBeenCalledWith(expect.anything(), expect.arrayContaining(['2600']), expect.anything());
  });

  it('should apply explicit email company coding over the bill-to company but flag the conflict', async () => {
    const { processor, workday, slack, invoiceEnrichment, invoiceLines } = freshRequire();
    const { findDocumentsByReferenceIds } = require('../lib/database.js');
    findDocumentsByReferenceIds.mockResolvedValue(new Map([
      ['912', [{
        workday_id: 'email-company-wid',
        type: 'company',
        content: 'PGA Company',
        metadata: { companyReferenceId: '912', companyName: 'PGA Company' },
      }]],
    ]));
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      companyVerification: {
        status: 'different',
        confidence: 0.9,
        extractedInformation: {},
        recommended: { workdayId: 'pdf-company-wid', companyName: 'PDF Company', confidence: 0.9, reason: 'Better match' },
        reason: 'Extracted company differs from the default placeholder',
      },
      emailWorktags: {
        company: { extracted: '912', name: 'PGA Company', workdayId: 'email-company-wid', referenceId: '912' },
      },
    });

    await expect(processor({
      data: [{
        ...attachmentRequest('new-invoices/req-company-conflict/invoice.pdf'),
        emailContext: { plainTextBody: 'Company: 912' },
      }]
    } as any)).resolves.not.toThrow();

    expect(workday.submitNewSupplierInvoice.mock.calls[0][1].companyWID).toBe('email-company-wid');
    expect(slack.notifyResult).toHaveBeenCalledWith(
      'create_invoice',
      'success',
      expect.any(Number),
      expect.objectContaining({
        company: expect.objectContaining({
          appliedFrom: 'email',
          emailOrigin: 'code',
          review: expect.stringContaining('differs from the invoice bill-to company (PDF Company)'),
        }),
      })
    );
  });

  it('should not apply a cost center code that is actually the email company reference ID', async () => {
    const { processor, invoiceEnrichment, invoiceLines } = freshRequire();
    const { findDocumentsByReferenceIds } = require('../lib/database.js');
    findDocumentsByReferenceIds.mockResolvedValue(new Map([
      ['912', [{
        workday_id: 'email-company-wid',
        type: 'company',
        content: 'PGA Company',
        metadata: { companyReferenceId: '912', companyName: 'PGA Company' },
      }]],
    ]));
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      emailWorktags: {
        company: { extracted: '912', name: 'PGA Company', workdayId: 'email-company-wid', referenceId: '912' },
        costCenter: { extracted: '912', name: null, code: '912' },
      },
    });

    await expect(processor({
      data: [attachmentRequest('new-invoices/req-11/invoice.pdf')]
    } as any)).resolves.not.toThrow();

    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][4]).toEqual(expect.objectContaining({
      costCenterId: null,
    }));
  });

  describe('email budget splits', () => {
    const budgetEnrichment = () => ({
      ...baseEnrichmentResult,
      extractedAmountDue: '$35,000',
      extractedSuppliersInvoiceNumber: 'ANAL092426',
      invoiceLineQuantityDisplayed: false,
      extractedInvoiceLines: [
        { description: 'PGA of America Sponsorship Package', quantity: null, unitCost: null, totalPrice: '$35,000', hasDiscount: false },
      ],
      emailWorktags: {
        event: null, lineOfBusiness: null, fund: null, costCenter: null, spendCategory: null,
        company: { extracted: '310', name: 'PGA Company', workdayId: 'email-company-wid', referenceId: '310' },
      },
      emailBudgetSplits: [
        {
          label: "Chris Kulinski's Budget", amount: '$15,000', percent: null, equalShare: null,
          event: null, fund: null,
          costCenter: { extracted: 'Recruitment', name: 'CC-Recruitment', code: 'CC-Recruitment' },
          lineOfBusiness: { extracted: 'Recruitment', referenceId: 'LOB-Recruitment' },
          spendCategory: { extracted: 'Sponsorship', name: 'Sponsorships', referenceId: 'SC-Sponsorships' },
        },
        {
          label: 'Brand and Marketing Budget', amount: '$20,000', percent: null, equalShare: null,
          event: null, fund: null,
          costCenter: { extracted: 'Brand & Marketing', name: 'CC-Brand & Digital Marketing', code: 'CC-Brand_&_Digital_Marketing' },
          lineOfBusiness: { extracted: 'Production & Advertising', referenceId: 'LOB-Production_&_Advertising' },
          spendCategory: { extracted: 'Advertising & Promotion', name: 'Advertising and Promotion', referenceId: 'SC-Advertising_and_Promotion' },
        },
      ],
    });

    const mockCompany310 = () => {
      const { findDocumentsByReferenceIds } = require('../lib/database.js');
      findDocumentsByReferenceIds.mockResolvedValue(new Map([
        ['310', [{
          workday_id: 'email-company-wid',
          type: 'company',
          content: 'PGA Company',
          metadata: { companyReferenceId: '310', companyName: 'PGA Company' },
        }]],
      ]));
    };

    it('hands each budget and the merchandise total to the line builder and reports the split', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, slack } = freshRequire();
      mockCompany310();
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(budgetEnrichment());
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue({
        lines: [
          { lineOrder: 1, description: 'PGA of America Sponsorship Package', quantity: 0, unitCost: 0, extendedAmount: 15000, costCenterId: 'CC-Recruitment', spendCategoryId: 'SC-Sponsorships' },
          { lineOrder: 2, description: 'PGA of America Sponsorship Package', quantity: 0, unitCost: 0, extendedAmount: 20000, costCenterId: 'CC-Brand_&_Digital_Marketing', spendCategoryId: 'SC-Advertising_and_Promotion' },
        ],
        appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false },
        relatedLobByCostCenter: new Map(),
        emailBudgetSplit: {
          applied: true,
          budgets: [
            { label: "Chris Kulinski's Budget", amountCents: 1500000, costCenterId: 'CC-Recruitment', spendCategoryId: 'SC-Sponsorships' },
            { label: 'Brand and Marketing Budget', amountCents: 2000000, costCenterId: 'CC-Brand_&_Digital_Marketing', spendCategoryId: 'SC-Advertising_and_Promotion' },
          ],
        },
      });

      await processor({
        data: [{
          ...attachmentRequest('new-invoices/req-budget-split/invoice.pdf'),
          emailContext: { emailFrom: 'smorrison@pgahq.com', subject: 'MIT Sloan', plainTextBody: 'Company 310. Split $15,000 / $20,000.' },
        }]
      } as any);

      expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][4]).toEqual(expect.objectContaining({
        budgetSplitBaseCents: 3500000,
        budgetSplitBlockedReason: null,
        budgetSplits: [
          expect.objectContaining({ amount: '$15,000', costCenterId: 'CC-Recruitment', spendCategoryReferenceId: 'SC-Sponsorships' }),
          expect.objectContaining({ amount: '$20,000', costCenterId: 'CC-Brand_&_Digital_Marketing', spendCategoryReferenceId: 'SC-Advertising_and_Promotion' }),
        ],
      }));
      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(submitArgs.finalLines.map((line: any) => line.extendedAmount)).toEqual([15000, 20000]);
      const notes = submitArgs.buildNotes([]);
      expect(notes).toContain("Email budget split (one invoice line per budget): $15,000.00 Chris Kulinski's Budget");
      expect(notes).not.toContain('Line total review');
      const slackDetails = slack.notifyResult.mock.calls[0][3];
      expect(slackDetails.lineCount).toBe(2);
      expect(slackDetails.budgetSplit).toHaveLength(2);
      expect(slackDetails).not.toHaveProperty('lineReview');
    });

    it('submits no header tax or freight when the email budgets total the amount due and the lines carry them', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, slack } = freshRequire();
      mockCompany310();
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...budgetEnrichment(),
        extractedAmountDue: '$13,621.74',
        extractedTaxAmount: '$1,122.66',
        extractedTaxLabel: 'OCCUPANCY TAX',
        extractedOtherCharges: [{ label: 'TOURISM TAX', amount: '$25.08' }],
        extractedInvoiceLines: [
          { description: 'GUEST ROOM - A', quantity: null, unitCost: null, totalPrice: '$12,000.00', hasDiscount: false },
          { description: 'GUEST ROOM - B', quantity: null, unitCost: null, totalPrice: '$474.00', hasDiscount: false },
        ],
        emailBudgetSplits: budgetEnrichment().emailBudgetSplits.map((split, index) => ({
          ...split,
          amount: index === 0 ? '$11,764.23' : '$1,857.51',
        })),
      });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue({
        lines: [
          { lineOrder: 1, description: 'GUEST ROOM', quantity: 0, unitCost: 0, extendedAmount: 11764.23, costCenterId: 'CC-Recruitment' },
          { lineOrder: 2, description: 'GUEST ROOM', quantity: 0, unitCost: 0, extendedAmount: 1857.51, costCenterId: 'CC-Brand_&_Digital_Marketing', intercompanyAffiliateId: '410' },
        ],
        appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false },
        relatedLobByCostCenter: new Map(),
        emailBudgetSplit: {
          applied: true,
          budgets: [
            { label: "Chris Kulinski's Budget", amountCents: 1176423, costCenterId: 'CC-Recruitment', spendCategoryId: null },
            { label: 'Brand and Marketing Budget', amountCents: 185751, costCenterId: 'CC-Brand_&_Digital_Marketing', spendCategoryId: null, companyId: '410' },
          ],
          headerChargesRolledIn: { amountDueCents: 1362174, lineTotalCents: 1247400 },
        },
      });

      await processor({
        data: [{
          ...attachmentRequest('new-invoices/req-budget-split-gross/invoice.pdf'),
          emailContext: { plainTextBody: 'Company 310. Split $11,764.23 / $1,857.51.' },
        }]
      } as any);

      expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][4]).toEqual(expect.objectContaining({
        budgetSplitBaseCents: 1247400,
        budgetSplitGrossCents: 1362174,
      }));
      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(submitArgs.extractedTaxAmount).toBeUndefined();
      expect(submitArgs.taxCleared).toBe(true);
      expect(submitArgs.freightCleared).toBe(true);
      expect(submitArgs.extractedAmountDue).toBe('$13,621.74');
      const notes = submitArgs.buildNotes([]);
      expect(notes).toMatch(/Tax Amount \(from document\): 1147\.74/);
      expect(notes).toContain('the full amount due, so each budget line carries its share');
      expect(notes).not.toContain('Line total review');
      const slackDetails = slack.notifyResult.mock.calls[0][3];
      expect(slackDetails).not.toHaveProperty('chargeCheck');
    });

    it('reports why the budgets were not split in the Workday note and Slack line review', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, slack } = freshRequire();
      mockCompany310();
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(budgetEnrichment());
      const review = 'The email splits the cost across 2 budgets (A; B), but the budget amounts total $30,000.00, not $35,000.00. The invoice was not split by budget; check the coding before approving.';
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue({
        lines: [{ lineOrder: 1, description: 'PGA of America Sponsorship Package', quantity: 0, unitCost: 0, extendedAmount: 35000 }],
        appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false },
        relatedLobByCostCenter: new Map(),
        emailBudgetSplit: { applied: false, review, budgets: [] },
      });

      await processor({
        data: [{
          ...attachmentRequest('new-invoices/req-budget-split-rejected/invoice.pdf'),
          emailContext: { plainTextBody: 'Company 310. Split $15,000 / $15,000.' },
        }]
      } as any);

      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(submitArgs.buildNotes([])).toContain(`Budget split review: ${review}`);
      const slackDetails = slack.notifyResult.mock.calls[0][3];
      expect(slackDetails.lineReview).toEqual([`Budget split review: ${review}`]);
      expect(slackDetails).not.toHaveProperty('budgetSplit');
    });

    it('tells AP the email budgets were not used when Default OCR Company coding applies', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, slack } = freshRequire();
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...budgetEnrichment(),
        emailWorktags: null,
      });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

      await processor({
        data: [attachmentRequest('new-invoices/req-budget-split-default-company/invoice.pdf')]
      } as any);

      expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][4]).toBeUndefined();
      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      const notes = submitArgs.buildNotes([]);
      expect(notes).toContain('Line worktags: Default OCR fallback coding applied; email worktags were not used on this invoice.');
      expect(notes).toContain("Budget split review: The email splits the cost across 2 budgets (Chris Kulinski's Budget; Brand and Marketing Budget), but Default OCR fallback coding was applied to the lines.");
      expect(slack.notifyResult.mock.calls[0][3].lineReview).toEqual(expect.arrayContaining([
        expect.stringContaining('Budget split review: The email splits the cost across 2 budgets'),
      ]));
    });

    it('blocks the split when the invoice header freight or tax could not be read', async () => {
      const { processor, invoiceEnrichment, invoiceLines } = freshRequire();
      mockCompany310();
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...budgetEnrichment(),
        extractedAmountDue: null,
      });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

      await processor({
        data: [{
          ...attachmentRequest('new-invoices/req-budget-split-blocked/invoice.pdf'),
          emailContext: { plainTextBody: 'Company 310.' },
        }]
      } as any);

      expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][4]).toEqual(expect.objectContaining({
        budgetSplitBaseCents: null,
        budgetSplitBlockedReason: 'the invoice amount due could not be read',
      }));
    });
  });

  it('should put extracted identifiers on the header and line memos', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue({
      lines: [{ lineOrder: 1, description: 'Widgets', memo: 'Widget purchase', quantity: 2, unitCost: 50 }],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false },
    });
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      extractedSuppliersInvoiceNumber: 'INV|001>>>',
      extractedPurchaseOrderNumber: 'PO-414498',
      extractedAccountNumber: '1033562',
      extractedSupplierReference: '5914196',
      extractedSupplierReferenceKind: 'order',
      extractedCustomerId: 'CU0122145',
      extractedServicePeriod: '2026 - September',
    });

    await processor({
      data: [attachmentRequest('new-invoices/req-memo/invoice.pdf')]
    } as any);

    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.memo).toBe('Acct 1033562 Ord 5914196 PO-414498 Svc Prd 09/01/26 - 09/30/26 office supplies');
    expect(submitArgs.suppliersInvoiceNumber).toBe('INV-001');
    expect(submitArgs.finalLines).toEqual([
      expect.objectContaining({
        description: 'Widgets',
        memo: 'Acct 1033562 Ord 5914196 PO-414498 Svc Prd 09/01/26 - 09/30/26 widget purchase',
      }),
    ]);
    expect(submitArgs.buildNotes([])).toContain('Account Number (from document): 1033562');
    expect(submitArgs.buildNotes([])).toContain('Supplier Reference (from document): Order 5914196');
    expect(submitArgs.buildNotes([])).toContain('Customer ID (from document): CU0122145');
    expect(submitArgs.buildNotes([])).toContain('Service Period (from document): 2026 - September');
  });

  it('submits an account number plus MMMYY when the printed invoice number is the account number', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      extractedSuppliersInvoiceNumber: '20-1183-01',
      extractedAccountNumber: '20-1183-01',
      extractedInvoiceDate: '2026-09-15',
      supplier: {
        ...baseEnrichmentResult.supplier,
        extractedInformation: {
          supplierName: 'City of Frisco Texas',
          memo: 'Utility bill',
        },
      },
    });

    await processor({
      data: [attachmentRequest('new-invoices/req-frisco/UtilityBill.pdf')]
    } as any);

    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.suppliersInvoiceNumber).toBe('20-1183-01SEP26');
    expect(submitArgs.buildNotes([])).toContain('Supplier Invoice Number (from document): 20-1183-01');
  });

  it('reports the timestamped supplier invoice number after a duplicate retry', async () => {
    const { processor, workday, slack, invoiceEnrichment, invoiceLines } = freshRequire();
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      extractedSuppliersInvoiceNumber: '12345',
    });
    workday.submitNewSupplierInvoice.mockResolvedValue({
      success: true,
      invoiceWID: 'new-invoice-wid',
      invoiceNumber: 'SUPIN-412727',
      suppliersInvoiceNumber: '12345-20260928170000',
      appliedFallbacks: [{
        field: 'suppliersInvoiceNumber',
        label: 'supplier invoice number suffixed with -20260928170000',
        dueToValidationError: true,
      }],
      priorFailures: [{
        attempt: 1,
        message: "Enter a Supplier's Invoice Number that isn't already in use on another supplier invoice",
      }],
    });

    await processor({
      data: [attachmentRequest('new-invoices/req-safari/invoice.pdf')]
    } as any);

    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.buildNotes([{
      field: 'suppliersInvoiceNumber',
      label: 'supplier invoice number suffixed with -20260928170000',
    }])).toContain('supplier invoice number suffixed with -20260928170000');
    expect(submitArgs.buildNotes([])).toContain('Supplier Invoice Number (from document): 12345');
    expect(slack.notifyResult).toHaveBeenCalledWith(
      'create_invoice',
      'success',
      expect.any(Number),
      expect.objectContaining({
        extracted: expect.objectContaining({ suppliersInvoiceNumber: '12345-20260928170000' }),
        appliedFallbacks: expect.arrayContaining(['supplier invoice number suffixed with -20260928170000']),
      }),
    );
  });

  describe('invoice attachment clustering', () => {
    const invoiceFile = {
      s3Key: 'new-invoices/req-1/1-invoice.pdf',
      fileName: 'invoice.pdf',
      contentType: 'application/pdf',
      kind: 'supplier_invoice',
      confidence: 0.95,
    };
    const supportFile = {
      s3Key: 'new-invoices/req-1/2-support.pdf',
      fileName: 'support.pdf',
      contentType: 'application/pdf',
      kind: 'supporting',
      supportingKind: 'packing_slip',
      confidence: 0.8,
    };

    function clusteredRequest() {
      return {
        conversationId: '1234567890',
        attachments: [invoiceFile, supportFile],
      };
    }

    it('keeps unrelated files off the invoice and reuses the classification downloads', async () => {
      const { processor, workday, clustering, invoiceEnrichment, invoiceLines, s3, loadEnv } = freshRequire();
      loadEnv.mockResolvedValue({ INVOICE_ATTACHMENT_CLUSTERING_ENABLED: 'true' });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      const flyer = { s3Key: 'new-invoices/req-1/3-flyer.pdf', fileName: 'flyer.pdf', contentType: 'application/pdf', kind: 'unrelated', confidence: 0.9 };
      clustering.parseAndClusterInvoiceAttachments.mockImplementation(
        async (files: Array<{ s3Key: string }>, load: (key: string) => Promise<Buffer>) => {
          await Promise.all(files.map((file) => load(file.s3Key)));
          return {
            classified: [invoiceFile, supportFile, flyer],
            clustering: { clusters: [{ primary: invoiceFile, supporting: [supportFile], fallback: false }], unrelated: [flyer] },
          };
        }
      );

      await processor({ data: [{ conversationId: '1234567890', attachments: [invoiceFile, supportFile, flyer] }] } as any);

      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(submitArgs.attachments.map((att: { fileName: string }) => att.fileName)).toEqual(['invoice.pdf', 'support.pdf']);
      const downloadedKeys = s3.getBinaryFromS3.mock.calls.map((call: unknown[]) => call[1]);
      expect(downloadedKeys.filter((key: string) => key === invoiceFile.s3Key)).toHaveLength(1);
      expect(downloadedKeys.filter((key: string) => key === supportFile.s3Key)).toHaveLength(1);
    });

    it('processes a clustered fan-out record one PDF at a time on a processor with the flag off', async () => {
      const { processor, workday, clustering, invoiceEnrichment, invoiceLines, registry, loadEnv } = freshRequire();
      loadEnv.mockResolvedValue({});
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);

      await processor({
        data: [{ conversationId: '1234567890', clustered: true, attachments: [invoiceFile, supportFile] }],
      } as any);

      expect(clustering.parseAndClusterInvoiceAttachments).not.toHaveBeenCalled();
      expect(workday.submitNewSupplierInvoice).toHaveBeenCalledTimes(2);
      expect(workday.submitNewSupplierInvoice.mock.calls.map((call: any[]) => call[1].attachments[0].fileName))
        .toEqual(['invoice.pdf', 'support.pdf']);
      expect(registry.getConversationSupplierInvoice).not.toHaveBeenCalled();
    });

    it('parses unclustered attachments and enriches the whole cluster', async () => {
      const { processor, workday, slack, invoiceEnrichment, invoiceLines, clustering, loadEnv } = freshRequire();
      loadEnv.mockResolvedValue({ INVOICE_ATTACHMENT_CLUSTERING_ENABLED: 'true' });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      clustering.parseAndClusterInvoiceAttachments.mockResolvedValue({
        classified: [invoiceFile, supportFile],
        clustering: {
          clusters: [{ primary: invoiceFile, supporting: [supportFile], fallback: false }],
          unrelated: [],
        },
      });

      await processor({ data: [clusteredRequest()] } as any);

      expect(clustering.parseAndClusterInvoiceAttachments).toHaveBeenCalledTimes(1);
      const enrichArgs = invoiceEnrichment.enrichInvoiceFromAttachments.mock.calls[0];
      expect(enrichArgs[1].map((att: { fileName: string }) => att.fileName))
        .toEqual(['1-invoice.pdf', '2-support.pdf']);
      expect(enrichArgs[6]).toEqual([
        { fileName: '1-invoice.pdf', role: 'invoice' },
        { fileName: '2-support.pdf', role: 'supporting' },
      ]);

      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(submitArgs.attachments).toHaveLength(2);
      expect(submitArgs.attachments.map((att: { fileName: string }) => att.fileName))
        .toEqual(['invoice.pdf', 'support.pdf']);

      expect(slack.notifyResult).toHaveBeenCalledWith(
        'create_invoice',
        'success',
        expect.any(Number),
        expect.objectContaining({
          attachments: expect.arrayContaining([
            expect.objectContaining({ fileName: 'invoice.pdf', role: 'invoice' }),
            expect.objectContaining({ fileName: 'support.pdf', role: 'supporting' }),
          ]),
        }),
      );
    });

    it('fans out leftover clusters to separate processor invocations', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, clustering, lambda, loadEnv } = freshRequire();
      loadEnv.mockResolvedValue({
        INVOICE_ATTACHMENT_CLUSTERING_ENABLED: 'true',
        AWS_STACK_NAME: 'finance-agent',
      });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      const secondInvoice = {
        s3Key: 'new-invoices/req-1/3-second.pdf',
        fileName: 'second.pdf',
        contentType: 'application/pdf',
        kind: 'supplier_invoice',
        confidence: 0.9,
      };
      clustering.parseAndClusterInvoiceAttachments.mockResolvedValue({
        classified: [invoiceFile, supportFile, secondInvoice],
        clustering: {
          clusters: [
            { primary: invoiceFile, supporting: [supportFile], fallback: false },
            { primary: secondInvoice, supporting: [], fallback: false },
          ],
          unrelated: [],
        },
      });

      await processor({ data: [{ conversationId: '1234567890', attachments: [invoiceFile, supportFile, secondInvoice] }] } as any);

      expect(workday.submitNewSupplierInvoice).toHaveBeenCalledTimes(1);
      expect(lambda.InvokeCommand).toHaveBeenCalledTimes(1);
      const fanOutPayload = JSON.parse(lambda.InvokeCommand.mock.calls[0][0].Payload);
      expect(fanOutPayload.data[0].clustered).toBe(true);
      expect(fanOutPayload.data[0].attachments.map((att: { fileName: string }) => att.fileName))
        .toEqual(['second.pdf']);
    });

    it('attaches only the latest copy of a repeated document and reports the older copies', async () => {
      const { processor, workday, slack, invoiceEnrichment, invoiceLines, clustering, lambda, loadEnv } = freshRequire();
      loadEnv.mockResolvedValue({ INVOICE_ATTACHMENT_CLUSTERING_ENABLED: 'true', AWS_STACK_NAME: 'finance-agent' });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      const olderInvoice = { ...invoiceFile, s3Key: 'new-invoices/req-1/0-invoice-old.pdf', fileName: 'invoice-old.pdf', receivedAt: 100 };
      const latestInvoice = { ...invoiceFile, receivedAt: 200 };
      const secondInvoice = { s3Key: 'new-invoices/req-1/3-second.pdf', fileName: 'second.pdf', contentType: 'application/pdf', kind: 'supplier_invoice', confidence: 0.9 };
      const olderSecond = { ...secondInvoice, s3Key: 'new-invoices/req-1/4-second-old.pdf', fileName: 'second-old.pdf' };
      clustering.parseAndClusterInvoiceAttachments.mockResolvedValue({
        classified: [olderInvoice, latestInvoice, supportFile, secondInvoice, olderSecond],
        clustering: {
          clusters: [
            { primary: latestInvoice, supporting: [supportFile], superseded: [olderInvoice], fallback: false },
            { primary: secondInvoice, supporting: [], superseded: [olderSecond], fallback: false },
          ],
          unrelated: [],
        },
      });

      await processor({
        data: [{ conversationId: '1234567890', attachments: [olderInvoice, latestInvoice, supportFile, secondInvoice, olderSecond] }],
      } as any);

      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(submitArgs.attachments.map((att: { fileName: string }) => att.fileName)).toEqual(['invoice.pdf', 'support.pdf']);
      expect(slack.notifyResult).toHaveBeenCalledWith(
        'create_invoice',
        'success',
        expect.any(Number),
        expect.objectContaining({ supersededAttachments: ['invoice-old.pdf'] }),
      );
      const fanOutPayload = JSON.parse(lambda.InvokeCommand.mock.calls[0][0].Payload);
      expect(fanOutPayload.data[0].attachments.map((att: { fileName: string }) => att.fileName)).toEqual(['second.pdf']);
      expect(fanOutPayload.data[0].supersededFileNames).toEqual(['second-old.pdf']);
    });

    it('tells each cluster when another cluster got the newer file, so an unrelated reply skips the existing invoice', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, clustering, registry, lambda, loadEnv } = freshRequire();
      loadEnv.mockResolvedValue({
        INVOICE_ATTACHMENT_CLUSTERING_ENABLED: 'true',
        AWS_STACK_NAME: 'finance-agent',
      });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      registry.getConversationSupplierInvoice.mockResolvedValue({
        conversationId: '1234567890',
        supplierInvoiceNumber: 'INV-001',
        supplierWid: 'supplier-wid-1',
        workdayInvoiceWid: 'b'.repeat(32),
        workdayInvoiceNumber: 'SUPIN-1',
        lastProcessedReceivedAt: 200,
      });
      workday.getSupplierInvoiceEditability.mockResolvedValue({ found: true, editable: true, status: 'Draft' });
      const original = { ...invoiceFile, receivedAt: 200 };
      const support = { ...supportFile, receivedAt: 100 };
      const unrelatedInvoice = {
        s3Key: 'new-invoices/req-1/3-other.pdf',
        fileName: 'other.pdf',
        contentType: 'application/pdf',
        kind: 'supplier_invoice',
        confidence: 0.9,
        receivedAt: 300,
      };
      clustering.parseAndClusterInvoiceAttachments.mockResolvedValue({
        classified: [original, support, unrelatedInvoice],
        clustering: {
          clusters: [
            { primary: original, supporting: [support], fallback: false },
            { primary: unrelatedInvoice, supporting: [], fallback: false },
          ],
          unrelated: [],
        },
      });

      await processor({
        data: [{ conversationId: '1234567890', latestMessageAt: 300, attachments: [original, support, unrelatedInvoice] }],
      } as any);

      expect(workday.submitNewSupplierInvoice).not.toHaveBeenCalled();
      expect(workday.submitSupplierInvoiceUpdate).not.toHaveBeenCalled();
      const fanOutPayload = JSON.parse(lambda.InvokeCommand.mock.calls[0][0].Payload);
      expect(fanOutPayload.data[0].attachments.map((att: { fileName: string }) => att.fileName)).toEqual(['other.pdf']);
      expect(fanOutPayload.data[0].otherClustersLatestReceivedAt).toBe(200);
    });

    it('records a plan, claims the first cluster, and tags fanned-out records with their plan row', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, clustering, plans, lambda, loadEnv } = freshRequire();
      loadEnv.mockResolvedValue({ INVOICE_ATTACHMENT_CLUSTERING_ENABLED: 'true', AWS_STACK_NAME: 'finance-agent' });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      const secondInvoice = { s3Key: 'new-invoices/req-1/3-second.pdf', fileName: 'second.pdf', contentType: 'application/pdf', kind: 'supplier_invoice', confidence: 0.9 };
      clustering.parseAndClusterInvoiceAttachments.mockResolvedValue({
        classified: [invoiceFile, supportFile, secondInvoice],
        clustering: {
          clusters: [
            { primary: invoiceFile, supporting: [supportFile], fallback: false },
            { primary: secondInvoice, supporting: [], fallback: false },
          ],
          unrelated: [],
        },
      });

      await processor({ data: [{ conversationId: '1234567890', attachments: [invoiceFile, supportFile, secondInvoice] }] } as any);

      const [, planId, conversationId, clusterNames] = plans.createInvoiceClusterPlan.mock.calls[0];
      expect(conversationId).toBe('1234567890');
      expect(clusterNames).toEqual([['invoice.pdf', 'support.pdf'], ['second.pdf']]);
      expect(plans.claimInvoiceCluster).toHaveBeenCalledWith(expect.anything(), planId, 0);
      expect(plans.finishInvoiceCluster).toHaveBeenCalledWith(expect.anything(), planId, 0, 'done', 'new-invoice-wid');
      const fanOutPayload = JSON.parse(lambda.InvokeCommand.mock.calls[0][0].Payload);
      expect(fanOutPayload.data[0]).toMatchObject({ planId, clusterIndex: 1, clustered: true });
      expect(workday.submitNewSupplierInvoice).toHaveBeenCalledTimes(1);
    });

    it('still processes the first cluster and reports clusters that could not be dispatched', async () => {
      const { processor, workday, slack, invoiceEnrichment, invoiceLines, clustering, plans, loadEnv } = freshRequire();
      loadEnv.mockResolvedValue({ INVOICE_ATTACHMENT_CLUSTERING_ENABLED: 'true', AWS_STACK_NAME: 'finance-agent' });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      mockLambdaSend.mockRejectedValueOnce(new Error('invoke throttled'));
      const secondInvoice = { s3Key: 'new-invoices/req-1/3-second.pdf', fileName: 'second.pdf', contentType: 'application/pdf', kind: 'supplier_invoice', confidence: 0.9 };
      clustering.parseAndClusterInvoiceAttachments.mockResolvedValue({
        classified: [invoiceFile, secondInvoice],
        clustering: {
          clusters: [
            { primary: invoiceFile, supporting: [], fallback: false },
            { primary: secondInvoice, supporting: [], fallback: false },
          ],
          unrelated: [],
        },
      });

      await processor({ data: [{ conversationId: '1234567890', attachments: [invoiceFile, secondInvoice] }] } as any);

      expect(workday.submitNewSupplierInvoice).toHaveBeenCalledTimes(1);
      const planId = plans.createInvoiceClusterPlan.mock.calls[0][1];
      expect(plans.markInvoiceClusterUndispatched).toHaveBeenCalledWith(expect.anything(), planId, 1);
      expect(slack.notifyResult).toHaveBeenCalledWith(
        'create_invoice',
        'error',
        expect.any(Number),
        expect.objectContaining({ planId, undispatchedClusters: [['second.pdf']] }),
        expect.objectContaining({ message: expect.stringContaining('1 of 2 invoice clusters could not be dispatched') }),
      );
    });

    it('does nothing for a fanned-out record whose plan row is already done or in progress', async () => {
      const { processor, workday, invoiceEnrichment, plans, loadEnv } = freshRequire();
      loadEnv.mockResolvedValue({ INVOICE_ATTACHMENT_CLUSTERING_ENABLED: 'true' });
      plans.claimInvoiceCluster.mockResolvedValue(false);

      await processor({
        data: [{ conversationId: '1234567890', clustered: true, planId: 'plan-1', clusterIndex: 1, attachments: [invoiceFile] }],
      } as any);

      expect(plans.claimInvoiceCluster).toHaveBeenCalledWith(expect.anything(), 'plan-1', 1);
      expect(invoiceEnrichment.enrichInvoiceFromAttachments).not.toHaveBeenCalled();
      expect(workday.submitNewSupplierInvoice).not.toHaveBeenCalled();
      expect(plans.finishInvoiceCluster).not.toHaveBeenCalled();
    });

    it('marks the plan row failed when the cluster throws', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, plans, loadEnv } = freshRequire();
      loadEnv.mockResolvedValue({ INVOICE_ATTACHMENT_CLUSTERING_ENABLED: 'true' });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      workday.submitNewSupplierInvoice.mockRejectedValue(new Error('Workday down'));

      await expect(processor({
        data: [{ conversationId: '1234567890', clustered: true, planId: 'plan-1', clusterIndex: 1, attachments: [invoiceFile] }],
      } as any)).rejects.toThrow('Workday down');

      expect(plans.finishInvoiceCluster).toHaveBeenCalledWith(expect.anything(), 'plan-1', 1, 'failed');
    });

    it('returns the plan row to pending when another run holds the invoice claim', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, registry, plans, loadEnv } = freshRequire();
      loadEnv.mockResolvedValue({ INVOICE_ATTACHMENT_CLUSTERING_ENABLED: 'true' });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      registry.acquireConversationInvoiceClaim.mockResolvedValue(false);

      await processor({
        data: [{ conversationId: '1234567890', clustered: true, planId: 'plan-1', clusterIndex: 1, attachments: [invoiceFile] }],
      } as any);

      expect(workday.submitNewSupplierInvoice).not.toHaveBeenCalled();
      expect(plans.releaseInvoiceCluster).toHaveBeenCalledWith(expect.anything(), 'plan-1', 1);
      expect(plans.finishInvoiceCluster).not.toHaveBeenCalled();
    });

    it('keeps the plan row done when a step after the Workday create throws', async () => {
      const { processor, slack, invoiceEnrichment, invoiceLines, registry, plans, loadEnv } = freshRequire();
      loadEnv.mockResolvedValue({ INVOICE_ATTACHMENT_CLUSTERING_ENABLED: 'true' });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      registry.getConversationSupplierInvoice.mockResolvedValue(undefined);
      slack.notifyResult.mockRejectedValueOnce(new Error('slack down'));

      await expect(processor({
        data: [{ conversationId: '1234567890', clustered: true, planId: 'plan-1', clusterIndex: 1, attachments: [invoiceFile] }],
      } as any)).rejects.toThrow();

      expect(plans.finishInvoiceCluster).toHaveBeenCalledWith(expect.anything(), 'plan-1', 1, 'done', 'new-invoice-wid');
      expect(plans.finishInvoiceCluster).not.toHaveBeenCalledWith(expect.anything(), 'plan-1', 1, 'failed');
    });

    it('alerts Slack when the plan row cannot be marked done', async () => {
      const { processor, slack, invoiceEnrichment, invoiceLines, registry, plans, loadEnv } = freshRequire();
      loadEnv.mockResolvedValue({ INVOICE_ATTACHMENT_CLUSTERING_ENABLED: 'true' });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      registry.getConversationSupplierInvoice.mockResolvedValue(undefined);
      plans.finishInvoiceCluster.mockRejectedValue(new Error('db down'));

      await processor({
        data: [{ conversationId: '1234567890', clustered: true, planId: 'plan-1', clusterIndex: 1, attachments: [invoiceFile] }],
      } as any);

      expect(slack.notifyResult).toHaveBeenCalledWith(
        'create_invoice',
        'error',
        expect.any(Number),
        expect.objectContaining({ planId: 'plan-1', clusterIndex: 1, invoiceWID: 'new-invoice-wid' }),
        expect.objectContaining({ message: expect.stringContaining('could not be marked done') }),
      );
    });

    it('processes an already-clustered fan-out payload without re-parsing', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, clustering, loadEnv } = freshRequire();
      loadEnv.mockResolvedValue({ INVOICE_ATTACHMENT_CLUSTERING_ENABLED: 'true' });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);

      await processor({ data: [{ ...clusteredRequest(), clustered: true }] } as any);

      expect(clustering.parseAndClusterInvoiceAttachments).not.toHaveBeenCalled();
      expect(workday.submitNewSupplierInvoice).toHaveBeenCalledTimes(1);
      expect(workday.submitNewSupplierInvoice.mock.calls[0][1].attachments).toHaveLength(2);
    });

    it('keeps one invoke per PDF when clustering is disabled', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, clustering } = freshRequire();
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);

      await processor({ data: [clusteredRequest()] } as any);

      expect(clustering.parseAndClusterInvoiceAttachments).not.toHaveBeenCalled();
      expect(workday.submitNewSupplierInvoice).toHaveBeenCalledTimes(2);
      expect(workday.submitNewSupplierInvoice.mock.calls[0][1].attachments).toHaveLength(1);
      expect(workday.submitNewSupplierInvoice.mock.calls[1][1].attachments).toHaveLength(1);
    });

    it('Slacks once and rethrows when clustering fails', async () => {
      const { processor, workday, slack, invoiceEnrichment, invoiceLines, clustering, loadEnv } = freshRequire();
      loadEnv.mockResolvedValue({ INVOICE_ATTACHMENT_CLUSTERING_ENABLED: 'true' });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      clustering.parseAndClusterInvoiceAttachments.mockRejectedValue(new Error('classify boom'));

      await expect(processor({ data: [clusteredRequest()] } as any)).rejects.toThrow('classify boom');
      expect(workday.submitNewSupplierInvoice).not.toHaveBeenCalled();
      expect(slack.notifyResult).toHaveBeenCalledTimes(1);
      expect(slack.notifyResult).toHaveBeenCalledWith(
        'create_invoice',
        'error',
        expect.any(Number),
        expect.objectContaining({ attachments: ['invoice.pdf', 'support.pdf'] }),
        expect.any(Error),
      );
    });

    it('carries the trigger email onto the clustering failure without a name lookup', async () => {
      const { processor, slack, clustering, employees, loadEnv } = freshRequire();
      loadEnv.mockResolvedValue({ INVOICE_ATTACHMENT_CLUSTERING_ENABLED: 'true' });
      clustering.parseAndClusterInvoiceAttachments.mockRejectedValue(new Error('classify boom'));

      await expect(processor({
        data: [{ ...clusteredRequest(), assigneeEmail: 'jcarey@pgahq.com' }],
      } as any)).rejects.toThrow('classify boom');

      expect(employees.getEmployeeWidByEmail).not.toHaveBeenCalled();
      const details = slack.notifyResult.mock.calls[0][3];
      expect(details).toMatchObject({ triggeredByEmail: 'jcarey@pgahq.com' });
      expect(details).not.toHaveProperty('triggeredByName');
    });

    it('Slacks once when invoice creation fails after successful clustering', async () => {
      const { processor, workday, slack, invoiceEnrichment, invoiceLines, clustering, loadEnv } = freshRequire();
      loadEnv.mockResolvedValue({ INVOICE_ATTACHMENT_CLUSTERING_ENABLED: 'true' });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...baseEnrichmentResult,
        supplier: { status: 'error', reason: 'unreadable' },
      });
      clustering.parseAndClusterInvoiceAttachments.mockResolvedValue({
        classified: [invoiceFile, supportFile],
        clustering: {
          clusters: [{ primary: invoiceFile, supporting: [supportFile], fallback: false }],
          unrelated: [],
        },
      });

      await expect(processor({ data: [clusteredRequest()] } as any)).rejects.toThrow(
        'Invoice enrichment returned error status'
      );
      expect(workday.submitNewSupplierInvoice).not.toHaveBeenCalled();
      expect(slack.notifyResult).toHaveBeenCalledTimes(1);
    });
  });

  describe('shadow mode', () => {
    const invoiceFile = {
      s3Key: 'new-invoices/req-1/1-invoice.pdf',
      fileName: 'invoice.pdf',
      contentType: 'application/pdf',
      kind: 'supplier_invoice',
      invoiceNumber: 'INV-100',
      confidence: 0.95,
    };
    const packingSlip = {
      s3Key: 'new-invoices/req-1/2-packing.pdf',
      fileName: 'packing.pdf',
      contentType: 'application/pdf',
      kind: 'supporting',
      supportingKind: 'packing_slip',
      confidence: 0.8,
    };

    it.each(['shadow', 'true', undefined])(
      'reports the clustering plan and writes nothing for a shadow record (flag %s)',
      async (flag) => {
        const { processor, workday, slack, invoiceEnrichment, clustering, registry, lambda, loadEnv } = freshRequire();
        loadEnv.mockResolvedValue(flag ? { INVOICE_ATTACHMENT_CLUSTERING_ENABLED: flag } : {});
        clustering.parseAndClusterInvoiceAttachments.mockResolvedValue({
          classified: [invoiceFile, packingSlip],
          clustering: {
            clusters: [{ primary: invoiceFile, supporting: [packingSlip], fallback: false }],
            unrelated: [],
          },
        });

        await processor({
          data: [{ conversationId: '1234567890', shadow: true, attachments: [invoiceFile, packingSlip] }],
        } as any);

        expect(clustering.parseAndClusterInvoiceAttachments).toHaveBeenCalledTimes(1);
        expect(invoiceEnrichment.enrichInvoiceFromAttachments).not.toHaveBeenCalled();
        expect(workday.submitNewSupplierInvoice).not.toHaveBeenCalled();
        expect(workday.submitSupplierInvoiceUpdate).not.toHaveBeenCalled();
        expect(registry.getConversationSupplierInvoice).not.toHaveBeenCalled();
        expect(registry.upsertConversationSupplierInvoice).not.toHaveBeenCalled();
        expect(lambda.InvokeCommand).not.toHaveBeenCalled();
        expect(slack.notifyResult).toHaveBeenCalledWith(
          'create_invoice_shadow',
          'success',
          expect.any(Number),
          expect.objectContaining({
            mode: 'shadow',
            wouldCreateInvoices: 1,
            clusters: [{
              invoice: 'invoice.pdf (supplier_invoice, #INV-100)',
              supporting: ['packing.pdf (supporting: packing_slip)'],
            }],
          }),
        );
      }
    );

    it('Slacks and rethrows when shadow classification fails, without writing', async () => {
      const { processor, workday, slack, clustering, loadEnv } = freshRequire();
      loadEnv.mockResolvedValue({ INVOICE_ATTACHMENT_CLUSTERING_ENABLED: 'shadow' });
      clustering.parseAndClusterInvoiceAttachments.mockRejectedValue(new Error('classify boom'));

      await expect(processor({
        data: [{ conversationId: '1234567890', shadow: true, attachments: [invoiceFile] }],
      } as any)).rejects.toThrow('classify boom');

      expect(workday.submitNewSupplierInvoice).not.toHaveBeenCalled();
      expect(slack.notifyResult).toHaveBeenCalledWith(
        'create_invoice_shadow', 'error', expect.any(Number), expect.anything(), expect.any(Error)
      );
    });

    it('creates the per-PDF invoice as usual without touching the registry when the flag is shadow', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, clustering, registry, loadEnv } = freshRequire();
      loadEnv.mockResolvedValue({ INVOICE_ATTACHMENT_CLUSTERING_ENABLED: 'shadow' });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);

      await processor({
        data: [{ ...attachmentRequest('new-invoices/req-1/invoice.pdf'), conversationId: '1234567890' }],
      } as any);

      expect(workday.submitNewSupplierInvoice).toHaveBeenCalledTimes(1);
      expect(clustering.parseAndClusterInvoiceAttachments).not.toHaveBeenCalled();
      expect(registry.getConversationSupplierInvoice).not.toHaveBeenCalled();
      expect(registry.upsertConversationSupplierInvoice).not.toHaveBeenCalled();
    });
  });

  describe('conversation resend', () => {
    const wid = 'b'.repeat(32);

    function enableClustering(loadEnv: { mockResolvedValue: (env: unknown) => void }) {
      loadEnv.mockResolvedValue({ INVOICE_ATTACHMENT_CLUSTERING_ENABLED: 'true' });
    }

    function registeredInvoice(overrides: Record<string, unknown> = {}) {
      return {
        conversationId: '1234567890',
        supplierInvoiceNumber: 'INV-001',
        supplierWid: 'supplier-wid-1',
        workdayInvoiceWid: wid,
        workdayInvoiceNumber: 'SUPIN-1',
        lastProcessedReceivedAt: 100,
        ...overrides,
      };
    }

    it('records the registry on first create', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, registry, loadEnv } = freshRequire();
      enableClustering(loadEnv);
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      registry.getConversationSupplierInvoice.mockResolvedValue(undefined);

      await processor({
        data: [{ ...attachmentRequest('new-invoices/req-1/invoice.pdf'), conversationId: '1234567890' }],
      } as any);

      expect(workday.submitNewSupplierInvoice).toHaveBeenCalledTimes(1);
      expect(registry.getConversationSupplierInvoice).toHaveBeenCalledWith(
        expect.anything(), '1234567890', 'INV-001'
      );
      expect(registry.upsertConversationSupplierInvoice).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          conversationId: '1234567890',
          supplierInvoiceNumber: 'INV-001',
          workdayInvoiceWid: 'new-invoice-wid',
          workdayInvoiceNumber: 'SUPIN-412727',
        })
      );
    });

    it('updates the existing invoice when a resend brings newer documents', async () => {
      const { processor, workday, slack, invoiceEnrichment, invoiceLines, registry, loadEnv } = freshRequire();
      enableClustering(loadEnv);
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      registry.getConversationSupplierInvoice.mockResolvedValue(registeredInvoice());
      workday.getSupplierInvoiceEditability.mockResolvedValue({ found: true, editable: true, status: 'Draft' });

      await processor({
        data: [{
          conversationId: '1234567890',
          clustered: true,
          attachments: [{ ...attachmentRequest('new-invoices/req-2/v2.pdf', 'v2.pdf'), receivedAt: 200 }],
        }],
      } as any);

      expect(workday.submitNewSupplierInvoice).not.toHaveBeenCalled();
      expect(workday.submitSupplierInvoiceUpdate).toHaveBeenCalledTimes(1);
      const updateArgs = workday.submitSupplierInvoiceUpdate.mock.calls[0][1];
      expect(updateArgs.invoiceWorkdayID).toBe(wid);
      expect(updateArgs.suppliersInvoiceNumber).toBe('INV-001');
      expect(updateArgs.attachments).toHaveLength(1);
      expect(updateArgs.buildNotes([])).toContain('Resubmission: conversation re-triggered');
      expect(registry.upsertConversationSupplierInvoice).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ lastProcessedReceivedAt: 200 })
      );
      expect(slack.notifyResult).toHaveBeenCalledWith(
        'create_invoice',
        'success',
        expect.any(Number),
        expect.objectContaining({ updated: true, invoiceNumber: 'SUPIN-1' }),
      );
    });

    it('builds a remaining-balance line on a resend update the same way as on create (SUPIN-471692)', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, registry, loadEnv } = freshRequire();
      enableClustering(loadEnv);
      invoiceLines.buildFinalInvoiceLines.mockImplementation((lines: any[]) => Promise.resolve({
        lines: lines.map((line, index) => ({
          lineOrder: index + 1,
          description: line.description,
          quantity: line.quantity,
          unitCost: Number(String(line.unitCost).replace(/[$,]/g, '')),
          extendedAmount: Number(String(line.totalPrice).replace(/[$,]/g, '')),
        })),
        appliedFallbacks: {},
      }));
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...baseEnrichmentResult,
        ...supin471692Header,
        extractedInvoiceLines: supin471692Rows,
      });
      registry.getConversationSupplierInvoice.mockResolvedValue(registeredInvoice());
      workday.getSupplierInvoiceEditability.mockResolvedValue({ found: true, editable: true, status: 'Draft' });

      await processor({
        data: [{
          conversationId: '1234567890',
          clustered: true,
          attachments: [{ ...attachmentRequest('new-invoices/req-2/v2.pdf', 'v2.pdf'), receivedAt: 200 }],
        }],
      } as any);

      expect(workday.submitNewSupplierInvoice).not.toHaveBeenCalled();
      const updateArgs = workday.submitSupplierInvoiceUpdate.mock.calls[0][1];
      expect(updateArgs.finalLines).toEqual([expect.objectContaining({ extendedAmount: 5909.5 })]);
      expect(updateArgs.buildNotes([])).toContain('Balance invoice: "Total Contract Price" is $23,887.00 but the amount due is $5,909.50');
    });

    it('sends the printed due date on a resend update', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, registry, loadEnv } = freshRequire();
      enableClustering(loadEnv);
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...baseEnrichmentResult,
        extractedInvoiceDate: '2026-10-10',
        extractedDueDate: '2026-11-11',
      });
      registry.getConversationSupplierInvoice.mockResolvedValue(registeredInvoice());
      workday.getSupplierInvoiceEditability.mockResolvedValue({ found: true, editable: true, status: 'Draft' });

      await processor({
        data: [{
          conversationId: '1234567890',
          clustered: true,
          attachments: [{ ...attachmentRequest('new-invoices/req-2/v2.pdf', 'v2.pdf'), receivedAt: 200 }],
        }],
      } as any);

      const updateArgs = workday.submitSupplierInvoiceUpdate.mock.calls[0][1];
      expect(updateArgs).toMatchObject({ invoiceDate: '2026-10-10', dueDate: '2026-11-11' });
      expect(updateArgs.buildNotes([])).toContain('Due Date (from document): 2026-11-11');
    });

    it('snapshots a resend update and keeps the AP edits the update overwrote', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, registry, loadEnv, database } = freshRequire();
      enableClustering(loadEnv);
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      registry.getConversationSupplierInvoice.mockResolvedValue(registeredInvoice());
      workday.getSupplierInvoiceEditability.mockResolvedValue({ found: true, editable: true, status: 'Draft' });
      workday.submitSupplierInvoiceUpdate.mockResolvedValueOnce({
        success: true,
        appliedFallbacks: [],
        previousInvoice: { Memo: 'AP memo' },
      });
      workday.getSupplierInvoice = jest.fn().mockResolvedValue({ Memo: 'Agent memo' });
      const db = await database.getDatabaseConnection();
      db.query.mockImplementation(async (sql: string) => (sql.includes('SELECT') && sql.includes('agent_invoice_snapshots')
        ? [{ workday_invoice_wid: wid, write_seq: 1, source: 'create', fields: { memo: 'Agent memo', lines: [] }, created_at: new Date() }]
        : []));

      await processor({
        data: [{
          conversationId: '1234567890',
          clustered: true,
          attachments: [{ ...attachmentRequest('new-invoices/req-2/v2.pdf', 'v2.pdf'), receivedAt: 200 }],
        }],
      } as any);

      const insert = db.query.mock.calls.find(([sql]: [string]) => sql.includes('INSERT INTO agent_invoice_snapshots'));
      expect(insert?.[1][1]).toBe('resend_update');
      expect(JSON.parse(insert?.[1][9])).toEqual([{ field: 'memo', before: 'Agent memo', after: 'AP memo' }]);
      db.query.mockReset();
      db.query.mockResolvedValue([]);
      delete workday.getSupplierInvoice;
    });

    it('reports the timestamped supplier invoice number after a duplicate retry on resend', async () => {
      const { processor, workday, slack, invoiceEnrichment, invoiceLines, registry, loadEnv } = freshRequire();
      enableClustering(loadEnv);
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      registry.getConversationSupplierInvoice.mockResolvedValue(registeredInvoice());
      workday.getSupplierInvoiceEditability.mockResolvedValue({ found: true, editable: true, status: 'Draft' });
      workday.submitSupplierInvoiceUpdate.mockResolvedValue({
        success: true,
        suppliersInvoiceNumber: 'INV-001-20260928170000',
        appliedFallbacks: [{
          field: 'suppliersInvoiceNumber',
          label: 'supplier invoice number suffixed with -20260928170000',
          dueToValidationError: true,
        }],
      });

      await processor({
        data: [{
          conversationId: '1234567890',
          clustered: true,
          attachments: [{ ...attachmentRequest('new-invoices/req-2/v2.pdf', 'v2.pdf'), receivedAt: 200 }],
        }],
      } as any);

      expect(slack.notifyResult).toHaveBeenCalledWith(
        'create_invoice',
        'success',
        expect.any(Number),
        expect.objectContaining({
          updated: true,
          extracted: expect.objectContaining({ suppliersInvoiceNumber: 'INV-001-20260928170000' }),
          appliedFallbacks: expect.arrayContaining(['supplier invoice number suffixed with -20260928170000']),
        }),
      );
    });

    it('names consumed PO lines, not a closed PO, on the resend Slack fallbacks', async () => {
      const { processor, workday, slack, invoiceEnrichment, invoiceLines, registry, loadEnv } = freshRequire();
      enableClustering(loadEnv);
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      workday.loadPurchaseOrder.mockResolvedValue({
        documentNumber: 'PO-414498',
        company: { workdayId: 'pga-company-wid', descriptor: 'PGA of America' },
        lines: [1, 2].map((n) => ({
          lineOrder: n,
          purchaseOrderLineId: `POL-${n}`,
          purchaseOrderDocumentNumber: 'PO-414498',
          invoiceStatus: { descriptor: 'Fully Invoiced' },
        })),
      });
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...baseEnrichmentResult,
        extractedPurchaseOrderNumber: 'PO-414498',
      });
      registry.getConversationSupplierInvoice.mockResolvedValue(registeredInvoice());
      workday.getSupplierInvoiceEditability.mockResolvedValue({ found: true, editable: true, status: 'Draft' });
      workday.submitSupplierInvoiceUpdate.mockResolvedValue({
        success: true,
        appliedFallbacks: [{ field: 'consumedPurchaseOrderLine', label: 'omitted PO line reference (PO line fully invoiced or closed)' }],
      });

      await processor({
        data: [{
          conversationId: '1234567890',
          clustered: true,
          attachments: [{ ...attachmentRequest('new-invoices/req-2/v2.pdf', 'v2.pdf'), receivedAt: 200 }],
        }],
      } as any);

      expect(workday.submitSupplierInvoiceUpdate.mock.calls[0][1].omitPurchaseOrderLineReference).toBeUndefined();
      expect(slack.notifyResult).toHaveBeenCalledWith(
        'create_invoice',
        'success',
        expect.any(Number),
        expect.objectContaining({
          updated: true,
          appliedFallbacks: ['Invoice lines that matched lines on PO-414498 already fully invoiced or closed were coded from the PO but not linked to PO lines.'],
        }),
      );
    });

    it('skips the resend when no documents are newer than the last processing', async () => {
      const { processor, workday, slack, invoiceEnrichment, invoiceLines, registry, loadEnv } = freshRequire();
      enableClustering(loadEnv);
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      registry.getConversationSupplierInvoice.mockResolvedValue(registeredInvoice({ lastProcessedReceivedAt: 200 }));
      workday.getSupplierInvoiceEditability.mockResolvedValue({ found: true, editable: true, status: 'Draft' });

      await processor({
        data: [{
          conversationId: '1234567890',
          clustered: true,
          attachments: [{ ...attachmentRequest('new-invoices/req-2/v2.pdf', 'v2.pdf'), receivedAt: 200 }],
        }],
      } as any);

      expect(workday.submitNewSupplierInvoice).not.toHaveBeenCalled();
      expect(workday.submitSupplierInvoiceUpdate).not.toHaveBeenCalled();
      expect(slack.notifyResult).toHaveBeenCalledWith(
        'create_invoice',
        'success',
        expect.any(Number),
        expect.objectContaining({ skipped: true, invoiceNumber: 'SUPIN-1' }),
      );
    });

    it.each([
      ['canceled', { found: true, editable: false, status: 'Canceled', isCanceled: true }],
      ['deleted from Workday', { found: false, editable: false }],
    ])('creates a replacement when the registered invoice was %s and a newer document for it arrived', async (_label, editability) => {
      const { processor, workday, slack, invoiceEnrichment, invoiceLines, registry, loadEnv } = freshRequire();
      enableClustering(loadEnv);
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      registry.getConversationSupplierInvoice.mockResolvedValue(registeredInvoice({ lastProcessedReceivedAt: 200 }));
      workday.getSupplierInvoiceEditability.mockResolvedValue(editability);

      await processor({
        data: [{
          conversationId: '1234567890',
          clustered: true,
          attachments: [{ ...attachmentRequest('new-invoices/req-2/v2.pdf', 'v2.pdf'), receivedAt: 300 }],
        }],
      } as any);

      expect(workday.submitSupplierInvoiceUpdate).not.toHaveBeenCalled();
      expect(workday.submitNewSupplierInvoice).toHaveBeenCalledTimes(1);
      const createArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(createArgs.buildNotes([], [])).toContain('Replaces canceled invoice SUPIN-1 from the same conversation.');
      expect(registry.upsertConversationSupplierInvoice).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ workdayInvoiceWid: 'new-invoice-wid', workdayInvoiceNumber: 'SUPIN-412727' })
      );
      expect(slack.notifyResult).toHaveBeenCalledWith(
        'create_invoice',
        'success',
        expect.any(Number),
        expect.objectContaining({ invoiceNumber: 'SUPIN-412727', replacesCanceledInvoice: 'SUPIN-1' }),
      );
    });

    it.each([
      ['canceled', { found: true, editable: false, status: 'Canceled', isCanceled: true }],
      ['deleted from Workday', { found: false, editable: false }],
    ])('does not bring back a %s invoice when only a newer message arrived', async (_label, editability) => {
      const { processor, workday, slack, invoiceEnrichment, invoiceLines, registry, loadEnv } = freshRequire();
      enableClustering(loadEnv);
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      registry.getConversationSupplierInvoice.mockResolvedValue(registeredInvoice({ lastProcessedReceivedAt: 200 }));
      workday.getSupplierInvoiceEditability.mockResolvedValue(editability);

      await processor({
        data: [{
          conversationId: '1234567890',
          clustered: true,
          latestMessageAt: 300,
          attachments: [{ ...attachmentRequest('new-invoices/req-2/v1.pdf', 'v1.pdf'), receivedAt: 200 }],
        }],
      } as any);

      expect(workday.submitNewSupplierInvoice).not.toHaveBeenCalled();
      expect(workday.submitSupplierInvoiceUpdate).not.toHaveBeenCalled();
      expect(registry.upsertConversationSupplierInvoice).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ workdayInvoiceWid: wid, lastProcessedReceivedAt: 300 })
      );
      expect(slack.notifyResult).toHaveBeenCalledWith(
        'create_invoice',
        'success',
        expect.any(Number),
        expect.objectContaining({
          skipped: true,
          canceledNotReplaced: true,
          skipReason: 'Invoice SUPIN-1 was canceled and no newer document for it arrived, so no replacement was created.',
        }),
      );
    });

    it('leaves an existing invoice alone when the newer message brought a different invoice', async () => {
      const { processor, workday, slack, invoiceEnrichment, invoiceLines, registry, loadEnv } = freshRequire();
      enableClustering(loadEnv);
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      registry.getConversationSupplierInvoice.mockResolvedValue(registeredInvoice({ lastProcessedReceivedAt: 200 }));
      workday.getSupplierInvoiceEditability.mockResolvedValue({ found: true, editable: true, status: 'Draft' });

      await processor({
        data: [{
          conversationId: '1234567890',
          clustered: true,
          latestMessageAt: 300,
          otherClustersLatestReceivedAt: 300,
          attachments: [{ ...attachmentRequest('new-invoices/req-2/v1.pdf', 'v1.pdf'), receivedAt: 200 }],
        }],
      } as any);

      expect(workday.submitSupplierInvoiceUpdate).not.toHaveBeenCalled();
      expect(workday.submitNewSupplierInvoice).not.toHaveBeenCalled();
      expect(registry.upsertConversationSupplierInvoice).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ lastProcessedReceivedAt: 300 })
      );
      expect(slack.notifyResult).toHaveBeenCalledWith(
        'create_invoice',
        'success',
        expect.any(Number),
        expect.objectContaining({ skipped: true, invoiceNumber: 'SUPIN-1' }),
      );
    });

    it('still updates on a later text-only reply after an unrelated invoice arrived', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, registry, loadEnv } = freshRequire();
      enableClustering(loadEnv);
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      registry.getConversationSupplierInvoice.mockResolvedValue(registeredInvoice({ lastProcessedReceivedAt: 300 }));
      workday.getSupplierInvoiceEditability.mockResolvedValue({ found: true, editable: true, status: 'Draft' });

      await processor({
        data: [{
          conversationId: '1234567890',
          clustered: true,
          latestMessageAt: 400,
          otherClustersLatestReceivedAt: 300,
          attachments: [{ ...attachmentRequest('new-invoices/req-2/v1.pdf', 'v1.pdf'), receivedAt: 200 }],
        }],
      } as any);

      expect(workday.submitSupplierInvoiceUpdate).toHaveBeenCalledTimes(1);
      expect(registry.upsertConversationSupplierInvoice).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ lastProcessedReceivedAt: 400 })
      );
    });

    it('updates when an AP note arrived after the unrelated invoice, before the same trigger', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, registry, loadEnv } = freshRequire();
      enableClustering(loadEnv);
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      registry.getConversationSupplierInvoice.mockResolvedValue(registeredInvoice({ lastProcessedReceivedAt: 200 }));
      workday.getSupplierInvoiceEditability.mockResolvedValue({ found: true, editable: true, status: 'Draft' });

      await processor({
        data: [{
          conversationId: '1234567890',
          clustered: true,
          latestMessageAt: 400,
          otherClustersLatestReceivedAt: 300,
          attachments: [{ ...attachmentRequest('new-invoices/req-2/v1.pdf', 'v1.pdf'), receivedAt: 200 }],
        }],
      } as any);

      expect(workday.submitSupplierInvoiceUpdate).toHaveBeenCalledTimes(1);
      expect(registry.upsertConversationSupplierInvoice).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ lastProcessedReceivedAt: 400 })
      );
    });

    it.each([
      ['create', undefined],
      ['update', registeredInvoice({ lastProcessedReceivedAt: 100 })],
    ])('carries the closed-PO line omission (and the Intercom URL on create) into the clustered %s', async (path, existing) => {
      const { processor, workday, invoiceEnrichment, invoiceLines, registry, loadEnv } = freshRequire();
      enableClustering(loadEnv);
      workday.loadPurchaseOrder.mockResolvedValue({
        documentNumber: 'PO-414498',
        company: { workdayId: 'pga-company-wid', descriptor: 'The Professional Golfers Association of America' },
        documentStatus: { id: 'CLOSED', descriptor: 'Closed' },
        lines: [{ lineOrder: 1, purchaseOrderLineId: 'POL-1', purchaseOrderDocumentNumber: 'PO-414498', description: 'Summit ENG' }],
      });
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...baseEnrichmentResult,
        extractedPurchaseOrderNumber: 'PO-414498',
      });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue({
        lines: [{ lineOrder: 1, description: 'Summit ENG', quantity: 1, unitCost: 100, extendedAmount: 100, purchaseOrderLineId: 'POL-1' }],
        appliedFallbacks: {},
        relatedLobByCostCenter: new Map(),
      });
      registry.getConversationSupplierInvoice.mockResolvedValue(existing);
      workday.getSupplierInvoiceEditability.mockResolvedValue({ found: true, editable: true, status: 'Draft' });

      await processor({
        data: [{
          conversationId: '1234567890',
          intercomAppId: 'sandbox-app',
          clustered: true,
          attachments: [{ ...attachmentRequest('new-invoices/req-2/v2.pdf', 'v2.pdf'), receivedAt: 200 }],
        }],
      } as any);

      if (path === 'create') {
        const createArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
        expect(createArgs.omitPurchaseOrderLineReference).toBe(true);
        expect(createArgs.conversationUrl).toEqual(expect.stringContaining('/conversation/1234567890'));
      } else {
        expect(workday.submitNewSupplierInvoice).not.toHaveBeenCalled();
        const updateArgs = workday.submitSupplierInvoiceUpdate.mock.calls[0][1];
        expect(updateArgs.omitPurchaseOrderLineReference).toBe(true);
      }
    });

    it('reports a failed watermark write on a skip instead of hiding it', async () => {
      const { processor, workday, slack, invoiceEnrichment, invoiceLines, registry, loadEnv } = freshRequire();
      enableClustering(loadEnv);
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      registry.getConversationSupplierInvoice.mockResolvedValue(registeredInvoice({ lastProcessedReceivedAt: 200 }));
      registry.upsertConversationSupplierInvoice.mockRejectedValue(new Error('db down'));
      workday.getSupplierInvoiceEditability.mockResolvedValue({ found: true, editable: true, status: 'Draft' });

      await processor({
        data: [{
          conversationId: '1234567890',
          clustered: true,
          latestMessageAt: 300,
          otherClustersLatestReceivedAt: 300,
          attachments: [{ ...attachmentRequest('new-invoices/req-2/v1.pdf', 'v1.pdf'), receivedAt: 200 }],
        }],
      } as any);

      expect(slack.notifyResult).toHaveBeenCalledWith(
        'create_invoice',
        'success',
        expect.any(Number),
        expect.objectContaining({ skipped: true, registrySync: 'failed' }),
      );
    });

    it('skips without touching Workday or the registry when another run holds the invoice claim', async () => {
      const { processor, workday, slack, invoiceEnrichment, invoiceLines, registry, loadEnv } = freshRequire();
      enableClustering(loadEnv);
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      registry.acquireConversationInvoiceClaim.mockResolvedValue(false);

      await processor({
        data: [{ ...attachmentRequest('new-invoices/req-1/invoice.pdf'), conversationId: '1234567890' }],
      } as any);

      expect(registry.acquireConversationInvoiceClaim).toHaveBeenCalledWith(expect.anything(), '1234567890', 'INV-001', expect.any(String));
      expect(registry.getConversationSupplierInvoice).not.toHaveBeenCalled();
      expect(workday.submitNewSupplierInvoice).not.toHaveBeenCalled();
      expect(workday.submitSupplierInvoiceUpdate).not.toHaveBeenCalled();
      expect(registry.releaseConversationInvoiceClaim).not.toHaveBeenCalled();
      expect(slack.notifyResult).toHaveBeenCalledWith(
        'create_invoice',
        'success',
        expect.any(Number),
        expect.objectContaining({ skipped: true, inProgressElsewhere: true }),
      );
    });

    it.each([
      ['succeeds', undefined],
      ['fails', new Error('Workday down')],
    ])('releases the invoice claim after the create %s', async (_label, failure) => {
      const { processor, workday, invoiceEnrichment, invoiceLines, registry, loadEnv } = freshRequire();
      enableClustering(loadEnv);
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      registry.getConversationSupplierInvoice.mockResolvedValue(undefined);
      if (failure) workday.submitNewSupplierInvoice.mockRejectedValue(failure);

      const run = processor({
        data: [{ ...attachmentRequest('new-invoices/req-1/invoice.pdf'), conversationId: '1234567890' }],
      } as any);
      if (failure) {
        await expect(run).rejects.toThrow('Workday down');
      } else {
        await run;
      }

      const token = registry.acquireConversationInvoiceClaim.mock.calls[0][3];
      expect(registry.releaseConversationInvoiceClaim).toHaveBeenCalledWith(expect.anything(), '1234567890', 'INV-001', token);
    });

    it('does not advance the watermark when a skip has nothing newer at all', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, registry, loadEnv } = freshRequire();
      enableClustering(loadEnv);
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      registry.getConversationSupplierInvoice.mockResolvedValue(registeredInvoice({ lastProcessedReceivedAt: 300 }));
      workday.getSupplierInvoiceEditability.mockResolvedValue({ found: true, editable: true, status: 'Draft' });

      await processor({
        data: [{
          conversationId: '1234567890',
          clustered: true,
          latestMessageAt: 250,
          attachments: [{ ...attachmentRequest('new-invoices/req-2/v1.pdf', 'v1.pdf'), receivedAt: 200 }],
        }],
      } as any);

      expect(workday.submitSupplierInvoiceUpdate).not.toHaveBeenCalled();
      expect(registry.upsertConversationSupplierInvoice).not.toHaveBeenCalled();
    });

    const transcriptPdf = {
      s3Key: 'new-invoices/req-2/pga_corp_accounts_payable_2026_09_21_1234567890.pdf',
      fileName: 'pga_corp_accounts_payable_2026_09_21_1234567890.pdf',
    };

    it('updates when a text-only supplier reply is newer, resending every document and the fresh transcript', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, registry, loadEnv } = freshRequire();
      enableClustering(loadEnv);
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      registry.getConversationSupplierInvoice.mockResolvedValue(registeredInvoice({ lastProcessedReceivedAt: 200 }));
      workday.getSupplierInvoiceEditability.mockResolvedValue({ found: true, editable: true, status: 'Draft' });

      await processor({
        data: [{
          conversationId: '1234567890',
          clustered: true,
          latestMessageAt: 300,
          conversationPdf: transcriptPdf,
          attachments: [{ ...attachmentRequest('new-invoices/req-2/v1.pdf', 'v1.pdf'), receivedAt: 200 }],
        }],
      } as any);

      expect(workday.submitNewSupplierInvoice).not.toHaveBeenCalled();
      expect(workday.submitSupplierInvoiceUpdate).toHaveBeenCalledTimes(1);
      const updateArgs = workday.submitSupplierInvoiceUpdate.mock.calls[0][1];
      expect(updateArgs.attachments.map((att: { fileName: string }) => att.fileName))
        .toEqual(['v1.pdf', transcriptPdf.fileName]);
      expect(updateArgs.buildNotes([])).toContain('No new attachments.');
      expect(invoiceEnrichment.enrichInvoiceFromAttachments.mock.calls[0][1]).toHaveLength(1);
      expect(registry.upsertConversationSupplierInvoice).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ lastProcessedReceivedAt: 300 })
      );
    });

    it('resends the full document set plus the transcript on update and names the new files', async () => {
      const { processor, workday, slack, invoiceEnrichment, invoiceLines, registry, loadEnv } = freshRequire();
      enableClustering(loadEnv);
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      registry.getConversationSupplierInvoice.mockResolvedValue(registeredInvoice({ lastProcessedReceivedAt: 100 }));
      workday.getSupplierInvoiceEditability.mockResolvedValue({ found: true, editable: true, status: 'Draft' });

      await processor({
        data: [{
          conversationId: '1234567890',
          clustered: true,
          conversationPdf: transcriptPdf,
          attachments: [
            { ...attachmentRequest('new-invoices/req-2/v2.pdf', 'v2.pdf'), receivedAt: 200 },
            { ...attachmentRequest('new-invoices/req-2/v1.pdf', 'v1.pdf'), receivedAt: 100 },
          ],
        }],
      } as any);

      const updateArgs = workday.submitSupplierInvoiceUpdate.mock.calls[0][1];
      expect(updateArgs.attachments.map((att: { fileName: string }) => att.fileName))
        .toEqual(['v2.pdf', 'v1.pdf', transcriptPdf.fileName]);
      expect(updateArgs.buildNotes([])).toContain('New attachments: v2.pdf.');
      expect(invoiceEnrichment.enrichInvoiceFromAttachments.mock.calls[0][1]
        .map((att: { fileName: string }) => att.fileName)).toEqual(['1-v2.pdf', '2-v1.pdf']);
      expect(slack.notifyResult).toHaveBeenCalledWith(
        'create_invoice',
        'success',
        expect.any(Number),
        expect.objectContaining({ updated: true, newAttachments: ['v2.pdf'] }),
      );
    });

    it('replaces the attachments on update with the latest copy only and reports the superseded one', async () => {
      const { processor, workday, slack, invoiceEnrichment, invoiceLines, registry, loadEnv } = freshRequire();
      enableClustering(loadEnv);
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      registry.getConversationSupplierInvoice.mockResolvedValue(registeredInvoice({ lastProcessedReceivedAt: 100 }));
      workday.getSupplierInvoiceEditability.mockResolvedValue({ found: true, editable: true, status: 'Draft' });

      await processor({
        data: [{
          conversationId: '1234567890',
          clustered: true,
          conversationPdf: transcriptPdf,
          supersededFileNames: ['v1.pdf'],
          attachments: [{ ...attachmentRequest('new-invoices/req-2/v2.pdf', 'v2.pdf'), receivedAt: 200 }],
        }],
      } as any);

      const updateArgs = workday.submitSupplierInvoiceUpdate.mock.calls[0][1];
      expect(updateArgs.attachments.map((att: { fileName: string }) => att.fileName))
        .toEqual(['v2.pdf', transcriptPdf.fileName]);
      expect(slack.notifyResult).toHaveBeenCalledWith(
        'create_invoice',
        'success',
        expect.any(Number),
        expect.objectContaining({ updated: true, supersededAttachments: ['v1.pdf'] }),
      );
    });

    it('skips with a manual-review note when the invoice is no longer editable', async () => {
      const { processor, workday, slack, invoiceEnrichment, invoiceLines, registry, loadEnv } = freshRequire();
      enableClustering(loadEnv);
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      registry.getConversationSupplierInvoice.mockResolvedValue(registeredInvoice());
      workday.getSupplierInvoiceEditability.mockResolvedValue({
        found: true, editable: false, status: 'Approved', isPaid: true,
      });

      await processor({
        data: [{
          conversationId: '1234567890',
          clustered: true,
          attachments: [{ ...attachmentRequest('new-invoices/req-2/v2.pdf', 'v2.pdf'), receivedAt: 200 }],
        }],
      } as any);

      expect(workday.submitSupplierInvoiceUpdate).not.toHaveBeenCalled();
      expect(slack.notifyResult).toHaveBeenCalledWith(
        'create_invoice',
        'success',
        expect.any(Number),
        expect.objectContaining({
          skipped: true,
          needsManualReview: true,
          skipReason: expect.stringContaining('manual review'),
        }),
      );
    });

    it('updates instead of duplicating when supplier resolution moves from default to real', async () => {
      process.env.WORKDAY_DEFAULT_SUPPLIER_WID = 'default-supplier-wid';
      const { processor, workday, invoiceEnrichment, invoiceLines, registry, loadEnv } = freshRequire();
      enableClustering(loadEnv);
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      registry.getConversationSupplierInvoice.mockResolvedValue(registeredInvoice({ supplierWid: null }));
      workday.getSupplierInvoiceEditability.mockResolvedValue({ found: true, editable: true, status: 'Draft' });

      await processor({
        data: [{
          conversationId: '1234567890',
          clustered: true,
          attachments: [{ ...attachmentRequest('new-invoices/req-2/w9.pdf', 'w9.pdf'), receivedAt: 200 }],
        }],
      } as any);

      expect(workday.submitNewSupplierInvoice).not.toHaveBeenCalled();
      expect(workday.submitSupplierInvoiceUpdate.mock.calls[0][1].supplierWID).toBe('supplier-wid-1');
      expect(registry.upsertConversationSupplierInvoice).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ supplierWid: 'supplier-wid-1' })
      );
    });

    it('resubmits with the PO supplier while the registry keeps the invoice supplier', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, registry, loadEnv } = freshRequire();
      enableClustering(loadEnv);
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({ ...baseEnrichmentResult, extractedPurchaseOrderNumber: 'PO-414373' });
      workday.loadPurchaseOrder.mockResolvedValue({
        documentNumber: 'PO-414373',
        supplier: { workdayId: 'club-pro-wid', descriptor: 'CLUB PRO GOLF GROUP LLC' },
        lines: [{ lineOrder: 1, purchaseOrderLineId: 'ITEM_ORDER_LINE-3-29143', purchaseOrderDocumentNumber: 'PO-414373', description: 'Cart' }],
      });
      registry.getConversationSupplierInvoice.mockResolvedValue(registeredInvoice());
      workday.getSupplierInvoiceEditability.mockResolvedValue({ found: true, editable: true, status: 'Draft' });

      await processor({
        data: [{
          conversationId: '1234567890',
          clustered: true,
          attachments: [{ ...attachmentRequest('new-invoices/req-2/v2.pdf', 'v2.pdf'), receivedAt: 200 }],
        }],
      } as any);

      expect(workday.submitNewSupplierInvoice).not.toHaveBeenCalled();
      const updateArgs = workday.submitSupplierInvoiceUpdate.mock.calls[0][1];
      expect(updateArgs.supplierWID).toBe('club-pro-wid');
      expect(updateArgs.buildNotes([])).toContain('Supplier from PO: Set to CLUB PRO GOLF GROUP LLC, the supplier on PO-414373.');
      expect(registry.upsertConversationSupplierInvoice).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ supplierWid: 'supplier-wid-1' })
      );
    });

    it('keeps the registered real supplier when a resend only resolves to the default supplier', async () => {
      process.env.WORKDAY_DEFAULT_SUPPLIER_WID = 'default-supplier-wid';
      const { processor, workday, invoiceEnrichment, invoiceLines, registry, loadEnv } = freshRequire();
      enableClustering(loadEnv);
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...baseEnrichmentResult,
        supplier: { ...baseEnrichmentResult.supplier, status: 'not_found', resolvedSupplier: null },
      });
      registry.getConversationSupplierInvoice.mockResolvedValue(registeredInvoice());
      workday.getSupplierInvoiceEditability.mockResolvedValue({ found: true, editable: true, status: 'Draft' });

      await processor({
        data: [{
          conversationId: '1234567890',
          clustered: true,
          attachments: [{ ...attachmentRequest('new-invoices/req-2/v2.pdf', 'v2.pdf'), receivedAt: 200 }],
        }],
      } as any);

      expect(workday.submitNewSupplierInvoice).not.toHaveBeenCalled();
      expect(workday.submitSupplierInvoiceUpdate.mock.calls[0][1].supplierWID).toBe('supplier-wid-1');
      expect(registry.upsertConversationSupplierInvoice).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ supplierWid: 'supplier-wid-1' })
      );
    });

    it('creates a new invoice when the same number resolves to a different supplier', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, registry, loadEnv } = freshRequire();
      enableClustering(loadEnv);
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      registry.getConversationSupplierInvoice.mockResolvedValue(
        registeredInvoice({ supplierWid: 'other-supplier-wid' })
      );

      await processor({
        data: [{ ...attachmentRequest('new-invoices/req-1/invoice.pdf'), conversationId: '1234567890' }],
      } as any);

      expect(workday.submitNewSupplierInvoice).toHaveBeenCalledTimes(1);
      expect(workday.submitSupplierInvoiceUpdate).not.toHaveBeenCalled();
    });

    it('creates without touching the registry when no invoice number was extracted', async () => {
      const { processor, workday, invoiceEnrichment, invoiceLines, registry, loadEnv } = freshRequire();
      enableClustering(loadEnv);
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
        ...baseEnrichmentResult,
        extractedSuppliersInvoiceNumber: null,
      });

      await processor({
        data: [{ ...attachmentRequest('new-invoices/req-1/invoice.pdf'), conversationId: '1234567890' }],
      } as any);

      expect(workday.submitNewSupplierInvoice).toHaveBeenCalledTimes(1);
      expect(registry.getConversationSupplierInvoice).not.toHaveBeenCalled();
      expect(registry.upsertConversationSupplierInvoice).not.toHaveBeenCalled();
    });

    it('fails loudly when the editability check errors', async () => {
      const { processor, workday, slack, invoiceEnrichment, invoiceLines, registry, loadEnv } = freshRequire();
      enableClustering(loadEnv);
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      registry.getConversationSupplierInvoice.mockResolvedValue(registeredInvoice());
      workday.getSupplierInvoiceEditability.mockRejectedValue(new Error('WQL down'));

      await expect(processor({
        data: [{
          conversationId: '1234567890',
          clustered: true,
          attachments: [{ ...attachmentRequest('new-invoices/req-2/v2.pdf', 'v2.pdf'), receivedAt: 200 }],
        }],
      } as any)).rejects.toThrow('WQL down');
      expect(workday.submitSupplierInvoiceUpdate).not.toHaveBeenCalled();
      expect(slack.notifyResult).toHaveBeenCalledWith(
        'create_invoice', 'error', expect.any(Number), expect.anything(), expect.any(Error)
      );
    });

    it('succeeds with a registry warning when the registry write fails after create', async () => {
      const { processor, slack, invoiceEnrichment, invoiceLines, registry, loadEnv } = freshRequire();
      enableClustering(loadEnv);
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
      registry.getConversationSupplierInvoice.mockResolvedValue(undefined);
      registry.upsertConversationSupplierInvoice.mockRejectedValue(new Error('DB down'));

      await processor({
        data: [{ ...attachmentRequest('new-invoices/req-1/invoice.pdf'), conversationId: '1234567890' }],
      } as any);

      expect(slack.notifyResult).toHaveBeenCalledWith(
        'create_invoice',
        'success',
        expect.any(Number),
        expect.objectContaining({ invoiceNumber: 'SUPIN-412727', registrySync: 'failed' }),
      );
    });
  });

  // KNIGHT JV LLC (LevelBlue), Intercom conversation 215476370619232: each PDF bundles seven monthly invoices,
  // one per page. Only page 1 was read, so the other six invoices in each PDF were silently dropped.
  describe('one PDF holding several supplier invoices', () => {
    const po412640Numbers = ['LBL20428245', 'LBL20453710', 'LBL20475512', 'LBL20488608', 'LBL20499004', 'LBL20508800', 'LBL20518206'];
    const po412641Numbers = ['LBL20428246', 'LBL20453711', 'LBL20475513', 'LBL20488609', 'LBL20499005', 'LBL20508801', 'LBL20518207'];
    const bundledEnrichment = (numbers: string[]) => ({
      ...baseEnrichmentResult,
      extractedSuppliersInvoiceNumber: numbers[0],
      invoiceNumbersInDocument: numbers,
    });

    it('adds a review note to the Workday note and the Slack post and still enters only the first invoice', async () => {
      process.env.INVOICE_MOD_ENABLED = 'true';
      const { processor, workday, slack, invoiceEnrichment, invoiceLines } = freshRequire();
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(bundledEnrichment(po412640Numbers));

      await processor({ data: [attachmentRequest('new-invoices/req-1/1-PO-412640.pdf', 'PO-412640.pdf')] } as any);

      const expected = `PO-412640.pdf appears to contain 7 invoices (${po412640Numbers.join(', ')}); only LBL20428245 was entered. Enter the rest manually.`;
      expect(workday.submitNewSupplierInvoice).toHaveBeenCalledTimes(1);
      const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
      expect(submitArgs.suppliersInvoiceNumber).toBe('LBL20428245');
      const notes = submitArgs.buildNotes([]);
      expect(notes.startsWith(`Multiple invoices in one PDF: ${expected}\n\nSupplier: `)).toBe(true);
      expect(slack.notifyResult).toHaveBeenCalledWith(
        'create_invoice',
        'success',
        expect.any(Number),
        expect.objectContaining({
          invoiceNumber: 'SUPIN-412727',
          multipleInvoices: { fileName: 'PO-412640.pdf', invoiceNumbers: po412640Numbers, message: expected },
        }),
      );
    });

    it('reviews each PDF of the conversation on its own', async () => {
      process.env.INVOICE_MOD_ENABLED = 'true';
      const { processor, workday, slack, invoiceEnrichment, invoiceLines } = freshRequire();
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments
        .mockResolvedValueOnce(bundledEnrichment(po412640Numbers))
        .mockResolvedValueOnce(bundledEnrichment(po412641Numbers));

      await processor({
        data: [
          attachmentRequest('new-invoices/req-1/1-PO-412640.pdf', 'PO-412640.pdf'),
          attachmentRequest('new-invoices/req-1/2-PO-412641.pdf', 'PO-412641.pdf'),
        ],
      } as any);

      expect(workday.submitNewSupplierInvoice).toHaveBeenCalledTimes(2);
      expect(workday.submitNewSupplierInvoice.mock.calls[1][1].buildNotes([]))
        .toContain(`PO-412641.pdf appears to contain 7 invoices (${po412641Numbers.join(', ')}); only LBL20428246 was entered.`);
      expect(slack.notifyResult.mock.calls.map((call: unknown[]) => (call[3] as any).multipleInvoices.fileName))
        .toEqual(['PO-412640.pdf', 'PO-412641.pdf']);
    });

    it('adds nothing for a PDF with one invoice, with or without the reader listing its number', async () => {
      process.env.INVOICE_MOD_ENABLED = 'true';
      const { processor, workday, slack, invoiceEnrichment, invoiceLines } = freshRequire();
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments
        .mockResolvedValueOnce({ ...baseEnrichmentResult, invoiceNumbersInDocument: ['INV-001'] })
        .mockResolvedValueOnce({ ...baseEnrichmentResult, invoiceNumbersInDocument: null })
        .mockResolvedValueOnce(baseEnrichmentResult);

      await processor({
        data: ['a', 'b', 'c'].map((name) => attachmentRequest(`new-invoices/req-1/${name}.pdf`, `${name}.pdf`)),
      } as any);

      expect(workday.submitNewSupplierInvoice).toHaveBeenCalledTimes(3);
      for (const [, submitArgs] of workday.submitNewSupplierInvoice.mock.calls) {
        expect(submitArgs.buildNotes([])).not.toContain('Multiple invoices');
        expect(submitArgs.buildNotes([])).not.toContain('appears to contain');
      }
      for (const call of slack.notifyResult.mock.calls) {
        expect(call[3]).not.toHaveProperty('multipleInvoices');
      }
    });

    it('keeps the note on a resend update and names the PDF in the skipped post when the invoice is already approved', async () => {
      const { processor, workday, slack, invoiceEnrichment, invoiceLines, registry, loadEnv } = freshRequire();
      loadEnv.mockResolvedValue({ INVOICE_ATTACHMENT_CLUSTERING_ENABLED: 'true' });
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);
      invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(bundledEnrichment(po412640Numbers));
      registry.getConversationSupplierInvoice.mockResolvedValue({
        conversationId: '215476370619232',
        supplierInvoiceNumber: 'LBL20428245',
        supplierWid: 'supplier-wid-1',
        workdayInvoiceWid: 'wid-467351',
        workdayInvoiceNumber: 'SUPIN-467351',
        lastProcessedReceivedAt: 100,
      });
      const resend = {
        data: [{
          conversationId: '215476370619232',
          clustered: true,
          attachments: [{ ...attachmentRequest('new-invoices/req-2/3-PO-412640.pdf', 'PO-412640.pdf'), receivedAt: 200 }],
        }],
      } as any;

      workday.getSupplierInvoiceEditability.mockResolvedValue({ found: true, editable: true, status: 'Draft' });
      await processor(resend);
      expect(workday.submitSupplierInvoiceUpdate.mock.calls[0][1].buildNotes([]))
        .toContain('Multiple invoices in one PDF: PO-412640.pdf appears to contain 7 invoices');

      workday.getSupplierInvoiceEditability.mockResolvedValue({ found: true, editable: false, status: 'Approved', isPaid: true });
      await processor(resend);
      expect(workday.submitSupplierInvoiceUpdate).toHaveBeenCalledTimes(1);
      expect(slack.notifyResult).toHaveBeenLastCalledWith(
        'create_invoice',
        'success',
        expect.any(Number),
        expect.objectContaining({
          skipped: true,
          needsManualReview: true,
          multipleInvoices: expect.objectContaining({ fileName: 'PO-412640.pdf', invoiceNumbers: po412640Numbers }),
        }),
      );
    });
  });
});
