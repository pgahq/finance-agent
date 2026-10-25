import { basename } from 'node:path';
import type { ProcessingContext } from '../lib/handlers.js';
import { purchaseOrderNumbersOfCase, type EvalCase, type EvalDocumentRef, type EvalPurchaseOrder } from '../lib/eval_cases.js';
import type { PresignedAttachment, InvoiceData } from '../lib/types.js';
import type { ClusterInvoiceInput, ClusterRunState } from '../create_invoice.js';
import { setWorkdayReplayHook } from '../lib/workday.js';
import { blockS3Writes } from '../lib/s3.js';
import { readPinnedDocument, type LoadedDocument, type ReadOnlyS3 } from './s3_documents.js';
import { invoiceDataFromScoredFields, scoredFieldsFromSubmitRequest, type ReferenceResolver } from './replay_payload.js';
import { createReplayWorkday } from './replay_workday.js';
import { scoreCase, type CaseScore } from './scoring.js';

/** The two pipeline entry points the replay drives; passed in so tests can stand in for the model calls. */
export interface ReplayPipeline {
  create: (context: ProcessingContext, input: ClusterInvoiceInput, run: ClusterRunState, abortSignal?: AbortSignal) => Promise<void>;
  enrich: (context: ProcessingContext, invoice: InvoiceData, abortSignal?: AbortSignal) => Promise<void>;
}

