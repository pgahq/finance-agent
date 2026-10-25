import {
  buildEvalCase,
  purchaseOrderNumbersOfCase,
  type EvalCase,
  type EvalEmailContext,
  type EvalPurchaseOrder,
} from '../lib/eval_cases.js';
import type { InvoiceScore } from '../lib/invoice_scores.js';
import { AGENT_WRITE_SOURCES, type AgentInvoiceSnapshot } from '../lib/invoice_snapshots.js';
import { pinCreateDocuments, pinEnrichDocuments, type ReadOnlyS3 } from './s3_documents.js';

/** The agent write AP's entry read was diffed against: the last one saved before that read. */
export function agentWriteAtEntry(snapshots: AgentInvoiceSnapshot[], entryReadAt: Date | undefined): AgentInvoiceSnapshot | undefined {
  return snapshots
    .filter((snapshot) => AGENT_WRITE_SOURCES.includes(snapshot.source) && (!entryReadAt || snapshot.createdAt <= entryReadAt))
    .at(-1);
}

/** The OCR invoice before the agent's enrich write: the newest enrich baseline saved before that write. */
export function enrichBaselineFor(snapshots: AgentInvoiceSnapshot[], write: AgentInvoiceSnapshot): AgentInvoiceSnapshot | undefined {
  return [...snapshots].reverse().find((snapshot) => snapshot.source === 'enrich_baseline' && snapshot.writeSeq < write.writeSeq);
}

export interface ExportSources {
  s3?: ReadOnlyS3;
  bucket?: string;
  /** Intercom context as of a time; present only with `--include-messages`. */
  intercom?: {
    emailContext: (conversationId: string, asOfUnixSeconds: number, fileName?: string) => Promise<{ emailContext: EvalEmailContext; conversationCreatedAt?: string }>;
    messages: (conversationId: string) => Promise<Array<{ createdAt?: number; body: string }>>;
  };
  /** Raw `Get_Purchase_Orders` response for a document number; present only with `--include-po` (needs Workday read access). */
  purchaseOrder?: (documentNumber: string) => Promise<unknown>;
  /** Inbound OCR emails by invoice WID; present only with `--include-ocr-email` (needs Workday read access). */
  ocrEmails?: Map<string, { emailFrom?: string; subject?: string; plainTextBody?: string }>;
  now?: () => Date;
}

export interface ExportedCase {
  evalCase?: EvalCase;
  skipReason?: string;
  /** Things the person running the export should know about this case. */
  notes: string[];
}

/**
 * Builds one case from an invoice's score and snapshots, then attaches everything the replay needs that Aurora does not
 * hold: pinned documents from S3, and (when the matching access is available) the PO responses, the Intercom context as of
 * the agent's write, and the enrich OCR email.
 */
