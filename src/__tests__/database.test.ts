import { 
  getDatabaseConfig, 
  getDatabaseConnection,
  insertDocument,
  updateDocument,
  deleteDocument,
  searchDocuments,
  bulkInsertDocuments,
  bulkUpdateDocuments,
  bulkDeleteDocuments
} from '../lib/database.js';

// Mock AWS SDK
const mockSecretsSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn().mockImplementation(() => ({
    send: mockSecretsSend
  })),
  GetSecretValueCommand: jest.fn()
}));

// Mock pg
jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: jest.fn(),
    end: jest.fn(),
    on: jest.fn()
  }))
}));

describe('Database Library', () => {
  let mockPool: any;
  let mockQuery: jest.MockedFunction<any>;

  beforeEach(() => {
    jest.clearAllMocks();
    
    const pgModule = require('pg');
    mockPool = new pgModule.Pool();
    mockQuery = mockPool.query;
    
    // Mock successful secrets retrieval
    mockSecretsSend.mockResolvedValue({
      SecretString: JSON.stringify({
        username: 'testuser',
        password: 'testpass'
      })
    });
  });

  describe('getDatabaseConfig', () => {
    it('should return database configuration from EVAL_DATABASE_URL', async () => {
      const env = {
        EVAL_DATABASE_URL: 'postgresql://evaluser:evalpass@localhost:5433/finance_agent_eval',
      };

      const config = await getDatabaseConfig(env);

      expect(config).toEqual({
        host: 'localhost',
        port: 5433,
        database: 'finance_agent_eval',
        user: 'evaluser',
        password: 'evalpass',
      });
    });

    it('should return database configuration from environment', async () => {
      const env = {
        DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test-secret',
        DATABASE_CLUSTER_ENDPOINT: 'test-cluster.cluster-xyz.us-east-1.rds.amazonaws.com',
        DATABASE_NAME: 'test_db'
      };

      const mockSecretsClient = require('@aws-sdk/client-secrets-manager').SecretsManagerClient;
      const mockSend = mockSecretsClient().send;
      mockSend.mockResolvedValue({
        SecretString: JSON.stringify({
          username: 'testuser',
          password: 'testpass'
        })
      });

      const config = await getDatabaseConfig(env);

      expect(config).toEqual({
        host: 'test-cluster.cluster-xyz.us-east-1.rds.amazonaws.com',
        port: 5432,
        database: 'test_db',
        user: 'postgres',
        password: '{"username":"testuser","password":"testpass"}'
      });
    });

    it('should handle missing environment variables', async () => {
      const env = {};

      await expect(getDatabaseConfig(env)).rejects.toThrow();
    });
  });

  describe('getDatabaseConnection', () => {
    it('should create database connection successfully', async () => {
      const env = {
        DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test-secret',
        DATABASE_CLUSTER_ENDPOINT: 'test-cluster.cluster-xyz.us-east-1.rds.amazonaws.com',
        DATABASE_NAME: 'test_db'
      };

      const mockSecretsClient = require('@aws-sdk/client-secrets-manager').SecretsManagerClient;
      const mockSend = mockSecretsClient().send;
      mockSend.mockResolvedValue({
        SecretString: JSON.stringify({
          username: 'testuser',
          password: 'testpass'
        })
      });

      mockQuery.mockResolvedValue({ rows: [] });

      const connection = await getDatabaseConnection(env);

      expect(connection).toBeDefined();
      expect(connection.query).toBeDefined();
    });
  });

  describe('insertDocument', () => {
    it('should insert document successfully', async () => {
      const mockConnection = { 
        query: mockQuery,
        close: jest.fn()
      };

      mockQuery.mockResolvedValue({ rows: [{ id: 1 }] });

      await insertDocument(
        mockConnection,
        'doc-123',
        'supplier',
        'Test content',
        { name: 'Test Document' },
        [0.1, 0.2, 0.3]
      );

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO documents'),
        ['doc-123', 'supplier', 'Test content', '{"name":"Test Document"}', [0.1, 0.2, 0.3]]
      );
    });

    it('should handle insert errors', async () => {
      const mockConnection = { 
        query: mockQuery,
        close: jest.fn()
      };

      mockQuery.mockRejectedValue(new Error('Insert failed'));

      await expect(insertDocument(
        mockConnection,
        'doc-123',
        'supplier',
        'Test content',
        { name: 'Test Document' },
        [0.1, 0.2, 0.3]
      )).rejects.toThrow('Insert failed');
    });
  });

  describe('updateDocument', () => {
    it('should update document successfully', async () => {
      const mockConnection = { 
        query: mockQuery,
        close: jest.fn()
      };

      mockQuery.mockResolvedValue({ rows: [{ id: 1 }] });

      await updateDocument(
        mockConnection,
        'doc-123',
        'supplier',
        'Updated content',
        { name: 'Updated Document' },
        [0.1, 0.2, 0.3]
      );

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE documents'),
        ['doc-123', 'supplier', 'Updated content', '{"name":"Updated Document"}', [0.1, 0.2, 0.3]]
      );
    });
  });

  describe('deleteDocument', () => {
    it('should delete document successfully', async () => {
      const mockConnection = { 
        query: mockQuery,
        close: jest.fn()
      };

      mockQuery.mockResolvedValue({ rows: [{ id: 1 }] });

      await deleteDocument(mockConnection, 'doc-123', 'supplier');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM documents'),
        ['doc-123', 'supplier']
      );
    });
  });

  describe('searchDocuments', () => {
    it('should search documents with vector similarity', async () => {
      const mockConnection = { 
        query: mockQuery,
        close: jest.fn()
      };

      const mockResults = [
        {
          workday_id: 'supplier-1',
          type: 'supplier',
          content: 'Test Supplier content',
          metadata: { name: 'Test Supplier' },
          similarity: 0.95
        }
      ];

      mockQuery.mockResolvedValue(mockResults);

      const result = await searchDocuments(
        mockConnection,
        [0.1, 0.2, 0.3],
        'test query',
        'supplier',
        10
      );

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('SELECT'),
        ['supplier', 10, '%test query%']
      );
      expect(result).toEqual(mockResults);
    });

    it('should handle search errors', async () => {
      const mockConnection = { 
        query: mockQuery,
        close: jest.fn()
      };

      mockQuery.mockRejectedValue(new Error('Search failed'));

      await expect(searchDocuments(
        mockConnection,
        [0.1, 0.2, 0.3],
        'test query',
        'supplier',
        10
      )).rejects.toThrow('Search failed');
    });
  });

  describe('bulkInsertDocuments', () => {
    it('should bulk insert documents successfully', async () => {
      const mockConnection = { 
        query: mockQuery,
        close: jest.fn()
      };
      const documents = [
        {
          workdayId: 'doc-1',
          type: 'supplier' as const,
          content: 'Content 1',
          metadata: { name: 'Doc 1' },
          embedding: [0.1, 0.2, 0.3]
        },
        {
          workdayId: 'doc-2',
          type: 'supplier' as const,
          content: 'Content 2',
          metadata: { name: 'Doc 2' },
          embedding: [0.4, 0.5, 0.6]
        }
      ];

      mockQuery.mockResolvedValue({ rows: [{ id: 1 }, { id: 2 }] });

      const result = await bulkInsertDocuments(mockConnection, documents);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO documents'),
        expect.any(Array)
      );
      expect(result).toBeUndefined(); // bulkInsertDocuments doesn't return values
    });
  });

  describe('bulkUpdateDocuments', () => {
    it('should bulk update documents successfully', async () => {
      const mockConnection = { 
        query: mockQuery,
        close: jest.fn()
      };
      const updates = [
        { 
          workdayId: 'doc-1', 
          type: 'supplier' as const,
          content: 'Updated 1',
          metadata: { name: 'Updated Doc 1' },
          embedding: [0.1, 0.2, 0.3]
        },
        { 
          workdayId: 'doc-2', 
          type: 'supplier' as const,
          content: 'Updated 2',
          metadata: { name: 'Updated Doc 2' },
          embedding: [0.4, 0.5, 0.6]
        }
      ];

      mockQuery.mockResolvedValue({ rows: [{ id: 1 }, { id: 2 }] });

      const result = await bulkUpdateDocuments(mockConnection, updates);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE documents'),
        expect.any(Array)
      );
      expect(result).toBeUndefined(); // bulkUpdateDocuments doesn't return values
    });
  });

  describe('bulkDeleteDocuments', () => {
    it('should bulk delete documents successfully', async () => {
      const mockConnection = { 
        query: mockQuery,
        close: jest.fn()
      };
      const workdayIds = ['doc-1', 'doc-2'];
      const type = 'supplier';

      mockQuery.mockResolvedValue({ rows: [{ id: 1 }, { id: 2 }] });

      const result = await bulkDeleteDocuments(mockConnection, workdayIds, type);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM documents'),
        [['doc-1', 'doc-2'], 'supplier']
      );
      expect(result).toBe(0); // bulkDeleteDocuments returns row count
    });
  });
});