export interface ReplayDeps {
  s3: ReadOnlyS3;
  context: ProcessingContext;
  resolver?: ReferenceResolver;
  pipeline: ReplayPipeline;
  /** Resolves a supplier or company key (`Supplier_ID=S-1`) to the descriptor and WID the enrich input carries. */
  existingReference?: (kind: 'supplier' | 'company', key: string) => Promise<{ descriptor: string; id: string } | undefined>;
  perCaseTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export function parseCases(jsonl: string): EvalCase[] {
  return jsonl.split('\n').filter((line) => line.trim()).map((line, index) => {
    const parsed = JSON.parse(line) as EvalCase;
    if (parsed.schemaVersion !== 2) {
      throw new Error(`Line ${index + 1}: expected an eval case with schemaVersion 2 (re-export it with npm run export:eval-cases)`);
    }
    return parsed;
  });
}

export function caseId(evalCase: Pick<EvalCase, 'workdayInvoiceWid' | 'workdayInvoiceNumber'>): string {
  return evalCase.workdayInvoiceNumber ?? evalCase.workdayInvoiceWid;
}

function skipped(evalCase: EvalCase, reason: string): CaseScore {
  return scoreCase({ id: caseId(evalCase), status: 'skipped', reason, expected: evalCase.expected });
}

function failed(evalCase: EvalCase, reason: string, warnings: string[] = []): CaseScore {
  return scoreCase({ id: caseId(evalCase), status: 'error', reason, expected: evalCase.expected, warnings });
}

async function loadDocuments(s3: ReadOnlyS3, documents: EvalDocumentRef[]): Promise<Array<{ ref: EvalDocumentRef; loaded: LoadedDocument }>> {
  return Promise.all(documents.map(async (ref) => ({ ref, loaded: await readPinnedDocument(s3, ref) })));
}

function purchaseOrderMap(purchaseOrders: EvalPurchaseOrder[] | undefined): Map<string, unknown> {
  return new Map((purchaseOrders ?? []).map((po) => [po.documentNumber, po.response]));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Replay timed out after ${Math.round(ms / 1000)}s`)), ms);
  try {
    return await work(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Re-runs the current pipeline for one case with Workday switched off: the pipeline builds its Submit_Supplier_Invoice
 * request as it would in production, the fake Workday records it instead of sending it, and the request is mapped to
 * the scored shape and scored against what AP saved.
 */
export async function replayCase(evalCase: EvalCase, deps: ReplayDeps): Promise<CaseScore> {
  const documents = evalCase.documents;
  if (!documents.length) return skipped(evalCase, 'case has no documents (export it with S3 access)');
  const unusable = documents.filter((ref) => ref.status !== 'pinned');
  if (unusable.length) {
    return skipped(evalCase, `document not readable: ${unusable.map((ref) => `${ref.key} is ${ref.status}`).join('; ')}`);
  }
  const origin = evalCase.origin ?? 'create';
  if (origin === 'enrich' && !evalCase.inputs.baseline) {
    return skipped(evalCase, 'enrich case has no OCR baseline snapshot, so ownership of each field cannot be decided');
  }

  let loaded: Array<{ ref: EvalDocumentRef; loaded: LoadedDocument }>;
  try {
    loaded = await loadDocuments(deps.s3, documents);
  } catch (error) {
    return skipped(evalCase, `could not read documents: ${describeError(error)}`);
  }
  if (origin === 'enrich' && loaded.some(({ loaded: document }) => document.contentType.startsWith('image/'))) {
    return skipped(evalCase, 'enrich case with image attachments is not supported by the replay');
  }

  const invoices = new Map<string, Record<string, unknown>>();
  if (origin === 'enrich') {
    invoices.set(evalCase.workdayInvoiceWid, invoiceDataFromScoredFields(evalCase.inputs.baseline!, evalCase.workdayInvoiceNumber));
  }
  const workday = createReplayWorkday({
    invoices,
    purchaseOrders: purchaseOrderMap(evalCase.inputs.purchaseOrders),
    loadAttachments: () => Promise.resolve(loaded.map(({ ref, loaded: document }, index): PresignedAttachment => {
      const indexOfAttachment = Number(ref.workdayAttachmentRef?.attachmentId?.split('-').pop());
      return {
        id: `${evalCase.workdayInvoiceWid}-${Number.isInteger(indexOfAttachment) ? indexOfAttachment : index}`,
        fileName: ref.workdayAttachmentRef?.originalFileName ?? ref.fileName ?? basename(ref.key),
        contentType: document.contentType,
        presignedUrl: '',
        expiresAt: new Date(Date.now() + 3600 * 1000),
        s3Key: ref.key,
        buffer: document.buffer,
      };
    })),
  });

  setWorkdayReplayHook(workday.hook);
  try {
    await withTimeout(async (signal) => {
      if (origin === 'enrich') {
        const baseline = evalCase.inputs.baseline!;
        const [supplier, company] = await Promise.all([
          baseline.supplier ? deps.existingReference?.('supplier', baseline.supplier) : undefined,
          baseline.company ? deps.existingReference?.('company', baseline.company) : undefined,
        ]);
        const invoice: InvoiceData = {
          workdayID: evalCase.workdayInvoiceWid,
          invoiceStatusAsText: 'Draft',
          OCRSupplierInvoice: { descriptor: evalCase.workdayInvoiceNumber ?? evalCase.workdayInvoiceWid, id: evalCase.workdayInvoiceWid },
          ...(supplier ? { supplier } : {}),
          ...(company ? { company1: company } : {}),
          ...(evalCase.inputs.ocrEmail ? { emailContext: evalCase.inputs.ocrEmail } : {}),
        };
        await deps.pipeline.enrich(deps.context, invoice, signal);
        return;
      }
      const files = loaded.map(({ ref, loaded: document }) => ({
        s3Key: ref.key,
        fileName: ref.fileName ?? basename(ref.key),
        contentType: document.contentType,
        ...(ref.kind ? { kind: ref.kind as never } : {}),
      }));
      const input: ClusterInvoiceInput = {
        files,
        unrelated: [],
        ...(evalCase.inputs.emailContext ? { emailContext: evalCase.inputs.emailContext } : {}),
        ...(evalCase.inputs.conversationCreatedAt ? { conversationCreatedAt: evalCase.inputs.conversationCreatedAt } : {}),
        preloadedBuffers: new Map(loaded.map(({ ref, loaded: document }) => [ref.key, document.buffer])),
        startTime: Date.now(),
        clustered: files.length > 1,
      };
      await deps.pipeline.create(deps.context, input, {}, signal);
    }, deps.perCaseTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  } catch (error) {
    return failed(evalCase, describeError(error));
  } finally {
    setWorkdayReplayHook(undefined);
  }

  const submitted = workday.submits.at(-1);
  if (!submitted) {
    return failed(evalCase, `the pipeline finished without building a Workday write${workday.blocked.length ? ` (blocked: ${[...new Set(workday.blocked)].join(', ')})` : ''}`);
  }
  const mapped = await scoredFieldsFromSubmitRequest(submitted.request, deps.resolver);
  const capturedPurchaseOrders = new Set((evalCase.inputs.purchaseOrders ?? []).map((po) => po.documentNumber));
  const missingPurchaseOrders = purchaseOrderNumbersOfCase(evalCase).filter((number) => !capturedPurchaseOrders.has(number));
  if (missingPurchaseOrders.length) {
    mapped.warnings.push(`the agent coded against ${missingPurchaseOrders.join(', ')}, which this case did not capture (export with --include-po); the replay ran without it, so PO-driven coding will differ`);
  }
  return scoreCase({
    id: caseId(evalCase),
    status: 'scored',
    origin,
    expected: evalCase.expected,
    replay: mapped.fields,
    ...(evalCase.inputs.baseline ? { baseline: evalCase.inputs.baseline } : {}),
    production: { entryDiff: evalCase.entryDiff, ...(evalCase.lateDiff ? { lateDiff: evalCase.lateDiff } : {}) },
    warnings: mapped.warnings,
  });
}

/** Installs the read-only guards a replay process must have before it runs any case. */
export function enterReplayMode(): void {
  blockS3Writes();
}
