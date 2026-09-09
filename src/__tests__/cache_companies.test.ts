import { QUERY, processor } from '../cache_companies.js';
import { createCompanyContent } from '../lib/rag.js';
import { bulkInsertDocuments, bulkUpdateDocuments, getDocumentsByType } from '../lib/database.js';

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
  createCompanyContent: jest.fn().mockReturnValue('Company content'),
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

describe('cache_companies WQL', () => {
  it('selects referenceID1 and does not select a bare referenceID field', () => {
    expect(QUERY).toMatch(/\breferenceID1\b/);
    expect(QUERY).not.toMatch(/\breferenceID\b/);
  });
});

describe('cache_companies processor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const workdayCompany = {
    company: {
      descriptor: 'The Professional Golfers Association of America',
      id: 'pga-wid',
    },
    referenceID1: { id: 'ref-1', descriptor: '310' },
    addressPrimary: {
      id: 'addr-1',
      descriptor: '100 Avenue of the Champions, Palm Beach Gardens, FL 33418',
    },
    publicAddresses: [
      { descriptor: '100 Avenue of the Champions, Palm Beach Gardens, FL 33418', id: 'pub-1' },
    ],
  };

  it('stores Workday address descriptors on content input and metadata', async () => {
    await expect(processor({ data: [workdayCompany] })).resolves.not.toThrow();

    expect(createCompanyContent).toHaveBeenCalledWith(expect.objectContaining({
      workdayId: 'pga-wid',
      companyName: 'The Professional Golfers Association of America',
      companyReferenceId: '310',
      addressPrimary: '100 Avenue of the Champions, Palm Beach Gardens, FL 33418',
      publicAddresses: ['100 Avenue of the Champions, Palm Beach Gardens, FL 33418'],
    }));

    expect(bulkInsertDocuments).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({
          workdayId: 'pga-wid',
          type: 'company',
          metadata: expect.objectContaining({
            companyName: 'The Professional Golfers Association of America',
            companyReferenceId: '310',
            addressPrimary: '100 Avenue of the Champions, Palm Beach Gardens, FL 33418',
            publicAddresses: ['100 Avenue of the Champions, Palm Beach Gardens, FL 33418'],
          }),
        }),
      ])
    );
  });

  it('rewrites existing companies when primary address was not stored', async () => {
    jest.mocked(getDocumentsByType).mockResolvedValueOnce([{
      workday_id: 'pga-wid',
      content: 'Company Name: The Professional Golfers Association of America\nPrimary Address: [object Object]',
      metadata: {
        companyName: 'The Professional Golfers Association of America',
        companyReferenceId: '310',
      },
      created_at: new Date('2026-01-01T00:00:00Z'),
    }]);

    await expect(processor({ data: [workdayCompany] })).resolves.not.toThrow();

    expect(bulkInsertDocuments).not.toHaveBeenCalled();
    expect(bulkUpdateDocuments).toHaveBeenCalledTimes(1);
  });
});
