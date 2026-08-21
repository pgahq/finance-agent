// create_invoice.ts reads WORKDAY_DEFAULT_COMPANY_REFERENCE_ID / WORKDAY_DEFAULT_SUPPLIER_WID /
// INVOICE_MOD_ENABLED as module-level constants at import time. Each test sets the env
// vars it needs, resets the module registry, and re-requires the module (and its mocked
// dependencies) fresh so those constants are re-evaluated against the current env.

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
  submitNewSupplierInvoice: jest.fn().mockResolvedValue({ success: true, invoiceWID: 'new-invoice-wid', appliedFallbacks: [] })
}));

jest.mock('../lib/database.js', () => ({
  getDatabaseConnection: jest.fn().mockResolvedValue({
    query: jest.fn().mockResolvedValue([]),
    close: jest.fn().mockResolvedValue({})
  }),
  searchSimilarDocuments: jest.fn().mockResolvedValue([]),
  getCostCenterRelatedLobsByCodes: jest.fn().mockResolvedValue(new Map()),
  getCostCenterWorkdayIdsByCodes: jest.fn().mockResolvedValue(new Map())
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

jest.mock('../lib/invoice_lines.js', () => ({
  buildFinalInvoiceLines: jest.fn()
}));

const mockGetGmailConfig = jest.fn();
const mockApplyProcessorLabelOutcome = jest.fn();

jest.mock('../lib/gmail.js', () => ({
  getGmailConfig: (...args: unknown[]) => mockGetGmailConfig(...args),
  applyProcessorLabelOutcome: (...args: unknown[]) => mockApplyProcessorLabelOutcome(...args),
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
  extractedInvoiceLines: [
    { description: 'Widgets', quantity: 2, unitCost: '50.00', totalPrice: '100.00', hasDiscount: false }
  ],
  emailWorktags: null,
  emailSummary: null
};

const defaultFinalLines = {
  lines: [{ lineOrder: 1, description: 'Widgets', quantity: 2, unitCost: 50 }],
  appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false }
};

// Resets the module registry and re-requires create_invoice.js and its mocked dependencies,
// so module-level env constants (e.g. WORKDAY_DEFAULT_COMPANY_REFERENCE_ID) reflect the current env.
function freshRequire() {
  jest.resetModules();
  const { processor } = require('../create_invoice.js');
  return {
    processor,
    workday: require('../lib/workday.js'),
    slack: require('../lib/slack.js'),
    invoiceEnrichment: require('../lib/invoice_enrichment.js'),
    invoiceLines: require('../lib/invoice_lines.js'),
  };
}

function attachmentRequest(s3Key: string, fileName = 'invoice.pdf') {
  return { s3Key, fileName, contentType: 'application/pdf' };
}

describe('create_invoice', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.WORKDAY_DEFAULT_COMPANY_REFERENCE_ID;
    delete process.env.WORKDAY_DEFAULT_SUPPLIER_WID;
    delete process.env.INVOICE_MOD_ENABLED;
    mockGetGmailConfig.mockResolvedValue({
      accessToken: 'ya29.test',
      userEmail: 'ap@pgahq.com',
      environment: 'sandbox',
      apiBaseUrl: 'https://gmail.googleapis.com',
    });
    mockApplyProcessorLabelOutcome.mockResolvedValue('success');
  });

  afterEach(() => {
    delete process.env.WORKDAY_DEFAULT_COMPANY_REFERENCE_ID;
    delete process.env.WORKDAY_DEFAULT_SUPPLIER_WID;
    delete process.env.INVOICE_MOD_ENABLED;
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
    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][4]).toEqual({
      costCenterId: '72200',
      eventWid: 'event-wid',
      lobReferenceId: 'lob-id',
      fundReferenceId: 'fund-id',
      spendCategoryReferenceId: 'spend-id',
    });

    expect(workday.submitNewSupplierInvoice).toHaveBeenCalledTimes(1);
    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.supplierWID).toBe('supplier-wid-1');
    expect(submitArgs.companyWID).toBe('Default_OCR_Company');
    expect(submitArgs.companyReferenceType).toBe('Company_Reference_ID');
    expect(submitArgs.attachment).toEqual({
      fileName: 'invoice.pdf',
      contentType: 'application/pdf',
      base64Content: Buffer.from('fake-pdf-content').toString('base64')
    });

    expect(slack.notifyResult).toHaveBeenCalledWith(
      'create_invoice',
      'success',
      expect.any(Number),
      expect.objectContaining({
        invoiceWID: 'new-invoice-wid',
        attachment: {
          fileName: 'invoice.pdf',
          contentType: 'application/pdf',
          sizeBytes: Buffer.byteLength('fake-pdf-content'),
          includedInline: true,
        }
      })
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
    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.finalLines).toEqual([{ lineOrder: 1, description: 'Office supplies', quantity: 1, unitCost: 100 }]);
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

  it('should allow overriding the default company reference id via WORKDAY_DEFAULT_COMPANY_REFERENCE_ID', async () => {
    process.env.WORKDAY_DEFAULT_COMPANY_REFERENCE_ID = 'Custom_Placeholder_Company';

    const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

    const event = {
      data: [attachmentRequest('new-invoices/req-7/invoice.pdf')]
    };

    await expect(processor(event as any)).resolves.not.toThrow();

    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.companyWID).toBe('Custom_Placeholder_Company');
    expect(submitArgs.companyReferenceType).toBe('Company_Reference_ID');
  });

  it('updates the Gmail success label when the payload includes Gmail ids', async () => {
    const { processor, invoiceEnrichment, invoiceLines } = freshRequire();
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

    await processor({
      data: [{
        ...attachmentRequest('new-invoices/req-8/invoice.pdf'),
        gmailMessageId: 'msg-1',
        userEmail: 'ap@pgahq.com',
      }]
    } as any);

    expect(mockGetGmailConfig).toHaveBeenCalledWith(expect.anything(), 'ap@pgahq.com', undefined);
    expect(mockApplyProcessorLabelOutcome).toHaveBeenCalledWith(
      expect.anything(),
      'msg-1',
      'success',
    );
  });

  it('updates the Gmail failure label when enrichment fails for a Gmail payload', async () => {
    const { processor, invoiceEnrichment } = freshRequire();
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      supplier: { ...baseEnrichmentResult.supplier, status: 'error', reason: 'AI failure' }
    });

    await expect(processor({
      data: [{
        ...attachmentRequest('new-invoices/req-9/invoice.pdf'),
        gmailMessageId: 'msg-1',
        userEmail: 'ap@pgahq.com',
      }]
    } as any)).rejects.toThrow('Invoice enrichment returned error status');

    expect(mockGetGmailConfig).toHaveBeenCalledWith(expect.anything(), 'ap@pgahq.com', undefined);
    expect(mockApplyProcessorLabelOutcome).toHaveBeenCalledWith(
      expect.anything(),
      'msg-1',
      'failure',
    );
  });

  it('passes the add-on user OAuth token when updating Gmail labels', async () => {
    const { processor, invoiceEnrichment, invoiceLines } = freshRequire();
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

    await processor({
      data: [{
        ...attachmentRequest('new-invoices/req-11/invoice.pdf'),
        gmailMessageId: 'msg-1',
        userEmail: 'ap@pgahq.com',
        gmailAccessToken: 'ya29.user',
      }]
    } as any);

    expect(mockGetGmailConfig).toHaveBeenCalledWith(expect.anything(), 'ap@pgahq.com', 'ya29.user');
    expect(mockApplyProcessorLabelOutcome).toHaveBeenCalledWith(
      expect.anything(),
      'msg-1',
      'success',
    );
  });

  it('does not touch Gmail labels for Intercom payloads', async () => {
    const { processor, invoiceEnrichment, invoiceLines } = freshRequire();
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

    await processor({
      data: [attachmentRequest('new-invoices/req-10/invoice.pdf')]
    } as any);

    expect(mockGetGmailConfig).not.toHaveBeenCalled();
    expect(mockApplyProcessorLabelOutcome).not.toHaveBeenCalled();
  });
});
