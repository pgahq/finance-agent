import { AP_AGENT_WORKERS_CUSTOM_REPORT_PATH } from '../lib/ap_agent_workers_report.js';
import { executeWorkdayCustomReport } from '../lib/workday.js';

jest.mock('@pga/logger', () => ({ debug: jest.fn() }));

describe('AP agent workers custom report path', () => {
  it('uses the Worker Assignment For AP Agent integration IDs', () => {
    expect(AP_AGENT_WORKERS_CUSTOM_REPORT_PATH).toBe(
      'wdw-7212/Worker Assignment For AP Agent',
    );
  });
});

describe('executeWorkdayCustomReport', () => {
  const config = {
    domain: 'test.workday.com',
    tenant: 'pgahq',
    clientId: 'client',
    clientSecret: 'secret',
    refreshToken: 'refresh',
  };

  beforeEach(() => {
    (global.fetch as jest.Mock) = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'token' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ Report_Entry: [] }),
      });
  });

  it('requests the custom report JSON endpoint with an encoded path', async () => {
    await executeWorkdayCustomReport(config, AP_AGENT_WORKERS_CUSTOM_REPORT_PATH);

    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      'https://test.workday.com/ccx/service/customreport2/pgahq/wdw-7212/Worker%20Assignment%20For%20AP%20Agent?format=json',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer token',
        }),
      }),
    );
  });
});
