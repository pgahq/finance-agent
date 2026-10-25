#!/usr/bin/env node
/**
 * Replays eval cases through the current pipeline without writing to Workday, then scores the result against AP's saved
 * version with the production scorer. See evals/README.md.
 *
 * Usage: npm run eval:replay -- --cases cases.jsonl [--label NAME] [--ids A,B] [--limit N]
 *          [--baseline base.json] [--save-baseline base.json] [--out report.json]
 *          [--share-tolerance 0] [--field-tolerance 0.02] [--min-share 0.5]
 */
import * as dotenv from 'dotenv';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { S3Client } from '@aws-sdk/client-s3';
import { companyReferenceIdForWorkdayId } from '../lib/reference_ids.js';
import { getDocumentsByWorkdayIds, type DatabaseConnection } from '../lib/database.js';
import type { ProcessingContext } from '../lib/handlers.js';
import { prepareReplayEnv } from './env.js';
import { getReadOnlyDatabaseConnection } from './readonly_db.js';
import { caseId, enterReplayMode, parseCases, replayCase } from './replay_runner.js';
import type { ReferenceResolver } from './replay_payload.js';
import {
  compareToBaseline,
  formatSummary,
  summarize,
  type CaseScore,
  type EvalSummary,
} from './scoring.js';

dotenv.config();
dotenv.config({ path: 'evals/.env.local' });

const USAGE = 'Usage: npm run eval:replay -- --cases cases.jsonl [--label NAME] [--ids A,B] [--limit N] [--baseline base.json] [--save-baseline base.json] [--out report.json] [--share-tolerance 0] [--field-tolerance 0.02] [--min-share 0.5] [--force]';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function numberArg(name: string): number | undefined {
  const raw = argValue(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`${name} must be a non-negative number`);
    process.exit(1);
  }
  return value;
}

function databaseResolver(db: DatabaseConnection): ReferenceResolver {
  return {
    supplierKey: async (workdayId) => {
      const rows = await getDocumentsByWorkdayIds(db, 'supplier', [workdayId]);
      const supplierId = (rows[0]?.metadata as { supplierId?: unknown } | undefined)?.supplierId;
      return typeof supplierId === 'string' && supplierId ? `Supplier_ID=${supplierId}` : undefined;
    },
    companyKey: async (workdayId) => {
      const id = await companyReferenceIdForWorkdayId(db, workdayId);
      return id ? `Company_Reference_ID=${id}` : undefined;
    },
  };
}

async function existingReference(db: DatabaseConnection, kind: 'supplier' | 'company', key: string) {
  const value = key.includes('=') ? key.slice(key.indexOf('=') + 1) : key;
  const field = kind === 'supplier' ? 'supplierId' : 'companyReferenceId';
  const rows = await db.query(
    'SELECT workday_id, metadata FROM documents WHERE type = $1 AND metadata->>$2 = $3 LIMIT 1',
    [kind, field, value]
  ) as Array<{ workday_id: string; metadata?: Record<string, unknown> }>;
  const row = rows[0];
  if (!row) return undefined;
  const name = row.metadata?.supplierName ?? row.metadata?.companyName ?? row.metadata?.name;
  return { descriptor: typeof name === 'string' && name ? name : value, id: row.workday_id };
}

async function main() {
  const casesPath = argValue('--cases');
  if (!casesPath || casesPath.startsWith('--')) {
    console.error(USAGE);
    process.exit(1);
  }
  const { missing } = prepareReplayEnv(process.env);
  if (missing.length) {
    console.error(`Missing environment: ${missing.join(', ')}`);
    process.exit(1);
  }
  enterReplayMode();

  let cases = parseCases(readFileSync(casesPath, 'utf8'));
  const ids = argValue('--ids')?.split(',').map((id) => id.trim()).filter(Boolean);
  if (ids?.length) cases = cases.filter((evalCase) => ids.includes(caseId(evalCase)) || ids.includes(evalCase.workdayInvoiceWid));
  const limit = numberArg('--limit');
  if (limit !== undefined) cases = cases.slice(0, limit);
  if (!cases.length) {
    console.error('No cases to replay');
    process.exit(1);
  }

  // Import after the environment is prepared: these modules read some of it once, at load.
  const [{ processInvoiceCluster }, { processInvoice }, { getWorkdayConfig }] = await Promise.all([
    import('../create_invoice.js'),
    import('../enrich_invoice.js'),
    import('../lib/workday.js'),
  ]);

  const db = await getReadOnlyDatabaseConnection(process.env);
  const bucket = cases.flatMap((evalCase) => evalCase.documents).find((document) => document.bucket)?.bucket ?? process.env.S3_BUCKET_NAME ?? '';
  const context: ProcessingContext = {
    workdayConfig: getWorkdayConfig(process.env),
    s3Config: { bucketName: bucket },
    dbConnection: db,
  };
  const s3 = new S3Client({});

  const scores: CaseScore[] = [];
  try {
    for (const [index, evalCase] of cases.entries()) {
      const id = caseId(evalCase);
      console.error(`[${index + 1}/${cases.length}] ${id} (${evalCase.origin ?? 'create'})`);
      const score = await replayCase(evalCase, {
        s3,
        context,
        resolver: databaseResolver(db),
        pipeline: { create: processInvoiceCluster, enrich: processInvoice },
        existingReference: (kind, key) => existingReference(db, kind, key),
      });
      console.error(`  ${score.status}${score.reason ? `: ${score.reason}` : ''}${score.codingTouches !== null ? ` — ${score.codingTouches} coding touches (production: ${score.productionTouches ?? 'n/a'})` : ''}`);
      for (const warning of score.warnings) console.error(`  warning: ${warning}`);
      scores.push(score);
    }
  } finally {
    await db.close();
  }

  const summary = summarize(scores, {
    label: argValue('--label'),
    releaseSha: process.env.RELEASE_SHA ?? [...new Set(cases.map((evalCase) => evalCase.releaseSha).filter(Boolean))].join(','),
  });

  let comparison;
  const baselinePath = argValue('--baseline');
  if (baselinePath) {
    if (!existsSync(baselinePath)) {
      console.error(`Baseline not found: ${baselinePath}`);
      process.exit(1);
    }
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as EvalSummary;
    comparison = compareToBaseline(summary, baseline, {
      shareTolerance: numberArg('--share-tolerance'),
      fieldTolerance: numberArg('--field-tolerance'),
    });
  }

  console.log(formatSummary(summary, comparison));

  const out = argValue('--out');
  const force = process.argv.includes('--force');
  if (out) {
    writeFileSync(out, `${JSON.stringify({ summary, comparison, scores }, null, 2)}\n`, { mode: 0o600, flag: force ? 'w' : 'wx' });
    console.error(`Wrote report to ${out}`);
  }
  const saveBaseline = argValue('--save-baseline');
  if (saveBaseline) {
    writeFileSync(saveBaseline, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600, flag: force ? 'w' : 'wx' });
    console.error(`Saved baseline to ${saveBaseline}`);
  }

  const minShare = numberArg('--min-share');
  const belowBar = minShare !== undefined && summary.share0to3 < minShare;
  if (belowBar) console.error(`0–3 share ${(summary.share0to3 * 100).toFixed(1)}% is below --min-share ${(minShare * 100).toFixed(1)}%`);
  process.exit(comparison && !comparison.ok || belowBar ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
