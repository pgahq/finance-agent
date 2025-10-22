import { handler } from '../wqlToEvent.js';

// Mock the dependencies
jest.mock('@pga/lambda-env', () => ({
  __esModule: true,
  default: jest.fn().mockResolvedValue({
    EVENT_BUS_NAME: 'test-event-bus',
    WORKDAY_DOMAIN: 'test.workday.com',
    WORKDAY_TENANT: 'test-tenant',
    WORKDAY_CLIENT_ID: 'test-client-id',
    WORKDAY_CLIENT_SECRET: 'test-client-secret',
    WORKDAY_REFRESH_TOKEN: 'test-refresh-token'
  })
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
  executeWorkdayQuery: jest.fn()
}));

jest.mock('@aws-sdk/client-eventbridge', () => {
  const mockSend = jest.fn().mockResolvedValue({});
  return {
    EventBridgeClient: jest.fn().mockImplementation(() => ({
      send: mockSend
    })),
    PutEventsCommand: jest.fn(),
    __mockSend: mockSend
  };
});

describe('WQL to Event', () => {
  let mockSend: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    const eventBridgeModule = require('@aws-sdk/client-eventbridge');
    mockSend = eventBridgeModule.__mockSend;
  });

  describe('handler with new data format', () => {
    it('should process query results with new format (bulk=false)', async () => {
      const { executeWorkdayQuery } = require('../lib/workday.js');
      executeWorkdayQuery.mockResolvedValue({
        total: 2,
        data: [
          { workdayID: '123', invoiceNumber: 'INV-001' },
          { workdayID: '456', invoiceNumber: 'INV-002' }
        ]
      });

      const mockEvent = {
        action: 'enrich_invoice_supplier',
        query: 'SELECT workdayID, invoiceNumber FROM supplierInvoices',
        bulk: false
      };

      const result = await handler(mockEvent as any, { awsRequestId: 'test-request-id' } as any, jest.fn());

      expect(executeWorkdayQuery).toHaveBeenCalled();
      expect(mockSend).toHaveBeenCalledTimes(1); // Batched into groups of 10
      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body).message).toBe('Successfully published 2 events');
    });

    it('should process query results with new format (bulk=true)', async () => {
      const { executeWorkdayQuery } = require('../lib/workday.js');
      executeWorkdayQuery.mockResolvedValue({
        total: 2,
        data: [
          { workdayID: '123', invoiceNumber: 'INV-001' },
          { workdayID: '456', invoiceNumber: 'INV-002' }
        ]
      });

      const mockEvent = {
        action: 'cache_suppliers',
        query: 'SELECT supplier FROM suppliers',
        bulk: true
      };

      const result = await handler(mockEvent as any, { awsRequestId: 'test-request-id' } as any, jest.fn());

      expect(executeWorkdayQuery).toHaveBeenCalled();
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body).message).toBe('Successfully published bulk event with 2 results');
    });

    it('should handle large result sets with batching', async () => {
      const { executeWorkdayQuery } = require('../lib/workday.js');
      const largeDataSet = Array.from({ length: 25 }, (_, i) => ({ 
        workdayID: `id-${i}`, 
        invoiceNumber: `INV-${i}` 
      }));
      
      executeWorkdayQuery.mockResolvedValue({
        total: 25,
        data: largeDataSet
      });

      const mockEvent = {
        action: 'enrich_invoice_supplier',
        query: 'SELECT workdayID, invoiceNumber FROM supplierInvoices',
        bulk: false
      };

      const result = await handler(mockEvent as any, { awsRequestId: 'test-request-id' } as any, jest.fn());

      expect(mockSend).toHaveBeenCalledTimes(3); // 10 + 10 + 5
      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body).message).toBe('Successfully published 25 events');
    });

    it('should throw error for invalid response format', async () => {
      const { executeWorkdayQuery } = require('../lib/workday.js');
      executeWorkdayQuery.mockResolvedValue('invalid-format');

      const mockEvent = {
        action: 'enrich_invoice_supplier',
        query: 'SELECT workdayID FROM supplierInvoices',
        bulk: false
      };

      await expect(handler(mockEvent as any, { awsRequestId: 'test-request-id' } as any, jest.fn()))
        .rejects.toThrow('Expected query response format: {total: number, data: array}');
    });

    it('should throw error for missing data property', async () => {
      const { executeWorkdayQuery } = require('../lib/workday.js');
      executeWorkdayQuery.mockResolvedValue({ total: 5 });

      const mockEvent = {
        action: 'enrich_invoice_supplier',
        query: 'SELECT workdayID FROM supplierInvoices',
        bulk: false
      };

      await expect(handler(mockEvent as any, { awsRequestId: 'test-request-id' } as any, jest.fn()))
        .rejects.toThrow('Expected query response format: {total: number, data: array}');
    });
  });
});
