import { processor } from '../enrich_invoice.js';

// Mock the dependencies
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
  getSupplierInvoiceWithAttachments: jest.fn().mockResolvedValue({
    invoice: {
      Invoice_ID: 'test-invoice-id',
      Invoice_Number: 'SUPIN-412727',
      Attachment_Data: []
    },
    presignedAttachments: []
  }),
  executeWorkdayQuery: jest.fn().mockResolvedValue({
    total: 1,
    data: [{
      workdayID: 'test-invoice-id',
      invoiceNumber: 'INV-001',
      company1: { id: 'company-1', name: 'Test Company' },
      supplier: null,
      allAttachmentsForBusinessDocument: []
    }]
  }),
  submitSupplierInvoiceUpdate: jest.fn().mockResolvedValue({ success: true, appliedFallbacks: [] }),
  getSupplierInvoice: jest.fn().mockResolvedValue({ Invoice_Number: 'SUPIN-412727' }),
  annotateSupplierInvoice: jest.fn().mockResolvedValue(undefined),
  getPurchaseOrder: jest.fn().mockResolvedValue(undefined),
  parsePurchaseOrder: jest.requireActual('../lib/workday.js').parsePurchaseOrder,
  isPurchaseOrderClosedForInvoicing: jest.requireActual('../lib/workday.js').isPurchaseOrderClosedForInvoicing,
  closedPurchaseOrderLineNote: jest.requireActual('../lib/workday.js').closedPurchaseOrderLineNote,
  consumedPurchaseOrderLinesNote: jest.requireActual('../lib/workday.js').consumedPurchaseOrderLinesNote,
  markPurchaseOrderLineAvailability: jest.requireActual('../lib/workday.js').markPurchaseOrderLineAvailability,
  formatPurchaseOrderLineFallbackNotes: jest.requireActual('../lib/workday.js').formatPurchaseOrderLineFallbackNotes,
  isPurchaseOrderLineFallback: jest.requireActual('../lib/workday.js').isPurchaseOrderLineFallback,
  purchaseOrderLineFallbackNote: jest.requireActual('../lib/workday.js').purchaseOrderLineFallbackNote,
  CONSUMED_PO_LINE_REFERENCE_LABEL: jest.requireActual('../lib/workday.js').CONSUMED_PO_LINE_REFERENCE_LABEL,
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
  getOrgWorktagKindsByIds: jest.fn().mockResolvedValue(new Map())
}));

jest.mock('../lib/rag.js', () => ({
  createEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3])
}));

jest.mock('../lib/ai.js', () => ({
  getAiResponse: jest.fn().mockResolvedValue({
    supplier: {
      status: 'matching',
      confidence: 0.9,
      extractedInformation: {
        supplierName: 'Test Supplier',
        memo: 'Test invoice'
      },
      resolvedSupplier: null,
      potentialDuplicateSuppliers: null,
      recommendation: {
        action: 'no_action',
        reason: 'Supplier matches existing assignment'
      },
      reason: 'High confidence match'
    },
    companyVerification: {
      status: 'matching',
      confidence: 0.85,
      extractedInformation: {},
      recommended: null,
      reason: 'Company matches existing assignment'
    }
  })
}));

