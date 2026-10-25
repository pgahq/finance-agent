import { Pool } from 'pg';
import { getDatabaseConfig, type DatabaseConnection } from '../lib/database.js';

const READ_ONLY_STATEMENT = /^\s*(select|with|show|explain)\b/i;

/** Rejects anything that is not a SELECT/WITH/SHOW/EXPLAIN before it reaches the driver. */
export function assertReadOnlySql(sql: string): void {
  const refuse = () => new Error(`Eval database access is read-only; refused: ${sql.trim().slice(0, 60)}`);
  const withoutLiterals = sql.replace(/'(?:[^']|'')*'/g, "''");
  if (!READ_ONLY_STATEMENT.test(sql)) throw refuse();
  if (/;\s*\S/.test(withoutLiterals)) throw refuse();
  // A data-modifying CTE starts with WITH but writes.
  if (/\b(insert|update|delete|truncate|drop|alter|create|grant|revoke)\b/i.test(withoutLiterals)) throw refuse();
}

export interface ReadOnlyDatabaseOptions {
  /** Defaults to DATABASE_PORT, then 5432. Point it at the local end of the SSM tunnel. */
  port?: number;
}

export interface ReadOnlyConnectionConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

/** Opens the read-only connection: a read-only session, and only SELECT/WITH/SHOW/EXPLAIN statements get through. */
export function createReadOnlyConnection(config: ReadOnlyConnectionConfig): DatabaseConnection {
  const pool = new Pool({
    ...config,
    max: 4,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    options: '-c default_transaction_read_only=on -c statement_timeout=60000 -c timezone=UTC',
  });
  pool.on('error', (error: Error) => console.error('Database pool error:', error.message));
  return {
    query: async (sql: string, params?: unknown[]) => {
      assertReadOnlySql(sql);
      const result = await pool.query(sql, params);
      return result.rows as unknown[];
    },
    close: async () => {
      await pool.end();
    },
  };
}

/**
 * A database connection for the exporter and replay. Unlike `getDatabaseConnection` it runs no schema setup (no
 * CREATE or ALTER) and it cannot write, so a bug cannot modify prod Aurora even with the master credentials the stack's
 * secret holds. Needs DATABASE_SECRET_ARN and DATABASE_CLUSTER_ENDPOINT (`localhost` when going through the tunnel).
 */
export async function getReadOnlyDatabaseConnection(
  env: NodeJS.ProcessEnv,
  options: ReadOnlyDatabaseOptions = {}
): Promise<DatabaseConnection> {
  const config = await getDatabaseConfig(env);
  return createReadOnlyConnection({
    host: config.host,
    port: options.port ?? (env.DATABASE_PORT ? Number(env.DATABASE_PORT) : config.port),
    database: config.database,
    user: config.user,
    password: config.password,
  });
}
