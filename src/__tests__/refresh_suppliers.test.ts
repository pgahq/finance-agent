import { handler } from '../refresh_suppliers.js';

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

jest.mock('../lib/database.js', () => ({
  getDatabaseConnection: jest.fn().mockResolvedValue({
    query: jest.fn().mockResolvedValue([]),
    close: jest.fn().mockResolvedValue({})
  }),
  deleteAllDocumentsByType: jest.fn().mockResolvedValue(10)
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
    total: 100,
    data: []
  })
}));

jest.mock('../lib/slack.js', () => ({
  notifyResult: jest.fn().mockResolvedValue({})
}));

jest.mock('../lib/handlers.js', () => ({
  withQueryHandler: jest.fn().mockReturnValue(() => jest.fn().mockResolvedValue(undefined))
}));

describe('refresh_suppliers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should complete refresh process successfully', async () => {
    const { deleteAllDocumentsByType } = require('../lib/database.js');
    const { executeWorkdayQuery } = require('../lib/workday.js');
    const { notifyResult } = require('../lib/slack.js');
    const { withQueryHandler } = require('../lib/handlers.js');

    await expect(handler()).resolves.not.toThrow();

    expect(deleteAllDocumentsByType).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.any(Function),
        close: expect.any(Function)
      }),
      'supplier'
    );

    expect(executeWorkdayQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: 'test.workday.com'
      }),
      expect.stringContaining('SELECT')
    );

    expect(withQueryHandler).toHaveBeenCalledWith(
      expect.stringContaining('SELECT')
    );

    expect(notifyResult).toHaveBeenCalledWith(
      'refresh_suppliers',
      'success',
      expect.any(Number),
      expect.objectContaining({
        refreshStats: expect.objectContaining({
          totalSuppliers: 100,
          totalPages: expect.any(Number),
          pageSize: 500,
          processingTime: expect.any(Number)
        })
      }),
      undefined,
      expect.stringContaining('cache batches processed')
    );
  });

  it('should handle no suppliers found', async () => {
    const { executeWorkdayQuery } = require('../lib/workday.js');
    const { notifyResult } = require('../lib/slack.js');
    
    executeWorkdayQuery.mockResolvedValue({
      total: 0,
      data: []
    });

    await expect(handler()).resolves.not.toThrow();

    expect(notifyResult).toHaveBeenCalledWith(
      'refresh_suppliers',
      'success',
      expect.any(Number),
      { message: 'No suppliers found in Workday' }
    );
  });

  it('should handle errors gracefully', async () => {
    const { executeWorkdayQuery } = require('../lib/workday.js');
    const { notifyResult } = require('../lib/slack.js');
    
    executeWorkdayQuery.mockRejectedValue(new Error('Workday error'));

    await expect(handler()).rejects.toThrow('Workday error');

    expect(notifyResult).toHaveBeenCalledWith(
      'refresh_suppliers',
      'error',
      expect.any(Number),
      {
        processingTime: expect.stringMatching(/\d+ms/)
      },
      expect.any(Error)
    );
  });
});
