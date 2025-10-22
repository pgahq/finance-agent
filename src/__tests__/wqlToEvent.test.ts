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
    WORKDAY_REFRESH_TOKEN: 'test-refresh-token',
    ACTION_FUNCTION_MAP: JSON.stringify({
      'CacheSuppliersAction': 'arn:aws:lambda:us-east-1:123456789012:function:finance-agent-CacheSuppliersAction-ABC123',
      'EnrichInvoiceSupplierAction': 'arn:aws:lambda:us-east-1:123456789012:function:finance-agent-EnrichInvoiceSupplierAction-DEF456'
    })
  })
}));

jest.mock('@pga/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn()
}));

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({})
  })),
  InvokeCommand: jest.fn().mockImplementation((params) => params)
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


describe('WQL to Event', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
        action: 'EnrichInvoiceSupplierAction',
        query: 'SELECT workdayID, invoiceNumber FROM supplierInvoices',
        bulk: false
      };

      const result = await handler(mockEvent as any, { awsRequestId: 'test-request-id' } as any, jest.fn());

      expect(executeWorkdayQuery).toHaveBeenCalled();
      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body).message).toBe('Successfully invoked EnrichInvoiceSupplierAction 2 times');
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
        action: 'CacheSuppliersAction',
        query: 'SELECT supplier FROM suppliers',
        bulk: true
      };

      const result = await handler(mockEvent as any, { awsRequestId: 'test-request-id' } as any, jest.fn());

      expect(executeWorkdayQuery).toHaveBeenCalled();
      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body).message).toContain('Successfully invoked CacheSuppliersAction with 2 results');
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
        action: 'EnrichInvoiceSupplierAction',
        query: 'SELECT workdayID, invoiceNumber FROM supplierInvoices',
        bulk: false
      };

      const result = await handler(mockEvent as any, { awsRequestId: 'test-request-id' } as any, jest.fn());

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body).message).toBe('Successfully invoked EnrichInvoiceSupplierAction 25 times');
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
