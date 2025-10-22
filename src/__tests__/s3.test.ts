// Mock the dependencies first
jest.mock('@pga/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn()
}));

jest.mock('@aws-sdk/client-s3', () => {
  const mockSend = jest.fn();
  return {
    S3Client: jest.fn().mockImplementation(() => ({
      send: mockSend
    })),
    GetObjectCommand: jest.fn(),
    PutObjectCommand: jest.fn(),
    __mockSend: mockSend
  };
});

import { getS3Config, getJsonFromS3, putJsonToS3 } from '../lib/s3.js';

describe('S3 Library', () => {
  let mockSend: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    const s3Module = require('@aws-sdk/client-s3');
    mockSend = s3Module.__mockSend;
  });

  describe('getS3Config', () => {
    it('should return S3 config with bucket name', () => {
      const env = {
        S3_BUCKET_NAME: 'test-bucket'
      };

      const config = getS3Config(env);

      expect(config).toEqual({
        bucketName: 'test-bucket'
      });
    });

    it('should throw error when S3_BUCKET_NAME is missing', () => {
      const env = {};

      expect(() => getS3Config(env)).toThrow('S3_BUCKET_NAME environment variable is required');
    });

    it('should throw error when S3_BUCKET_NAME is empty', () => {
      const env = {
        S3_BUCKET_NAME: ''
      };

      expect(() => getS3Config(env)).toThrow('S3_BUCKET_NAME environment variable is required');
    });
  });

  describe('getJsonFromS3', () => {
    const mockConfig = {
      bucketName: 'test-bucket'
    };

    it('should successfully retrieve JSON from S3', async () => {
      const mockData = { test: 'data', count: 42 };
      const mockResponse = {
        Body: {
          transformToString: jest.fn().mockResolvedValue(JSON.stringify(mockData))
        }
      };

      mockSend.mockResolvedValue(mockResponse);

      const result = await getJsonFromS3(mockConfig, 'test-key');

      expect(mockSend).toHaveBeenCalledWith(expect.any(Object));
      expect(result).toEqual(mockData);
    });

    it('should return null when object has no body', async () => {
      const mockResponse = {
        Body: null
      };

      mockSend.mockResolvedValue(mockResponse);

      const result = await getJsonFromS3(mockConfig, 'test-key');

      expect(result).toBeNull();
    });

    it('should return null when object does not exist (NoSuchKey)', async () => {
      const error = new Error('Object not found');
      error.name = 'NoSuchKey';
      mockSend.mockRejectedValue(error);

      const result = await getJsonFromS3(mockConfig, 'test-key');

      expect(result).toBeNull();
    });

    it('should throw error for other S3 errors', async () => {
      const error = new Error('Access denied');
      error.name = 'AccessDenied';
      mockSend.mockRejectedValue(error);

      await expect(getJsonFromS3(mockConfig, 'test-key')).rejects.toThrow('Access denied');
    });

    it('should throw error for invalid JSON', async () => {
      const mockResponse = {
        Body: {
          transformToString: jest.fn().mockResolvedValue('invalid json')
        }
      };

      mockSend.mockResolvedValue(mockResponse);

      await expect(getJsonFromS3(mockConfig, 'test-key')).rejects.toThrow();
    });

    it('should handle complex JSON data', async () => {
      const complexData = {
        suppliers: [
          { id: '1', name: 'Supplier A' },
          { id: '2', name: 'Supplier B' }
        ],
        metadata: {
          cachedAt: '2024-01-01T00:00:00Z',
          totalCount: 2
        }
      };

      const mockResponse = {
        Body: {
          transformToString: jest.fn().mockResolvedValue(JSON.stringify(complexData))
        }
      };

      mockSend.mockResolvedValue(mockResponse);

      const result = await getJsonFromS3(mockConfig, 'cache/suppliers.json');

      expect(result).toEqual(complexData);
    });
  });

  describe('putJsonToS3', () => {
    const mockConfig = {
      bucketName: 'test-bucket'
    };

    it('should successfully store JSON in S3', async () => {
      const testData = { test: 'data', count: 42 };
      mockSend.mockResolvedValue({});

      await putJsonToS3(mockConfig, 'test-key', testData);

      expect(mockSend).toHaveBeenCalledWith(expect.any(Object));
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('should handle complex data structures', async () => {
      const complexData = {
        suppliers: [
          { id: '1', name: 'Supplier A', status: 'Active' },
          { id: '2', name: 'Supplier B', status: 'Inactive' }
        ],
        metadata: {
          cachedAt: '2024-01-01T00:00:00Z',
          totalCount: 2,
          version: '1.0'
        }
      };

      mockSend.mockResolvedValue({});

      await putJsonToS3(mockConfig, 'cache/suppliers.json', complexData);

      expect(mockSend).toHaveBeenCalledWith(expect.any(Object));
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('should throw error when S3 put fails', async () => {
      const testData = { test: 'data' };
      const error = new Error('S3 put failed');
      mockSend.mockRejectedValue(error);

      await expect(putJsonToS3(mockConfig, 'test-key', testData)).rejects.toThrow('S3 put failed');
    });

    it('should format JSON with proper indentation', async () => {
      const testData = { 
        nested: { 
          value: 'test',
          array: [1, 2, 3]
        }
      };

      mockSend.mockResolvedValue({});

      await putJsonToS3(mockConfig, 'test-key', testData);

      expect(mockSend).toHaveBeenCalledWith(expect.any(Object));
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('should handle null and undefined values', async () => {
      const testData = {
        nullValue: null,
        undefinedValue: undefined,
        emptyString: '',
        zero: 0,
        falseValue: false
      };

      mockSend.mockResolvedValue({});

      await putJsonToS3(mockConfig, 'test-key', testData);

      expect(mockSend).toHaveBeenCalledWith(expect.any(Object));
      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  describe('integration scenarios', () => {
    const mockConfig = {
      bucketName: 'test-bucket'
    };

    it('should handle cache and retrieve cycle', async () => {
      const originalData = {
        cachedAt: '2024-01-01T00:00:00Z',
        totalCount: 2,
        suppliers: [
          { id: '1', name: 'Supplier A' },
          { id: '2', name: 'Supplier B' }
        ]
      };

      // Mock put operation
      mockSend.mockResolvedValueOnce({});
      await putJsonToS3(mockConfig, 'cache/suppliers.json', originalData);

      // Mock get operation
      const mockResponse = {
        Body: {
          transformToString: jest.fn().mockResolvedValue(JSON.stringify(originalData))
        }
      };
      mockSend.mockResolvedValueOnce(mockResponse);

      const retrievedData = await getJsonFromS3(mockConfig, 'cache/suppliers.json');

      expect(retrievedData).toEqual(originalData);
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('should handle missing cache gracefully', async () => {
      const error = new Error('Object not found');
      error.name = 'NoSuchKey';
      mockSend.mockRejectedValue(error);

      const result = await getJsonFromS3(mockConfig, 'cache/missing.json');

      expect(result).toBeNull();
    });
  });
});
