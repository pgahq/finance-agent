import './setup.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bulkInsertDocuments, getDatabaseConnection } from '../src/lib/database.js';
import { createEmbedding } from '../src/lib/rag.js';
import { requireEvalEnv } from './setup.js';

const fixturePath = join(process.cwd(), 'evals/fixtures/supplier-rag.json');

interface SupplierFixtureDocument {
  workday_id: string;
  type: 'supplier';
  content: string;
  metadata: Record<string, unknown>;
  embedding?: number[];
}

async function main(): Promise<void> {
  process.env.RUN_EVALS = '1';
  requireEvalEnv();

  if (!process.env.DATABASE_URL) {
    throw new Error('eval:seed requires EVAL_DATABASE_URL (or DATABASE_URL)');
  }

  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
    documents: SupplierFixtureDocument[];
  };

  const db = await getDatabaseConnection(process.env);
  try {
    await db.query(`DELETE FROM documents WHERE type = 'supplier'`);

    const documents = [];
    for (const document of fixture.documents) {
      const embedding = document.embedding ?? await createEmbedding(document.content);
      documents.push({
        workdayId: document.workday_id,
        type: document.type,
        content: document.content,
        metadata: document.metadata,
        embedding,
      });
    }

    await bulkInsertDocuments(db, documents);
    console.log(`Seeded ${documents.length} supplier documents for evals`);
  } finally {
    await db.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
