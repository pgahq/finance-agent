import { processor } from '../cache_cost_centers.js';
import { bulkInsertDocuments, bulkUpdateDocuments, getCostCenterRelatedLobsByCodes, getDocumentsByType } from '../lib/database.js';
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
  getDocumentsByType: jest.fn().mockResolvedValue([
    { workday_id: 'cc-active', metadata: {}, created_at: new Date() },
    { workday_id: 'cc-inactive', metadata: {}, created_at: new Date() }
  ]),
  getCostCenterRelatedLobsByCodes: jest.fn().mockResolvedValue(new Map()),
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
  const mockBulkUpdateDocuments = bulkUpdateDocuments as jest.MockedFunction<typeof bulkUpdateDocuments>;
  const mockGetCostCenterRelatedLobsByCodes = getCostCenterRelatedLobsByCodes as jest.MockedFunction<
    typeof getCostCenterRelatedLobsByCodes
  >;
  const mockGetDocumentsByType = getDocumentsByType as jest.MockedFunction<typeof getDocumentsByType>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRelatedWorktagsForCostCenters.mockResolvedValue(new Map());
    mockGetCostCenterRelatedLobsByCodes.mockResolvedValue(new Map());
    mockGetDocumentsByType.mockResolvedValue([
      { workday_id: 'cc-active', metadata: {}, created_at: new Date() },
      { workday_id: 'cc-inactive', metadata: {}, created_at: new Date() }
    ] as any);
  });

  it('stores related LOB metadata on cost center documents', async () => {
    mockGetRelatedWorktagsForCostCenters.mockResolvedValue(new Map([
      ['cc-wid-1', {
        requiredOnTransaction: true,
        defaultReferenceId: 'LOB-Facilities',
        allowedReferenceIds: ['LOB-Facilities'],
        defaultIds: [{ type: 'Organization_Reference_ID', value: 'LOB-Facilities' }],
        allowedIds: [
          { type: 'Organization_Reference_ID', value: 'LOB-Facilities' },
          { type: 'WID', value: '737c7895dd701001ec3537bb73570000' },
        ],
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
        defaultIds: [{ type: 'Organization_Reference_ID', value: 'LOB-Facilities' }],
        allowedIds: [
          { type: 'Organization_Reference_ID', value: 'LOB-Facilities' },
          { type: 'WID', value: '737c7895dd701001ec3537bb73570000' },
        ],
      }
    });
  });

  it('continues with empty related LOB when the SOAP fetch fails', async () => {
    mockGetRelatedWorktagsForCostCenters.mockRejectedValue(new Error('SOAP down'));

    await expect(processor({
      data: [{ workdayID: 'cc-wid-2', name: 'Other', code: 'CC-Other' }]
    })).resolves.not.toThrow();

    expect(mockGetCostCenterRelatedLobsByCodes).toHaveBeenCalled();
    const inserted = mockBulkInsertDocuments.mock.calls[0]?.[1] ?? [];
    expect(inserted[0]?.metadata).toMatchObject({ relatedLob: EMPTY_RELATED_LOB });
  });

  it('keeps cached related LOB when the SOAP fetch is unauthorized', async () => {
    const cachedRelated = {
      requiredOnTransaction: true,
      defaultReferenceId: null,
      allowedReferenceIds: ['LOB-Building_Services'],
      defaultIds: [],
      allowedIds: [{ type: 'Organization_Reference_ID', value: 'LOB-Building_Services' }],
    };
    mockGetRelatedWorktagsForCostCenters.mockRejectedValue(
      new Error('Processing error occurred. The task submitted is not authorized.')
    );
    mockGetCostCenterRelatedLobsByCodes.mockResolvedValue(new Map([
      ['CC-Other', cachedRelated],
      ['cc-wid-2', cachedRelated],
    ]));

    await expect(processor({
      data: [{ workdayID: 'cc-wid-2', name: 'Other', code: 'CC-Other' }]
    })).resolves.not.toThrow();

    const inserted = mockBulkInsertDocuments.mock.calls[0]?.[1] ?? [];
    expect(inserted[0]?.metadata).toMatchObject({ relatedLob: cachedRelated });

    const { notifyResult } = require('../lib/slack.js');
    expect(notifyResult).not.toHaveBeenCalledWith(
      'cache_cost_centers',
      'error',
      undefined,
      expect.objectContaining({
        note: expect.stringContaining('Get_Related_Worktags_for_Worktags')
      }),
      expect.any(Error),
      'related worktags unauthorized'
    );
  });

  it('does not wipe existing related LOB when SOAP and cached lookup both fail', async () => {
    const existingRelated = {
      requiredOnTransaction: true,
      defaultReferenceId: null,
      allowedReferenceIds: ['LOB-Building_Services'],
      defaultIds: [],
      allowedIds: [{ type: 'Organization_Reference_ID', value: 'LOB-Building_Services' }],
    };
    mockGetRelatedWorktagsForCostCenters.mockRejectedValue(new Error('SOAP down'));
    mockGetCostCenterRelatedLobsByCodes.mockRejectedValue(new Error('DB down'));
    mockGetDocumentsByType.mockResolvedValue([
      {
        workday_id: 'cc-wid-2',
        metadata: {
          name: 'Other',
          code: 'CC-Other',
          relatedLob: existingRelated,
        },
        created_at: new Date(),
      }
    ] as any);

    await expect(processor({
      data: [{ workdayID: 'cc-wid-2', name: 'Other', code: 'CC-Other' }]
    })).resolves.not.toThrow();

    expect(mockBulkInsertDocuments).not.toHaveBeenCalled();
    expect(mockBulkUpdateDocuments).not.toHaveBeenCalled();
  });

  it('keeps existing related LOB on name updates when SOAP and cached lookup both fail', async () => {
    const existingRelated = {
      requiredOnTransaction: true,
      defaultReferenceId: null,
      allowedReferenceIds: ['LOB-Building_Services'],
      defaultIds: [],
      allowedIds: [{ type: 'Organization_Reference_ID', value: 'LOB-Building_Services' }],
    };
    mockGetRelatedWorktagsForCostCenters.mockRejectedValue(new Error('SOAP down'));
    mockGetCostCenterRelatedLobsByCodes.mockRejectedValue(new Error('DB down'));
    mockGetDocumentsByType.mockResolvedValue([
      {
        workday_id: 'cc-wid-2',
        metadata: {
          name: 'Old Name',
          code: 'CC-Other',
          relatedLob: existingRelated,
        },
        created_at: new Date(),
      }
    ] as any);

    await expect(processor({
      data: [{ workdayID: 'cc-wid-2', name: 'New Name', code: 'CC-Other' }]
    })).resolves.not.toThrow();

    expect(mockBulkUpdateDocuments).toHaveBeenCalled();
    const updated = mockBulkUpdateDocuments.mock.calls[0]?.[1] ?? [];
    expect(updated).toHaveLength(1);
    expect(updated[0]?.metadata).toMatchObject({
      name: 'New Name',
      code: 'CC-Other',
      relatedLob: existingRelated,
    });
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
