import { processor } from '../cache_cost_centers.js';

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
  createCostCenterContent: jest.fn().mockReturnValue('Cost center content'),
  createEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3])
}));

jest.mock('../lib/database.js', () => ({
  getDatabaseConnection: jest.fn().mockResolvedValue({
    query: jest.fn().mockResolvedValue([]),
    close: jest.fn().mockResolvedValue({})
  }),
  getDocumentsByType: jest.fn().mockResolvedValue([
    { workday_id: 'cc-active', metadata: {}, created_at: new Date() },
    { workday_id: 'cc-inactive', metadata: {}, created_at: new Date() }
  ]),
  bulkInsertDocuments: jest.fn().mockResolvedValue({}),
  bulkUpdateDocuments: jest.fn().mockResolvedValue({}),
  bulkDeleteDocuments: jest.fn().mockResolvedValue(1)
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

describe('cache_cost_centers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('prunes cached cost centers that are not in the active Workday snapshot', async () => {
    await expect(processor({
      data: [
        { workdayID: 'cc-active', name: 'Active', code: '100' }
      ]
    })).resolves.not.toThrow();

    const { bulkDeleteDocuments, bulkInsertDocuments } = require('../lib/database.js');
    expect(bulkDeleteDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.any(Function),
        close: expect.any(Function)
      }),
      ['cc-inactive'],
      'cost_center'
    );
    expect(bulkInsertDocuments).not.toHaveBeenCalled();
  });

  it('does not prune when no cost center data is received', async () => {
    await expect(processor({ data: [] })).resolves.not.toThrow();

    const { bulkDeleteDocuments } = require('../lib/database.js');
    expect(bulkDeleteDocuments).not.toHaveBeenCalled();
  });
});
