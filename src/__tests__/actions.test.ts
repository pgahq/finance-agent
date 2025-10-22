import { getFunctionArn, isValidAction, getValidActions } from '../lib/actions.js';

// Mock environment variables
const originalEnv = process.env;

describe('Actions', () => {
  beforeEach(() => {
    // Reset environment
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe('getValidActions', () => {
    it('should return all valid action names from environment map', () => {
      process.env.ACTION_FUNCTION_MAP = JSON.stringify({
        'CacheSuppliersAction': 'arn:aws:lambda:us-east-1:123456789012:function:finance-agent-CacheSuppliersAction-ABC123',
        'EnrichInvoiceSupplierAction': 'arn:aws:lambda:us-east-1:123456789012:function:finance-agent-EnrichInvoiceSupplierAction-DEF456'
      });

      const validActions = getValidActions();
      expect(validActions).toContain('CacheSuppliersAction');
      expect(validActions).toContain('EnrichInvoiceSupplierAction');
      expect(validActions).toHaveLength(2);
    });

    it('should return empty array when no environment map is set', () => {
      delete process.env.ACTION_FUNCTION_MAP;
      const validActions = getValidActions();
      expect(validActions).toHaveLength(0);
    });
  });

  describe('isValidAction', () => {
    beforeEach(() => {
      process.env.ACTION_FUNCTION_MAP = JSON.stringify({
        'CacheSuppliersAction': 'arn:aws:lambda:us-east-1:123456789012:function:finance-agent-CacheSuppliersAction-ABC123',
        'EnrichInvoiceSupplierAction': 'arn:aws:lambda:us-east-1:123456789012:function:finance-agent-EnrichInvoiceSupplierAction-DEF456'
      });
    });

    it('should return true for valid actions', () => {
      expect(isValidAction('CacheSuppliersAction')).toBe(true);
      expect(isValidAction('EnrichInvoiceSupplierAction')).toBe(true);
    });

    it('should return false for invalid actions', () => {
      expect(isValidAction('InvalidAction')).toBe(false);
      expect(isValidAction('')).toBe(false);
    });
  });

  describe('getFunctionArn', () => {
    beforeEach(() => {
      process.env.ACTION_FUNCTION_MAP = JSON.stringify({
        'CacheSuppliersAction': 'arn:aws:lambda:us-east-1:123456789012:function:finance-agent-CacheSuppliersAction-ABC123',
        'EnrichInvoiceSupplierAction': 'arn:aws:lambda:us-east-1:123456789012:function:finance-agent-EnrichInvoiceSupplierAction-DEF456'
      });
    });

    it('should return function ARN from environment map', () => {
      expect(getFunctionArn('CacheSuppliersAction')).toBe('arn:aws:lambda:us-east-1:123456789012:function:finance-agent-CacheSuppliersAction-ABC123');
      expect(getFunctionArn('EnrichInvoiceSupplierAction')).toBe('arn:aws:lambda:us-east-1:123456789012:function:finance-agent-EnrichInvoiceSupplierAction-DEF456');
    });

    it('should throw error for invalid action', () => {
      expect(() => {
        getFunctionArn('InvalidAction');
      }).toThrow('Invalid action: InvalidAction. Valid actions: CacheSuppliersAction, EnrichInvoiceSupplierAction');
    });

    it('should throw error when action not found in map', () => {
      process.env.ACTION_FUNCTION_MAP = JSON.stringify({
        'CacheSuppliersAction': 'arn:aws:lambda:us-east-1:123456789012:function:finance-agent-CacheSuppliersAction-ABC123'
      });

      expect(() => {
        getFunctionArn('EnrichInvoiceSupplierAction');
      }).toThrow('Invalid action: EnrichInvoiceSupplierAction. Valid actions: CacheSuppliersAction');
    });

    it('should throw error for invalid JSON', () => {
      process.env.ACTION_FUNCTION_MAP = 'invalid-json';

      expect(() => {
        getFunctionArn('CacheSuppliersAction');
      }).toThrow('Failed to parse ACTION_FUNCTION_MAP:');
    });
  });
});
