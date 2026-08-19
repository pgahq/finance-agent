import { processor } from '../cache_cost_centers.js';
import { bulkInsertDocuments } from '../lib/database.js';
import { EMPTY_RELATED_LOB } from '../lib/related_worktags.js';
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
  executeWorkdayQuery: jest.fn(),
  getRelatedWorktagsForCostCenters: jest.fn()
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
  });

  it('stores related LOB metadata on cost center documents', async () => {
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

  it('continues with empty related LOB when the SOAP fetch fails', async () => {
    mockGetRelatedWorktagsForCostCenters.mockRejectedValue(new Error('SOAP down'));

    await expect(processor({
      data: [{ workdayID: 'cc-wid-2', name: 'Other', code: 'CC-Other' }]
    })).resolves.not.toThrow();

    const inserted = mockBulkInsertDocuments.mock.calls[0]?.[1] ?? [];
    expect(inserted[0]?.metadata).toMatchObject({ relatedLob: EMPTY_RELATED_LOB });
  });
});
