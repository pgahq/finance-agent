import { syncDataSource, type SyncDataSourceOptions } from '../lib/sync.js';
import type { DatabaseConnection } from '../lib/database.js';

jest.mock('@pga/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn()
}));

jest.mock('../lib/rag.js', () => ({
  createEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3])
}));

const getDocumentsByType = jest.fn();
const bulkInsertDocuments = jest.fn();
const bulkUpdateDocuments = jest.fn();
const bulkDeleteDocuments = jest.fn();

jest.mock('../lib/database.js', () => ({
  getDocumentsByType: (...args: unknown[]) => getDocumentsByType(...args),
  bulkInsertDocuments: (...args: unknown[]) => bulkInsertDocuments(...args),
  bulkUpdateDocuments: (...args: unknown[]) => bulkUpdateDocuments(...args),
  bulkDeleteDocuments: (...args: unknown[]) => bulkDeleteDocuments(...args)
}));

const notifyResult = jest.fn().mockResolvedValue(undefined);

jest.mock('../lib/slack.js', () => ({
  notifyResult: (...args: unknown[]) => notifyResult(...args)
}));

type CostCenterItem = { workdayId: string; name: string; code: string };

const dbConnection = {
  query: jest.fn(),
  close: jest.fn()
} as unknown as DatabaseConnection;

function baseOptions(
  overrides: Partial<SyncDataSourceOptions<CostCenterItem>> = {}
): SyncDataSourceOptions<CostCenterItem> {
  return {
    dbConnection,
    type: 'cost_center',
    items: new Map([
      ['cc-active', { workdayId: 'cc-active', name: 'Active', code: '100' }]
    ]),
    totalCount: 1,
    createContent: (item) => item.name,
    createMetadata: (item) => item,
    notifyLabel: 'cache_cost_centers',
    itemLabel: 'cost centers',
    ...overrides
  };
}

