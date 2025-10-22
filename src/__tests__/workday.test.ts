import { getWorkdayConfig, executeWorkdayQuery, getAttachmentContent } from '../lib/workday.js';

// Mock the dependencies
jest.mock('@pga/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn()
}));

// Mock fetch globally
global.fetch = jest.fn();

describe('Workday utilities', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getWorkdayConfig', () => {
    it('should extract configuration from environment variables', () => {
      const mockEnv = {
        WORKDAY_DOMAIN: 'test.workday.com',
        WORKDAY_TENANT: 'test-tenant',
        WORKDAY_CLIENT_ID: 'test-client-id',
        WORKDAY_CLIENT_SECRET: 'test-client-secret',
        WORKDAY_REFRESH_TOKEN: 'test-refresh-token',
      };

      const config = getWorkdayConfig(mockEnv);

      expect(config).toEqual({
        domain: 'test.workday.com',
        tenant: 'test-tenant',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        refreshToken: 'test-refresh-token',
      });
    });

    it('should handle missing environment variables', () => {
      const mockEnv = {};

      const config = getWorkdayConfig(mockEnv);
      expect(config.domain).toBeUndefined();
      expect(config.tenant).toBeUndefined();
      expect(config.clientId).toBeUndefined();
      expect(config.clientSecret).toBeUndefined();
      expect(config.refreshToken).toBeUndefined();
    });
  });

  describe('executeWorkdayQuery', () => {
    const mockConfig = {
      domain: 'test.workday.com',
      tenant: 'test-tenant',
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      refreshToken: 'test-refresh-token'
    };

    it('should execute WQL query successfully', async () => {
      const mockQuery = 'SELECT id, name FROM suppliers';
      const mockTokenResponse = { access_token: 'mock-access-token' };
      const mockQueryResponse = {
        data: [
          { id: '1', name: 'Supplier A' },
          { id: '2', name: 'Supplier B' }
        ]
      };

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValue(mockTokenResponse)
        })
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValue(mockQueryResponse)
        });

      const result = await executeWorkdayQuery(mockConfig, mockQuery);

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(result).toEqual(mockQueryResponse);
    });

    it('should handle query response with new format', async () => {
      const mockQuery = 'SELECT workdayID, invoiceNumber FROM supplierInvoices';
      const mockTokenResponse = { access_token: 'mock-access-token' };
      const mockQueryResponse = {
        total: 2,
        data: [
          { workdayID: '123', invoiceNumber: 'INV-001' },
          { workdayID: '456', invoiceNumber: 'INV-002' }
        ]
      };

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValue(mockTokenResponse)
        })
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValue(mockQueryResponse)
        });

      const result = await executeWorkdayQuery(mockConfig, mockQuery);

      expect(result).toEqual(mockQueryResponse);
    });

    it('should handle empty query response', async () => {
      const mockQuery = 'SELECT id FROM emptyTable';
      const mockTokenResponse = { access_token: 'mock-access-token' };
      const mockQueryResponse = { total: 0, data: [] };

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValue(mockTokenResponse)
        })
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValue(mockQueryResponse)
        });

      const result = await executeWorkdayQuery(mockConfig, mockQuery);

      expect(result).toEqual({ total: 0, data: [] });
    });

    it('should handle query response without data property', async () => {
      const mockQuery = 'SELECT id FROM suppliers';
      const mockTokenResponse = { access_token: 'mock-access-token' };
      const mockQueryResponse = { total: 0, data: [] };

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValue(mockTokenResponse)
        })
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValue(mockQueryResponse)
        });

      const result = await executeWorkdayQuery(mockConfig, mockQuery);

      expect(result).toEqual({ total: 0, data: [] });
    });

    it('should throw error when token request fails', async () => {
      const mockQuery = 'SELECT id FROM suppliers';

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: jest.fn().mockResolvedValue('Invalid credentials')
      });

      await expect(executeWorkdayQuery(mockConfig, mockQuery))
        .rejects.toThrow('Failed to get access token: 401 Unauthorized - Invalid credentials');
    });

    it('should throw error when token response has no access_token', async () => {
      const mockQuery = 'SELECT id FROM suppliers';
      const mockTokenResponse = { error: 'invalid_grant' };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue(mockTokenResponse)
      });

      await expect(executeWorkdayQuery(mockConfig, mockQuery))
        .rejects.toThrow('Unable to generate bearer token!');
    });

    it('should throw error when query request fails', async () => {
      const mockQuery = 'SELECT id FROM suppliers';
      const mockTokenResponse = { access_token: 'mock-access-token' };

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValue(mockTokenResponse)
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          text: jest.fn().mockResolvedValue('Invalid query syntax')
        });

      await expect(executeWorkdayQuery(mockConfig, mockQuery))
        .rejects.toThrow('Workday API error: 400 Bad Request - Invalid query syntax');
    });

    it('should construct correct URLs for token and query requests', async () => {
      const mockQuery = 'SELECT id FROM suppliers';
      const mockTokenResponse = { access_token: 'mock-access-token' };
      const mockQueryResponse = { data: [] };

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValue(mockTokenResponse)
        })
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValue(mockQueryResponse)
        });

      await executeWorkdayQuery(mockConfig, mockQuery);

      // Check token request
      expect(global.fetch).toHaveBeenNthCalledWith(1, 
        'https://test.workday.com/ccx/oauth2/test-tenant/token',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': expect.stringContaining('Basic ')
          }),
          body: expect.any(URLSearchParams)
        })
      );

      // Check query request
      expect(global.fetch).toHaveBeenNthCalledWith(2, 
        expect.stringContaining('https://test.workday.com/api/wql/v1/test-tenant/data?query='),
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Authorization': 'Bearer mock-access-token',
            'Accept': 'application/json'
          })
        })
      );
    });
  });

  describe('getAttachmentContent', () => {
    const mockConfig = {
      domain: 'test.workday.com',
      tenant: 'test-tenant',
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      refreshToken: 'test-refresh-token'
    };

    it('should return empty array for null attachments', async () => {
      const result = await getAttachmentContent(mockConfig, null as any);
      expect(result).toEqual([]);
    });

    it('should return empty array for empty attachments', async () => {
      const result = await getAttachmentContent(mockConfig, []);
      expect(result).toEqual([]);
    });

    it('should process attachment metadata', async () => {
      const attachments = [
        {
          id: 'att-1',
          fileName: 'invoice.pdf',
          contentType: 'application/pdf'
        },
        {
          id: 'att-2',
          fileName: 'receipt.jpg',
          contentType: 'image/jpeg'
        }
      ];

      const result = await getAttachmentContent(mockConfig, attachments);

      expect(result).toEqual([
        {
          id: 'att-1',
          fileName: 'invoice.pdf',
          contentType: 'application/pdf'
        },
        {
          id: 'att-2',
          fileName: 'receipt.jpg',
          contentType: 'image/jpeg'
        }
      ]);
    });

    it('should handle attachments with missing properties', async () => {
      const attachments = [
        {
          id: 'att-1'
          // Missing fileName and contentType
        },
        {
          id: 'att-2',
          fileName: 'document.pdf'
          // Missing contentType
        }
      ];

      const result = await getAttachmentContent(mockConfig, attachments);

      expect(result).toEqual([
        {
          id: 'att-1',
          fileName: undefined,
          contentType: undefined
        },
        {
          id: 'att-2',
          fileName: 'document.pdf',
          contentType: undefined
        }
      ]);
    });

    it('should handle large number of attachments', async () => {
      const attachments = Array.from({ length: 100 }, (_, i) => ({
        id: `att-${i}`,
        fileName: `document-${i}.pdf`,
        contentType: 'application/pdf'
      }));

      const result = await getAttachmentContent(mockConfig, attachments);

      expect(result).toHaveLength(100);
      expect(result[0]).toEqual({
        id: 'att-0',
        fileName: 'document-0.pdf',
        contentType: 'application/pdf'
      });
      expect(result[99]).toEqual({
        id: 'att-99',
        fileName: 'document-99.pdf',
        contentType: 'application/pdf'
      });
    });
  });
});
