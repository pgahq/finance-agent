import { processor } from '../cache_companies.js';
import { createCompanyContent } from '../lib/rag.js';
import { bulkInsertDocuments, bulkUpdateDocuments, getDocumentsByType } from '../lib/database.js';
import { notifyResult } from '../lib/slack.js';
import { getAllWorkdayCompanies } from '../lib/workday.js';

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
  getAllWorkdayCompanies: jest.fn()
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

const mockGetAllWorkdayCompanies = getAllWorkdayCompanies as jest.MockedFunction<typeof getAllWorkdayCompanies>;
const mockNotifyResult = notifyResult as jest.MockedFunction<typeof notifyResult>;

const soapCompany = {
  workdayId: 'pga-wid',
  companyName: 'The Professional Golfers Association of America',
  companyReferenceId: '310',
  addressPrimary: '100 Avenue of the Champions, Palm Beach Gardens, FL 33418',
  publicAddresses: ['100 Avenue of the Champions, Palm Beach Gardens, FL 33418'],
  emailAddresses: ['ap@pga.org'],
  phoneNumbers: ['(555) 123-4567'],
  financeAgentAliases: ['PGA of America'],
};

describe('cache_companies SOAP', () => {
  it('does not export a companies WQL query', async () => {
    const module = await import('../cache_companies.js');
    expect(module).not.toHaveProperty('QUERY');
  });
});

describe('cache_companies processor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAllWorkdayCompanies.mockResolvedValue([soapCompany]);
    jest.mocked(getDocumentsByType).mockResolvedValue([]);
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'CacheCompaniesProcessor';
  });

  it('stores SOAP catalog fields and Finance Agent aliases on content input and metadata', async () => {
    await expect(processor({})).resolves.not.toThrow();

    expect(mockGetAllWorkdayCompanies).toHaveBeenCalledTimes(1);
    expect(createCompanyContent).toHaveBeenCalledWith(expect.objectContaining({
      workdayId: 'pga-wid',
      companyName: 'The Professional Golfers Association of America',
      companyReferenceId: '310',
      addressPrimary: '100 Avenue of the Champions, Palm Beach Gardens, FL 33418',
      publicAddresses: ['100 Avenue of the Champions, Palm Beach Gardens, FL 33418'],
      financeAgentAliases: ['PGA of America'],
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
            financeAgentAliases: ['PGA of America'],
          }),
        }),
      ])
    );
  });

  it('rewrites existing companies when aliases are cleared', async () => {
    jest.mocked(getDocumentsByType).mockResolvedValue([{
      workday_id: 'pga-wid',
      content: 'Company Name: The Professional Golfers Association of America\nFinance Agent Alias: PGA of America',
      metadata: {
        companyName: 'The Professional Golfers Association of America',
        companyReferenceId: '310',
        financeAgentAliases: ['PGA of America'],
      },
      created_at: new Date('2026-01-01T00:00:00Z'),
    }]);
    mockGetAllWorkdayCompanies.mockResolvedValueOnce([{
      ...soapCompany,
      financeAgentAliases: [],
    }]);

    await expect(processor({})).resolves.not.toThrow();

    expect(bulkUpdateDocuments).toHaveBeenCalledTimes(1);
  });

  it('keeps cached streets when SOAP omits formatted addresses', async () => {
    jest.mocked(getDocumentsByType).mockResolvedValue([{
      workday_id: 'pga-wid',
      content: 'Company Name: The Professional Golfers Association of America\nPrimary Address: 100 Avenue of the Champions, Palm Beach Gardens, FL 33418\nFinance Agent Alias: PGA of America',
      metadata: {
        companyName: 'The Professional Golfers Association of America',
        companyReferenceId: '310',
        addressPrimary: '100 Avenue of the Champions, Palm Beach Gardens, FL 33418',
        publicAddresses: ['100 Avenue of the Champions, Palm Beach Gardens, FL 33418'],
        financeAgentAliases: ['PGA of America'],
      },
      created_at: new Date('2026-01-01T00:00:00Z'),
    }]);
    mockGetAllWorkdayCompanies.mockResolvedValueOnce([{
      ...soapCompany,
      addressPrimary: undefined,
      publicAddresses: undefined,
      financeAgentAliases: [],
    }]);

    await expect(processor({})).resolves.not.toThrow();

    expect(bulkInsertDocuments).not.toHaveBeenCalled();
    expect(bulkUpdateDocuments).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({
          workdayId: 'pga-wid',
          metadata: expect.objectContaining({
            addressPrimary: '100 Avenue of the Champions, Palm Beach Gardens, FL 33418',
            publicAddresses: ['100 Avenue of the Champions, Palm Beach Gardens, FL 33418'],
            financeAgentAliases: [],
          }),
        }),
      ])
    );
  });

  it('rewrites existing companies when primary address was not stored', async () => {
    jest.mocked(getDocumentsByType).mockResolvedValue([{
      workday_id: 'pga-wid',
      content: 'Company Name: The Professional Golfers Association of America\nPrimary Address: [object Object]',
      metadata: {
        companyName: 'The Professional Golfers Association of America',
        companyReferenceId: '310',
      },
      created_at: new Date('2026-01-01T00:00:00Z'),
    }]);

    await expect(processor({})).resolves.not.toThrow();

    expect(bulkInsertDocuments).not.toHaveBeenCalled();
    expect(bulkUpdateDocuments).toHaveBeenCalledTimes(1);
  });

  it('skips sync when SOAP returns no companies', async () => {
    mockGetAllWorkdayCompanies.mockResolvedValueOnce([]);

    await expect(processor({})).resolves.not.toThrow();

    expect(bulkInsertDocuments).not.toHaveBeenCalled();
    expect(bulkUpdateDocuments).not.toHaveBeenCalled();
    expect(mockNotifyResult).not.toHaveBeenCalledWith(
      expect.anything(),
      'error',
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  });

  it('skips sync and Slacks when Get_Workday_Companies fails', async () => {
    const soapError = new Error('Processing error occurred. The task submitted is not authorized.');
    mockGetAllWorkdayCompanies.mockRejectedValueOnce(soapError);

    await expect(processor({})).rejects.toThrow('Processing error occurred. The task submitted is not authorized.');

    expect(bulkInsertDocuments).not.toHaveBeenCalled();
    expect(bulkUpdateDocuments).not.toHaveBeenCalled();
    expect(mockNotifyResult).toHaveBeenCalledWith(
      'CacheCompaniesProcessor',
      'error',
      undefined,
      undefined,
      soapError
    );
  });
});
