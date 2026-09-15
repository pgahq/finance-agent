import { executeWorkdayCustomReport } from '../lib/workday.js';

jest.mock('@pga/logger', () => ({ debug: jest.fn() }));

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
    await executeWorkdayCustomReport(config, 'owner/Worker_Assignment_For_AP_Agent');

    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      'https://test.workday.com/ccx/service/customreport2/pgahq/owner/Worker_Assignment_For_AP_Agent?format=json',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer token',
        }),
      }),
    );
  });
});
