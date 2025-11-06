import { createEmbedding, createSupplierContent, queryDocuments } from '../lib/rag.js';

// Mock the dependencies
jest.mock('@pga/logger', () => ({
  debug: jest.fn()
}));

jest.mock('../lib/database.js', () => ({
  getDatabaseConnection: jest.fn(),
  searchDocuments: jest.fn()
}));

// Mock fetch for OpenAI API
global.fetch = jest.fn();

describe('rag', () => {
  const mockDebug = require('@pga/logger').debug;
  const mockGetDatabaseConnection = require('../lib/database.js').getDatabaseConnection;
  const mockSearchDocuments = require('../lib/database.js').searchDocuments;
  const mockFetch = global.fetch as jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENAI_API_KEY = 'test-api-key';
  });

  describe('createEmbedding', () => {
    it('should create embedding successfully', async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          data: [{ embedding: [0.1, 0.2, 0.3] }]
        })
      };
      mockFetch.mockResolvedValue(mockResponse as any);

      const result = await createEmbedding('test text');

      expect(mockFetch).toHaveBeenCalledWith('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-api-key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'text-embedding-3-small',
          input: 'test text'
        })
      });
      expect(result).toEqual([0.1, 0.2, 0.3]);
    });

    it('should handle API error', async () => {
      const mockResponse = {
        ok: false,
        status: 400,
        text: jest.fn().mockResolvedValue('Bad Request')
      };
      mockFetch.mockResolvedValue(mockResponse as any);

      await expect(createEmbedding('test text')).rejects.toThrow('OpenAI Embeddings API error: 400 Bad Request');
    });

    it('should use missing key when OPENAI_API_KEY is not set', async () => {
      delete process.env.OPENAI_API_KEY;
      
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          data: [{ embedding: [0.1, 0.2, 0.3] }]
        })
      };
      mockFetch.mockResolvedValue(mockResponse as any);

      await createEmbedding('test text');

      expect(mockFetch).toHaveBeenCalledWith('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer MISSING_KEY',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'text-embedding-3-small',
          input: 'test text'
        })
      });
    });
  });

  describe('createSupplierContent', () => {
    it('should create content with all fields', () => {
      const supplier = {
        supplierName: 'Acme Corp',
        allAlternateNames: ['Acme Corporation', 'ACME Inc'],
        allPhoneNumbers: ['555-123-4567', '555-987-6543'],
        allEmailAddresses: ['contact@acme.com', 'support@acme.com'],
        allAddresses: ['123 Main St, New York, NY 10001'],
        supplierStatus: 'Active'
      };

      const result = createSupplierContent(supplier);

      expect(result).toBe(`Company Name: Acme Corp
Alternate Names: Acme Corporation, ACME Inc
Phone: 555-123-4567, 555-987-6543
Email: contact@acme.com, support@acme.com
Address: 123 Main St, New York, NY 10001
Status: Active`);
    });

    it('should create content with minimal fields', () => {
      const supplier = {
        supplierName: 'Minimal Corp',
        supplierStatus: 'Inactive'
      };

      const result = createSupplierContent(supplier);

      expect(result).toBe(`Company Name: Minimal Corp
Status: Inactive`);
    });

    it('should filter out null/undefined values', () => {
      const supplier = {
        supplierName: 'Test Corp',
        allAlternateNames: null,
        allPhoneNumbers: undefined,
        allEmailAddresses: [],
        allAddresses: null,
        supplierStatus: 'Active'
      };

      const result = createSupplierContent(supplier);

      expect(result).toBe(`Company Name: Test Corp
Status: Active`);
    });

    it('should handle empty arrays', () => {
      const supplier = {
        supplierName: 'Empty Corp',
        allAlternateNames: [],
        allPhoneNumbers: [],
        allEmailAddresses: [],
        allAddresses: [],
        supplierStatus: 'Active'
      };

      const result = createSupplierContent(supplier);

      expect(result).toBe(`Company Name: Empty Corp
Status: Active`);
    });
  });

  describe('queryDocuments', () => {
    const mockDb = {
      close: jest.fn()
    };

    beforeEach(() => {
      mockGetDatabaseConnection.mockResolvedValue(mockDb);
    });

    it('should query documents successfully', async () => {
      const mockSearchResults = [
        {
          workday_id: 'supplier-1',
          type: 'supplier',
          content: 'Test supplier content',
          metadata: { supplierId: 'supp-1' },
          similarity: '0.85'
        },
        {
          workday_id: 'supplier-2',
          type: 'supplier',
          content: 'Another supplier content',
          metadata: { supplierId: 'supp-2' },
          similarity: '0.75'
        }
      ];

      mockSearchDocuments.mockResolvedValue(mockSearchResults);
      
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          data: [{ embedding: [0.1, 0.2, 0.3] }]
        })
      };
      mockFetch.mockResolvedValue(mockResponse as any);

      const result = await queryDocuments({
        query: 'test query',
        documentType: 'supplier',
        limit: 10,
        similarityThreshold: 0.7
      });

      expect(mockSearchDocuments).toHaveBeenCalledWith(
        mockDb,
        [0.1, 0.2, 0.3],
        'test query',
        'supplier',
        10
      );
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        workday_id: 'supplier-1',
        type: 'supplier',
        content: 'Test supplier content',
        metadata: { supplierId: 'supp-1' },
        similarity: 0.85
      });
      expect(mockDb.close).toHaveBeenCalled();
    });

    it('should use default parameters', async () => {
      const mockSearchResults = [
        {
          workday_id: 'supplier-1',
          type: 'supplier',
          content: 'Test supplier content',
          metadata: { supplierId: 'supp-1' },
          similarity: '0.85'
        }
      ];

      mockSearchDocuments.mockResolvedValue(mockSearchResults);
      
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          data: [{ embedding: [0.1, 0.2, 0.3] }]
        })
      };
      mockFetch.mockResolvedValue(mockResponse as any);

      const result = await queryDocuments({
        query: 'test query'
      });

      expect(mockSearchDocuments).toHaveBeenCalledWith(
        mockDb,
        [0.1, 0.2, 0.3],
        'test query',
        'supplier', // default documentType
        100 // default limit
      );
      expect(result).toHaveLength(1);
    });

    it('should filter by similarity threshold', async () => {
      const mockSearchResults = [
        {
          workday_id: 'supplier-1',
          type: 'supplier',
          content: 'High similarity content',
          metadata: { supplierId: 'supp-1' },
          similarity: '0.85'
        },
        {
          workday_id: 'supplier-2',
          type: 'supplier',
          content: 'Low similarity content',
          metadata: { supplierId: 'supp-2' },
          similarity: '0.25'
        }
      ];

      mockSearchDocuments.mockResolvedValue(mockSearchResults);
      
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          data: [{ embedding: [0.1, 0.2, 0.3] }]
        })
      };
      mockFetch.mockResolvedValue(mockResponse as any);

      const result = await queryDocuments({
        query: 'test query',
        similarityThreshold: 0.5
      });

      expect(result).toHaveLength(1);
      expect(result[0].workday_id).toBe('supplier-1');
    });

    it('should handle empty query', async () => {
      await expect(queryDocuments({
        query: ''
      })).rejects.toThrow('Query parameter is required and cannot be empty');

      await expect(queryDocuments({
        query: '   '
      })).rejects.toThrow('Query parameter is required and cannot be empty');
    });

    it('should handle no results', async () => {
      mockSearchDocuments.mockResolvedValue([]);
      
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          data: [{ embedding: [0.1, 0.2, 0.3] }]
        })
      };
      mockFetch.mockResolvedValue(mockResponse as any);

      const result = await queryDocuments({
        query: 'test query'
      });

      expect(result).toHaveLength(0);
      expect(mockDebug).toHaveBeenCalledWith('RAG Query: "test query" - No documents found above similarity threshold');
    });

    it('should handle database error', async () => {
      mockGetDatabaseConnection.mockRejectedValue(new Error('Database connection failed'));

      await expect(queryDocuments({
        query: 'test query'
      })).rejects.toThrow('Database connection failed');
    });

    it('should handle searchDocuments error', async () => {
      mockSearchDocuments.mockRejectedValue(new Error('Search failed'));
      
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          data: [{ embedding: [0.1, 0.2, 0.3] }]
        })
      };
      mockFetch.mockResolvedValue(mockResponse as any);

      await expect(queryDocuments({
        query: 'test query'
      })).rejects.toThrow('Search failed');

      expect(mockDb.close).toHaveBeenCalled();
    });

    it('should close database connection on success', async () => {
      const mockSearchResults = [
        {
          workday_id: 'supplier-1',
          type: 'supplier',
          content: 'Test supplier content',
          metadata: { supplierId: 'supp-1' },
          similarity: '0.85'
        }
      ];

      mockSearchDocuments.mockResolvedValue(mockSearchResults);
      
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          data: [{ embedding: [0.1, 0.2, 0.3] }]
        })
      };
      mockFetch.mockResolvedValue(mockResponse as any);

      await queryDocuments({
        query: 'test query'
      });

      expect(mockDb.close).toHaveBeenCalled();
    });
  });

  // Note: findSuppliersTool tests are complex due to AI SDK integration
  // The tool is tested indirectly through the queryDocuments function above
});