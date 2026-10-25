#!/usr/bin/env node
/**
 * Local script to export AP-corrected agent invoices as labeled eval cases (JSON Lines). Read-only: it never writes
 * to Aurora, S3, or Workday. See evals/README.md for access, the tunnel, and data-handling rules.
 *
 * Usage: npm run export:eval-cases -- --out cases.jsonl [selection] [sources]
 *
 * Selection (default: invoices AP materially corrected):
 *   --since DATE --until DATE   AP entry-read window (until is exclusive); DATE is YYYY-MM-DD (UTC) or an ISO time with offset
 *   --include-clean                          also clean and convention-only invoices (outcome submitted_clean)
 *   --outcomes submitted_edited,denied       explicit outcomes
 *   --origin create|enrich   --limit N
 *   --invoice-number SUPIN-467195,SUPIN-466263   Workday invoice numbers (skips the outcome filter)
 *   --wid WID,WID                                Workday invoice WIDs (skips the outcome filter)
 *   --suppliers-invoice-number NUMBER,...        the number printed on the supplier's invoice (skips the outcome filter)
 *
 * Sources:
 *   (always)             Aurora: scores and snapshots, via the SSM tunnel. Needs DATABASE_SECRET_ARN, DATABASE_CLUSTER_ENDPOINT.
 *   (default)            S3: pins each document with HeadObject. Needs S3_BUCKET_NAME or --bucket. --no-s3 skips it.
 *   --include-messages   Intercom context as of the agent write, plus all messages. Needs INTERCOM_ACCESS_TOKEN.
 *   --include-po         Raw PO responses from Workday (a read). Needs WORKDAY_* credentials, which the eval role cannot reach.
 *   --include-ocr-email  Enrich OCR email from Workday (a read, last 90 days). Needs WORKDAY_* credentials.
 *
 * Cases hold supplier invoice data, so the file is created owner-only and never overwritten; keep it in a gitignored
 * directory or a private S3 prefix and delete it when the eval run is done.
 */

import * as dotenv from 'dotenv';
import { writeFileSync } from 'node:fs';
import { S3Client } from '@aws-sdk/client-s3';
import { closeDatabasePool } from './lib/database.js';
import { fetchConversationMessages, fetchEmailContextAsOf, getIntercomConfig } from './lib/intercom.js';
import { rowToInvoiceScore } from './lib/invoice_scores.js';
import { getAgentInvoiceSnapshots } from './lib/invoice_snapshots.js';
import { getInboundEmailsForOCRInvoices, getPurchaseOrder, getWorkdayConfig } from './lib/workday.js';
import type { EvalCase } from './lib/eval_cases.js';
import { buildExportedCase, buildSelectionQuery, type ExportSources, type SelectionArgs } from './eval/export_case.js';
import { getReadOnlyDatabaseConnection } from './eval/readonly_db.js';

dotenv.config();

const USAGE = 'Usage: npm run export:eval-cases -- --out cases.jsonl [--since DATE] [--until DATE] [--include-clean] [--outcomes a,b] [--origin create|enrich] [--limit N] [--invoice-number SUPIN-1,SUPIN-2] [--wid WID] [--suppliers-invoice-number N] [--bucket NAME] [--no-s3] [--include-messages] [--include-po] [--include-ocr-email]';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function listArg(name: string): string[] | undefined {
  const raw = argValue(name);
  const values = raw?.split(',').map((value) => value.trim()).filter(Boolean);
  return values?.length ? values : undefined;
}

