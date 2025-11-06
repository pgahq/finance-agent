import { handler, QueryRequest } from '../query_documents';

// Mock the dependencies
jest.mock('../lib/rag.js', () => ({
  queryDocuments: jest.fn()
}));

import { queryDocuments } from '../lib/rag.js';

const mockQueryDocuments = queryDocuments as jest.MockedFunction<typeof queryDocuments>;

describe('QueryDocuments', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should query documents successfully', async () => {
    // Mock queryDocuments function
    const mockResults = [
      {
        workday_id: 'SUP001',
        type: 'supplier',
        content: 'Company Name: Test Supplier\nPhone: 555-1234',
        metadata: { source: 'workday' },
        similarity: 0.85
      },
      {
        workday_id: 'SUP002',
        type: 'supplier', 
        content: 'Company Name: Another Supplier\nEmail: test@example.com',
        metadata: { source: 'workday' },
        similarity: 0.78
      }
    ];
    mockQueryDocuments.mockResolvedValue(mockResults);

    // Test query
    const queryRequest: QueryRequest = {
      query: 'test supplier company',
      documentType: 'supplier',
      limit: 5,
      similarityThreshold: 0.7
    };

    const result = await handler(queryRequest);

    // Verify queryDocuments was called with correct parameters
    expect(mockQueryDocuments).toHaveBeenCalledWith(queryRequest);

    // Verify results
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      workday_id: 'SUP001',
      type: 'supplier',
      content: 'Company Name: Test Supplier\nPhone: 555-1234',
      metadata: { source: 'workday' },
      similarity: 0.85
    });
  });

  it('should handle empty query', async () => {
    mockQueryDocuments.mockRejectedValue(new Error('Query parameter is required and cannot be empty'));
    
    const queryRequest: QueryRequest = {
      query: '',
      limit: 5
    };

    await expect(handler(queryRequest)).rejects.toThrow('Query parameter is required and cannot be empty');
  });

  it('should handle database errors', async () => {
    mockQueryDocuments.mockRejectedValue(new Error('Database connection failed'));

    const queryRequest: QueryRequest = {
      query: 'test query',
      limit: 5
    };

    await expect(handler(queryRequest)).rejects.toThrow('Database connection failed');
  });

  it('should query all document types when no type specified', async () => {
    mockQueryDocuments.mockResolvedValue([]);

    const queryRequest: QueryRequest = {
      query: 'test query',
      limit: 10
    };

    await handler(queryRequest);

    // Verify queryDocuments was called with correct parameters
    expect(mockQueryDocuments).toHaveBeenCalledWith(queryRequest);
  });

  it('should return empty results when no matches found', async () => {
    mockQueryDocuments.mockResolvedValue([]);

    const queryRequest: QueryRequest = {
      query: 'no matches query',
      limit: 5
    };

    const result = await handler(queryRequest);

    expect(result).toHaveLength(0);
  });
});