export async function buildExportedCase(
  score: InvoiceScore,
  snapshots: AgentInvoiceSnapshot[],
  options: { includeClean: boolean },
  sources: ExportSources
): Promise<ExportedCase> {
  const notes: string[] = [];
  const write = agentWriteAtEntry(snapshots, score.entryReadAt);
  if (!write) return { skipReason: 'no agent write snapshot before the entry read', notes };
  if (!score.entryFields) return { skipReason: 'AP has not entered the invoice yet (no entry read)', notes };
  const evalCase = buildEvalCase(score, write, options);
  if (!evalCase) return { skipReason: 'no material changes against the agent (pass --include-clean to export it)', notes };

  const origin = evalCase.origin ?? (write.source === 'enrich' ? 'enrich' : 'create');
  evalCase.origin = origin;

  if (sources.s3 && sources.bucket) {
    if (origin === 'create') {
      evalCase.documents = await pinCreateDocuments(sources.s3, sources.bucket, write.s3Keys ?? [], write.attachmentKinds ?? []);
      if (!evalCase.documents.length) notes.push('the agent write recorded no S3 keys, so there are no documents to replay');
    } else {
      evalCase.documents = await pinEnrichDocuments(sources.s3, sources.bucket, evalCase.workdayInvoiceWid, write.createdAt);
      if (!evalCase.documents.length) notes.push(`nothing under attachments/${evalCase.workdayInvoiceWid}/ in the bucket`);
    }
    const bad = evalCase.documents.filter((document) => document.status !== 'pinned');
    if (bad.length) notes.push(`${bad.length} document(s) not pinned: ${bad.map((document) => `${document.key} (${document.status})`).join(', ')}`);
  } else {
    notes.push('exported without S3 access: documents are not pinned, so the replay will skip this case');
  }

  if (origin === 'enrich') {
    const baseline = enrichBaselineFor(snapshots, write);
    if (baseline) evalCase.inputs.baseline = baseline.fields;
    else notes.push('no enrich baseline snapshot: the replay cannot tell which fields are the agent\'s');
    const email = sources.ocrEmails?.get(evalCase.workdayInvoiceWid);
    if (email) evalCase.inputs.ocrEmail = email;
    else if (sources.ocrEmails) notes.push('Workday returned no inbound email for this OCR invoice (it only looks back 90 days)');
  }

  if (sources.intercom && evalCase.conversationId) {
    const asOf = Math.floor(write.createdAt.getTime() / 1000);
    try {
      const context = await sources.intercom.emailContext(evalCase.conversationId, asOf, evalCase.documents[0]?.fileName);
      evalCase.inputs.emailContext = context.emailContext;
      if (context.conversationCreatedAt) evalCase.inputs.conversationCreatedAt = context.conversationCreatedAt;
      evalCase.inputs.emailMessages = await sources.intercom.messages(evalCase.conversationId);
    } catch (error) {
      notes.push(`could not read conversation ${evalCase.conversationId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (sources.purchaseOrder) {
    const purchaseOrders: EvalPurchaseOrder[] = [];
    for (const documentNumber of purchaseOrderNumbersOfCase(evalCase)) {
      try {
        purchaseOrders.push({
          documentNumber,
          capturedAt: (sources.now?.() ?? new Date()).toISOString(),
          asOfExport: true,
          response: await sources.purchaseOrder(documentNumber),
        });
      } catch (error) {
        notes.push(`could not read ${documentNumber}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (purchaseOrders.length) evalCase.inputs.purchaseOrders = purchaseOrders;
  } else if (evalCase.inputs.purchaseOrderLines.length) {
    notes.push('PO lines not captured (--include-po): the replay will ask Workday nothing and treat the invoice as having no PO');
  }

  return { evalCase, notes };
}

export interface SelectionArgs {
  since?: string;
  until?: string;
  wids?: string[];
  invoiceNumbers?: string[];
  suppliersInvoiceNumbers?: string[];
  origin?: 'create' | 'enrich';
  outcomes?: string[];
  limit?: number;
}

export const DEFAULT_OUTCOMES = ['submitted_edited'];

/**
 * The score rows to export. Naming specific invoices (by Workday WID, Workday invoice number such as SUPIN-467195, or the
 * supplier's invoice number) skips the outcome filter, so a clean or denied invoice can be pulled by name.
 */
export function buildSelectionQuery(args: SelectionArgs): { sql: string; params: unknown[] } {
  const where = ['entry_read_at IS NOT NULL'];
  const params: unknown[] = [];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const named = Boolean(args.wids?.length || args.invoiceNumbers?.length || args.suppliersInvoiceNumbers?.length);
  if (named) {
    const alternatives: string[] = [];
    if (args.wids?.length) alternatives.push(`workday_invoice_wid = ANY(${add(args.wids)}::text[])`);
    if (args.invoiceNumbers?.length) alternatives.push(`workday_invoice_number = ANY(${add(args.invoiceNumbers)}::text[])`);
    if (args.suppliersInvoiceNumbers?.length) {
      alternatives.push(`entry_fields->>'suppliersInvoiceNumber' = ANY(${add(args.suppliersInvoiceNumbers)}::text[])`);
    }
    where.push(`(${alternatives.join(' OR ')})`);
  } else {
    where.push(`outcome = ANY(${add(args.outcomes?.length ? args.outcomes : DEFAULT_OUTCOMES)}::text[])`);
  }
  // entry_read_at is a UTC wall-clock timestamp without a zone; convert the bound's instant to that same form.
  if (args.since) where.push(`entry_read_at >= (${add(args.since)}::timestamptz AT TIME ZONE 'UTC')`);
  if (args.until) where.push(`entry_read_at < (${add(args.until)}::timestamptz AT TIME ZONE 'UTC')`);
  if (args.origin) where.push(`origin = ${add(args.origin)}`);
  const limit = args.limit ? ` LIMIT ${Math.max(1, Math.floor(args.limit))}` : '';
  return {
    sql: `SELECT * FROM agent_invoice_scores WHERE ${where.join(' AND ')} ORDER BY entry_read_at, workday_invoice_wid${limit}`,
    params,
  };
}