const hasFlag = (name: string) => process.argv.includes(name);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main() {
  const out = argValue('--out');
  const since = argValue('--since');
  const until = argValue('--until');
  const date = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2}))?$/;
  if (!out || out.startsWith('--') || (since && !date.test(since)) || (until && !date.test(until))) fail(USAGE);
  const origin = argValue('--origin');
  if (origin && origin !== 'create' && origin !== 'enrich') fail('--origin must be create or enrich');
  const limit = argValue('--limit') ? Number(argValue('--limit')) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) fail('--limit must be a positive integer');

  const includeMessages = hasFlag('--include-messages');
  const includePo = hasFlag('--include-po');
  const includeOcrEmail = hasFlag('--include-ocr-email');
  if (includeMessages && !process.env.INTERCOM_ACCESS_TOKEN) fail('--include-messages needs INTERCOM_ACCESS_TOKEN');
  if ((includePo || includeOcrEmail) && !(process.env.WORKDAY_DOMAIN && process.env.WORKDAY_TENANT && process.env.WORKDAY_CLIENT_ID && process.env.WORKDAY_CLIENT_SECRET && process.env.WORKDAY_REFRESH_TOKEN)) {
    fail('--include-po and --include-ocr-email need WORKDAY_DOMAIN, WORKDAY_TENANT, WORKDAY_CLIENT_ID, WORKDAY_CLIENT_SECRET, and WORKDAY_REFRESH_TOKEN (read access)');
  }
  const bucket = argValue('--bucket') ?? process.env.S3_BUCKET_NAME;
  const useS3 = !hasFlag('--no-s3');
  if (useS3 && !bucket) fail('Set S3_BUCKET_NAME (finance-agent-<account id>) or pass --bucket, or pass --no-s3');

  const selection: SelectionArgs = {
    since,
    until,
    wids: listArg('--wid'),
    invoiceNumbers: listArg('--invoice-number'),
    suppliersInvoiceNumbers: listArg('--suppliers-invoice-number'),
    origin: origin as SelectionArgs['origin'],
    outcomes: listArg('--outcomes'),
    limit,
  };
  const named = Boolean(selection.wids || selection.invoiceNumbers || selection.suppliersInvoiceNumbers);
  const includeClean = named || hasFlag('--include-clean') || Boolean(selection.outcomes?.some((outcome) => outcome !== 'submitted_edited'));

  const db = await getReadOnlyDatabaseConnection(process.env);
  try {
    const { sql, params } = buildSelectionQuery(selection);
    const rows = await db.query(sql, params) as Array<Record<string, unknown>>;
    console.error(`${rows.length} invoice score(s) selected`);

    const intercom = includeMessages ? getIntercomConfig(process.env) : undefined;
    const workdayConfig = includePo || includeOcrEmail ? getWorkdayConfig(process.env) : undefined;
    const sources: ExportSources = {
      ...(useS3 && bucket ? { s3: new S3Client({}), bucket } : {}),
      ...(intercom ? {
        intercom: {
          emailContext: (conversationId, asOf, fileName) => fetchEmailContextAsOf(intercom, conversationId, asOf, fileName),
          messages: (conversationId) => fetchConversationMessages(intercom, conversationId),
        },
      } : {}),
      ...(workdayConfig && includePo ? { purchaseOrder: (documentNumber: string) => getPurchaseOrder({ workdayConfig }, documentNumber) } : {}),
    };

    const scores = rows.map((row) => rowToInvoiceScore(row));
    if (workdayConfig && includeOcrEmail && scores.some((score) => score.origin === 'enrich')) {
      sources.ocrEmails = await getInboundEmailsForOCRInvoices(workdayConfig);
    }

    const cases: EvalCase[] = [];
    for (const score of scores) {
      const label = score.workdayInvoiceNumber ?? score.workdayInvoiceWid;
      const snapshots = await getAgentInvoiceSnapshots(db, score.workdayInvoiceWid);
      const exported = await buildExportedCase(score, snapshots, { includeClean }, sources);
      if (!exported.evalCase) {
        console.error(`skip ${label}: ${exported.skipReason}`);
        continue;
      }
      for (const note of exported.notes) console.error(`note ${label}: ${note}`);
      cases.push(exported.evalCase);
    }

    const lines = cases.map((evalCase) => JSON.stringify(evalCase)).join('\n');
    writeFileSync(out, lines ? `${lines}\n` : '', { mode: 0o600, flag: 'wx' });
    const pinned = cases.filter((evalCase) => evalCase.documents.length && evalCase.documents.every((document) => document.status === 'pinned')).length;
    console.error(`Wrote ${cases.length} eval cases to ${out} (${pinned} with every document pinned and replayable)`);
  } finally {
    await db.close();
    await closeDatabasePool();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
