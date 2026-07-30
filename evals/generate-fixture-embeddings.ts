import './setup.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { error, info } from '@pga/logger';
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

  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
    cases: unknown[];
    documents: SupplierFixtureDocument[];
  };

  for (const document of fixture.documents) {
    document.embedding = await createEmbedding(document.content);
  }

  writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  info(`Updated embeddings for ${fixture.documents.length} supplier documents`);
}

main().catch(err => {
  error(err);
  process.exit(1);
});
