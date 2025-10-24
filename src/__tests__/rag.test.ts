import { createSupplierContent, createEmbedding, queryDocuments, findSuppliersTool } from '../lib/rag.js';

// Mock fetch globally
global.fetch = jest.fn();

// Mock database module
jest.mock('../lib/database.js', () => ({
  getDatabaseConnection: jest.fn().mockResolvedValue({
    query: jest.fn(),
    close: jest.fn()
  }),
  searchDocuments: jest.fn()
}));

// Mock the rag module to avoid real API calls
jest.mock('../lib/rag.js', () => {
  const originalModule = jest.requireActual('../lib/rag.js');
  return {
    ...originalModule,
    createEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3, 0.4, 0.5])
  };
});

describe('RAG Library', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createSupplierContent', () => {
    it('should create content from supplier data', () => {
      const supplier = {
        supplierName: 'Test Supplier',
        allPhoneNumbers: ['555-1234', '555-5678'],
        allEmailAddresses: ['test@supplier.com', 'contact@supplier.com'],
        allAddresses: ['123 Main St', '456 Oak Ave'],
        supplierStatus: 'Active'
      };

      const result = createSupplierContent(supplier);

      expect(result).toContain('Company Name: Test Supplier');
      expect(result).toContain('Phone: 555-1234, 555-5678');
      expect(result).toContain('Email: test@supplier.com, contact@supplier.com');
      expect(result).toContain('Address: 123 Main St, 456 Oak Ave');
      expect(result).toContain('Status: Active');
    });

    it('should handle missing optional fields', () => {
      const supplier = {
        supplierName: 'Minimal Supplier'
      };

      const result = createSupplierContent(supplier);

      expect(result).toContain('Company Name: Minimal Supplier');
      expect(result).not.toContain('Phone:');
      expect(result).not.toContain('Email:');
      expect(result).not.toContain('Address:');
      expect(result).toContain('Status: undefined');
    });

    it('should handle empty arrays', () => {
      const supplier = {
        supplierName: 'Empty Supplier',
        allPhoneNumbers: [],
        allEmailAddresses: [],
        allAddresses: []
      };

      const result = createSupplierContent(supplier);

      expect(result).toContain('Company Name: Empty Supplier');
      expect(result).not.toContain('Phone:');
      expect(result).not.toContain('Email:');
      expect(result).not.toContain('Address:');
    });
  });

  describe('createEmbedding', () => {
    it('should create embedding successfully', async () => {
      const mockResponse = {
        data: [{ embedding: [0.1, 0.2, 0.3, 0.4, 0.5] }]
      };
      
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue(mockResponse)
      });

      const result = await createEmbedding('test text');

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/embeddings',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': expect.stringContaining('Bearer'),
            'Content-Type': 'application/json'
          }),
          body: expect.stringContaining('text-embedding-3-small')
        })
      );
      expect(result).toEqual([0.1, 0.2, 0.3, 0.4, 0.5]);
    });

    it('should handle API errors', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: jest.fn().mockResolvedValue('Unauthorized')
      });

      await expect(createEmbedding('test text')).rejects.toThrow('OpenAI Embeddings API error: 401 Unauthorized');
    });

    it('should handle missing API key', async () => {
      const originalEnv = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      const mockResponse = {
        data: [{ embedding: [0.1, 0.2, 0.3, 0.4, 0.5] }]
      };
      
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue(mockResponse)
      });

      await createEmbedding('test text');

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/embeddings',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Bearer MISSING_KEY'
          })
        })
      );

      process.env.OPENAI_API_KEY = originalEnv;
    });
  });

  describe('queryDocuments', () => {
    it('should query documents successfully', async () => {
      const mockResults = [
        { workday_id: 'doc-1', type: 'supplier', content: 'Test content', metadata: {}, similarity: '0.8' }
      ];

      const { getDatabaseConnection, searchDocuments } = require('../lib/database.js');
      const mockDb = { query: jest.fn(), close: jest.fn() };
      getDatabaseConnection.mockResolvedValue(mockDb);
      searchDocuments.mockResolvedValue(mockResults);


      const result = await queryDocuments({
        query: 'test query',
        documentType: 'supplier',
        limit: 10,
        similarityThreshold: 0.5
      });

      expect(getDatabaseConnection).toHaveBeenCalledWith(process.env);
      expect(searchDocuments).toHaveBeenCalledWith(
        mockDb,
        [0.1, 0.2, 0.3],
        'test query',
        'supplier',
        10
      );
      expect(mockDb.close).toHaveBeenCalled();
      expect(result).toEqual([{
        workday_id: 'doc-1',
        type: 'supplier',
        content: 'Test content',
        metadata: {},
        similarity: 0.8
      }]);
    });

    it('should handle empty query', async () => {
      await expect(queryDocuments({ query: '' })).rejects.toThrow('Query parameter is required and cannot be empty');
    });

    it('should handle whitespace-only query', async () => {
      await expect(queryDocuments({ query: '   ' })).rejects.toThrow('Query parameter is required and cannot be empty');
    });

    it('should use default parameters', async () => {
      const mockResults: any[] = [];
      const { getDatabaseConnection, searchDocuments } = require('../lib/database.js');
      const mockDb = { query: jest.fn(), close: jest.fn() };
      getDatabaseConnection.mockResolvedValue(mockDb);
      searchDocuments.mockResolvedValue(mockResults);


      await queryDocuments({ query: 'test' });

      expect(searchDocuments).toHaveBeenCalledWith(
        mockDb,
        [0.1, 0.2, 0.3],
        'test',
        'supplier', // default documentType
        100 // default limit
      );
    });

    it('should filter by similarity threshold', async () => {
      const mockResults = [
        { workday_id: 'doc-1', type: 'supplier', content: 'Test content 1', metadata: {}, similarity: '0.8' },
        { workday_id: 'doc-2', type: 'supplier', content: 'Test content 2', metadata: {}, similarity: '0.2' }
      ];

      const { getDatabaseConnection, searchDocuments } = require('../lib/database.js');
      const mockDb = { query: jest.fn(), close: jest.fn() };
      getDatabaseConnection.mockResolvedValue(mockDb);
      searchDocuments.mockResolvedValue(mockResults);


      const result = await queryDocuments({
        query: 'test',
        similarityThreshold: 0.5
      });

      expect(result).toHaveLength(1);
      expect(result[0].workday_id).toBe('doc-1');
    });

    it('should handle database errors', async () => {
      const { getDatabaseConnection } = require('../lib/database.js');
      getDatabaseConnection.mockRejectedValue(new Error('Database connection failed'));


      await expect(queryDocuments({ query: 'test' })).rejects.toThrow('Database connection failed');
    });
  });

  describe('findSuppliersTool', () => {
    it('should execute successfully', async () => {
      const mockResults = [
        { workday_id: 'supplier-1', type: 'supplier', content: 'Test Supplier', metadata: {}, similarity: 0.8 }
      ];

      const { queryDocuments } = require('../lib/rag.js');
      queryDocuments.mockResolvedValue(mockResults);

      const result = await findSuppliersTool.execute!({
        query: 'test supplier',
        limit: 10,
        similarityThreshold: 0.5
      }, { toolCallId: 'test-call', messages: [] });

      expect(result).toEqual({
        success: true,
        results: [{
          workdayId: 'supplier-1',
          type: 'supplier',
          content: 'Test Supplier',
          metadata: {},
          similarity: 0.8
        }]
      });
    });

    it('should handle errors gracefully', async () => {
      const { queryDocuments } = require('../lib/rag.js');
      queryDocuments.mockRejectedValue(new Error('Database error'));

      const result = await findSuppliersTool.execute!({
        query: 'test supplier'
      }, { toolCallId: 'test-call', messages: [] });

      expect(result).toEqual({
        success: false,
        error: 'Database error'
      });
    });

    it('should handle unknown errors', async () => {
      const { queryDocuments } = require('../lib/rag.js');
      queryDocuments.mockRejectedValue('Unknown error');

      const result = await findSuppliersTool.execute!({
        query: 'test supplier'
      }, { toolCallId: 'test-call', messages: [] });

      expect(result).toEqual({
        success: false,
        error: 'Unknown error occurred'
      });
    });
  });
});
