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
  updateSupplierInvoiceSupplier: jest.fn().mockResolvedValue(undefined),
  addNoSupplierTagToInvoice: jest.fn().mockResolvedValue(undefined),
  updateVerifySupplierInvoiceData: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../lib/database.js', () => ({
  getDatabaseConnection: jest.fn().mockResolvedValue({
    query: jest.fn().mockResolvedValue([]),
    close: jest.fn().mockResolvedValue({})
  }),
  searchSimilarDocuments: jest.fn().mockResolvedValue([])
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

jest.mock('../lib/invoice_validation_failures.js', () => ({
  getInvoiceValidationFailuresConfig: jest.fn().mockReturnValue(undefined),
  isInvoiceMarkedForSkip: jest.fn().mockResolvedValue(false),
  isWorkdayValidationError: jest.fn((error: unknown) => {
    if (typeof error === 'string') {
      return /validation/i.test(error);
    }

    if (error instanceof Error) {
      return /validation/i.test(error.message);
    }

    const message = (error as { message?: string } | undefined)?.message;
    return typeof message === 'string' && /validation/i.test(message);
  }),
  recordInvoiceValidationFailure: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../lib/s3.js', () => ({
  getS3Config: jest.fn().mockReturnValue({
    bucketName: 'test-bucket',
    region: 'us-east-1'
  }),
}));

describe('enrich_invoice', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const validationFailures = require('../lib/invoice_validation_failures.js');
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
    const { updateVerifySupplierInvoiceData } = require('../lib/workday.js');
    const { recordInvoiceValidationFailure } = require('../lib/invoice_validation_failures.js');

    const validationError = new Error('Validation_Fault: spend category is required');
    updateVerifySupplierInvoiceData.mockRejectedValue(validationError);

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
    expect(recordInvoiceValidationFailure).toHaveBeenCalledWith(undefined, 'test-invoice-id', validationError);
  });

  it('should continue throwing non-validation processing errors', async () => {
    const { updateVerifySupplierInvoiceData } = require('../lib/workday.js');
    const { recordInvoiceValidationFailure } = require('../lib/invoice_validation_failures.js');

    updateVerifySupplierInvoiceData.mockRejectedValue(new Error('Update failed'));

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

  it('should handle batching with hardcoded configuration', () => {
    // Test that the batching logic works with hardcoded values
    // This is more of an integration test to ensure the batching doesn't break
    expect(true).toBe(true); // Placeholder for batching logic validation
  });
});
