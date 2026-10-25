import { countsAgainstAgent, type ScoredChange } from './invoice_score.js';
import type { InvoiceScore } from './invoice_scores.js';
import type { AgentInvoiceSnapshot, ScoredFields } from './invoice_snapshots.js';

export const EVAL_CASE_SCHEMA_VERSION = 2;

/**
 * A source document read in place from the finance-agent bucket. `versionId` and `etag` pin the exact bytes the
 * agent read; the replay refuses a document whose ETag no longer matches.
 */
export interface EvalDocumentRef {
  bucket: string;
  key: string;
  versionId?: string;
  etag?: string;
  fileName?: string;
  contentType?: string;
  sizeBytes?: number;
  /** Cluster position for create invoices (first is the invoice) and `attachmentKinds` entry, when known. */
  kind?: string;
  /**
   * pinned: HeadObject returned a version ID and ETag. missing: the key or the version no longer exists (a
   * noncurrent version expires 30 days after it is replaced), so the case cannot be replayed from S3.
   * unverified: the exporter ran without S3 access.
   */
  status: 'pinned' | 'missing' | 'unverified';
  /** `snapshot`: key recorded on the agent write (create). `attachments_prefix`: found by listing `attachments/{wid}/` (enrich). */
  source: 'snapshot' | 'attachments_prefix';
  /**
   * Enrich only. The pipeline stores `{workdayInvoiceWid}-{index}` as S3 object metadata `attachment-id` and the
   * original file name; Workday's own attachment ID is not recorded anywhere. To rebuild an expired version, read the
   * invoice's attachments from Workday and take the one at this index with this name.
   */
  workdayAttachmentRef?: { workdayInvoiceWid: string; attachmentId?: string; originalFileName?: string };
  lastModified?: string;
  note?: string;
}

/** The raw `Get_Purchase_Orders` response the exporter read, replayed instead of calling Workday. */
export interface EvalPurchaseOrder {
  documentNumber: string;
  capturedAt: string;
  /**
   * Read at export time, which is after the agent wrote the invoice. A PO line the invoice consumed can now read as
   * fully invoiced, and PO edits since then show up here.
   */
  asOfExport: true;
  response: unknown;
}

export interface EvalEmailContext {
  emailFrom?: string;
  subject?: string;
  plainTextBody?: string;
  conversationParts?: string;
  adminConversationParts?: string;
  messageBody?: string;
  messageSubject?: string;
}

/**
 * One labeled case for checking prompt and matching changes against AP's answers: the documents the
 * agent read, what the agent submitted, and what AP saved when it submitted the invoice.
 */
export interface EvalCase {
  schemaVersion: typeof EVAL_CASE_SCHEMA_VERSION;
  workdayInvoiceWid: string;
  workdayInvoiceNumber?: string;
  origin?: 'create' | 'enrich';
  releaseSha?: string;
  conversationId?: string;
  outcome?: string;
  agentWrittenAt?: string;
  entryReadAt?: string;
  documents: EvalDocumentRef[];
  inputs: {
    s3Keys: string[];
    attachmentKinds: string[];
    clusteringMode?: string;
    purchaseOrderLines: string[];
    /** Raw PO responses for the POs those lines belong to; present when the exporter ran with `--include-po`. */
    purchaseOrders?: EvalPurchaseOrder[];
    /** Create: the Intercom context as of the agent write (messages after it are left out so AP's fixes cannot leak in). */
    emailContext?: EvalEmailContext;
    emailMessages?: Array<{ createdAt?: number; body: string }>;
    conversationCreatedAt?: string;
    /** Enrich: the inbound email Workday matched to the OCR invoice. It is never saved by the pipeline. */
    ocrEmail?: { emailFrom?: string; subject?: string; plainTextBody?: string };
    /** Enrich: the invoice as Workday OCR left it, before the agent wrote. */
    baseline?: ScoredFields;
  };
  agent: ScoredFields;
  expected: ScoredFields;
  /** The changes AP made that count against the agent (material and agent-owned). */
  misses: ScoredChange[];
  /** Convention changes (memo, descriptions, invoice number) kept for the convention discussion. */
  conventionChanges: ScoredChange[];
  /** Every change AP made at the entry read, as the scorer recorded it. */
  entryDiff: ScoredChange[];
  /** Changes AP made after submitting, as the scorer recorded them at the terminal read. */
  lateDiff?: ScoredChange[];
}

export interface BuildEvalCaseOptions {
  /** Also build cases for invoices AP did not change materially (clean, or only memo and description conventions). */
  includeClean?: boolean;
}

/**
 * Builds a case from a score with an entry read. Without `includeClean`, returns undefined unless the entry read shows
 * material changes against the agent; undefined also when there is no agent snapshot or entry read to compare.
 */
export function buildEvalCase(
  score: InvoiceScore,
  latestAgentWrite: AgentInvoiceSnapshot | undefined,
  options: BuildEvalCaseOptions = {}
): EvalCase | undefined {
  if (!latestAgentWrite || !score.entryFields) return undefined;
  const changes = score.entryDiff ?? [];
  const misses = changes.filter(countsAgainstAgent);
  if (!misses.length && !options.includeClean) return undefined;
  const purchaseOrderLines = [...new Set(
    latestAgentWrite.fields.lines.map((line) => line.purchaseOrderLine).filter((line): line is string => Boolean(line))
  )];
  return {
    schemaVersion: EVAL_CASE_SCHEMA_VERSION,
    workdayInvoiceWid: score.workdayInvoiceWid,
    ...(score.workdayInvoiceNumber ? { workdayInvoiceNumber: score.workdayInvoiceNumber } : {}),
    ...(score.origin ? { origin: score.origin } : {}),
    ...(latestAgentWrite.releaseSha ? { releaseSha: latestAgentWrite.releaseSha } : {}),
    ...(latestAgentWrite.conversationId ? { conversationId: latestAgentWrite.conversationId } : {}),
    ...(score.outcome ? { outcome: score.outcome } : {}),
    agentWrittenAt: latestAgentWrite.createdAt.toISOString(),
    ...(score.entryReadAt ? { entryReadAt: score.entryReadAt.toISOString() } : {}),
    documents: [],
    inputs: {
      s3Keys: latestAgentWrite.s3Keys ?? [],
      attachmentKinds: latestAgentWrite.attachmentKinds ?? [],
      ...(latestAgentWrite.clusteringMode ? { clusteringMode: latestAgentWrite.clusteringMode } : {}),
      purchaseOrderLines,
    },
    agent: latestAgentWrite.fields,
    expected: score.entryFields,
    misses,
    conventionChanges: changes.filter((change) => change.category === 'convention' && change.agentOwned),
    entryDiff: changes,
    ...(score.lateDiff?.length ? { lateDiff: score.lateDiff } : {}),
  };
}

/** The PO document number a PO line key belongs to: `Purchase_Order_Line_ID=PO-123456-1` is PO `PO-123456`. */
export function purchaseOrderNumberOfLineKey(lineKey: string): string | undefined {
  const id = lineKey.includes('=') ? lineKey.slice(lineKey.indexOf('=') + 1) : lineKey;
  return id.match(/^(PO-\d+)-\d+$/i)?.[1]?.toUpperCase();
}

export function purchaseOrderNumbersOfCase(evalCase: Pick<EvalCase, 'inputs'>): string[] {
  return [...new Set(evalCase.inputs.purchaseOrderLines.flatMap((line) => purchaseOrderNumberOfLineKey(line) ?? []))];
}
