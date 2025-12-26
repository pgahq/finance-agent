import { processor } from '../cache_suppliers.js';

// Mock the dependencies
jest.mock('@pga/lambda-env', () => ({
  __esModule: true,
  default: jest.fn().mockResolvedValue({
    S3_BUCKET_NAME: 'test-bucket',
    AWS_REGION: 'us-east-1'
  })
}));

jest.mock('@pga/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn()
}));

jest.mock('../lib/rag.js', () => ({
  createSupplierContent: jest.fn().mockReturnValue('Supplier content'),
  createEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3])
}));

jest.mock('../lib/database.js', () => ({
  getDatabaseConnection: jest.fn().mockResolvedValue({
    query: jest.fn().mockResolvedValue([]),
    close: jest.fn().mockResolvedValue({})
  }),
  getDocumentsByType: jest.fn().mockResolvedValue([]),
  bulkInsertDocuments: jest.fn().mockResolvedValue({}),
  bulkUpdateDocuments: jest.fn().mockResolvedValue({}),
  bulkDeleteDocuments: jest.fn().mockResolvedValue(0)
}));

jest.mock('../lib/workday.js', () => ({
  getWorkdayConfig: jest.fn().mockReturnValue({
    domain: 'test.workday.com',
    tenant: 'test-tenant',
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    refreshToken: 'test-refresh-token'
  }),
  executeWorkdayQuery: jest.fn()
}));

jest.mock('../lib/slack.js', () => ({
  notifyResult: jest.fn().mockResolvedValue({})
}));

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({})
  })),
  InvokeCommand: jest.fn()
}));

describe('cache_suppliers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should process supplier cache with new format', async () => {
    const mockSuppliers = [
      {
        supplier: {
          descriptor: 'Test Supplier 1',
          id: 'supplier-1'
        },
        lastUpdatedDateTime: '2024-01-01T00:00:00Z',
        supplierStatus: {
          descriptor: 'Active',
          id: 'status-1'
        },
        allPhoneNumbers: [
          { descriptor: '555-1234', id: 'phone-1' }
        ],
        allEmailAddresses: [
          { descriptor: 'test1@supplier.com', id: 'email-1' }
        ],
        allAddresses: [
          { descriptor: '123 Test St', id: 'address-1' }
        ]
      },
      {
        supplier: {
          descriptor: 'Test Supplier 2',
          id: 'supplier-2'
        },
        lastUpdatedDateTime: '2024-01-02T00:00:00Z',
        supplierStatus: {
          descriptor: 'Active',
          id: 'status-2'
        },
        allPhoneNumbers: [
          { descriptor: '555-5678', id: 'phone-2' }
        ],
        allEmailAddresses: [
          { descriptor: 'test2@supplier.com', id: 'email-2' }
        ],
        allAddresses: [
          { descriptor: '456 Test Ave', id: 'address-2' }
        ]
      }
    ];

    await expect(processor({ data: mockSuppliers })).resolves.not.toThrow();

    const { bulkInsertDocuments } = require('../lib/database.js');
    expect(bulkInsertDocuments).toHaveBeenCalledTimes(1);
    expect(bulkInsertDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.any(Function),
        close: expect.any(Function)
      }),
      expect.arrayContaining([
        expect.objectContaining({
          workdayId: 'supplier-1',
          type: 'supplier',
          content: 'Supplier content',
          metadata: expect.objectContaining({
            supplierId: 'supplier-1',
            supplierName: 'Test Supplier 1',
            workdayId: 'supplier-1',
            lastUpdatedDateTime: '2024-01-01T00:00:00Z'
          }),
          embedding: [0.1, 0.2, 0.3]
        })
      ])
    );
  });

  it('should handle suppliers with missing optional fields', async () => {
    const mockSuppliers = [
      {
        supplier: {
          descriptor: 'Minimal Supplier',
          id: 'supplier-minimal'
        },
        lastUpdatedDateTime: '2024-01-01T00:00:00Z',
        supplierStatus: {
          descriptor: 'Active',
          id: 'status-1'
        }
        // Missing optional fields: allPhoneNumbers, allEmailAddresses, allAddresses
      }
    ];

    await expect(processor({ data: mockSuppliers })).resolves.not.toThrow();

    const { bulkInsertDocuments } = require('../lib/database.js');
    expect(bulkInsertDocuments).toHaveBeenCalledTimes(1);
    expect(bulkInsertDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.any(Function),
        close: expect.any(Function)
      }),
      expect.arrayContaining([
        expect.objectContaining({
          workdayId: 'supplier-minimal',
          type: 'supplier',
          content: 'Supplier content',
          metadata: expect.objectContaining({
            supplierId: 'supplier-minimal',
            supplierName: 'Minimal Supplier',
            workdayId: 'supplier-minimal',
            lastUpdatedDateTime: '2024-01-01T00:00:00Z'
          }),
          embedding: [0.1, 0.2, 0.3]
        })
      ])
    );
  });

  it('should skip processing when no data received', async () => {
    await expect(processor({ data: [] })).resolves.not.toThrow();

    const { bulkInsertDocuments } = require('../lib/database.js');
    expect(bulkInsertDocuments).not.toHaveBeenCalled();
  });

  it('should handle null/undefined data gracefully', async () => {
    await expect(processor({ data: null })).resolves.not.toThrow();

    const { bulkInsertDocuments } = require('../lib/database.js');
    expect(bulkInsertDocuments).not.toHaveBeenCalled();
  });

  it('should transform supplier data correctly', async () => {
    const mockSuppliers = [
      {
        supplier: {
          descriptor: 'Complex Supplier',
          id: 'supplier-complex'
        },
        lastUpdatedDateTime: '2024-01-01T00:00:00Z',
        supplierStatus: {
          descriptor: 'Active',
          id: 'status-active'
        },
        allPhoneNumbers: [
          { descriptor: '555-1111', id: 'phone-1' },
          { descriptor: '555-2222', id: 'phone-2' }
        ],
        allEmailAddresses: [
          { descriptor: 'primary@supplier.com', id: 'email-1' },
          { descriptor: 'secondary@supplier.com', id: 'email-2' }
        ],
        allAddresses: [
          { descriptor: '123 Main St', id: 'address-1' },
          { descriptor: '456 Oak Ave', id: 'address-2' }
        ]
      }
    ];

    await expect(processor({ data: mockSuppliers })).resolves.not.toThrow();

    const { bulkInsertDocuments } = require('../lib/database.js');
    expect(bulkInsertDocuments).toHaveBeenCalledTimes(1);
    expect(bulkInsertDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.any(Function),
        close: expect.any(Function)
      }),
      expect.arrayContaining([
        expect.objectContaining({
          workdayId: 'supplier-complex',
          type: 'supplier',
          content: 'Supplier content',
          metadata: expect.objectContaining({
            supplierId: 'supplier-complex',
            supplierName: 'Complex Supplier',
            workdayId: 'supplier-complex',
            lastUpdatedDateTime: '2024-01-01T00:00:00Z'
          }),
          embedding: [0.1, 0.2, 0.3]
        })
      ])
    );
  });
});
