import { processor } from '../cache_employees.js';
import { AP_AGENT_WORKERS_CUSTOM_REPORT_PATH } from '../lib/ap_agent_workers_report.js';
import { syncDataSource } from '../lib/sync.js';
import { executeWorkdayCustomReport } from '../lib/workday.js';

jest.mock('@pga/lambda-env', () => ({
  __esModule: true,
  default: jest.fn().mockResolvedValue({
    S3_BUCKET_NAME: 'test-bucket',
    AWS_REGION: 'us-east-1',
  }),
}));

jest.mock('@pga/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
}));

jest.mock('../lib/rag.js', () => ({
  createEmployeeContent: jest.fn().mockReturnValue('Employee content'),
  createEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
}));

jest.mock('../lib/database.js', () => ({
  getDatabaseConnection: jest.fn().mockResolvedValue({
    query: jest.fn().mockResolvedValue([]),
    close: jest.fn().mockResolvedValue({}),
  }),
  getDocumentsByType: jest.fn().mockResolvedValue([]),
  bulkInsertDocuments: jest.fn().mockResolvedValue({}),
  bulkUpdateDocuments: jest.fn().mockResolvedValue({}),
  bulkDeleteDocuments: jest.fn().mockResolvedValue(0),
}));

jest.mock('../lib/workday.js', () => ({
  getWorkdayConfig: jest.fn().mockReturnValue({
    domain: 'test.workday.com',
    tenant: 'test-tenant',
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    refreshToken: 'test-refresh-token',
  }),
  executeWorkdayCustomReport: jest.fn(),
}));

jest.mock('../lib/slack.js', () => ({
  notifyResult: jest.fn().mockResolvedValue({}),
}));

jest.mock('../lib/sync.js', () => ({
  syncDataSource: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({}),
  })),
  InvokeCommand: jest.fn(),
}));

const mockExecuteWorkdayCustomReport = executeWorkdayCustomReport as jest.MockedFunction<
  typeof executeWorkdayCustomReport
>;
const mockSyncDataSource = syncDataSource as jest.MockedFunction<typeof syncDataSource>;

const activeWorkerRow = {
  'Workday ID': 'wid-a',
  'Primary Work - Email': 'a@pgahq.com',
  'Active Status': 'Yes',
};

describe('cache_employees processor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AWS_STACK_NAME = 'finance-agent';
  });

  it('skips sync when the report has no entries', async () => {
    mockExecuteWorkdayCustomReport.mockResolvedValue({ Report_Entry: [] });

    await processor({});

    expect(mockExecuteWorkdayCustomReport).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'test.workday.com' }),
      AP_AGENT_WORKERS_CUSTOM_REPORT_PATH,
    );
    expect(mockSyncDataSource).not.toHaveBeenCalled();
  });

  it('skips sync without prune when every row is inactive', async () => {
    mockExecuteWorkdayCustomReport.mockResolvedValue({
      Report_Entry: [{ 'Workday ID': 'wid-x', 'Active Status': 'No' }],
    });

    await processor({});

    expect(mockSyncDataSource).not.toHaveBeenCalled();
  });

  it('skips sync when every report row is unparseable', async () => {
    mockExecuteWorkdayCustomReport.mockResolvedValue({
      Report_Entry: [{ 'Active Status': 'Yes' }],
    });

    await processor({});

    expect(mockSyncDataSource).not.toHaveBeenCalled();
  });

  it('syncs parseable rows when the report also has unparseable rows', async () => {
    mockExecuteWorkdayCustomReport.mockResolvedValue({
      Report_Entry: [
        activeWorkerRow,
        { 'Active Status': 'Yes' },
      ],
    });

    await processor({});

    expect(mockSyncDataSource).toHaveBeenCalledTimes(1);
    expect(mockSyncDataSource).toHaveBeenCalledWith(
      expect.objectContaining({ sourceTotal: 1, sourceFetchedCount: 1 }),
    );
  });

  it('syncs employees with pruneAbsent when the report parses', async () => {
    mockExecuteWorkdayCustomReport.mockResolvedValue({
      Report_Entry: [activeWorkerRow, { 'Workday ID': 'wid-b', 'Active Status': 'No' }],
    });

    await processor({});

    expect(mockSyncDataSource).toHaveBeenCalledTimes(1);
    expect(mockSyncDataSource).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'employee',
        pruneAbsent: true,
        sourceTotal: 1,
        sourceFetchedCount: 1,
        notifyLabel: 'cache_employees',
        itemLabel: 'employees',
        items: expect.any(Map),
      }),
    );
    const call = mockSyncDataSource.mock.calls[0][0];
    expect(call.items.get('wid-a')).toMatchObject({
      workdayId: 'wid-a',
      email: 'a@pgahq.com',
    });
  });
});
