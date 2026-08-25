import { processor } from '../cache_cost_centers.js';
import { bulkInsertDocuments } from '../lib/database.js';
import { getRelatedWorktagsForCostCenters } from '../lib/workday.js';

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
  executeWorkdayQuery: jest.fn(),
  getRelatedWorktagsForCostCenters: jest.fn(),
  isRelatedWorktagsSoapEnabled: jest.fn(() => process.env.WORKDAY_RELATED_WORKTAGS_SOAP === 'true')
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
  const mockGetRelatedWorktagsForCostCenters = getRelatedWorktagsForCostCenters as jest.MockedFunction<
    typeof getRelatedWorktagsForCostCenters
  >;
  const mockBulkInsertDocuments = bulkInsertDocuments as jest.MockedFunction<typeof bulkInsertDocuments>;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.WORKDAY_RELATED_WORKTAGS_SOAP;
    mockGetRelatedWorktagsForCostCenters.mockResolvedValue(new Map());
  });

  afterEach(() => {
    delete process.env.WORKDAY_RELATED_WORKTAGS_SOAP;
  });

  it('skips Get_Related_Worktags_for_Worktags by default and does not post Slack', async () => {
    await processor({
      data: [{
        workdayID: 'cc-wid-1',
        name: 'Building Services PBG',
        code: 'CC-Building Services-PBG',
      }]
    });

    expect(mockGetRelatedWorktagsForCostCenters).not.toHaveBeenCalled();

    const { notifyResult } = require('../lib/slack.js');
    expect(notifyResult).not.toHaveBeenCalledWith(
      'cache_cost_centers',
      'error',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'related worktags unauthorized'
    );

    const inserted = mockBulkInsertDocuments.mock.calls[0]?.[1] ?? [];
    expect(inserted[0]?.metadata).toEqual({
      workdayId: 'cc-wid-1',
      name: 'Building Services PBG',
      code: 'CC-Building Services-PBG',
    });
    expect(inserted[0]?.metadata).not.toHaveProperty('relatedLob');
  });

  it('stores related LOB metadata when WORKDAY_RELATED_WORKTAGS_SOAP is enabled', async () => {
    process.env.WORKDAY_RELATED_WORKTAGS_SOAP = 'true';
    mockGetRelatedWorktagsForCostCenters.mockResolvedValue(new Map([
      ['cc-wid-1', {
        requiredOnTransaction: true,
        defaultReferenceId: 'LOB-Facilities',
        allowedReferenceIds: ['LOB-Facilities'],
      }]
    ]));

    await processor({
      data: [{
        workdayID: 'cc-wid-1',
        name: 'Building Services PBG',
        code: 'CC-Building Services-PBG',
      }]
    });

    expect(mockGetRelatedWorktagsForCostCenters).toHaveBeenCalled();
    expect(mockGetRelatedWorktagsForCostCenters.mock.calls[0]?.[1]).toEqual(['cc-wid-1']);

    const inserted = mockBulkInsertDocuments.mock.calls[0]?.[1] ?? [];
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.workdayId).toBe('cc-wid-1');
    expect(inserted[0]?.type).toBe('cost_center');
    expect(inserted[0]?.metadata).toEqual({
      workdayId: 'cc-wid-1',
      name: 'Building Services PBG',
      code: 'CC-Building Services-PBG',
      relatedLob: {
        requiredOnTransaction: true,
        defaultReferenceId: 'LOB-Facilities',
        allowedReferenceIds: ['LOB-Facilities'],
      }
    });
  });

  it('continues without related LOB metadata when the SOAP fetch fails', async () => {
    process.env.WORKDAY_RELATED_WORKTAGS_SOAP = 'true';
    mockGetRelatedWorktagsForCostCenters.mockRejectedValue(new Error('SOAP down'));

    await expect(processor({
      data: [{ workdayID: 'cc-wid-2', name: 'Other', code: 'CC-Other' }]
    })).resolves.not.toThrow();

    const inserted = mockBulkInsertDocuments.mock.calls[0]?.[1] ?? [];
    expect(inserted[0]?.metadata).toEqual({
      workdayId: 'cc-wid-2',
      name: 'Other',
      code: 'CC-Other',
    });
    expect(inserted[0]?.metadata).not.toHaveProperty('relatedLob');
  });

  it('does not notify Slack when related worktags are not authorized', async () => {
    process.env.WORKDAY_RELATED_WORKTAGS_SOAP = 'true';
    mockGetRelatedWorktagsForCostCenters.mockRejectedValue(
      new Error('Processing error occurred. The task submitted is not authorized.')
    );

    await expect(processor({
      data: [{ workdayID: 'cc-wid-2', name: 'Other', code: 'CC-Other' }]
    })).resolves.not.toThrow();

    const { notifyResult } = require('../lib/slack.js');
    expect(notifyResult).not.toHaveBeenCalledWith(
      'cache_cost_centers',
      'error',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'related worktags unauthorized'
    );
  });

  it('prunes cached cost centers that are not in the active Workday snapshot', async () => {
    await expect(processor({
      data: [
        { workdayID: 'cc-active', name: 'Active', code: '100' }
      ],
      sourceTotal: 1
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

  it('does not prune when Workday total is missing from the event', async () => {
    await expect(processor({
      data: [
        { workdayID: 'cc-active', name: 'Active', code: '100' }
      ]
    })).resolves.not.toThrow();

    const { bulkDeleteDocuments } = require('../lib/database.js');
    expect(bulkDeleteDocuments).not.toHaveBeenCalled();
  });
});
