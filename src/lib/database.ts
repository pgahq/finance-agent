import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { debug } from '@pga/logger';
import { Pool } from 'pg';

// Database configuration interface
export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export type DocumentType = 'supplier' | 'invoice' | 'company' | 'cost_center' | 'payment_terms';

// Document interface
export interface Document {
  id: string;
  workday_id: string;
  type: DocumentType;
  content: string;
  metadata: Record<string, any>;
  embedding: number[];
  created_at: Date;
}

// Database connection interface
export interface DatabaseConnection {
  query: (sql: string, params?: any[]) => Promise<any[]>;
  close: () => Promise<void>;
}

// Database schema creation
export const CREATE_DOCUMENTS_TABLE = `
  CREATE TABLE IF NOT EXISTS documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workday_id VARCHAR(255) NOT NULL,
    type VARCHAR(20) NOT NULL CHECK (type IN ('supplier', 'invoice', 'company', 'cost_center', 'payment_terms')),
    content TEXT NOT NULL,
    metadata JSONB,
    embedding VECTOR(1536),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`;

// Create indexes for performance
export const CREATE_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(type);`,
  `CREATE INDEX IF NOT EXISTS idx_documents_workday_id ON documents(workday_id);`,
  `CREATE INDEX IF NOT EXISTS idx_documents_embedding ON documents USING ivfflat (embedding vector_cosine_ops);`
];

// Migrations to run on every cold start (idempotent)
export const MIGRATIONS = [
  `ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_type_check`,
  `ALTER TABLE documents ADD CONSTRAINT documents_type_check CHECK (type IN ('supplier', 'invoice', 'company', 'cost_center', 'payment_terms'))`,
];

// Enable pgvector extension
export const ENABLE_PGVECTOR = `CREATE EXTENSION IF NOT EXISTS vector;`;

// Get database configuration from environment and Secrets Manager
export async function getDatabaseConfig(env: NodeJS.ProcessEnv): Promise<DatabaseConfig> {
  const secretArn = env.DATABASE_SECRET_ARN;
  const clusterEndpoint = env.DATABASE_CLUSTER_ENDPOINT;
  const databaseName = env.DATABASE_NAME || 'finance_agent';

  if (!secretArn || !clusterEndpoint) {
    throw new Error('Database configuration not found in environment variables');
  }

  debug('Retrieving database credentials from Secrets Manager');

  try {
    const secretsClient = new SecretsManagerClient({});
    const command = new GetSecretValueCommand({ SecretId: secretArn });
    const response = await secretsClient.send(command);

    if (!response.SecretString) {
      throw new Error('No secret value found in Secrets Manager');
    }

    // CloudFormation GenerateSecretString creates a plain password string
    const password = response.SecretString;

    return {
      host: clusterEndpoint,
      port: 5432,
      database: databaseName,
      user: 'postgres',
      password: password
    };
  } catch (error) {
    debug('Error retrieving database credentials:', error);
    throw new Error(`Failed to retrieve database credentials: ${error}`);
  }
}

// Global connection pool
let pool: Pool | null = null;

// Initialize database connection
export async function getDatabaseConnection(env: NodeJS.ProcessEnv): Promise<DatabaseConnection> {
  if (!pool) {
    debug('Creating new database connection pool');

    const config = await getDatabaseConfig(env);

    pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      max: 10, // Maximum number of connections in the pool
      idleTimeoutMillis: 30000, // Close idle connections after 30 seconds
      connectionTimeoutMillis: 2000, // Return error after 2 seconds if connection could not be established
    });

    debug('Database connection established');
    debug('Initializing database schema...');

    try {
      // Enable pgvector extension
      await pool.query(ENABLE_PGVECTOR);

      // Create documents table
      await pool.query(CREATE_DOCUMENTS_TABLE);

      // Create indexes
      for (const indexSql of CREATE_INDEXES) {
        await pool.query(indexSql);
      }

      // Run migrations
      for (const migrationSql of MIGRATIONS) {
        await pool.query(migrationSql);
      }

    } catch (error) {
      debug('Error initializing database schema:', error);
      throw error;
    }

    // Handle pool errors
    pool.on('error', (err: Error) => {
      debug('Database pool error:', err);
    });
  }

  return {
    query: async (sql: string, params?: any[]) => {
      debug('Executing database query:', sql.substring(0, 100) + '...');

      try {
        const result = await pool!.query(sql, params);
        debug(`Query executed successfully, returned ${result.rows.length} rows`);
        return result.rows;
      } catch (error) {
        debug('Database query error:', error);
        throw error;
      }
    },
    close: async () => {
      if (pool) {
        debug('Closing database connection pool');
        await pool.end();
        pool = null;
      }
    }
  };
}

// Document CRUD operations
export async function insertDocument(
  db: DatabaseConnection,
  workdayId: string,
  type: DocumentType,
  content: string,
  metadata: Record<string, any>,
  embedding: number[]
): Promise<void> {
  try {
    await db.query(`
      INSERT INTO documents (workday_id, type, content, metadata, embedding)
      VALUES ($1, $2, $3, $4, $5)
    `, [workdayId, type, content, JSON.stringify(metadata), embedding]);

    debug(`Document inserted: ${type} - ${workdayId}`);
  } catch (error) {
    debug(`Error inserting document ${type} - ${workdayId}:`, error);
    throw error;
  }
}

export async function updateDocument(
  db: DatabaseConnection,
  workdayId: string,
  type: DocumentType,
  content: string,
  metadata: Record<string, any>,
  embedding: number[]
): Promise<void> {
  try {
    await db.query(`
      UPDATE documents 
      SET content = $3, metadata = $4, embedding = $5, updated_at = CURRENT_TIMESTAMP
      WHERE workday_id = $1 AND type = $2
    `, [workdayId, type, content, JSON.stringify(metadata), embedding]);

    debug(`Document updated: ${type} - ${workdayId}`);
  } catch (error) {
    debug(`Error updating document ${type} - ${workdayId}:`, error);
    throw error;
  }
}

export async function deleteDocument(
  db: DatabaseConnection,
  workdayId: string,
  type: DocumentType
): Promise<void> {
  try {
    await db.query(`
      DELETE FROM documents 
      WHERE workday_id = $1 AND type = $2
    `, [workdayId, type]);

    debug(`Document deleted: ${type} - ${workdayId}`);
  } catch (error) {
    debug(`Error deleting document ${type} - ${workdayId}:`, error);
    throw error;
  }
}

export async function deleteAllDocumentsByType(
  db: DatabaseConnection,
  type: DocumentType
): Promise<number> {
  try {
    const result = await db.query(`
      DELETE FROM documents 
      WHERE type = $1
    `, [type]);

    const deletedCount = result.length || 0;
    debug(`Deleted ${deletedCount} documents of type: ${type}`);
    return deletedCount;
  } catch (error) {
    debug(`Error deleting all documents of type ${type}:`, error);
    throw error;
  }
}

export async function getDocumentsByType(
  db: DatabaseConnection,
  type: DocumentType
): Promise<Array<{ workday_id: string; metadata: any; created_at: Date }>> {
  try {
    const results = await db.query(`
      SELECT workday_id, metadata, created_at
      FROM documents 
      WHERE type = $1
    `, [type]);

    debug(`Found ${results.length} existing ${type} documents`);
    return results;
  } catch (error) {
    debug(`Error getting ${type} documents:`, error);
    throw error;
  }
}

// Bulk operations for better performance
export async function bulkInsertDocuments(
  db: DatabaseConnection,
  documents: Array<{
    workdayId: string;
    type: DocumentType;
    content: string;
    metadata: Record<string, any>;
    embedding: number[];
  }>
): Promise<void> {
  if (documents.length === 0) return;

  try {
    // Build VALUES clause for bulk insert with raw vector formatting
    const values = documents.map((doc, index) => {
      const baseIndex = index * 4;
      const vectorString = `[${doc.embedding.join(',')}]`;
      return `($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, '${vectorString}'::vector)`;
    }).join(', ');

    const params = documents.flatMap(doc => [
      doc.workdayId,
      doc.type,
      doc.content,
      JSON.stringify(doc.metadata)
    ]);

    await db.query(`
      INSERT INTO documents (workday_id, type, content, metadata, embedding)
      VALUES ${values}
    `, params);

    debug(`Bulk inserted ${documents.length} documents`);
  } catch (error) {
    debug(`Error bulk inserting documents:`, error);
    throw error;
  }
}

export async function bulkUpdateDocuments(
  db: DatabaseConnection,
  documents: Array<{
    workdayId: string;
    type: DocumentType;
    content: string;
    metadata: Record<string, any>;
    embedding: number[];
  }>
): Promise<void> {
  if (documents.length === 0) return;

  try {
    // Use a transaction for bulk updates
    await db.query('BEGIN');

    for (const doc of documents) {
      const vectorString = `[${doc.embedding.join(',')}]`;
      await db.query(`
        UPDATE documents 
        SET content = $3, metadata = $4, embedding = '${vectorString}'::vector, updated_at = CURRENT_TIMESTAMP
        WHERE workday_id = $1 AND type = $2
      `, [doc.workdayId, doc.type, doc.content, JSON.stringify(doc.metadata)]);
    }

    await db.query('COMMIT');
    debug(`Bulk updated ${documents.length} documents`);
  } catch (error) {
    await db.query('ROLLBACK');
    debug(`Error bulk updating documents:`, error);
    throw error;
  }
}

export async function bulkDeleteDocuments(
  db: DatabaseConnection,
  workdayIds: string[],
  type: DocumentType
): Promise<number> {
  if (workdayIds.length === 0) return 0;

  try {
    const result = await db.query(`
      DELETE FROM documents 
      WHERE workday_id = ANY($1) AND type = $2
    `, [workdayIds, type]);

    const deletedCount = result.length || 0;
    debug(`Bulk deleted ${deletedCount} documents of type: ${type}`);
    return deletedCount;
  } catch (error) {
    debug(`Error bulk deleting documents:`, error);
    throw error;
  }
}

export async function searchSimilarDocuments(
  db: DatabaseConnection,
  queryEmbedding: number[],
  documentType: DocumentType,
  limit: number = 5
): Promise<any[]> {
  try {
    // Format the embedding as a PostgreSQL vector literal
    const vectorString = `[${queryEmbedding.join(',')}]`;

    const results = await db.query(`
      SELECT 
        id,
        workday_id,
        type,
        content,
        metadata,
        1 - (embedding <=> '${vectorString}'::vector) as similarity
      FROM documents 
      WHERE type = $1
      ORDER BY embedding <=> '${vectorString}'::vector
      LIMIT $2
    `, [documentType, limit]);

    debug(`Found ${results.length} similar ${documentType} documents`);
    return results;
  } catch (error) {
    debug(`Error searching for similar ${documentType} documents:`, error);
    throw error;
  }
}

// Hybrid search that combines semantic similarity with exact text matching
export async function searchDocuments(
  db: DatabaseConnection,
  queryEmbedding: number[],
  queryText: string,
  documentType: DocumentType,
  limit: number = 5
): Promise<any[]> {
  try {
    // Format the embedding as a PostgreSQL vector literal
    const vectorString = `[${queryEmbedding.join(',')}]`;

    // Search combining semantic similarity with text matching
    const results = await db.query(`
      SELECT 
        id,
        workday_id,
        type,
        content,
        metadata,
        -- Boost exact matches significantly
        CASE 
          WHEN LOWER(content) LIKE LOWER($3) THEN 1.0
          ELSE 1 - (embedding <=> '${vectorString}'::vector)
        END as similarity
      FROM documents 
      WHERE type = $1
      ORDER BY similarity DESC
      LIMIT $2
    `, [
      documentType,
      limit,
      `%${queryText.toLowerCase()}%`
    ]);

    debug(`Found ${results.length} hybrid search results for ${documentType}`);
    return results;
  } catch (error) {
    debug(`Error in hybrid search for ${documentType} documents:`, error);
    throw error;
  }
}
