import { debug } from '@pga/logger';
import { getAiResponse } from './ai.js';
import type { InvoiceData } from './types.js';
import {
  InvoiceAttachmentParseSchema,
  parseInvoiceAttachmentsPrompt,
  type InvoiceAttachmentKind,
  type InvoiceAttachmentParseResult,
  type SupportingDocumentKind,
} from '../prompts/parse_invoice_attachments_prompt.js';
import { sanitizeSuppliersInvoiceNumber } from './invoice_memo.js';
import { normalizePurchaseOrderNumber } from './purchase_order.js';

export type { InvoiceAttachmentKind, SupportingDocumentKind };
export {
  INVOICE_ATTACHMENT_CLUSTERING_ENV_VAR,
  invoiceAttachmentClusteringMode,
  isInvoiceAttachmentClusteringEnabled,
  type InvoiceAttachmentClusteringMode,
} from './invoice_attachment_clustering_flag.js';

export interface ClusterableAttachment {
  s3Key: string;
  fileName: string;
  contentType: string;
  receivedAt?: number;
  emailContext?: InvoiceData['emailContext'];
  conversationId?: string;
  intercomAppId?: string;
  assigneeEmail?: string;
  conversationCreatedAt?: string;
}

export interface ClassifiedAttachment extends ClusterableAttachment {
  kind: InvoiceAttachmentKind;
  supportingKind?: SupportingDocumentKind | null;
  supplierName?: string | null;
  invoiceNumber?: string | null;
  purchaseOrderNumber?: string | null;
  invoiceDate?: string | null;
  amountDue?: string | null;
  confidence: number;
  reason?: string;
}

export interface InvoiceAttachmentCluster {
  primary: ClassifiedAttachment;
  supporting: ClassifiedAttachment[];
  fallback: boolean;
}

export interface InvoiceAttachmentClustering {
  clusters: InvoiceAttachmentCluster[];
  unrelated: ClassifiedAttachment[];
}

export function normalizeClusterInvoiceNumber(value?: string | null): string | undefined {
  const sanitized = sanitizeSuppliersInvoiceNumber(value);
  if (!sanitized) return undefined;
  const normalized = sanitized.replace(/[\s_]+/g, '').toUpperCase();
  return normalized || undefined;
}

const SUPPLIER_NAME_NOISE_TOKENS = new Set([
  'the', 'inc', 'incorporated', 'llc', 'llp', 'ltd', 'limited', 'co', 'corp', 'corporation', 'company', 'lp', 'plc',
]);

