import { withQueryHandler, withProcessorHandler } from '../lib/handlers.js';

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

jest.mock('../lib/workday.js', () => ({
  getWorkdayConfig: jest.fn().mockReturnValue({
    domain: 'test.workday.com',
    tenant: 'test-tenant',
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    refreshToken: 'test-refresh-token'
  }),
  getWorkdaySoapConfig: jest.fn().mockReturnValue({
    domain: 'test.workday.com',
    tenant: 'test-tenant',
    username: 'test-user',
    password: 'test-password'
  }),
  executeWorkdayQuery: jest.fn().mockResolvedValue({
    total: 2,
    data: [
      { id: '1', name: 'Item 1' },
      { id: '2', name: 'Item 2' }
    ]
  })
}));

jest.mock('../lib/s3.js', () => ({
  getS3Config: jest.fn().mockReturnValue({
    bucketName: 'test-bucket',
    region: 'us-east-1'
  })
}));

jest.mock('../lib/database.js', () => ({
  getDatabaseConnection: jest.fn().mockResolvedValue({
    query: jest.fn().mockResolvedValue([]),
    close: jest.fn().mockResolvedValue({})
  })
}));

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({})
  })),
  InvokeCommand: jest.fn()
}));

describe('handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('withQueryHandler', () => {
    it('should create a query handler that invokes processor when pageSize is null', async () => {
      const query = 'SELECT * FROM test';
      const processorFunctionName = 'TestProcessor';
      
      const queryHandler = withQueryHandler(query)({
        processorFunctionName,
        pageSize: null
      });

      await queryHandler();

      const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
      expect(LambdaClient).toHaveBeenCalled();
      expect(InvokeCommand).toHaveBeenCalledWith({
        FunctionName: processorFunctionName,
        InvocationType: 'Event',
        Payload: JSON.stringify({
          query,
        })
      });
    });

    it('should create a query handler that paginates when pageSize is provided', async () => {
      const query = 'SELECT * FROM test';
      const processorFunctionName = 'TestProcessor';
      const pageSize = 1;
      
      const queryHandler = withQueryHandler(query)({
        processorFunctionName,
        pageSize
      });

      await queryHandler();

      const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
      expect(LambdaClient).toHaveBeenCalled();
      expect(InvokeCommand).toHaveBeenCalledTimes(2); // Two items, pageSize 1
    });

    it('should handle empty data gracefully', async () => {
      const { executeWorkdayQuery } = require('../lib/workday.js');
      executeWorkdayQuery.mockResolvedValue({
        total: 0,
        data: []
      });

      const query = 'SELECT * FROM test';
      const processorFunctionName = 'TestProcessor';
      
      const queryHandler = withQueryHandler(query)({
        processorFunctionName,
        pageSize: 1
      });

      await queryHandler();

      const { InvokeCommand } = require('@aws-sdk/client-lambda');
      expect(InvokeCommand).not.toHaveBeenCalled();
    });
  });

  describe('withProcessorHandler', () => {
    it('should execute query when event contains query', async () => {
      const mockProcessAction = jest.fn().mockResolvedValue(undefined);
      const processor = withProcessorHandler(mockProcessAction);

      const event = {
        query: 'SELECT * FROM test'
      };

      await processor(event);

      expect(mockProcessAction).toHaveBeenCalledWith(
        expect.objectContaining({
          workdayConfig: expect.any(Object),
          workdaySoapConfig: expect.any(Object),
          s3Config: expect.any(Object),
          dbConnection: expect.any(Object)
        }),
        expect.any(Array),
        event
      );
    });

    it('should process data from payload when no query', async () => {
      const mockProcessAction = jest.fn().mockResolvedValue(undefined);
      const processor = withProcessorHandler(mockProcessAction);

      const event = {
        data: [{ id: '1', name: 'Test Item' }]
      };

      await processor(event);

      expect(mockProcessAction).toHaveBeenCalledWith(
        expect.objectContaining({
          workdayConfig: expect.any(Object),
          workdaySoapConfig: expect.any(Object),
          s3Config: expect.any(Object),
          dbConnection: expect.any(Object)
        }),
        [{ id: '1', name: 'Test Item' }],
        event
      );
    });

    it('should handle empty data gracefully', async () => {
      const mockProcessAction = jest.fn().mockResolvedValue(undefined);
      const processor = withProcessorHandler(mockProcessAction);

      const event = {
        data: []
      };

      await processor(event);

      expect(mockProcessAction).toHaveBeenCalledWith(
        expect.any(Object),
        [],
        event
      );
    });
  });
});