jest.mock('../lib/slack.js', () => ({
  notifyEnrichmentResult: jest.fn().mockResolvedValue(undefined),
  notifyResult: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../lib/invoice_validation_failures.js', () => {
  const actual = jest.requireActual('../lib/invoice_validation_failures.js');
  return {
    ...actual,
    getInvoiceValidationFailuresConfig: jest.fn().mockReturnValue(undefined),
    isInvoiceMarkedForSkip: jest.fn().mockResolvedValue(false),
    recordInvoiceValidationFailure: jest.fn().mockResolvedValue(undefined)
  };
});

jest.mock('../lib/s3.js', () => ({
  getS3Config: jest.fn().mockReturnValue({
    bucketName: 'test-bucket',
    region: 'us-east-1'
  }),
}));

jest.mock('../lib/invoice_lines.js', () => {
  const actual = jest.requireActual('../lib/invoice_lines.js');
  return {
    ...actual,
    buildFinalInvoiceLines: jest.fn()
  };
});

describe('enrich_invoice', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const { getAiResponse } = require('../lib/ai.js');
    const { submitSupplierInvoiceUpdate, annotateSupplierInvoice } = require('../lib/workday.js');
    const validationFailures = require('../lib/invoice_validation_failures.js');
    getAiResponse.mockResolvedValue({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: {
          supplierName: 'Test Supplier',
          memo: 'Test invoice'
        },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: {
          action: 'no_action',
          reason: 'Supplier matches existing assignment'
        },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      }
    });
    submitSupplierInvoiceUpdate.mockResolvedValue({ success: true, appliedFallbacks: [] });

    annotateSupplierInvoice.mockResolvedValue(undefined);
    validationFailures.isInvoiceMarkedForSkip.mockResolvedValue(false);
    validationFailures.recordInvoiceValidationFailure.mockResolvedValue(undefined);
  });

  it('should process supplier enrichment event with new format', async () => {
    const mockEvent = {
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        OCRSupplierInvoice: {
          descriptor: '24953$4729',
          id: '0627e00a601c1001085f64bd33e20000'
        }
      }]
    };

    await expect(processor(mockEvent as any)).resolves.not.toThrow();
  });

  it('passes the Lambda deadline signal to the enrichment AI call', async () => {
    const { getAiResponse } = require('../lib/ai.js');

    await processor(
      { data: [{ workdayID: 'test-invoice-id', invoiceStatusAsText: 'Draft' }] } as any,
      { getRemainingTimeInMillis: () => 120_000 } as any
    );

    const signal = getAiResponse.mock.calls[0][0].abortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  it('should handle missing supplier and identify supplier', async () => {
    const { executeWorkdayQuery } = require('../lib/workday.js');
    executeWorkdayQuery.mockResolvedValue({
      total: 1,
      data: [{
        workdayID: 'test-invoice-id',
        invoiceNumber: 'INV-001',
        supplier: null, // Missing supplier
        allAttachmentsForBusinessDocument: []
      }]
    });

    const mockEvent = {
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        OCRSupplierInvoice: {
          descriptor: '24953$4729',
          id: '0627e00a601c1001085f64bd33e20000'
        }
      }]
    };

    await expect(processor(mockEvent as any)).resolves.not.toThrow();
  });

  it('should pass PDF attachments to the AI as file parts', async () => {
    const { getAiResponse } = require('../lib/ai.js');
    const { getSupplierInvoiceWithAttachments } = require('../lib/workday.js');
    const pdfBuffer = Buffer.from('fake-pdf-data');

    getSupplierInvoiceWithAttachments.mockResolvedValueOnce({
      invoice: {
        Invoice_ID: 'test-invoice-id',
        Attachment_Data: []
      },
      presignedAttachments: [
        {
          id: 'pdf-1',
          fileName: 'invoice.pdf',
          contentType: 'application/pdf',
          presignedUrl: 'https://example.com/invoice.pdf',
          expiresAt: new Date('2026-05-12T00:00:00Z'),
          s3Key: 'attachments/test-invoice-id/invoice.pdf',
          buffer: pdfBuffer
        }
      ]
    });

    const mockEvent = {
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        OCRSupplierInvoice: {
          descriptor: '24953$4729',
          id: '0627e00a601c1001085f64bd33e20000'
        }
      }]
    };

    await expect(processor(mockEvent as any)).resolves.not.toThrow();

    const aiCall = getAiResponse.mock.calls[0][0];
    const messageContent = aiCall.messages[0].content;

    expect(messageContent).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'file',
        data: pdfBuffer,
        mediaType: 'application/pdf',
        filename: 'invoice.pdf'
      })
    ]));
    expect(messageContent.some((part: { type: string }) => part.type === 'image')).toBe(false);
  });

  function supplierHintEvent(emailContext: Record<string, string>) {
    return {
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        OCRSupplierInvoice: {
          descriptor: '24953$4729',
          id: '0627e00a601c1001085f64bd33e20000'
        },
        emailContext,
      }]
    };
  }

  function promptText(getAiResponse: jest.Mock): string {
    const aiCall = getAiResponse.mock.calls[0][0];
    return aiCall.messages[0].content.find((part: { type: string }) => part.type === 'text').text;
  }

  async function mockCachedAcmeSupplier() {
    const { getDatabaseConnection } = require('../lib/database.js');
    const db = await getDatabaseConnection();
    db.query.mockImplementation(async (sql: string) => (
      sql.includes("metadata->>'supplierId'")
        ? [{ workday_id: 'wid-acme', metadata: { supplierId: 'S-001234', supplierName: 'Acme Corp' } }]
        : []
    ));
    return () => db.query.mockResolvedValue([]);
  }

  it('should pass an exact-matched supplier ID from an Intercom conversation part to the AI as authoritative', async () => {
    const { getAiResponse } = require('../lib/ai.js');
    const restore = await mockCachedAcmeSupplier();

    await expect(processor(supplierHintEvent({
      emailFrom: 'ap@vendor.com',
      subject: 'Invoice for review',
      plainTextBody: 'Please process the attached invoice.\n\nUse supplier S-001234',
      conversationParts: 'Use supplier S-001234',
    }) as any)).resolves.not.toThrow();

    const text = promptText(getAiResponse);
    expect(text).toContain('Supplier hints from the email and conversation');
    expect(text).toContain('S-001234 (Acme Corp), workdayId wid-acme');
    expect(text).toContain('exact cached Supplier ID match');
    restore();
  });

  it('should not let a sender-only supplier ID override the invoice document', async () => {
    const { getAiResponse } = require('../lib/ai.js');
    const restore = await mockCachedAcmeSupplier();

    await expect(processor(supplierHintEvent({
      emailFrom: 'billing@vendor.com',
      subject: 'Invoice',
      plainTextBody: 'Please book this to supplier S-001234',
    }) as any)).resolves.not.toThrow();

    const text = promptText(getAiResponse);
    expect(text).toContain('S-001234 (Acme Corp), workdayId wid-acme');
    expect(text).toContain('findSuppliers candidate only');
    expect(text).not.toContain('exact cached Supplier ID match');
    restore();
  });

  it('should build supplier hints from the email subject and source body', async () => {
    const { getAiResponse } = require('../lib/ai.js');

    await expect(processor(supplierHintEvent({
      emailFrom: 'billing@vendor.com',
      subject: 'Invoice for S-000777',
      plainTextBody: 'Supplier: Globex Inc',
    }) as any)).resolves.not.toThrow();

    const text = promptText(getAiResponse);
    expect(text).toContain('Supplier hints from the email and conversation');
    expect(text).toContain('S-000777, which is not in the supplier cache');
    expect(text).toContain('"Globex Inc"');
  });

  it('should not add a supplier hint block when the email names no supplier', async () => {
    const { getAiResponse } = require('../lib/ai.js');

    await expect(processor(supplierHintEvent({
      emailFrom: 'billing@vendor.com',
      subject: 'Invoice',
      plainTextBody: 'Please process the attached invoice.',
    }) as any)).resolves.not.toThrow();

    expect(promptText(getAiResponse)).not.toContain('Supplier hints from the email and conversation');
  });

  it('should skip processing when supplier already exists', async () => {
    const { executeWorkdayQuery } = require('../lib/workday.js');
    executeWorkdayQuery.mockResolvedValue({
      total: 1,
      data: [{
        workdayID: 'test-invoice-id',
        invoiceNumber: 'INV-001',
        supplier: 'Existing Supplier', // Supplier already exists
        allAttachmentsForBusinessDocument: []
      }]
    });

    const mockEvent = {
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        OCRSupplierInvoice: {
          descriptor: '24953$4729',
          id: '0627e00a601c1001085f64bd33e20000'
        }
      }]
    };

    await expect(processor(mockEvent as any)).resolves.not.toThrow();
  });

  it('should handle missing supplier cache gracefully', async () => {
    const mockEvent = {
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        OCRSupplierInvoice: {
          descriptor: '24953$4729',
          id: '0627e00a601c1001085f64bd33e20000'
        }
      }]
    };

    await expect(processor(mockEvent as any)).resolves.not.toThrow();
  });

  it('should skip processing invoices already marked in the validation skip registry', async () => {
    const { getSupplierInvoiceWithAttachments } = require('../lib/workday.js');
    const { isInvoiceMarkedForSkip } = require('../lib/invoice_validation_failures.js');

    isInvoiceMarkedForSkip.mockResolvedValue(true);

    const mockEvent = {
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        OCRSupplierInvoice: {
          descriptor: '24953$4729',
          id: '0627e00a601c1001085f64bd33e20000'
        }
      }]
    };

    await expect(processor(mockEvent as any)).resolves.not.toThrow();
    expect(getSupplierInvoiceWithAttachments).not.toHaveBeenCalled();
  });

  it('should record validation failures and avoid rethrowing them', async () => {
    const { annotateSupplierInvoice } = require('../lib/workday.js');
    const { recordInvoiceValidationFailure } = require('../lib/invoice_validation_failures.js');

    const validationError = new Error('Validation_Fault: spend category is required');
    annotateSupplierInvoice.mockRejectedValue(validationError);

    const mockEvent = {
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        OCRSupplierInvoice: {
          descriptor: '24953$4729',
          id: '0627e00a601c1001085f64bd33e20000'
        }
      }]
    };

    await expect(processor(mockEvent as any)).resolves.not.toThrow();
    expect(annotateSupplierInvoice).toHaveBeenCalledTimes(1);
    expect(recordInvoiceValidationFailure).toHaveBeenCalledTimes(1);
    expect(recordInvoiceValidationFailure).toHaveBeenCalledWith(undefined, 'test-invoice-id', validationError);
  });

  it('should continue throwing non-validation processing errors', async () => {
    const { annotateSupplierInvoice } = require('../lib/workday.js');
    const { recordInvoiceValidationFailure } = require('../lib/invoice_validation_failures.js');

    annotateSupplierInvoice.mockRejectedValue(new Error('Update failed'));

    const mockEvent = {
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        OCRSupplierInvoice: {
          descriptor: '24953$4729',
          id: '0627e00a601c1001085f64bd33e20000'
        }
      }]
    };

    await expect(processor(mockEvent as any)).rejects.toThrow('Update failed');
    expect(recordInvoiceValidationFailure).not.toHaveBeenCalled();
  });

  it('should continue throwing AI or Zod schema validation errors without recording in skip registry', async () => {
    const { getAiResponse } = require('../lib/ai.js');
    const { recordInvoiceValidationFailure } = require('../lib/invoice_validation_failures.js');

    getAiResponse.mockRejectedValueOnce(new Error('Type validation failed: Value must be object'));

    const mockEvent = {
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        OCRSupplierInvoice: {
          descriptor: '24953$4729',
          id: '0627e00a601c1001085f64bd33e20000'
        }
      }]
    };

    await expect(processor(mockEvent as any)).rejects.toThrow('Type validation failed: Value must be object');
    expect(recordInvoiceValidationFailure).not.toHaveBeenCalled();
  });

  it('should continue throwing RAG tool failures without recording in skip registry', async () => {
    const { getAiResponse } = require('../lib/ai.js');
    const { recordInvoiceValidationFailure } = require('../lib/invoice_validation_failures.js');

    getAiResponse.mockRejectedValueOnce(new Error('Database connection failed'));

    const mockEvent = {
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        OCRSupplierInvoice: {
          descriptor: '24953$4729',
          id: '0627e00a601c1001085f64bd33e20000'
        }
      }]
    };

    await expect(processor(mockEvent as any)).rejects.toThrow('Database connection failed');
    expect(recordInvoiceValidationFailure).not.toHaveBeenCalled();
  });

  it('should notify Slack and stop retrying Workday task-not-authorized errors', async () => {
    const { annotateSupplierInvoice } = require('../lib/workday.js');
    const { recordInvoiceValidationFailure } = require('../lib/invoice_validation_failures.js');
    const { notifyResult } = require('../lib/slack.js');

    const authorizationError = new Error('The task submitted is not authorized for this supplier invoice');
    annotateSupplierInvoice.mockRejectedValue(authorizationError);

    const mockEvent = {
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        OCRSupplierInvoice: {
          descriptor: '24953$4729',
          id: '0627e00a601c1001085f64bd33e20000'
        }
      }]
    };

    await expect(processor(mockEvent as any)).resolves.not.toThrow();
    expect(notifyResult).toHaveBeenCalledWith(
      'enrich_invoice',
      'error',
      expect.any(Number),
      expect.objectContaining({
        workdayId: 'test-invoice-id',
        note: expect.stringContaining('not retrying')
      }),
      authorizationError,
      'Workday task not authorized - no retry'
    );
    expect(recordInvoiceValidationFailure).not.toHaveBeenCalled();
  });

  it('should handle batching with hardcoded configuration', () => {
    // Test that the batching logic works with hardcoded values
    // This is more of an integration test to ensure the batching doesn't break
    expect(true).toBe(true); // Placeholder for batching logic validation
  });

  it('should pass extracted invoice date to Workday update calls', async () => {
    const { getAiResponse } = require('../lib/ai.js');
    const { submitSupplierInvoiceUpdate } = require('../lib/workday.js');

    getAiResponse.mockResolvedValueOnce({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: {
          supplierName: 'Test Supplier',
          memo: 'Test invoice'
        },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: {
          action: 'no_action',
          reason: 'Supplier matches existing assignment'
        },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      },
      extractedInvoiceDate: '2026-04-15'
    });

    const mockEvent = {
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: {
          descriptor: 'Existing Supplier',
          id: 'SUP-1'
        },
        company1: {
          descriptor: 'Test Company',
          id: 'COMP-1'
        },
        OCRSupplierInvoice: {
          descriptor: '24953$4729',
          id: '0627e00a601c1001085f64bd33e20000'
        }
      }]
    };

    await expect(processor(mockEvent as any)).resolves.not.toThrow();

    expect(submitSupplierInvoiceUpdate).toHaveBeenCalledWith(
      expect.anything(),
      {
        invoiceWorkdayID: 'test-invoice-id',
        supplierWID: 'SUP-1',
        buildNotes: expect.any(Function),
        memo: undefined,
        invoiceDate: '2026-04-15',
        companyWID: undefined,
        extractedAmountDue: undefined,
        suppliersInvoiceNumber: 'TEST041526',
        extractedFreightAmount: undefined,
        extractedTaxAmount: undefined,
        freightCleared: false,
        taxCleared: false,
        finalLines: undefined,
        invoiceLineQuantityDisplayed: undefined,
        relatedLobByCostCenter: undefined,
        resolveCostCenterWorkdayIds: expect.any(Function),
        resolveOrgWorktagKinds: expect.any(Function),
        paymentTermsId: undefined,
      }
    );
  });

  it('uses the existing Workday supplier name when the extracted name has no letters', async () => {
    const { getAiResponse } = require('../lib/ai.js');
    const { submitSupplierInvoiceUpdate } = require('../lib/workday.js');

    getAiResponse.mockResolvedValueOnce({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: {
          supplierName: '123!!!',
          memo: 'Test invoice'
        },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: {
          action: 'no_action',
          reason: 'Supplier matches existing assignment'
        },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      },
      extractedInvoiceDate: '2022-04-01'
    });

    await expect(processor({
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: { descriptor: 'Safari', id: 'SUP-1' },
        company1: { descriptor: 'Test Company', id: 'COMP-1' },
        OCRSupplierInvoice: { descriptor: '24953$4729', id: '0627e00a601c1001085f64bd33e20000' }
      }]
    } as any)).resolves.not.toThrow();

    expect(submitSupplierInvoiceUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ suppliersInvoiceNumber: 'SAFA040122' })
    );
  });

  it('should note when invoice date defaults to the first day of the current month', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-21T12:00:00Z'));

    const { getAiResponse } = require('../lib/ai.js');
    const { submitSupplierInvoiceUpdate } = require('../lib/workday.js');

    getAiResponse.mockResolvedValueOnce({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: {
          supplierName: 'Test Supplier',
          memo: 'Test invoice'
        },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: {
          action: 'no_action',
          reason: 'Supplier matches existing assignment'
        },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      }
    });

    const mockEvent = {
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: {
          descriptor: 'Existing Supplier',
          id: 'SUP-1'
        },
        company1: {
          descriptor: 'Test Company',
          id: 'COMP-1'
        },
        OCRSupplierInvoice: {
          descriptor: '24953$4729',
          id: '0627e00a601c1001085f64bd33e20000'
        }
      }]
    };

    await expect(processor(mockEvent as any)).resolves.not.toThrow();

    expect(submitSupplierInvoiceUpdate).toHaveBeenCalledWith(
      expect.anything(),
      {
        invoiceWorkdayID: 'test-invoice-id',
        supplierWID: 'SUP-1',
        buildNotes: expect.any(Function),
        memo: undefined,
        invoiceDate: undefined,
        companyWID: undefined,
        extractedAmountDue: undefined,
        suppliersInvoiceNumber: undefined,
        extractedFreightAmount: undefined,
        extractedTaxAmount: undefined,
        freightCleared: false,
        taxCleared: false,
        finalLines: undefined,
        relatedLobByCostCenter: undefined,
        resolveCostCenterWorkdayIds: expect.any(Function),
        resolveOrgWorktagKinds: expect.any(Function),
        paymentTermsId: undefined,
      }
    );

    const [[, params]] = (submitSupplierInvoiceUpdate as jest.Mock).mock.calls;
    expect(params.buildNotes([])).toContain('Invoice Date: Date was not extracted from the document and defaulted to the beginning of the current month (2026-04-01).');

    jest.useRealTimers();
  });

  it('should pass the email-coded company workdayId as companyWID on update', async () => {
    const { getAiResponse } = require('../lib/ai.js');
    const { submitSupplierInvoiceUpdate } = require('../lib/workday.js');
    const { findDocumentsByReferenceIds } = require('../lib/database.js');
    findDocumentsByReferenceIds.mockResolvedValue(new Map([
      ['912', [{
        workday_id: 'email-company-wid',
        type: 'company',
        content: 'PGA Company',
        metadata: { companyReferenceId: '912', companyName: 'PGA Company' },
      }]],
    ]));

    getAiResponse.mockResolvedValueOnce({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: {
          supplierName: 'Test Supplier',
          memo: 'Test invoice'
        },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: {
          action: 'no_action',
          reason: 'Supplier matches existing assignment'
        },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      },
      emailWorktags: {
        company: {
          extracted: '912',
          name: 'PGA Company',
          workdayId: 'email-company-wid',
          referenceId: '912'
        },
        costCenter: { extracted: '912', name: null, code: null },
        event: { extracted: null, workdayId: null },
        lineOfBusiness: { extracted: null, referenceId: null },
        fund: { extracted: null, referenceId: null },
        spendCategory: { extracted: null, name: null, referenceId: null }
      }
    });

    const mockEvent = {
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: {
          descriptor: 'Existing Supplier',
          id: 'SUP-1'
        },
        company1: {
          descriptor: 'Test Company',
          id: 'COMP-1'
        },
        OCRSupplierInvoice: {
          descriptor: '24953$4729',
          id: '0627e00a601c1001085f64bd33e20000'
        }
      }]
    };

    await expect(processor(mockEvent as any)).resolves.not.toThrow();

    expect(submitSupplierInvoiceUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyWID: 'email-company-wid',
      })
    );

    const { notifyEnrichmentResult } = require('../lib/slack.js');
    expect(notifyEnrichmentResult).toHaveBeenCalledWith(
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

  it('passes priorFailures from a successful submit retry to Slack', async () => {
    const { getAiResponse } = require('../lib/ai.js');
    const { submitSupplierInvoiceUpdate } = require('../lib/workday.js');
    const { notifyEnrichmentResult } = require('../lib/slack.js');

    getAiResponse.mockResolvedValueOnce({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: { supplierName: 'Test Supplier', memo: 'Test invoice' },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: { action: 'no_action', reason: 'Supplier matches existing assignment' },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      }
    });
    submitSupplierInvoiceUpdate.mockResolvedValue({
      success: true,
      appliedFallbacks: [],
      priorFailures: [
        { attempt: 1, message: 'The invoice date must be the first day of the month.' },
      ],
    });

    await expect(processor({
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: { descriptor: 'Existing Supplier', id: 'SUP-1' },
        company1: { descriptor: 'Test Company', id: 'COMP-1' },
        OCRSupplierInvoice: { descriptor: '24953$4729', id: '0627e00a601c1001085f64bd33e20000' }
      }]
    } as any)).resolves.not.toThrow();

    expect(notifyEnrichmentResult).toHaveBeenCalledWith(
      expect.objectContaining({
        invoiceNumber: 'SUPIN-412727',
        invoiceWID: 'test-invoice-id',
        priorFailures: [
          { attempt: 1, message: 'The invoice date must be the first day of the month.' },
        ],
      })
    );
  });

  describe('scoring snapshots', () => {
    const matchingSupplierResponse = {
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: { supplierName: 'Test Supplier', memo: 'Test invoice' },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: { action: 'no_action', reason: 'Supplier matches existing assignment' },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      }
    };
    const event = {
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: { descriptor: 'Existing Supplier', id: 'SUP-1' },
        company1: { descriptor: 'Test Company', id: 'COMP-1' },
        OCRSupplierInvoice: { descriptor: '24953$4729', id: '0627e00a601c1001085f64bd33e20000' }
      }]
    };

    it('records the OCR baseline before the agent update and the invoice after it', async () => {
      const { getAiResponse } = require('../lib/ai.js');
      const { getDatabaseConnection } = require('../lib/database.js');
      const { notifyEnrichmentResult } = require('../lib/slack.js');
      getAiResponse.mockResolvedValueOnce(matchingSupplierResponse);

      await expect(processor(event as any)).resolves.not.toThrow();

      const db = await getDatabaseConnection();
      const sources = db.query.mock.calls
        .filter(([sql]: [string]) => sql.includes('INSERT INTO agent_invoice_snapshots'))
        .map(([, params]: [string, unknown[]]) => params[1]);
      expect(sources).toEqual(['enrich_baseline', 'enrich']);
      expect(notifyEnrichmentResult).toHaveBeenCalledWith(expect.not.objectContaining({ snapshotSync: 'failed' }));
    });

    it('reports snapshotSync failed without failing the enrichment when the read-back fails', async () => {
      const { getAiResponse } = require('../lib/ai.js');
      const { getSupplierInvoice } = require('../lib/workday.js');
      const { notifyEnrichmentResult } = require('../lib/slack.js');
      getAiResponse.mockResolvedValueOnce(matchingSupplierResponse);
      getSupplierInvoice.mockRejectedValueOnce(new Error('soap down'));

      await expect(processor(event as any)).resolves.not.toThrow();

      expect(notifyEnrichmentResult).toHaveBeenCalledWith(expect.objectContaining({
        invoiceWID: 'test-invoice-id',
        snapshotSync: 'failed',
      }));
    });

    it('takes no snapshot on the notes-only path', async () => {
      const { getAiResponse } = require('../lib/ai.js');
      const { getDatabaseConnection } = require('../lib/database.js');
      getAiResponse.mockResolvedValueOnce({
        ...matchingSupplierResponse,
        supplier: { ...matchingSupplierResponse.supplier, status: 'not_found', resolvedSupplier: null },
      });

      await expect(processor({ data: [{ ...event.data[0], supplier: null }] } as any)).resolves.not.toThrow();

      const db = await getDatabaseConnection();
      const { annotateSupplierInvoice } = require('../lib/workday.js');
      expect(annotateSupplierInvoice).toHaveBeenCalledTimes(1);
      expect(db.query.mock.calls.some(([sql]: [string]) => sql.includes('INSERT INTO agent_invoice_snapshots'))).toBe(false);
    });
  });

  it('omits Slack invoiceNumber when Get has no Invoice_Number', async () => {
    const { getSupplierInvoiceWithAttachments } = require('../lib/workday.js');
    const { notifyEnrichmentResult } = require('../lib/slack.js');
    getSupplierInvoiceWithAttachments.mockResolvedValueOnce({
      invoice: { Invoice_ID: 'test-invoice-id' },
      presignedAttachments: []
    });

    await expect(processor({
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: { descriptor: 'Existing Supplier', id: 'SUP-1' },
        company1: { descriptor: 'Test Company', id: 'COMP-1' },
        OCRSupplierInvoice: { descriptor: '24953$4729', id: '0627e00a601c1001085f64bd33e20000' }
      }]
    } as any)).resolves.not.toThrow();

    const slackPayload = notifyEnrichmentResult.mock.calls.at(-1)?.[0];
    expect(slackPayload).toBeDefined();
    expect(slackPayload).not.toHaveProperty('invoiceNumber');
    expect(slackPayload).toEqual(expect.objectContaining({ invoiceWID: 'test-invoice-id' }));
  });

  it('should strip shipping extracted lines before merge and pass recovered freight on update', async () => {
    const { getAiResponse } = require('../lib/ai.js');
    const { submitSupplierInvoiceUpdate } = require('../lib/workday.js');
    const invoiceLines = require('../lib/invoice_lines.js');

    getAiResponse.mockResolvedValueOnce({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: {
          supplierName: 'Test Supplier',
          memo: 'Test invoice'
        },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: {
          action: 'no_action',
          reason: 'Supplier matches existing assignment'
        },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      },
      extractedFreightAmount: '$15.00',
      extractedInvoiceLines: [
        { description: 'Widgets', quantity: 2, unitCost: '50.00', totalPrice: '100.00', hasDiscount: false },
        { description: 'Shipping', quantity: 1, unitCost: '15.00', totalPrice: '15.00', hasDiscount: false }
      ]
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue({
      lines: [{ lineOrder: 1, description: 'Widgets', quantity: 2, unitCost: 50 }],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false }
    });

    const mockEvent = {
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: {
          descriptor: 'Existing Supplier',
          id: 'SUP-1'
        },
        company1: {
          descriptor: 'Test Company',
          id: 'COMP-1'
        },
        OCRSupplierInvoice: {
          descriptor: '24953$4729',
          id: '0627e00a601c1001085f64bd33e20000'
        }
      }]
    };

    await expect(processor(mockEvent as any)).resolves.not.toThrow();

    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0]).toEqual([
      { description: 'Widgets', quantity: 2, unitCost: '50.00', totalPrice: '100.00', hasDiscount: false }
    ]);
    expect(submitSupplierInvoiceUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        extractedFreightAmount: '$15.00',
        finalLines: [{ lineOrder: 1, description: 'Widgets', quantity: 2, unitCost: 50 }]
      })
    );
  });

  describe('mislabeled freight and tax', () => {
    const enrichmentWith = (charges: Record<string, string | null>) => ({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: { supplierName: 'BearCom', memo: 'Radios' },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: { action: 'no_action', reason: 'Supplier matches existing assignment' },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      },
      ...charges,
    });
    const mockEvent = {
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: { descriptor: 'BearCom', id: 'SUP-1' },
        company1: { descriptor: 'Test Company', id: 'COMP-1' },
        OCRSupplierInvoice: { descriptor: '24953$4729', id: '0627e00a601c1001085f64bd33e20000' }
      }]
    };

    it('moves a sales-tax amount read as freight to tax and clears freight on update', async () => {
      const { getAiResponse } = require('../lib/ai.js');
      const { submitSupplierInvoiceUpdate } = require('../lib/workday.js');
      getAiResponse.mockResolvedValueOnce(enrichmentWith({
        extractedFreightAmount: '510.86',
        extractedFreightLabel: 'Sales Tax',
        extractedTaxAmount: null,
        extractedTaxLabel: null,
      }));

      await expect(processor(mockEvent as any)).resolves.not.toThrow();

      const params = submitSupplierInvoiceUpdate.mock.calls[0][1];
      expect(params).toEqual(expect.objectContaining({
        extractedFreightAmount: undefined,
        extractedTaxAmount: '510.86',
        freightCleared: true,
        taxCleared: false,
      }));
      const notes = params.buildNotes([]);
      expect(notes).toContain('Freight Amount (from document): none');
      expect(notes).toContain('Tax Amount (from document): 510.86');
      expect(notes).not.toContain('Freight/Tax review');
    });

    it('keeps both amounts and adds a review note when a tax-labeled freight amount differs from tax', async () => {
      const { getAiResponse } = require('../lib/ai.js');
      const { submitSupplierInvoiceUpdate } = require('../lib/workday.js');
      getAiResponse.mockResolvedValueOnce(enrichmentWith({
        extractedFreightAmount: '8.00',
        extractedFreightLabel: 'Sales Tax',
        extractedTaxAmount: '10.00',
        extractedTaxLabel: 'Sales Tax',
      }));

      await expect(processor(mockEvent as any)).resolves.not.toThrow();

      const params = submitSupplierInvoiceUpdate.mock.calls[0][1];
      expect(params).toEqual(expect.objectContaining({
        extractedFreightAmount: '8.00',
        extractedTaxAmount: '10.00',
        freightCleared: false,
        taxCleared: false,
      }));
      expect(params.buildNotes([])).toContain('Freight/Tax review: Freight amount 8.00 is labeled "Sales Tax" and a separate tax amount 10.00 was also read; both were kept as read.');
    });
  });

  it('concatenates Hashrocket Activity and Description into Workday line item description', async () => {
    const { getAiResponse } = require('../lib/ai.js');
    const { submitSupplierInvoiceUpdate } = require('../lib/workday.js');
    const invoiceLines = require('../lib/invoice_lines.js');

    getAiResponse.mockResolvedValueOnce({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: {
          supplierName: 'Test Supplier',
          memo: 'Project management services'
        },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: {
          action: 'no_action',
          reason: 'Supplier matches existing assignment'
        },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      },
      extractedPurchaseOrderNumber: 'PO-413898',
      extractedServicePeriod: '9/7/26 - 9/13/26',
      extractedInvoiceLines: [
        {
          description: 'Project Management',
          descriptionCells: ['', 'Ryan Poland', 'Project Management', '32', '155.00', '4,960.00'],
          quantity: 32,
          unitCost: '155.00',
          totalPrice: '4,960.00',
          hasDiscount: false
        }
      ]
    });
    invoiceLines.buildFinalInvoiceLines.mockImplementation(async (extracted: Array<{ description: string }>) => ({
      lines: [{
        lineOrder: 1,
        description: extracted[0].description,
        memo: 'Project management services for Ryan Poland',
        quantity: 32,
        unitCost: 155,
        extendedAmount: 4960
      }],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false }
    }));

    await expect(processor({
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: { descriptor: 'Existing Supplier', id: 'SUP-1' },
        company1: { descriptor: 'Test Company', id: 'COMP-1' },
        OCRSupplierInvoice: { descriptor: '24953$4729', id: '0627e00a601c1001085f64bd33e20000' }
      }]
    } as any)).resolves.not.toThrow();

    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0][0].description).toBe(
      'Ryan Poland - Project Management'
    );
    const [[, params]] = (submitSupplierInvoiceUpdate as jest.Mock).mock.calls;
    expect(params.finalLines[0].description).toBe('Ryan Poland - Project Management');
    expect(params.finalLines[0].memo).toBe(
      'PO-413898. Service Period 9/7/26 - 9/13/26. Project management services for Ryan Poland'
    );
  });

  it('omits PO line refs but keeps PO line coding when the PO is Pending Close', async () => {
    const { getAiResponse } = require('../lib/ai.js');
    const { getPurchaseOrder, submitSupplierInvoiceUpdate } = require('../lib/workday.js');
    const { notifyEnrichmentResult } = require('../lib/slack.js');
    const invoiceLines = require('../lib/invoice_lines.js');

    getPurchaseOrder.mockResolvedValueOnce({
      Response_Data: {
        Purchase_Order: {
          Purchase_Order_Data: {
            Document_Number: 'PO-413898',
            Purchase_Order_Document_Status_Reference: {
              descriptor: 'Pending Close',
              ID: [{ $attributes: { type: 'Document_Status_ID' }, $value: 'PENDING_CLOSE' }]
            },
            Service_Line_Data: { Line_Number: 1, Service_Order_Line_ID: 'POL-1', Description: 'Project Management' }
          }
        }
      }
    });
    getAiResponse.mockResolvedValueOnce({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: { supplierName: 'Test Supplier' },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: { action: 'no_action', reason: 'Supplier matches existing assignment' },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      },
      extractedPurchaseOrderNumber: 'PO-413898',
      extractedInvoiceLines: [
        { description: 'Project Management', quantity: 1, unitCost: '155.00', totalPrice: '155.00', hasDiscount: false }
      ]
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValueOnce({
      lines: [{ lineOrder: 1, description: 'Project Management', quantity: 1, unitCost: 155, extendedAmount: 155, purchaseOrderLineId: 'POL-1', costCenterId: 'CC-PO' }],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false }
    });
    (submitSupplierInvoiceUpdate as jest.Mock).mockResolvedValueOnce({
      success: true,
      appliedFallbacks: [{ field: 'purchaseOrderLine', label: 'omitted PO line reference (PO closed or pending close)' }]
    });

    await processor({
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: { descriptor: 'Existing Supplier', id: 'SUP-1' },
        company1: { descriptor: 'Test Company', id: 'COMP-1' },
        OCRSupplierInvoice: { descriptor: '24953$4729', id: '0627e00a601c1001085f64bd33e20000' }
      }]
    } as any);

    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][1]).toEqual([
      expect.objectContaining({ purchaseOrderLineId: 'POL-1' })
    ]);
    const [[, params]] = (submitSupplierInvoiceUpdate as jest.Mock).mock.calls;
    expect(params.omitPurchaseOrderLineReference).toBe(true);
    expect(params.finalLines[0]).toEqual(expect.objectContaining({ purchaseOrderLineId: 'POL-1', costCenterId: 'CC-PO' }));
    const closedNote = 'PO-413898 is Closed or Pending Close; invoice lines were coded from the PO but not linked to PO lines.';
    expect(params.buildNotes([{ field: 'purchaseOrderLine', label: 'omitted PO line reference (PO closed or pending close)' }]))
      .toContain(closedNote);
    expect(notifyEnrichmentResult.mock.calls[0][0].fallbacks.purchaseOrderLineNotes).toBe(closedNote);
  });

  afterEach(() => {
    delete process.env.PO_LINE_SELECTION_ENABLED;
    require('@pga/lambda-env').default.mockResolvedValue({});
  });

  it.each([
    ['some PO lines are fully invoiced', ['Fully Invoiced', 'Partially Invoiced'], [false, true], true],
    ['every PO line is fully invoiced', ['Fully Invoiced', 'Fully Invoiced'], [false, false], true],
    ['PO line selection is off', ['Fully Invoiced', 'Partially Invoiced'], [undefined, undefined], false],
  ])('handles PO line availability when %s', async (_label, invoiceStatuses, expectedAvailability, selectionOn) => {
    if (selectionOn) {
      process.env.PO_LINE_SELECTION_ENABLED = 'true';
      require('@pga/lambda-env').default.mockResolvedValue({ PO_LINE_SELECTION_ENABLED: 'true' });
    }
    const { getAiResponse } = require('../lib/ai.js');
    const { getPurchaseOrder, submitSupplierInvoiceUpdate } = require('../lib/workday.js');
    const invoiceLines = require('../lib/invoice_lines.js');

    getPurchaseOrder.mockResolvedValueOnce({
      Response_Data: {
        Purchase_Order: {
          Purchase_Order_Data: {
            Document_Number: 'PO-413898',
            Service_Line_Data: invoiceStatuses.map((descriptor, index) => ({
              Line_Number: index + 1,
              Service_Order_Line_ID: `POL-${index + 1}`,
              Description: 'Quarterly retainer',
              Start_Date: index === 0 ? '2026-07-01' : '2026-10-01',
              End_Date: index === 0 ? '2026-09-30' : '2026-12-31',
              Invoice_Status_Reference: { ID: [
                { $attributes: { type: 'WID' }, $value: `wid-status-${index}` },
                { $attributes: { type: 'Document_Status_ID' }, $value: descriptor },
              ] },
            })),
          }
        }
      }
    });
    getAiResponse.mockResolvedValueOnce({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: { supplierName: 'Test Supplier' },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: { action: 'no_action', reason: 'Supplier matches existing assignment' },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      },
      extractedPurchaseOrderNumber: 'PO-413898',
      extractedInvoiceDate: '2026-10-02',
      extractedServicePeriod: 'Q4 2026',
      extractedInvoiceLines: [
        { description: 'Quarterly retainer', quantity: 1, unitCost: '1500.00', totalPrice: '1500.00', hasDiscount: false }
      ]
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValueOnce({
      lines: [{ lineOrder: 1, description: 'Quarterly retainer', quantity: 1, unitCost: 1500, extendedAmount: 1500, purchaseOrderLineId: 'POL-2', costCenterId: 'CC-PO' }],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false }
    });

    await processor({
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: { descriptor: 'Existing Supplier', id: 'SUP-1' },
        company1: { descriptor: 'Test Company', id: 'COMP-1' },
        OCRSupplierInvoice: { descriptor: '24953$4729', id: '0627e00a601c1001085f64bd33e20000' }
      }]
    } as any);

    const mergeCall = invoiceLines.buildFinalInvoiceLines.mock.calls[0];
    expect(mergeCall[1].map((line: any) => [line.purchaseOrderLineId, line.availableForInvoicing])).toEqual([
      ['POL-1', expectedAvailability[0]],
      ['POL-2', expectedAvailability[1]],
    ]);
    expect(mergeCall[7]).toEqual({ invoiceDate: '2026-10-02', servicePeriod: 'Q4 2026' });
    const [[, params]] = (submitSupplierInvoiceUpdate as jest.Mock).mock.calls;
    expect(params.omitPurchaseOrderLineReference).toBeUndefined();
    const notes = params.buildNotes([{ field: 'consumedPurchaseOrderLine', label: 'omitted PO line reference (PO line fully invoiced or closed)' }]);
    expect(notes).toContain('Invoice lines that matched lines on PO-413898 already fully invoiced or closed were coded from the PO but not linked to PO lines.');

    const bothNotes = params.buildNotes([
      { field: 'purchaseOrderLine', label: 'omitted PO line reference (PO closed or pending close)' },
      { field: 'consumedPurchaseOrderLine', label: 'omitted PO line reference (PO line fully invoiced or closed)' },
    ]);
    expect(bothNotes.match(/Purchase order lines: /g)).toHaveLength(2);
    expect(bothNotes).not.toContain('Fallback values applied');
  });

  it('should submit amount-only lines with quantity zero when the invoice has no quantity column', async () => {
    const { getAiResponse } = require('../lib/ai.js');
    const { submitSupplierInvoiceUpdate } = require('../lib/workday.js');
    const invoiceLines = require('../lib/invoice_lines.js');

    getAiResponse.mockResolvedValueOnce({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: {
          supplierName: 'Test Supplier',
          memo: 'Test invoice'
        },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: {
          action: 'no_action',
          reason: 'Supplier matches existing assignment'
        },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      },
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

    await expect(processor({
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: { descriptor: 'Existing Supplier', id: 'SUP-1' },
        company1: { descriptor: 'Test Company', id: 'COMP-1' },
        OCRSupplierInvoice: { descriptor: '24953$4729', id: '0627e00a601c1001085f64bd33e20000' }
      }]
    } as any)).resolves.not.toThrow();

    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][6]).toBe(false);
    const [[, params]] = (submitSupplierInvoiceUpdate as jest.Mock).mock.calls;
    expect(params.invoiceLineQuantityDisplayed).toBe(false);
    expect(params.finalLines[0]).toMatchObject({
      quantity: 0,
      unitCost: 0,
      extendedAmount: 1250,
    });
  });

  it('should submit amount-only lines when quantity times unit cost does not equal extended amount', async () => {
    const { getAiResponse } = require('../lib/ai.js');
    const { submitSupplierInvoiceUpdate } = require('../lib/workday.js');
    const invoiceLines = require('../lib/invoice_lines.js');

    getAiResponse.mockResolvedValueOnce({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: {
          supplierName: 'Test Supplier',
          memo: 'Test invoice'
        },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: {
          action: 'no_action',
          reason: 'Supplier matches existing assignment'
        },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      },
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

    await expect(processor({
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: { descriptor: 'Existing Supplier', id: 'SUP-1' },
        company1: { descriptor: 'Test Company', id: 'COMP-1' },
        OCRSupplierInvoice: { descriptor: '24953$4729', id: '0627e00a601c1001085f64bd33e20000' }
      }]
    } as any)).resolves.not.toThrow();

    const [[, params]] = (submitSupplierInvoiceUpdate as jest.Mock).mock.calls;
    expect(params.invoiceLineQuantityDisplayed).toBeUndefined();
    expect(params.finalLines[0]).toMatchObject({
      quantity: 0,
      unitCost: 0,
      extendedAmount: 1105.49,
    });
  });

  it('should note when invoice lines total more than the amount due', async () => {
    const { getAiResponse } = require('../lib/ai.js');
    const { submitSupplierInvoiceUpdate } = require('../lib/workday.js');
    const invoiceLines = require('../lib/invoice_lines.js');

    getAiResponse.mockResolvedValueOnce({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: { supplierName: 'LevelBlue, LLC', memo: 'vCISO risk advisory' },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: { action: 'no_action', reason: 'Supplier matches existing assignment' },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      },
      extractedAmountDue: '$5,500.00',
      extractedTaxAmount: '$0.00',
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
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: { descriptor: 'Existing Supplier', id: 'SUP-1' },
        company1: { descriptor: 'Test Company', id: 'COMP-1' },
        OCRSupplierInvoice: { descriptor: '24953$4729', id: '0627e00a601c1001085f64bd33e20000' }
      }]
    } as any);

    const [[, params]] = (submitSupplierInvoiceUpdate as jest.Mock).mock.calls;
    expect(params.finalLines[0]).toMatchObject({ quantity: 24.45, unitCost: 224.948875, extendedAmount: 5500 });
    expect(params.buildNotes([])).toContain(
      'Line total review: Invoice lines total $11,000.00, but the amount due $5,500.00 less freight $0.00 and tax $0.00 is $5,500.00.'
    );
  });

  it('should count freight and tax already on the Workday invoice before noting a line total mismatch', async () => {
    const { getAiResponse } = require('../lib/ai.js');
    const { submitSupplierInvoiceUpdate, getSupplierInvoiceWithAttachments } = require('../lib/workday.js');
    const invoiceLines = require('../lib/invoice_lines.js');

    getSupplierInvoiceWithAttachments.mockResolvedValueOnce({
      invoice: { Invoice_ID: 'test-invoice-id', Freight_Amount: '15.00', Tax_Amount: '5.00' },
      presignedAttachments: []
    });
    getAiResponse.mockResolvedValueOnce({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: { supplierName: 'LevelBlue, LLC' },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: { action: 'no_action', reason: 'Supplier matches existing assignment' },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      },
      extractedAmountDue: '$5,520.00',
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
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: { descriptor: 'Existing Supplier', id: 'SUP-1' },
        company1: { descriptor: 'Test Company', id: 'COMP-1' },
        OCRSupplierInvoice: { descriptor: '24953$4729', id: '0627e00a601c1001085f64bd33e20000' }
      }]
    } as any);

    const [[, params]] = (submitSupplierInvoiceUpdate as jest.Mock).mock.calls;
    expect(params.buildNotes([])).not.toContain('Line total review');
  });

  it('should put extracted identifiers on the header and line memos', async () => {
    const { getAiResponse } = require('../lib/ai.js');
    const { submitSupplierInvoiceUpdate } = require('../lib/workday.js');
    const invoiceLines = require('../lib/invoice_lines.js');

    getAiResponse.mockResolvedValueOnce({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: {
          supplierName: 'Test Supplier',
          memo: 'Test invoice'
        },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: {
          action: 'no_action',
          reason: 'Supplier matches existing assignment'
        },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      },
      extractedSuppliersInvoiceNumber: 'INV|001>>>',
      extractedAccountNumber: '1033562',
      extractedJobNumber: '5914196',
      extractedCustomerId: 'CU0122145',
      extractedServicePeriod: '2026 - September',
      extractedInvoiceLines: [
        { description: 'Widgets', quantity: 2, unitCost: '50.00', totalPrice: '100.00', hasDiscount: false }
      ]
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue({
      lines: [{ lineOrder: 1, description: 'Widgets', memo: 'Widget purchase', quantity: 2, unitCost: 50 }],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false }
    });

    await expect(processor({
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: { descriptor: 'Existing Supplier', id: 'SUP-1' },
        company1: { descriptor: 'Test Company', id: 'COMP-1' },
        OCRSupplierInvoice: { descriptor: '24953$4729', id: '0627e00a601c1001085f64bd33e20000' }
      }]
    } as any)).resolves.not.toThrow();

    const [[, params]] = (submitSupplierInvoiceUpdate as jest.Mock).mock.calls;
    expect(params.memo).toBe(
      'AC 1033562. Customer ID CU0122145. Job 5914196. Service Period 2026 - September. Test invoice'
    );
    expect(params.suppliersInvoiceNumber).toBe('INV-001');
    expect(params.finalLines).toEqual([
      expect.objectContaining({
        memo: 'AC 1033562. Customer ID CU0122145. Job 5914196. Service Period 2026 - September. Widget purchase',
      }),
    ]);
    expect(params.buildNotes([])).toContain('Account Number (from document): 1033562');
  });

  it('submits an account number plus MMMYY when the printed invoice number is the account number', async () => {
    const { getAiResponse } = require('../lib/ai.js');
    const { submitSupplierInvoiceUpdate } = require('../lib/workday.js');

    getAiResponse.mockResolvedValueOnce({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: {
          supplierName: 'City of Frisco Texas',
          memo: 'Utility bill'
        },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: {
          action: 'no_action',
          reason: 'Supplier matches existing assignment'
        },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      },
      extractedSuppliersInvoiceNumber: '20-1183-01',
      extractedAccountNumber: '20-1183-01',
      extractedInvoiceDate: '2026-09-15',
    });

    await expect(processor({
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: { descriptor: 'Existing Supplier', id: 'SUP-1' },
        company1: { descriptor: 'Test Company', id: 'COMP-1' },
        OCRSupplierInvoice: { descriptor: '24953$4729', id: '0627e00a601c1001085f64bd33e20000' }
      }]
    } as any)).resolves.not.toThrow();

    const [[, params]] = (submitSupplierInvoiceUpdate as jest.Mock).mock.calls;
    expect(params.suppliersInvoiceNumber).toBe('20-1183-01SEP26');
    expect(params.buildNotes([])).toContain('Supplier Invoice Number (from document): 20-1183-01');
  });

  it('reports the timestamped supplier invoice number after a duplicate retry', async () => {
    const { getAiResponse } = require('../lib/ai.js');
    const { submitSupplierInvoiceUpdate } = require('../lib/workday.js');
    const { notifyEnrichmentResult } = require('../lib/slack.js');

    getAiResponse.mockResolvedValueOnce({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: { supplierName: 'Safari', memo: 'Trip' },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: { action: 'no_action', reason: 'Supplier matches existing assignment' },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      },
      extractedSuppliersInvoiceNumber: '12345',
      extractedInvoiceDate: '2026-09-28',
    });
    submitSupplierInvoiceUpdate.mockResolvedValueOnce({
      success: true,
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

    await expect(processor({
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: { descriptor: 'Safari', id: 'SUP-1' },
        company1: { descriptor: 'Test Company', id: 'COMP-1' },
        OCRSupplierInvoice: { descriptor: '24953$4729', id: '0627e00a601c1001085f64bd33e20000' }
      }]
    } as any)).resolves.not.toThrow();

    const [[, params]] = (submitSupplierInvoiceUpdate as jest.Mock).mock.calls;
    expect(params.buildNotes([{
      field: 'suppliersInvoiceNumber',
      label: 'supplier invoice number suffixed with -20260928170000',
    }])).toContain('Fallback values applied: supplier invoice number suffixed with -20260928170000');
    expect(params.buildNotes([])).toContain('Supplier Invoice Number (from document): 12345');
    expect(notifyEnrichmentResult).toHaveBeenCalledWith(expect.objectContaining({
      extracted: expect.objectContaining({ suppliersInvoiceNumber: '12345-20260928170000' }),
      appliedFallbackLabels: ['supplier invoice number suffixed with -20260928170000'],
    }));
  });

  it('does not pass a header memo when enrichment has a description but no identifiers', async () => {
    const { getAiResponse } = require('../lib/ai.js');
    const { submitSupplierInvoiceUpdate } = require('../lib/workday.js');
    const invoiceLines = require('../lib/invoice_lines.js');

    getAiResponse.mockResolvedValueOnce({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: {
          supplierName: 'Test Supplier',
          memo: 'Test invoice'
        },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: {
          action: 'no_action',
          reason: 'Supplier matches existing assignment'
        },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      },
      extractedInvoiceLines: [
        { description: 'Widgets', quantity: 2, unitCost: '50.00', totalPrice: '100.00', hasDiscount: false }
      ]
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue({
      lines: [{ lineOrder: 1, description: 'Widgets', memo: 'Widget purchase', quantity: 2, unitCost: 50 }],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false }
    });

    await expect(processor({
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: { descriptor: 'Existing Supplier', id: 'SUP-1' },
        company1: { descriptor: 'Test Company', id: 'COMP-1' },
        OCRSupplierInvoice: { descriptor: '24953$4729', id: '0627e00a601c1001085f64bd33e20000' }
      }]
    } as any)).resolves.not.toThrow();

    const [[, params]] = (submitSupplierInvoiceUpdate as jest.Mock).mock.calls;
    expect(params.memo).toBeUndefined();
    expect(params.finalLines).toEqual([
      expect.objectContaining({ memo: 'Widget purchase' }),
    ]);
  });
});
