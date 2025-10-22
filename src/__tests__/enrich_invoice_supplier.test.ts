import { handler } from '../actions/enrich_invoice_supplier.js';

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
  getAttachmentContent: jest.fn().mockResolvedValue([])
}));

jest.mock('../lib/openai.js', () => ({
  callOpenAIWithSchema: jest.fn().mockResolvedValue({
    supplierId: 'supplier-1',
    supplierName: 'Test Supplier',
    confidence: 0.9,
    reasoning: 'High confidence match'
  })
}));

jest.mock('../lib/s3.js', () => ({
  getS3Config: jest.fn().mockReturnValue({
    bucketName: 'test-bucket',
    region: 'us-east-1'
  }),
  getJsonFromS3: jest.fn().mockResolvedValue({
    cachedAt: '2024-01-01T00:00:00Z',
    totalCount: 1,
    suppliers: [{
      supplierId: 'supplier-1',
      supplierName: 'Test Supplier',
      lastUpdatedDateTime: '2024-01-01T00:00:00Z',
      supplierStatus: 'Active',
      allPhoneNumbers: ['555-1234'],
      allEmailAddresses: ['test@supplier.com'],
      allAddresses: ['123 Test St']
    }]
  })
}));

describe('enrich_invoice_supplier', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should process supplier enrichment event with new format', async () => {
    const mockEvent = {
      detail: {
        action: 'enrich_invoice_supplier',
        data: {
          workdayID: 'test-invoice-id',
          invoiceStatusAsText: 'Draft',
          OCRSupplierInvoice: {
            descriptor: '24953$4729',
            id: '0627e00a601c1001085f64bd33e20000'
          }
        },
        timestamp: '2024-01-01T00:00:00Z',
        requestId: 'test-request-id'
      }
    };

    await expect(handler(mockEvent as any)).resolves.not.toThrow();
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
      detail: {
        action: 'enrich_invoice_supplier',
        data: {
          workdayID: 'test-invoice-id',
          invoiceStatusAsText: 'Draft',
          OCRSupplierInvoice: {
            descriptor: '24953$4729',
            id: '0627e00a601c1001085f64bd33e20000'
          }
        },
        timestamp: '2024-01-01T00:00:00Z',
        requestId: 'test-request-id'
      }
    };

    await expect(handler(mockEvent as any)).resolves.not.toThrow();
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
      detail: {
        action: 'enrich_invoice_supplier',
        data: {
          workdayID: 'test-invoice-id',
          invoiceStatusAsText: 'Draft',
          OCRSupplierInvoice: {
            descriptor: '24953$4729',
            id: '0627e00a601c1001085f64bd33e20000'
          }
        },
        timestamp: '2024-01-01T00:00:00Z',
        requestId: 'test-request-id'
      }
    };

    await expect(handler(mockEvent as any)).resolves.not.toThrow();
  });

  it('should handle missing supplier cache gracefully', async () => {
    const { executeWorkdayQuery } = require('../lib/workday.js');
    const { getJsonFromS3 } = require('../lib/s3.js');
    
    // Mock the detailed query to return missing supplier
    executeWorkdayQuery.mockResolvedValue({
      total: 1,
      data: [{
        workdayID: 'test-invoice-id',
        invoiceNumber: 'INV-001',
        supplier: null, // Missing supplier
        allAttachmentsForBusinessDocument: []
      }]
    });
    
    getJsonFromS3.mockResolvedValue(null); // Cache not found

    const mockEvent = {
      detail: {
        action: 'enrich_invoice_supplier',
        data: {
          workdayID: 'test-invoice-id',
          invoiceStatusAsText: 'Draft',
          OCRSupplierInvoice: {
            descriptor: '24953$4729',
            id: '0627e00a601c1001085f64bd33e20000'
          }
        },
        timestamp: '2024-01-01T00:00:00Z',
        requestId: 'test-request-id'
      }
    };

    await expect(handler(mockEvent as any)).rejects.toThrow('Supplier cache not found');
  });
});
