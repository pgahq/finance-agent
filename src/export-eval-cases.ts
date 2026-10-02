#!/usr/bin/env tsx
/**
 * Local script to export AP-corrected agent invoices as labeled eval cases (JSON Lines).
 *
 * Usage: tsx src/export-eval-cases.ts [--since YYYY-MM-DD] [--out cases.jsonl]
 *
 * Needs database access (DATABASE_SECRET_ARN, DATABASE_CLUSTER_ENDPOINT). With INTERCOM_ACCESS_TOKEN
 * set, each case also carries the Intercom conversation messages the agent read.
 */

import * as dotenv from 'dotenv';
import { writeFileSync } from 'node:fs';
import { getDatabaseConnection, closeDatabasePool } from './lib/database.js';
import { buildEvalCase, type EvalCase } from './lib/eval_cases.js';
import { fetchConversationMessages, getIntercomConfig } from './lib/intercom.js';
import { rowToInvoiceScore } from './lib/invoice_scores.js';
import { getLatestAgentWriteSnapshot } from './lib/invoice_snapshots.js';

dotenv.config();

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const since = argValue('--since');
  const out = argValue('--out');
  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    console.error('Usage: tsx src/export-eval-cases.ts [--since YYYY-MM-DD] [--out cases.jsonl]');
    process.exit(1);
  }

  const db = await getDatabaseConnection(process.env);
  try {
    const rows = await db.query(
      `SELECT * FROM agent_invoice_scores
        WHERE entry_read_at IS NOT NULL AND outcome = 'submitted_edited'
          ${since ? 'AND entry_read_at >= $1' : ''}
        ORDER BY entry_read_at`,
      since ? [since] : []
    ) as Array<Record<string, unknown>>;

    const intercom = process.env.INTERCOM_ACCESS_TOKEN ? getIntercomConfig(process.env) : undefined;
    const cases: EvalCase[] = [];
    for (const row of rows) {
      const score = rowToInvoiceScore(row);
      const evalCase = buildEvalCase(score, await getLatestAgentWriteSnapshot(db, score.workdayInvoiceWid));
      if (!evalCase) continue;
      if (intercom && evalCase.conversationId) {
        try {
          evalCase.inputs.emailMessages = await fetchConversationMessages(intercom, evalCase.conversationId);
        } catch (error) {
          console.error(`Could not read conversation ${evalCase.conversationId}:`, error instanceof Error ? error.message : error);
        }
      }
      cases.push(evalCase);
    }

    const lines = cases.map((evalCase) => JSON.stringify(evalCase)).join('\n');
    if (out) {
      writeFileSync(out, lines ? `${lines}\n` : '');
      console.error(`Wrote ${cases.length} eval cases to ${out}`);
    } else if (lines) {
      console.log(lines);
    }
  } finally {
    await closeDatabasePool();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
