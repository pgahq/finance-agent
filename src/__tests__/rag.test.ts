import { createEmbedding, createSupplierContent, createCompanyContent, queryDocuments } from '../lib/rag.js';

// Mock the dependencies
jest.mock('@pga/logger', () => ({
  debug: jest.fn()
}));

jest.mock('../lib/database.js', () => ({
  getDatabaseConnection: jest.fn(),
  searchDocuments: jest.fn(),
  getDocumentsByType: jest.fn().mockResolvedValue([])
}));

// Mock fetch for OpenAI API
global.fetch = jest.fn();

describe('rag', () => {
  const mockDebug = require('@pga/logger').debug;
  const mockGetDatabaseConnection = require('../lib/database.js').getDatabaseConnection;
  const mockSearchDocuments = require('../lib/database.js').searchDocuments;
  const mockGetDocumentsByType = require('../lib/database.js').getDocumentsByType;
  const mockFetch = global.fetch as jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetDocumentsByType.mockResolvedValue([]);
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

  describe('createCompanyContent', () => {
    it('includes Company Reference ID when companyReferenceId is set', () => {
      const result = createCompanyContent({
        companyName: 'PGA of America',
        companyReferenceId: '912',
        addressPrimary: '100 PGA Tour Blvd',
      });

      expect(result).toContain('Company Name: PGA of America');
      expect(result).toContain('Company Reference ID: 912');
      expect(result).toContain('Primary Address: 100 PGA Tour Blvd');
    });

    it('omits Company Reference ID when companyReferenceId is absent', () => {
      const result = createCompanyContent({
        companyName: 'PGA of America',
        addressPrimary: '100 PGA Tour Blvd',
      });

      expect(result).toBe(`Company Name: PGA of America
Primary Address: 100 PGA Tour Blvd`);
    });

    it('uses a Workday instance descriptor for primary address', () => {
      const result = createCompanyContent({
        companyName: 'PGA of America',
        addressPrimary: {
          id: 'addr-1',
          descriptor: '100 Avenue of the Champions, Palm Beach Gardens, FL 33418',
        },
      });

      expect(result).toContain('Primary Address: 100 Avenue of the Champions, Palm Beach Gardens, FL 33418');
      expect(result).not.toContain('[object Object]');
    });

    it('omits primary address when it is missing', () => {
      expect(createCompanyContent({ companyName: 'PGA of America' })).toBe('Company Name: PGA of America');
    });

    it('uses Workday instance descriptors for public addresses', () => {
      const result = createCompanyContent({
        companyName: 'PGA of America',
        publicAddresses: [
          { id: 'pub-1', descriptor: 'PO Box 109601, Palm Beach Gardens, FL 33410' },
        ],
      });

      expect(result).toContain('Public Addresses: PO Box 109601, Palm Beach Gardens, FL 33410');
      expect(result).not.toContain('[object Object]');
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
      expect(mockDb.close).not.toHaveBeenCalled();
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

    it('ranks non-DNU cost centers above zDNU when both match Legal', async () => {
      const mockSearchResults = [
        {
          workday_id: 'dnu-wid',
          type: 'cost_center',
          content: 'Cost Center Name: zDNU-CC6015 Legal Dept',
          metadata: { code: 'zDNU-CC6015', name: 'zDNU-CC6015 Legal Dept' },
          similarity: '1'
        },
        {
          workday_id: 'active-wid',
          type: 'cost_center',
          content: 'Cost Center Name: CC-Legal Dept',
          metadata: { code: 'CC-Legal Dept', name: 'CC-Legal Dept' },
          similarity: '1'
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
        query: 'Legal',
        documentType: 'cost_center',
        similarityThreshold: 0.3
      });

      expect(result[0]?.workday_id).toBe('active-wid');
      expect(result[0]?.similarity).toBe(1);
      expect(result[1]?.similarity).toBe(0.88);
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

      expect(mockDb.close).not.toHaveBeenCalled();
    });

    it('should keep the shared database pool open after success', async () => {
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

      expect(mockDb.close).not.toHaveBeenCalled();
    });
  });

  // Note: findSuppliersTool tests are complex due to AI SDK integration
  // The tool is tested indirectly through the queryDocuments function above

  describe('RAG tools', () => {
    const { findSuppliersTool, findCompaniesTool, findCostCentersTool, findPaymentTermsTool } = require('../lib/rag.js');

    beforeEach(() => {
      mockGetDatabaseConnection.mockRejectedValue(new Error('Database connection failed'));
    });

    it.each([
      ['findSuppliersTool', findSuppliersTool],
      ['findCompaniesTool', findCompaniesTool],
      ['findCostCentersTool', findCostCentersTool],
      ['findPaymentTermsTool', findPaymentTermsTool],
    ])('%s propagates query failures instead of returning success: false', async (_name, ragTool) => {
      await expect(ragTool.execute({ query: 'Acme Corp' })).rejects.toThrow('Database connection failed');
    });

    it('omits a concatenated bill-to address from the company embedding query', async () => {
      mockGetDatabaseConnection.mockResolvedValue({ close: jest.fn() });
      mockSearchDocuments.mockResolvedValue([]);
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] })
      } as any);

      await findCompaniesTool.execute({
        query: 'PGA JR. LEAGUE 100 Avenue of the Stars Palm Beach Gardens FL 33418'
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/embeddings',
        expect.objectContaining({
          body: JSON.stringify({
            model: 'text-embedding-3-small',
            input: 'PGA JR. LEAGUE'
          })
        })
      );
    });

    it('skips company search when the query is only an address', async () => {
      await expect(findCompaniesTool.execute({
        query: '100 Avenue of the Stars Palm Beach Gardens FL 33418'
      })).resolves.toEqual({
        success: true,
        results: [],
        addressMatch: 'none',
        message: 'Query was only a street address. Search again with the billed company name or Company_Reference_ID.'
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('skips company search when a house number is the only remainder', async () => {
      await expect(findCompaniesTool.execute({
        query: '100 Palm Beach Gardens FL 33418'
      })).resolves.toEqual({
        success: true,
        results: [],
        addressMatch: 'none',
        message: 'Query was only a street address. Search again with the billed company name or Company_Reference_ID.'
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('tags a unique bill-to street without reordering name results', async () => {
      mockGetDatabaseConnection.mockResolvedValue({ close: jest.fn() });
      mockSearchDocuments.mockResolvedValue([
        {
          workday_id: 'wisconsin-wid',
          type: 'company',
          content: 'Company Name: Wisconsin Section of the PGA of America, Inc.',
          metadata: {
            companyName: 'Wisconsin Section of the PGA of America, Inc.',
            addressPrimary: '11370 N. Cedarburg Road, Mequon, WI 53092',
          },
          similarity: 1,
        },
        {
          workday_id: 'pga-wid',
          type: 'company',
          content: 'Company Name: The Professional Golfers Association of America',
          metadata: {
            companyName: 'The Professional Golfers Association of America',
            addressPrimary: '100 Avenue of the Champions, Palm Beach Gardens, FL 33418',
          },
          similarity: 0.65,
        },
      ]);
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] })
      } as any);

      const result = await findCompaniesTool.execute({
        query: 'PGA of America',
        address: '100 Avenue of the Champions, Palm Beach Gardens, FL 33418-3653',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/embeddings',
        expect.objectContaining({
          body: JSON.stringify({
            model: 'text-embedding-3-small',
            input: 'PGA of America'
          })
        })
      );
      expect(result.addressMatch).toBe('unique');
      expect(result.results.map((row: { workdayId: string }) => row.workdayId)).toEqual([
        'wisconsin-wid',
        'pga-wid',
      ]);
      expect(result.results[0].similarity).toBe(1);
      expect(result.results[0].addressMatch).toBe('none');
      expect(result.results[1].addressMatch).toBe('unique');
    });

    it('appends a unique cached street when name search only returned sections', async () => {
      mockGetDatabaseConnection.mockResolvedValue({ close: jest.fn() });
      mockGetDocumentsByType.mockResolvedValueOnce([
        {
          workday_id: 'georgia-wid',
          content: 'Company Name: Georgia Section PGA of America, Inc.',
          metadata: {
            companyName: 'Georgia Section PGA of America, Inc.',
            addressPrimary: '123 Main Street, Atlanta, GA 30301',
          },
          created_at: new Date('2026-01-01T00:00:00Z'),
        },
        {
          workday_id: 'pga-wid',
          content: 'Company Name: The Professional Golfers Association of America',
          metadata: {
            companyName: 'The Professional Golfers Association of America',
            companyReferenceId: '310',
            addressPrimary: '1916 PGA Parkway, Frisco, TX 75033',
          },
          created_at: new Date('2026-01-01T00:00:00Z'),
        },
      ]);
      mockSearchDocuments.mockResolvedValue([
        {
          workday_id: 'georgia-wid',
          type: 'company',
          content: 'Company Name: Georgia Section PGA of America, Inc.',
          metadata: {
            companyName: 'Georgia Section PGA of America, Inc.',
            addressPrimary: '123 Main Street, Atlanta, GA 30301',
          },
          similarity: 1,
        },
      ]);
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] })
      } as any);

      const result = await findCompaniesTool.execute({
        query: 'PGA of America',
        address: '1916 PGA Parkway, Frisco, TX 75033',
      });

      expect(result.addressMatch).toBe('unique');
      expect(result.results.map((row: { workdayId: string }) => row.workdayId)).toEqual([
        'georgia-wid',
        'pga-wid',
      ]);
      expect(result.results[0].addressMatch).toBe('none');
      expect(result.results[1].addressMatch).toBe('unique');
      expect(result.results[1].similarity).toBeUndefined();
    });

    it('still returns name hits when the company cache list fails', async () => {
      mockGetDatabaseConnection.mockResolvedValue({ close: jest.fn() });
      mockGetDocumentsByType.mockRejectedValueOnce(new Error('cache list failed'));
      mockSearchDocuments.mockResolvedValue([
        {
          workday_id: 'georgia-wid',
          type: 'company',
          content: 'Company Name: Georgia Section PGA of America, Inc.',
          metadata: {
            companyName: 'Georgia Section PGA of America, Inc.',
            addressPrimary: '123 Main Street, Atlanta, GA 30301',
          },
          similarity: 1,
        },
      ]);
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] })
      } as any);

      const result = await findCompaniesTool.execute({
        query: 'PGA of America',
        address: '1916 PGA Parkway, Frisco, TX 75033',
      });

      expect(result.success).toBe(true);
      expect(result.results.map((row: { workdayId: string }) => row.workdayId)).toEqual(['georgia-wid']);
    });

    it('recovers a concatenated bill-to remainder for tagging', async () => {
      mockGetDatabaseConnection.mockResolvedValue({ close: jest.fn() });
      mockSearchDocuments.mockResolvedValue([
        {
          workday_id: 'wisconsin-wid',
          type: 'company',
          content: 'Company Name: Wisconsin Section of the PGA of America, Inc.',
          metadata: {
            addressPrimary: '11370 N. Cedarburg Road, Mequon, WI 53092',
          },
          similarity: 1,
        },
        {
          workday_id: 'pga-wid',
          type: 'company',
          content: 'Company Name: The Professional Golfers Association of America',
          metadata: {
            addressPrimary: '100 Avenue of the Champions, Palm Beach Gardens, FL 33418',
          },
          similarity: 0.65,
        },
      ]);
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] })
      } as any);

      const result = await findCompaniesTool.execute({
        query: 'PGA of America 100 Avenue of the Champions Palm Beach Gardens FL 33418-3653',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/embeddings',
        expect.objectContaining({
          body: JSON.stringify({
            model: 'text-embedding-3-small',
            input: 'PGA of America'
          })
        })
      );
      expect(result.addressMatch).toBe('unique');
      expect(result.results.map((row: { workdayId: string }) => row.workdayId)).toEqual([
        'wisconsin-wid',
        'pga-wid',
      ]);
      expect(result.results[1].workdayId).toBe('pga-wid');
      expect(result.results[1].addressMatch).toBe('unique');
    });

    it('tags shared headquarters without moving them ahead of other name hits', async () => {
      mockGetDatabaseConnection.mockResolvedValue({ close: jest.fn() });
      mockSearchDocuments.mockResolvedValue([
        {
          workday_id: 'wisconsin-wid',
          type: 'company',
          content: 'Company Name: Wisconsin Section of the PGA of America, Inc.',
          metadata: {
            addressPrimary: '11370 N. Cedarburg Road, Mequon, WI 53092',
          },
          similarity: 1,
        },
        {
          workday_id: 'jr-wid',
          type: 'company',
          content: 'Company Name: PGA JR. LEAGUE',
          metadata: {
            addressPrimary: '100 Avenue of the Champions, Palm Beach Gardens, FL 33418',
          },
          similarity: 0.7,
        },
        {
          workday_id: 'pga-wid',
          type: 'company',
          content: 'Company Name: The Professional Golfers Association of America',
          metadata: {
            addressPrimary: '100 Avenue of the Champions, Palm Beach Gardens, FL 33418',
          },
          similarity: 0.65,
        },
      ]);
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] })
      } as any);

      const result = await findCompaniesTool.execute({
        query: 'PGA of America',
        address: '100 Avenue of the Champions, Palm Beach Gardens, FL 33418-3653',
      });

      expect(result.addressMatch).toBe('shared');
      expect(result.results.map((row: { workdayId: string }) => row.workdayId)).toEqual([
        'wisconsin-wid',
        'jr-wid',
        'pga-wid',
      ]);
      expect(result.results.map((row: { addressMatch: string }) => row.addressMatch)).toEqual([
        'none',
        'shared',
        'shared',
      ]);
    });
  });
});