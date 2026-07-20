import { connectDatabase, type DatabaseConfig, type DatabaseConnection } from '../src/lib/database.js';

function parseDatabaseUrl(databaseUrl: string): DatabaseConfig {
  const url = new URL(databaseUrl);

  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    database: url.pathname.slice(1),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

export async function getEvalDatabaseConnection(): Promise<DatabaseConnection> {
  const databaseUrl = process.env.EVAL_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('eval database requires EVAL_DATABASE_URL');
  }

  return connectDatabase(parseDatabaseUrl(databaseUrl));
}
