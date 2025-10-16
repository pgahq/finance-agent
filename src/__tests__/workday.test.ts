import { getWorkdayConfig } from '../lib/workday.js';

describe('Workday utilities', () => {
  describe('getWorkdayConfig', () => {
    it('should extract configuration from environment variables', () => {
      const mockEnv = {
        WORKDAY_API_URL: 'https://test.workday.com',
        WORKDAY_TENANT: 'test-tenant',
        WORKDAY_USER: 'test-user',
        WORKDAY_PASSWORD: 'test-password',
      };

      const config = getWorkdayConfig(mockEnv);

      expect(config).toEqual({
        apiUrl: 'https://test.workday.com',
        tenant: 'test-tenant',
        user: 'test-user',
        password: 'test-password',
      });
    });

    it('should handle missing environment variables', () => {
      const mockEnv = {};

      expect(() => getWorkdayConfig(mockEnv)).toThrow();
    });
  });
});
