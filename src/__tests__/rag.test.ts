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
    it('should be defined', () => {
      expect(createEmbedding).toBeDefined();
      expect(typeof createEmbedding).toBe('function');
    });
  });

  describe('queryDocuments', () => {
    it('should be defined', () => {
      expect(queryDocuments).toBeDefined();
      expect(typeof queryDocuments).toBe('function');
    });
  });

  describe('findSuppliersTool', () => {
    it('should be defined and have execute function', () => {
      expect(findSuppliersTool).toBeDefined();
      expect(findSuppliersTool.execute).toBeDefined();
      expect(typeof findSuppliersTool.execute).toBe('function');
    });
  });
});