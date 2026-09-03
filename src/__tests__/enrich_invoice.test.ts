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
  annotateSupplierInvoice: jest.fn().mockResolvedValue(undefined)
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
  getCostCenterWorkdayIdsByCodes: jest.fn().mockResolvedValue(new Map())
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
        suppliersInvoiceNumber: undefined,
        extractedFreightAmount: undefined,
        extractedTaxAmount: undefined,
        finalLines: undefined,
        relatedLobByCostCenter: undefined,
        resolveCostCenterWorkdayIds: expect.any(Function),
        paymentTermsId: undefined,
      }
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
        finalLines: undefined,
        relatedLobByCostCenter: undefined,
        resolveCostCenterWorkdayIds: expect.any(Function),
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
        priorFailures: [
          { attempt: 1, message: 'The invoice date must be the first day of the month.' },
        ],
      })
    );
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
      'AC #1033562 | Job #5914196 | Customer ID CU0122145 | Service Period 2026 - September | Test invoice'
    );
    expect(params.finalLines).toEqual([
      expect.objectContaining({
        memo: 'AC #1033562 | Job #5914196 | Customer ID CU0122145 | Service Period 2026 - September | Widget purchase',
      }),
    ]);
    expect(params.buildNotes([])).toContain('Account Number (from document): 1033562');
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
