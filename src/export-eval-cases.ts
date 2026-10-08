#!/usr/bin/env node
/**
 * Local script to export AP-corrected agent invoices as labeled eval cases (JSON Lines).
 *
 * Usage: npm run export:eval-cases -- --out cases.jsonl [--since YYYY-MM-DD] [--include-messages]
 *
 * Needs database access (DATABASE_SECRET_ARN, DATABASE_CLUSTER_ENDPOINT). Cases hold supplier invoice data,
 * so the file is created owner-only and never overwritten; delete it when the eval run is done.
 * `--include-messages` (with INTERCOM_ACCESS_TOKEN) adds the Intercom conversation messages the agent read.
 */

import * as dotenv from 'dotenv';
import { writeFileSync } from 'node:fs';
import { getDatabaseConnection, closeDatabasePool } from './lib/database.js';
import { buildEvalCase, type EvalCase } from './lib/eval_cases.js';
import { fetchConversationMessages, getIntercomConfig } from './lib/intercom.js';
import { rowToInvoiceScore } from './lib/invoice_scores.js';
import { AGENT_WRITE_SOURCES, getAgentInvoiceSnapshots, type AgentInvoiceSnapshot } from './lib/invoice_snapshots.js';

dotenv.config();

/** The agent write AP's entry read was diffed against: the last one saved before that read. */
function agentWriteAtEntry(snapshots: AgentInvoiceSnapshot[], entryReadAt: Date | undefined): AgentInvoiceSnapshot | undefined {
  return snapshots
    .filter((snapshot) => AGENT_WRITE_SOURCES.includes(snapshot.source) && (!entryReadAt || snapshot.createdAt <= entryReadAt))
    .at(-1);
}

const USAGE = 'Usage: npm run export:eval-cases -- --out cases.jsonl [--since YYYY-MM-DD] [--include-messages]';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const since = argValue('--since');
  const out = argValue('--out');
  const includeMessages = process.argv.includes('--include-messages');
  if (!out || out.startsWith('--') || (since && !/^\d{4}-\d{2}-\d{2}$/.test(since))) {
    console.error(USAGE);
    process.exit(1);
  }
  if (includeMessages && !process.env.INTERCOM_ACCESS_TOKEN) {
    console.error('--include-messages needs INTERCOM_ACCESS_TOKEN');
    process.exit(1);
  }

  const db = await getDatabaseConnection(process.env);
  try {
    const rows = await db.query(
      `SELECT * FROM agent_invoice_scores
        WHERE entry_read_at IS NOT NULL AND outcome = 'submitted_edited'
          ${since ? 'AND entry_read_at >= $1' : ''}
        ORDER BY entry_read_at, workday_invoice_wid`,
      since ? [since] : []
    ) as Array<Record<string, unknown>>;

    const intercom = includeMessages ? getIntercomConfig(process.env) : undefined;
    const cases: EvalCase[] = [];
    for (const row of rows) {
      const score = rowToInvoiceScore(row);
      const evalCase = buildEvalCase(score, agentWriteAtEntry(await getAgentInvoiceSnapshots(db, score.workdayInvoiceWid), score.entryReadAt));
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
    writeFileSync(out, lines ? `${lines}\n` : '', { mode: 0o600, flag: 'wx' });
    console.error(`Wrote ${cases.length} eval cases to ${out}`);
  } finally {
    await closeDatabasePool();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
