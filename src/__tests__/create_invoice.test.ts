// create_invoice.ts reads WORKDAY_DEFAULT_COMPANY_NAME / WORKDAY_DEFAULT_SUPPLIER_WID /
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
  parsePurchaseOrder: jest.fn(),
  loadPurchaseOrder: jest.fn().mockResolvedValue(undefined),
  submitNewSupplierInvoice: jest.fn().mockResolvedValue({ success: true, invoiceWID: 'new-invoice-wid', appliedFallbacks: [] })
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
// so module-level env constants (e.g. WORKDAY_DEFAULT_COMPANY_NAME) reflect the current env.
function freshRequire() {
  jest.resetModules();
  const { processor } = require('../create_invoice.js');
  return {
    processor,
    workday: require('../lib/workday.js'),
    slack: require('../lib/slack.js'),
    invoiceEnrichment: require('../lib/invoice_enrichment.js'),
    invoiceLines: require('../lib/invoice_lines.js'),
    database: require('../lib/database.js'),
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
    mockGetGmailConfig.mockResolvedValue({
      accessToken: 'ya29.test',
      userEmail: 'ap@pgahq.com',
      environment: 'sandbox',
      apiBaseUrl: 'https://gmail.googleapis.com',
    });
    mockApplyProcessorLabelOutcome.mockResolvedValue('success');
  });

  afterEach(() => {
    delete process.env.WORKDAY_DEFAULT_COMPANY_NAME;
    delete process.env.WORKDAY_DEFAULT_COMPANY_WID;
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
    expect(submitArgs.companyWID).toBe('pga-america-wid');
    expect(submitArgs.companyReferenceType).toBe('WID');
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

  it('should not synthesize a merchandise line that re-includes freight on a freight-only invoice', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue({
      ...baseEnrichmentResult,
      extractedAmountDue: '$15.00',
      extractedFreightAmount: '$15.00',
      extractedInvoiceLines: [
        { description: 'Shipping', quantity: 1, unitCost: '15.00', totalPrice: '15.00', hasDiscount: false }
      ]
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue({
      lines: [],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false }
    });

    await processor({
      data: [attachmentRequest('new-invoices/req-freight-only/invoice.pdf')]
    } as any);

    expect(invoiceLines.buildFinalInvoiceLines).toHaveBeenCalledTimes(1);
    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0]).toEqual([]);
    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.extractedFreightAmount).toBe('$15.00');
    expect(submitArgs.finalLines).toEqual([]);
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
      { lineOrder: 1, description: 'Office supplies', quantity: 1, unitCost: 100 }
    ]);
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

  it('should use the cached PGA of America company when no PO is present', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines, database } = freshRequire();
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue(defaultFinalLines);

    const event = {
      data: [attachmentRequest('new-invoices/req-7/invoice.pdf')]
    };

    await expect(processor(event as any)).resolves.not.toThrow();

    expect(database.findCompanyByName).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(['The Professional Golfers Association of America'])
    );
    expect(invoiceEnrichment.enrichInvoiceFromAttachments.mock.calls[0][3]).toEqual({
      descriptor: 'The Professional Golfers Association of America',
      id: 'pga-america-wid'
    });
    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.companyWID).toBe('pga-america-wid');
    expect(submitArgs.companyReferenceType).toBe('WID');
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
    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][1]).toEqual(parsedPo.lines);

    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.companyWID).toBe('pga-company-wid');
    expect(submitArgs.companyReferenceType).toBe('WID');
  });

  it('should keep a recommended company WID over the PO company', async () => {
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
    expect(submitArgs.companyWID).toBe('section-wid');
    expect(submitArgs.companyReferenceType).toBe('WID');
    expect(submitArgs.buildNotes([])).toContain('Changed to: Tennessee Section PGA of America');
    expect(slack.notifyResult).toHaveBeenCalledWith(
      'create_invoice',
      'success',
      expect.any(Number),
      expect.objectContaining({
        company: expect.objectContaining({
          appliedFrom: 'recommended',
          appliedId: 'section-wid',
          appliedName: 'Tennessee Section PGA of America',
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

  it('should use the enrichment PO company when it differs from the email PO', async () => {
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

    expect(workday.loadPurchaseOrder).toHaveBeenCalledWith(expect.anything(), 'PO-111111');
    expect(workday.loadPurchaseOrder).toHaveBeenCalledWith(expect.anything(), 'PO-222222');
    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.companyWID).toBe('late-po-wid');
    expect(submitArgs.buildNotes([])).not.toContain('Changed to:');
    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][1]).toEqual([
      expect.objectContaining({ purchaseOrderLineId: 'POL-B' })
    ]);
  });

  it('should not keep the email PO company as default when enrichment finds a different PO without a company', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
    workday.loadPurchaseOrder.mockImplementation(async (_ctx: unknown, poNumber: string) => {
      if (poNumber === 'PO-111111') {
        return {
          documentNumber: 'PO-111111',
          company: { workdayId: 'early-po-wid', descriptor: 'Early PO Company' },
          lines: []
        };
      }
      return {
        documentNumber: 'PO-222222',
        company: undefined,
        lines: [{ lineOrder: 1, purchaseOrderLineId: 'POL-B', purchaseOrderDocumentNumber: 'PO-222222' }]
      };
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
        ...attachmentRequest('new-invoices/req-po-mismatch-no-company/invoice.pdf'),
        emailContext: { plainTextBody: 'Please process PO-111111' }
      }]
    } as any);

    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.companyWID).toBe('pga-america-wid');
    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][1]).toEqual([
      expect.objectContaining({ purchaseOrderLineId: 'POL-B' })
    ]);
  });

  it('should drop the email PO when enrichment names a different PO that fails to load', async () => {
    const { processor, workday, invoiceEnrichment, invoiceLines } = freshRequire();
    workday.loadPurchaseOrder.mockImplementation(async (_ctx: unknown, poNumber: string) => {
      if (poNumber === 'PO-111111') {
        return {
          documentNumber: 'PO-111111',
          company: { workdayId: 'early-po-wid', descriptor: 'Early PO Company' },
          lines: [{ lineOrder: 1, purchaseOrderLineId: 'POL-A', purchaseOrderDocumentNumber: 'PO-111111' }]
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

    expect(workday.loadPurchaseOrder).toHaveBeenCalledWith(expect.anything(), 'PO-111111');
    expect(workday.loadPurchaseOrder).toHaveBeenCalledWith(expect.anything(), 'PO-222222');
    const submitArgs = workday.submitNewSupplierInvoice.mock.calls[0][1];
    expect(submitArgs.companyWID).toBe('pga-america-wid');
    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][1]).toBeUndefined();
  });

  it('should error when the default company is missing from the cache and no PO is present', async () => {
    const { processor, workday, slack, invoiceEnrichment, database } = freshRequire();
    database.findCompanyByName.mockResolvedValue(undefined);
    invoiceEnrichment.enrichInvoiceFromAttachments.mockResolvedValue(baseEnrichmentResult);

    await expect(processor({
      data: [attachmentRequest('new-invoices/req-11/invoice.pdf')]
    } as any)).rejects.toThrow('Default company not found in company cache');

    expect(invoiceEnrichment.enrichInvoiceFromAttachments).toHaveBeenCalled();
    expect(workday.submitNewSupplierInvoice).not.toHaveBeenCalled();
    expect(slack.notifyResult).toHaveBeenCalledWith(
      'create_invoice',
      'error',
      expect.any(Number),
      expect.objectContaining({ s3Key: 'new-invoices/req-11/invoice.pdf' }),
      expect.any(Error)
    );
    database.findCompanyByName.mockResolvedValue({
      workdayId: 'pga-america-wid',
      companyName: 'The Professional Golfers Association of America'
    });
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
});
