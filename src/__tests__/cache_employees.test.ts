import { parseApAgentWorkerReport } from '../lib/ap_agent_workers_report.js';

jest.mock('@pga/logger', () => ({ debug: jest.fn() }));

describe('cache_employees report parsing', () => {
  it('builds a deduped worker map from report payload', () => {
    const workers = parseApAgentWorkerReport({
      Report_Entry: [
        {
          'Workday ID': 'wid-a',
          'Primary Work - Email': 'a@pgahq.com',
          'Active Status': 'Yes',
        },
        {
          'Workday ID': 'wid-b',
          'Primary Work - Email': 'b@pgahq.com',
          'Active Status': 'Yes',
        },
      ],
    });

    const items = new Map(workers.map((worker) => [worker.workdayId, worker]));
    expect(items.size).toBe(2);
    expect(items.get('wid-a')?.email).toBe('a@pgahq.com');
  });
});
