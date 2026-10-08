import { countsAgainstAgent, type ScoredChange } from './invoice_score.js';
import type { InvoiceScore } from './invoice_scores.js';
import type { AgentInvoiceSnapshot, ScoredFields } from './invoice_snapshots.js';

/**
 * One labeled case for checking prompt and matching changes against AP's answers: the documents the
 * agent read, what the agent submitted, and what AP saved when it submitted the invoice.
 */
export interface EvalCase {
  workdayInvoiceWid: string;
  workdayInvoiceNumber?: string;
  origin?: 'create' | 'enrich';
  releaseSha?: string;
  conversationId?: string;
  inputs: {
    s3Keys: string[];
    attachmentKinds: string[];
    purchaseOrderLines: string[];
    emailMessages?: Array<{ createdAt?: number; body: string }>;
  };
  agent: ScoredFields;
  expected: ScoredFields;
  /** The changes AP made that count against the agent (material and agent-owned). */
  misses: ScoredChange[];
  /** Convention changes (memo, descriptions, invoice number) kept for the convention discussion. */
  conventionChanges: ScoredChange[];
}

/**
 * Builds a case from a score whose entry read shows material changes against the agent. Returns
 * undefined when there is nothing to learn from (clean, not yet entered, or no agent snapshot).
 */
export function buildEvalCase(score: InvoiceScore, latestAgentWrite: AgentInvoiceSnapshot | undefined): EvalCase | undefined {
  if (!latestAgentWrite || !score.entryFields) return undefined;
  const changes = score.entryDiff ?? [];
  const misses = changes.filter(countsAgainstAgent);
  if (!misses.length) return undefined;
  const purchaseOrderLines = [...new Set(
    latestAgentWrite.fields.lines.map((line) => line.purchaseOrderLine).filter((line): line is string => Boolean(line))
  )];
  return {
    workdayInvoiceWid: score.workdayInvoiceWid,
    ...(score.workdayInvoiceNumber ? { workdayInvoiceNumber: score.workdayInvoiceNumber } : {}),
    ...(score.origin ? { origin: score.origin } : {}),
    ...(latestAgentWrite.releaseSha ? { releaseSha: latestAgentWrite.releaseSha } : {}),
    ...(latestAgentWrite.conversationId ? { conversationId: latestAgentWrite.conversationId } : {}),
    inputs: {
      s3Keys: latestAgentWrite.s3Keys ?? [],
      attachmentKinds: latestAgentWrite.attachmentKinds ?? [],
      purchaseOrderLines,
    },
    agent: latestAgentWrite.fields,
    expected: score.entryFields,
    misses,
    conventionChanges: changes.filter((change) => change.category === 'convention' && change.agentOwned),
  };
}