describe('syncDataSource', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    bulkInsertDocuments.mockResolvedValue(undefined);
    bulkUpdateDocuments.mockResolvedValue(undefined);
    bulkDeleteDocuments.mockResolvedValue(1);
    getDocumentsByType.mockResolvedValue([]);
  });

  it('does not delete existing documents unless pruneAbsent is set', async () => {
    getDocumentsByType.mockResolvedValue([
      { workday_id: 'cc-inactive', metadata: {}, created_at: new Date() }
    ]);

    await syncDataSource(baseOptions());

    expect(bulkDeleteDocuments).not.toHaveBeenCalled();
    expect(notifyResult).toHaveBeenCalledWith(
      'cache_cost_centers',
      'success',
      expect.any(Number),
      expect.objectContaining({
        syncStats: expect.not.objectContaining({ deleted: expect.anything() })
      }),
      undefined,
      '1 cost centers'
    );
  });

  it('deletes existing documents whose workdayId is absent from the snapshot', async () => {
    getDocumentsByType.mockResolvedValue([
      { workday_id: 'cc-active', metadata: {}, created_at: new Date() },
      { workday_id: 'cc-inactive', metadata: {}, created_at: new Date() },
      { workday_id: 'cc-gone', metadata: {}, created_at: new Date() }
    ]);

    bulkDeleteDocuments.mockResolvedValue(2);

    await syncDataSource(baseOptions({
      pruneAbsent: true,
      sourceTotal: 1,
      sourceFetchedCount: 1,
    }));

    expect(bulkDeleteDocuments).toHaveBeenCalledWith(
      dbConnection,
      ['cc-inactive', 'cc-gone'],
      'cost_center'
    );
    expect(notifyResult).toHaveBeenCalledWith(
      'cache_cost_centers',
      'success',
      expect.any(Number),
      expect.objectContaining({
        syncStats: expect.objectContaining({
          new: 0,
          updated: 0,
          unchanged: 1,
          deleted: 2,
          absent: 2,
        })
      }),
      undefined,
      '1 cost centers'
    );
  });

  it('does not prune when the incoming snapshot is empty', async () => {
    getDocumentsByType.mockResolvedValue([
      { workday_id: 'cc-inactive', metadata: {}, created_at: new Date() }
    ]);

    await syncDataSource(baseOptions({
      pruneAbsent: true,
      items: new Map(),
      totalCount: 0
    }));

    expect(bulkDeleteDocuments).not.toHaveBeenCalled();
  });

  it('does not prune when sourceTotal is missing', async () => {
    getDocumentsByType.mockResolvedValue([
      { workday_id: 'cc-inactive', metadata: {}, created_at: new Date() }
    ]);

    await syncDataSource(baseOptions({ pruneAbsent: true }));

    expect(bulkDeleteDocuments).not.toHaveBeenCalled();
    expect(notifyResult).toHaveBeenCalledWith(
      'cache_cost_centers',
      'success',
      expect.any(Number),
      expect.objectContaining({
        syncStats: expect.objectContaining({
          deleted: 0,
          pruneSkipped: 'missing source total'
        })
      }),
      undefined,
      '1 cost centers'
    );
  });

  it('does not prune when fetched count does not match sourceTotal', async () => {
    getDocumentsByType.mockResolvedValue([
      { workday_id: 'cc-inactive', metadata: {}, created_at: new Date() }
    ]);

    await syncDataSource(baseOptions({
      pruneAbsent: true,
      sourceTotal: 99,
      sourceFetchedCount: 1,
    }));

    expect(bulkDeleteDocuments).not.toHaveBeenCalled();
    expect(notifyResult).toHaveBeenCalledWith(
      'cache_cost_centers',
      'success',
      expect.any(Number),
      expect.objectContaining({
        syncStats: expect.objectContaining({
          deleted: 0,
          pruneSkipped: 'incomplete snapshot: fetched 1 of 99'
        })
      }),
      undefined,
      '1 cost centers'
    );
  });

  it('does not prune when sourceFetchedCount is missing', async () => {
    getDocumentsByType.mockResolvedValue([
      { workday_id: 'cc-inactive', metadata: {}, created_at: new Date() }
    ]);

    await syncDataSource(baseOptions({
      pruneAbsent: true,
      sourceTotal: 1,
    }));

    expect(bulkDeleteDocuments).not.toHaveBeenCalled();
    expect(notifyResult).toHaveBeenCalledWith(
      'cache_cost_centers',
      'success',
      expect.any(Number),
      expect.objectContaining({
        syncStats: expect.objectContaining({
          deleted: 0,
          pruneSkipped: 'missing fetched count'
        })
      }),
      undefined,
      '1 cost centers'
    );
  });

  it('still prunes when duplicate workday IDs shrink the item Map', async () => {
    getDocumentsByType.mockResolvedValue([
      { workday_id: 'cc-active', metadata: {}, created_at: new Date() },
      { workday_id: 'cc-inactive', metadata: {}, created_at: new Date() }
    ]);
    bulkDeleteDocuments.mockResolvedValue(1);

    await syncDataSource(baseOptions({
      pruneAbsent: true,
      sourceTotal: 2,
      sourceFetchedCount: 2,
    }));

    expect(bulkDeleteDocuments).toHaveBeenCalledWith(
      dbConnection,
      ['cc-inactive'],
      'cost_center'
    );
  });

  it('logs absent IDs without deleting during a dry run', async () => {
    getDocumentsByType.mockResolvedValue([
      { workday_id: 'cc-active', metadata: {}, created_at: new Date() },
      { workday_id: 'cc-inactive', metadata: {}, created_at: new Date() }
    ]);

    await syncDataSource(baseOptions({
      pruneAbsent: true,
      sourceTotal: 1,
      sourceFetchedCount: 1,
      pruneDryRun: true,
    }));

    expect(bulkDeleteDocuments).not.toHaveBeenCalled();
    expect(notifyResult).toHaveBeenCalledWith(
      'cache_cost_centers',
      'success',
      expect.any(Number),
      expect.objectContaining({
        syncStats: expect.objectContaining({
          deleted: 0,
          absent: 1,
          absentIds: ['cc-inactive'],
          dryRun: true
        })
      }),
      undefined,
      '1 cost centers'
    );
  });
});
