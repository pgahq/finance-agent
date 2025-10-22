import { handler } from '../actions/cache_suppliers.js';

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

jest.mock('../lib/s3.js', () => ({
  getS3Config: jest.fn().mockReturnValue({
    bucketName: 'test-bucket',
    region: 'us-east-1'
  }),
  putJsonToS3: jest.fn().mockResolvedValue({})
}));

describe('cache_suppliers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should process supplier cache event with new format', async () => {
    const mockEvent = {
      detail: {
        action: 'cache_suppliers',
        data: {
          total: 2,
          data: [
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
          ]
        },
        timestamp: '2024-01-01T00:00:00Z',
        requestId: 'test-request-id'
      }
    };

    await expect(handler(mockEvent as any)).resolves.not.toThrow();

    const { putJsonToS3 } = require('../lib/s3.js');
    expect(putJsonToS3).toHaveBeenCalledWith(
      expect.any(Object),
      'cache/suppliers.json',
      expect.objectContaining({
        cachedAt: expect.any(String),
        totalCount: 2,
        suppliers: expect.arrayContaining([
          expect.objectContaining({
            supplierId: 'supplier-1',
            supplierName: 'Test Supplier 1',
            lastUpdatedDateTime: '2024-01-01T00:00:00Z',
            supplierStatus: 'Active',
            allPhoneNumbers: ['555-1234'],
            allEmailAddresses: ['test1@supplier.com'],
            allAddresses: ['123 Test St']
          }),
          expect.objectContaining({
            supplierId: 'supplier-2',
            supplierName: 'Test Supplier 2',
            lastUpdatedDateTime: '2024-01-02T00:00:00Z',
            supplierStatus: 'Active',
            allPhoneNumbers: ['555-5678'],
            allEmailAddresses: ['test2@supplier.com'],
            allAddresses: ['456 Test Ave']
          })
        ])
      })
    );
  });

  it('should handle suppliers with missing optional fields', async () => {
    const mockEvent = {
      detail: {
        action: 'cache_suppliers',
        data: {
          total: 1,
          data: [
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
          ]
        },
        timestamp: '2024-01-01T00:00:00Z',
        requestId: 'test-request-id'
      }
    };

    await expect(handler(mockEvent as any)).resolves.not.toThrow();

    const { putJsonToS3 } = require('../lib/s3.js');
    expect(putJsonToS3).toHaveBeenCalledWith(
      expect.any(Object),
      'cache/suppliers.json',
      expect.objectContaining({
        totalCount: 1,
        suppliers: expect.arrayContaining([
          expect.objectContaining({
            supplierId: 'supplier-minimal',
            supplierName: 'Minimal Supplier',
            allPhoneNumbers: [],
            allEmailAddresses: [],
            allAddresses: []
          })
        ])
      })
    );
  });

  it('should skip processing when no data received', async () => {
    const mockEvent = {
      detail: {
        action: 'cache_suppliers',
        data: {
          total: 0,
          data: []
        },
        timestamp: '2024-01-01T00:00:00Z',
        requestId: 'test-request-id'
      }
    };

    await expect(handler(mockEvent as any)).resolves.not.toThrow();

    const { putJsonToS3 } = require('../lib/s3.js');
    expect(putJsonToS3).not.toHaveBeenCalled();
  });

  it('should handle null/undefined data gracefully', async () => {
    const mockEvent = {
      detail: {
        action: 'cache_suppliers',
        data: null,
        timestamp: '2024-01-01T00:00:00Z',
        requestId: 'test-request-id'
      }
    };

    await expect(handler(mockEvent as any)).resolves.not.toThrow();

    const { putJsonToS3 } = require('../lib/s3.js');
    expect(putJsonToS3).not.toHaveBeenCalled();
  });

  it('should transform supplier data correctly', async () => {
    const mockEvent = {
      detail: {
        action: 'cache_suppliers',
        data: {
          total: 1,
          data: [
            {
              supplier: {
                descriptor: 'Complex Supplier',
                id: 'supplier-complex'
              },
              lastUpdatedDateTime: '2024-01-01T00:00:00Z',
              supplierStatus: {
                descriptor: 'Inactive',
                id: 'status-inactive'
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
          ]
        },
        timestamp: '2024-01-01T00:00:00Z',
        requestId: 'test-request-id'
      }
    };

    await expect(handler(mockEvent as any)).resolves.not.toThrow();

    const { putJsonToS3 } = require('../lib/s3.js');
    const putCall = putJsonToS3.mock.calls[0];
    const cacheData = putCall[2];

    expect(cacheData.suppliers[0]).toEqual({
      supplierId: 'supplier-complex',
      supplierName: 'Complex Supplier',
      lastUpdatedDateTime: '2024-01-01T00:00:00Z',
      supplierStatus: 'Inactive',
      allPhoneNumbers: ['555-1111', '555-2222'],
      allEmailAddresses: ['primary@supplier.com', 'secondary@supplier.com'],
      allAddresses: ['123 Main St', '456 Oak Ave']
    });
  });
});