export function normalizeClusterSupplierName(value?: string | null): string | undefined {
  const tokens = (value ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const meaningful = tokens.filter((token) => !SUPPLIER_NAME_NOISE_TOKENS.has(token));
  const normalized = (meaningful.length ? meaningful : tokens).join(' ');
  return normalized || undefined;
}

export function supplierNamesAgree(a?: string | null, b?: string | null): boolean {
  const left = normalizeClusterSupplierName(a);
  const right = normalizeClusterSupplierName(b);
  if (!left || !right) return true;
  return left === right;
}

function purchaseOrdersMatch(a?: string | null, b?: string | null): boolean {
  const left = normalizePurchaseOrderNumber(a);
  const right = normalizePurchaseOrderNumber(b);
  return Boolean(left && right && left === right);
}

function invoiceNumbersMatch(a?: string | null, b?: string | null): boolean {
  const left = normalizeClusterInvoiceNumber(a);
  const right = normalizeClusterInvoiceNumber(b);
  return Boolean(left && right && left === right);
}

function sameInvoice(a: ClassifiedAttachment, b: ClassifiedAttachment): boolean {
  if (!invoiceNumbersMatch(a.invoiceNumber, b.invoiceNumber)) return false;
  return supplierNamesAgree(a.supplierName, b.supplierName);
}

function pickLatestPrimary(members: ClassifiedAttachment[]): ClassifiedAttachment {
  let primary = members[0];
  for (const candidate of members.slice(1)) {
    const primaryAt = primary.receivedAt ?? Number.NEGATIVE_INFINITY;
    const candidateAt = candidate.receivedAt ?? Number.NEGATIVE_INFINITY;
    if (candidateAt > primaryAt) primary = candidate;
  }
  return primary;
}

function supportingTargetCluster(
  supporting: ClassifiedAttachment,
  clusters: InvoiceAttachmentCluster[]
): InvoiceAttachmentCluster | undefined {
  if (clusters.length === 0) return undefined;
  if (clusters.length === 1) return clusters[0];

  const byInvoiceNumber = clusters.filter(
    (cluster) =>
      invoiceNumbersMatch(supporting.invoiceNumber, cluster.primary.invoiceNumber) &&
      supplierNamesAgree(supporting.supplierName, cluster.primary.supplierName)
  );
  if (byInvoiceNumber.length === 1) return byInvoiceNumber[0];

  const byPo = (byInvoiceNumber.length > 0 ? byInvoiceNumber : clusters).filter((cluster) =>
    purchaseOrdersMatch(supporting.purchaseOrderNumber, cluster.primary.purchaseOrderNumber)
  );
  if (byPo.length === 1) return byPo[0];

  const candidates = byPo.length > 0 ? byPo : byInvoiceNumber.length > 0 ? byInvoiceNumber : clusters;
  const bySupplier = candidates.filter(
    (cluster) =>
      normalizeClusterSupplierName(supporting.supplierName) &&
      supplierNamesAgree(supporting.supplierName, cluster.primary.supplierName)
  );
  if (bySupplier.length === 1) return bySupplier[0];
  return bySupplier[0] ?? candidates[0];
}

export function clusterMaxReceivedAt(files: Array<{ receivedAt?: number }>): number | undefined {
  let max: number | undefined;
  for (const file of files) {
    if (file.receivedAt != null && (max == null || file.receivedAt > max)) max = file.receivedAt;
  }
  return max;
}

export function clusterClassifiedAttachments(classified: ClassifiedAttachment[]): InvoiceAttachmentClustering {
  const invoices = classified.filter((attachment) => attachment.kind === 'supplier_invoice');
  const supporting = classified.filter((attachment) => attachment.kind === 'supporting');
  const unrelated = classified.filter((attachment) => attachment.kind === 'unrelated');

  if (invoices.length === 0) {
    if (classified.length === 0) return { clusters: [], unrelated: [] };
    // Confidence is confidence in the kind, so a confident "unrelated" file must not outrank a supporting one.
    const ranked = [...classified].sort((a, b) => {
      const aSupporting = a.kind === 'supporting' ? 0 : 1;
      const bSupporting = b.kind === 'supporting' ? 0 : 1;
      if (aSupporting !== bSupporting) return aSupporting - bSupporting;
      return b.confidence - a.confidence;
    });
    const [primary, ...rest] = ranked;
    return {
      clusters: [{ primary, supporting: rest, fallback: true }],
      unrelated: [],
    };
  }

  const groups: ClassifiedAttachment[][] = [];
  for (const invoice of invoices) {
    const group = groups.find((members) => sameInvoice(invoice, members[0]));
    if (group) {
      group.push(invoice);
    } else {
      groups.push([invoice]);
    }
  }
  const clusters: InvoiceAttachmentCluster[] = groups.map((members) => {
    const primary = pickLatestPrimary(members);
    return { primary, supporting: members.filter((member) => member !== primary), fallback: false };
  });

  for (const doc of supporting) {
    const target = supportingTargetCluster(doc, clusters);
    if (target) target.supporting.push(doc);
  }

  return { clusters, unrelated };
}

export interface ClassifiableDocument {
  fileName: string;
  contentType: string;
  buffer: Buffer;
}

function classificationFileParts(documents: ClassifiableDocument[]) {
  return documents.map((doc, index) => ({
    type: 'file' as const,
    data: doc.buffer,
    mediaType: doc.contentType,
    filename: `${index + 1}-${doc.fileName}`,
  }));
}

export async function classifyInvoiceAttachments(
  documents: ClassifiableDocument[],
  emailContext?: InvoiceData['emailContext']
): Promise<InvoiceAttachmentParseResult> {
  const fileList = documents.map((doc, index) => `${index + 1}. ${doc.fileName}`).join('\n');
  const emailText = emailContext
    ? `\n\nEmail context:\nFrom: ${emailContext.emailFrom || 'N/A'}\nSubject: ${emailContext.subject || 'N/A'}\nBody: ${(emailContext.plainTextBody || 'N/A').slice(0, 4000)}`
    : '';
  const result = (await getAiResponse({
    prompt: parseInvoiceAttachmentsPrompt,
    schema: InvoiceAttachmentParseSchema,
    tools: {},
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Classify these ${documents.length} attachment(s) for AP invoice clustering:\n${fileList}${emailText}`,
          },
          ...classificationFileParts(documents),
        ],
      },
    ],
  })) as InvoiceAttachmentParseResult;

  const parsed = InvoiceAttachmentParseSchema.safeParse(result);
  if (!parsed.success) {
    debug('Invoice attachment classification failed schema validation', { issues: parsed.error.issues });
    throw new Error('Invoice attachment classification returned an unexpected shape');
  }
  return parsed.data;
}

function findClassification(
  attachments: ClusterableAttachment[],
  classifications: InvoiceAttachmentParseResult['documents'],
  index: number
): InvoiceAttachmentParseResult['documents'][number] | undefined {
  const byNumber = classifications.filter((doc) => doc.fileNumber === index + 1);
  if (byNumber.length === 1) return byNumber[0];

  const fileName = attachments[index].fileName;
  const nameIsUnique = attachments.filter((attachment) => attachment.fileName === fileName).length === 1;
  if (nameIsUnique) {
    const byName = classifications.filter((doc) => doc.fileName === fileName);
    if (byName.length === 1) return byName[0];
  }

  return classifications.length === attachments.length ? classifications[index] : undefined;
}

export function joinClassifications(
  attachments: ClusterableAttachment[],
  classifications: InvoiceAttachmentParseResult['documents']
): ClassifiedAttachment[] {
  return attachments.map((attachment, index) => {
    const match = findClassification(attachments, classifications, index);
    if (!match) {
      debug('Invoice attachment classification missing for file; treating as supporting', {
        fileName: attachment.fileName,
        fileNumber: index + 1,
      });
      return { ...attachment, kind: 'supporting' as const, confidence: 0 };
    }
    return {
      ...attachment,
      kind: match.kind,
      supportingKind: match.supportingKind ?? null,
      supplierName: match.supplierName ?? null,
      invoiceNumber: match.invoiceNumber ?? null,
      purchaseOrderNumber: match.purchaseOrderNumber ?? null,
      invoiceDate: match.invoiceDate ?? null,
      amountDue: match.amountDue ?? null,
      confidence: match.confidence,
      reason: match.reason,
    };
  });
}

export async function parseAndClusterInvoiceAttachments(
  attachments: ClusterableAttachment[],
  loadBuffer: (s3Key: string) => Promise<Buffer>
): Promise<{ clustering: InvoiceAttachmentClustering; classified: ClassifiedAttachment[] }> {
  const buffers = await Promise.all(attachments.map((attachment) => loadBuffer(attachment.s3Key)));
  const documents = attachments.map((attachment, index) => ({
    fileName: attachment.fileName,
    contentType: attachment.contentType,
    buffer: buffers[index],
  }));
  const classifications = await classifyInvoiceAttachments(documents, attachments[0]?.emailContext);
  const classified = joinClassifications(attachments, classifications.documents);
  const clustering = clusterClassifiedAttachments(classified);
  debug('Clustered invoice attachments', {
    attachmentCount: attachments.length,
    clusterCount: clustering.clusters.length,
    unrelatedCount: clustering.unrelated.length,
    clusters: clustering.clusters.map((cluster) => ({
      primary: cluster.primary.fileName,
      supporting: cluster.supporting.map((doc) => doc.fileName),
      fallback: cluster.fallback,
    })),
  });
  return { clustering, classified };
}
