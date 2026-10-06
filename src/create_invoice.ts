import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { randomUUID } from 'node:crypto';
import { debug } from '@pga/logger';
import { withProcessorHandler, type ProcessingContext } from './lib/handlers.js';
import {
  enrichInvoiceFromAttachments,
  formatAmountNotes,
  formatCompanyNotes,
  formatEmailWorktagNotes,
  formatFreightAmountNotes,
  formatInvoiceDateNotes,
  formatInvoiceLinesNotes,
  formatInvoiceNumberNotes,
  formatMemoIdentifierNotes,
  formatPaymentTermsNotes,
  formatPurchaseOrderNotes,
  formatSupplierNotes,
  formatTaxAmountNotes,
  formatWorkQueueAssigneeNotes,
  type InvoiceAttachmentRole,
} from './lib/invoice_enrichment.js';
import {
  clusterMaxReceivedAt,
  isInvoiceAttachmentClusteringEnabled,
  normalizeClusterInvoiceNumber,
  parseAndClusterInvoiceAttachments,
  type ClassifiedAttachment,
  type ClusterableAttachment,
} from './lib/invoice_attachment_clustering.js';
import {
  acquireConversationInvoiceClaim,
  getConversationSupplierInvoice,
  releaseConversationInvoiceClaim,
  upsertConversationSupplierInvoice,
  type ConversationSupplierInvoice,
} from './lib/conversation_invoices.js';
import {
  applyInvoiceMemoIdentifiersToLines,
  composeInvoiceMemo,
  composeSuppliersInvoiceNumber,
  supplierNameForInvoiceNumber,
  memoIdentifiersFromEnrichment,
} from './lib/invoice_memo.js';
import { getCostCenterRelatedLobsByCodes, getCostCenterWorkdayIdsByCodes, getOrgWorktagKindsByIds } from './lib/database.js';
import { employeeDisplayName, getEmployeeWidByEmail } from './lib/employees.js';
import {
  applyDefaultCompanyLineWorktags,
  buildFinalInvoiceLines,
  chargeReconciliationMessages,
  formatChargeReconciliationNotes,
  normalizeSupplierInvoiceLineAmounts,
  overlaySharedPoWorktagsOnUnmatchedLines,
  parseExtractedAmount,
  reconcileSubmittedCharges,
  resolveInvoiceLineQuantityDisplayed,
  splitFreightLines,
  withComposedLineDescriptions,
} from './lib/invoice_lines.js';
import {
  findPurchaseOrderNumber,
  normalizePurchaseOrderNumber,
  type PurchaseOrderEnrichmentContext,
} from './lib/purchase_order.js';
import { getBinaryFromS3, getPresignedUrl } from './lib/s3.js';
import { notifyResult } from './lib/slack.js';
import type { InvoiceData, WorkdayInvoice } from './lib/types.js';
import { buildIntercomConversationUrl } from './lib/intercom.js';
import {
  costCenterCodeExcludingCompany,
  resolveCompanyFromEmail,
  selectCompanyForCreateInvoice,
} from './lib/reference_ids.js';
import {
  claimInvoiceCluster,
  createInvoiceClusterPlan,
  finishInvoiceCluster,
  markInvoiceClusterUndispatched,
  releaseInvoiceCluster,
} from './lib/invoice_cluster_plans.js';
import {
  formatPurchaseOrderLineFallbackNotes,
  getSupplierInvoiceEditability,
  isPurchaseOrderClosedForInvoicing,
  isPurchaseOrderLineFallback,
  loadPurchaseOrder,
  markPurchaseOrderLineAvailability,
  purchaseOrderLineFallbackNote,
  submitNewSupplierInvoice,
  submitSupplierInvoiceUpdate,
  type AppliedFallback,
  type ParsedPurchaseOrder,
} from './lib/workday.js';

function toPurchaseOrderEnrichmentContext(
  purchaseOrder: ParsedPurchaseOrder
): PurchaseOrderEnrichmentContext {
  return {
    documentNumber: purchaseOrder.documentNumber,
    company: purchaseOrder.company
      ? { workdayId: purchaseOrder.company.workdayId, name: purchaseOrder.company.descriptor }
      : undefined,
    lines: purchaseOrder.lines.map(line => ({
      lineOrder: line.lineOrder,
      purchaseOrderLineId: line.purchaseOrderLineId,
      description: line.description,
      memo: line.memo,
    })),
  };
}

async function resolvePurchaseOrder(
  context: ProcessingContext,
  fileName: string,
  emailContext?: InvoiceData['emailContext']
): Promise<ParsedPurchaseOrder | undefined> {
  const purchaseOrderNumber = findPurchaseOrderNumber(
    emailContext?.subject,
    emailContext?.plainTextBody,
    fileName
  );
  if (!purchaseOrderNumber) return undefined;

  debug(`Fetching PO data before enrichment: ${purchaseOrderNumber}`);
  return loadPurchaseOrder(context, purchaseOrderNumber);
}

const DEFAULT_SUPPLIER_WID = process.env.WORKDAY_DEFAULT_SUPPLIER_WID;
const DEFAULT_COMPANY_WID = process.env.WORKDAY_DEFAULT_COMPANY_WID;
const DEFAULT_COMPANY_NAME = process.env.WORKDAY_DEFAULT_COMPANY_NAME
  || 'Default OCR Company';
const DEFAULT_COMPANY_REFERENCE_ID = 'Default_OCR_Company';
const INVOICE_MOD_ENABLED = process.env.INVOICE_MOD_ENABLED !== 'false'; // enabled by default
const INTERCOM_APP_ID = process.env.INTERCOM_APP_ID;

function resolveDefaultCompany(): {
  descriptor: string;
  id: string;
  companyReferenceType: 'WID' | 'Company_Reference_ID';
} {
  if (DEFAULT_COMPANY_WID) {
    return { descriptor: DEFAULT_COMPANY_NAME, id: DEFAULT_COMPANY_WID, companyReferenceType: 'WID' };
  }
  return {
    descriptor: DEFAULT_COMPANY_NAME,
    id: DEFAULT_COMPANY_REFERENCE_ID,
    companyReferenceType: 'Company_Reference_ID',
  };
}

function enrichmentStubCompany(parsedPo?: ParsedPurchaseOrder) {
  if (parsedPo?.company) {
    return { descriptor: parsedPo.company.descriptor, id: parsedPo.company.workdayId };
  }
  const fallback = resolveDefaultCompany();
  return { descriptor: fallback.descriptor, id: fallback.id };
}

export interface CreateInvoiceAttachment extends ClusterableAttachment {
  kind?: ClassifiedAttachment['kind'];
  supportingKind?: ClassifiedAttachment['supportingKind'];
  supplierName?: ClassifiedAttachment['supplierName'];
  invoiceNumber?: ClassifiedAttachment['invoiceNumber'];
  purchaseOrderNumber?: ClassifiedAttachment['purchaseOrderNumber'];
  invoiceDate?: ClassifiedAttachment['invoiceDate'];
  amountDue?: ClassifiedAttachment['amountDue'];
  confidence?: number;
}

export interface CreateInvoiceRequest {
  s3Key?: string;
  fileName?: string;
  contentType?: string;
  attachments?: CreateInvoiceAttachment[];
  clustered?: boolean;
  shadow?: boolean;
  emailContext?: InvoiceData['emailContext'];
  conversationId?: string;
  intercomAppId?: string;
  assigneeEmail?: string;
  conversationCreatedAt?: string;
  latestMessageAt?: number;
  /** Newest `receivedAt` among files grouped into the conversation's other invoice clusters. */
  otherClustersLatestReceivedAt?: number;
  /** Cluster plan row this fanned-out record processes (`invoice_cluster_plans`). */
  planId?: string;
  clusterIndex?: number;
  conversationPdf?: {
    s3Key: string;
    fileName: string;
  };
}

function intercomConversationUrl(conversationId?: string, intercomAppId?: string): string | undefined {
  return conversationId
    ? buildIntercomConversationUrl(conversationId, INTERCOM_APP_ID || intercomAppId)
    : undefined;
}

function slackInvoiceDetails(
  details: Record<string, unknown>,
  conversationId?: string,
  intercomAppId?: string
): Record<string, unknown> {
  const conversationUrl = intercomConversationUrl(conversationId, intercomAppId);
  return {
    ...details,
    ...(conversationId ? { conversationId } : {}),
    ...(conversationUrl ? { conversationUrl } : {}),
  };
}

// Processor function - invoked by trigger_create_invoice
export const processor = withProcessorHandler(async (context, requests) => {
  for (const request of requests) {
    await processNewInvoice(context, request as CreateInvoiceRequest);
  }
});

function requestFilenames(request: CreateInvoiceRequest): string[] {
  if (request.attachments?.length) return request.attachments.map((attachment) => attachment.fileName);
  return request.fileName ? [request.fileName] : [];
}

async function fanOutCluster(
  clusterFiles: CreateInvoiceAttachment[],
  shared: Pick<
    CreateInvoiceRequest,
    'emailContext' | 'conversationId' | 'intercomAppId' | 'assigneeEmail' | 'conversationCreatedAt' | 'conversationPdf' | 'latestMessageAt' | 'otherClustersLatestReceivedAt' | 'planId' | 'clusterIndex'
  >
): Promise<void> {
  if (!process.env.AWS_STACK_NAME) {
    throw new Error('AWS_STACK_NAME is required to fan out invoice clusters');
  }
  const lambda = new LambdaClient({ region: process.env.AWS_REGION });
  await lambda.send(new InvokeCommand({
    FunctionName: `${process.env.AWS_STACK_NAME}-CreateInvoiceProcessor`,
    InvocationType: 'Event',
    Payload: JSON.stringify({
      data: [{ ...shared, attachments: clusterFiles, clustered: true }],
      page: 1,
      totalPages: 1,
    }),
  }));
}

async function reportShadowClustering(context: ProcessingContext, request: CreateInvoiceRequest): Promise<void> {
  const startTime = Date.now();
  const attachments = request.attachments ?? [];
  const details = { mode: 'shadow', attachments: requestFilenames(request) };
  try {
    const { clustering } = await parseAndClusterInvoiceAttachments(
      attachments,
      (key) => getBinaryFromS3(context.s3Config, key)
    );
    const describe = (file: ClassifiedAttachment) =>
      `${file.fileName} (${file.kind}${file.supportingKind ? `: ${file.supportingKind}` : ''}${file.invoiceNumber ? `, #${file.invoiceNumber}` : ''})`;
    await notifyResult('create_invoice_shadow', 'success', Date.now() - startTime, slackInvoiceDetails({
      ...details,
      wouldCreateInvoices: clustering.clusters.length,
      clusters: clustering.clusters.map((cluster) => ({
        invoice: describe(cluster.primary),
        ...(cluster.supporting.length ? { supporting: cluster.supporting.map(describe) } : {}),
        ...(cluster.fallback ? { fallback: true } : {}),
      })),
      ...(clustering.unrelated.length ? { unrelated: clustering.unrelated.map(describe) } : {}),
      note: 'Shadow mode: invoices were created one per PDF as usual; nothing was written from this plan.',
    }, request.conversationId, request.intercomAppId));
  } catch (error) {
    debug('Shadow attachment clustering failed:', error);
    await notifyResult(
      'create_invoice_shadow',
      'error',
      Date.now() - startTime,
      slackInvoiceDetails(details, request.conversationId, request.intercomAppId),
      error
    );
    throw error;
  }
}

async function processNewInvoice(context: ProcessingContext, request: CreateInvoiceRequest): Promise<void> {
  if (request.shadow) {
    // A shadow record never writes to Workday or the registry, whatever this container's flag says.
    await reportShadowClustering(context, request);
    return;
  }
  const startTime = Date.now();
  const {
    s3Key,
    fileName,
    contentType,
    attachments,
    clustered,
    emailContext,
    conversationId,
    intercomAppId,
    assigneeEmail,
    conversationCreatedAt,
    conversationPdf,
    latestMessageAt,
    otherClustersLatestReceivedAt,
    planId: requestPlanId,
    clusterIndex: requestClusterIndex,
  } = request;
  const clusteringEnabled = isInvoiceAttachmentClusteringEnabled();

  if (!INVOICE_MOD_ENABLED) {
    debug('Invoice modification is disabled - skipping new invoice creation', { s3Key, fileName });
    await notifyResult(
      'create_invoice',
      'error',
      Date.now() - startTime,
      slackInvoiceDetails({ s3Key, fileName, ...(attachments?.length ? { attachments: requestFilenames(request) } : {}) }, conversationId, intercomAppId),
      new Error('INVOICE_MOD_ENABLED is false; cannot create new invoices')
    );
    return;
  }

  if (clusteringEnabled && attachments?.length && !clustered) {
    let firstClusterFiles: CreateInvoiceAttachment[] = [];
    let firstOtherClustersLatestReceivedAt: number | undefined;
    let unrelated: ClassifiedAttachment[] = [];
    const preloadedBuffers = new Map<string, Buffer>();
    const planId = randomUUID();
    let clusterCount = 0;
    const undispatched: Array<{ clusterIndex: number; files: CreateInvoiceAttachment[] }> = [];
    try {
      const { clustering } = await parseAndClusterInvoiceAttachments(
        attachments,
        async (key) => {
          const buffer = await getBinaryFromS3(context.s3Config, key);
          preloadedBuffers.set(key, buffer);
          return buffer;
        }
      );
      if (clustering.clusters.length === 0) {
        throw new Error('Invoice attachment clustering returned no clusters');
      }
      const clusterFiles = clustering.clusters.map((cluster) => [cluster.primary, ...cluster.supporting]);
      const othersLatest = (index: number) =>
        clusterMaxReceivedAt(clusterFiles.filter((_, other) => other !== index).flat());
      firstClusterFiles = clusterFiles[0];
      firstOtherClustersLatestReceivedAt = othersLatest(0);
      unrelated = clustering.unrelated;
      clusterCount = clusterFiles.length;
      // Every cluster is recorded before anything is dispatched or written, so each one runs once and a
      // cluster that never ran stays visible.
      await createInvoiceClusterPlan(
        context.dbConnection,
        planId,
        conversationId,
        clusterFiles.map((files) => files.map((file) => file.fileName))
      );
      const shared = { emailContext, conversationId, intercomAppId, assigneeEmail, conversationCreatedAt, conversationPdf, latestMessageAt };
      const dispatches = await Promise.allSettled(
        clusterFiles.slice(1).map((files, offset) => {
          const otherLatest = othersLatest(offset + 1);
          return fanOutCluster(files, {
            ...shared,
            planId,
            clusterIndex: offset + 1,
            ...(otherLatest != null ? { otherClustersLatestReceivedAt: otherLatest } : {}),
          });
        })
      );
      dispatches.forEach((dispatch, offset) => {
        if (dispatch.status === 'rejected') {
          const reason: unknown = dispatch.reason;
          debug('Failed to dispatch invoice cluster', { planId, clusterIndex: offset + 1, error: reason });
          undispatched.push({ clusterIndex: offset + 1, files: clusterFiles[offset + 1] });
        }
      });
    } catch (error) {
      const processingTime = Date.now() - startTime;
      debug('Error clustering invoice attachments:', error);
      await notifyResult(
        'create_invoice',
        'error',
        processingTime,
        slackInvoiceDetails({ attachments: requestFilenames(request) }, conversationId, intercomAppId),
        error
      );
      throw error;
    }
    for (const { clusterIndex } of undispatched) {
      await markInvoiceClusterUndispatched(context.dbConnection, planId, clusterIndex).catch((error: unknown) => {
        debug('Failed to mark undispatched invoice cluster', { planId, clusterIndex, error });
      });
    }
    try {
      await createInvoiceFromCluster(context, {
        files: firstClusterFiles,
        unrelated,
        emailContext,
        conversationId,
        intercomAppId,
        assigneeEmail,
        conversationCreatedAt,
        conversationPdf,
        latestMessageAt,
        otherClustersLatestReceivedAt: firstOtherClustersLatestReceivedAt,
        preloadedBuffers,
        plan: { planId, clusterIndex: 0 },
        startTime,
        clustered: true,
      });
    } finally {
      if (undispatched.length) {
        await notifyResult(
          'create_invoice',
          'error',
          Date.now() - startTime,
          slackInvoiceDetails({
            planId,
            undispatchedClusters: undispatched.map(({ files }) => files.map((file) => file.fileName)),
          }, conversationId, intercomAppId),
          new Error(
            `${undispatched.length} of ${clusterCount} invoice clusters could not be dispatched and were not processed. ` +
            'Re-trigger the conversation to process them; invoices already created for this conversation are not duplicated.'
          )
        );
      }
    }
    return;
  }

  // A processor whose cached flag is off never groups, even for a clustered fan-out record, so a
  // flag flip mid-flight falls back to one invoice per PDF rather than a cluster the registry skips.
  if (attachments?.length && clusteringEnabled) {
    await createInvoiceFromCluster(context, {
      files: attachments,
      unrelated: [],
      emailContext,
      conversationId,
      intercomAppId,
      assigneeEmail,
      conversationCreatedAt,
      conversationPdf,
      latestMessageAt,
      otherClustersLatestReceivedAt,
      ...(clustered && requestPlanId && requestClusterIndex != null
        ? { plan: { planId: requestPlanId, clusterIndex: requestClusterIndex } }
        : {}),
      startTime,
      clustered: true,
    });
    return;
  }

  if (attachments?.length) {
    for (const attachment of attachments) {
      await createInvoiceFromCluster(context, {
        files: [attachment],
        unrelated: [],
        emailContext: attachment.emailContext ?? emailContext,
        conversationId: attachment.conversationId ?? conversationId,
        intercomAppId: attachment.intercomAppId ?? intercomAppId,
        assigneeEmail: attachment.assigneeEmail ?? assigneeEmail,
        conversationCreatedAt: attachment.conversationCreatedAt ?? conversationCreatedAt,
        conversationPdf,
        startTime: Date.now(),
        clustered: false,
      });
    }
    return;
  }

  if (!s3Key || !fileName || !contentType) {
    throw new Error('CreateInvoice request has no attachment');
  }
  await createInvoiceFromCluster(context, {
    files: [{
      s3Key,
      fileName,
      contentType,
      ...(emailContext ? { emailContext } : {}),
    }],
    unrelated: [],
    emailContext,
    conversationId,
    intercomAppId,
    assigneeEmail,
    conversationCreatedAt,
    conversationPdf,
    startTime,
    clustered: false,
  });
}

interface ClusterInvoiceInput {
  files: CreateInvoiceAttachment[];
  unrelated: ClassifiedAttachment[];
  emailContext?: InvoiceData['emailContext'];
  conversationId?: string;
  intercomAppId?: string;
  assigneeEmail?: string;
  conversationCreatedAt?: string;
  conversationPdf?: {
    s3Key: string;
    fileName: string;
  };
  latestMessageAt?: number;
  otherClustersLatestReceivedAt?: number;
  /** Buffers already downloaded for classification in this invocation, keyed by S3 key. */
  preloadedBuffers?: Map<string, Buffer>;
  /** Cluster plan row this run owns; claimed before any work so a duplicate delivery does nothing. */
  plan?: { planId: string; clusterIndex: number };
  startTime: number;
  clustered: boolean;
}

/** Set while processing a cluster so the wrapper can finish the plan row and release the invoice claim. */
interface ClusterRunState {
  invoiceClaim?: { conversationId: string; supplierInvoiceNumber: string; claimToken: string };
  /** Another run held the invoice claim, so this run did no Workday or registry work. */
  invoiceClaimContended?: boolean;
  workdayInvoiceWid?: string;
}

interface LoadedClusterFile extends CreateInvoiceAttachment {
  buffer: Buffer;
  presignedUrl: string;
}

function clusterSlackAttachments(files: LoadedClusterFile[]): Array<Record<string, unknown>> {
  return files.map((file, index) => ({
    fileName: file.fileName,
    contentType: file.contentType,
    sizeBytes: file.buffer.length,
    role: index === 0 ? 'invoice' : 'supporting',
    ...(file.kind ? { kind: file.kind } : {}),
    ...(file.supportingKind ? { supportingKind: file.supportingKind } : {}),
    includedInline: true,
  }));
}

async function createInvoiceFromCluster(context: ProcessingContext, input: ClusterInvoiceInput): Promise<void> {
  const { plan } = input;
  if (plan && !(await claimInvoiceCluster(context.dbConnection, plan.planId, plan.clusterIndex))) {
    debug('Invoice cluster already done or being processed by another run; skipping', plan);
    return;
  }
  const run: ClusterRunState = {};
  try {
    await processInvoiceCluster(context, input, run);
    if (plan && run.invoiceClaimContended) {
      await releaseInvoiceCluster(context.dbConnection, plan.planId, plan.clusterIndex)
        .catch((error: unknown) => debug('Failed to release contended invoice cluster', { ...plan, error }));
    } else if (plan) {
      await markInvoiceClusterDone(context, input, plan, run.workdayInvoiceWid);
    }
  } catch (error) {
    if (plan) {
      // Once Workday accepted the invoice, a later failure must not make the cluster retryable.
      if (run.workdayInvoiceWid) {
        await markInvoiceClusterDone(context, input, plan, run.workdayInvoiceWid);
      } else {
        await finishInvoiceCluster(context.dbConnection, plan.planId, plan.clusterIndex, 'failed')
          .catch((finishError: unknown) => debug('Failed to mark invoice cluster failed', { ...plan, error: finishError }));
      }
    }
    throw error;
  } finally {
    const claim = run.invoiceClaim;
    if (claim) {
      await releaseConversationInvoiceClaim(context.dbConnection, claim.conversationId, claim.supplierInvoiceNumber, claim.claimToken)
        .catch((error: unknown) => debug('Failed to release conversation invoice claim', { ...claim, error }));
    }
  }
}

async function markInvoiceClusterDone(
  context: ProcessingContext,
  input: ClusterInvoiceInput,
  plan: { planId: string; clusterIndex: number },
  workdayInvoiceWid: string | undefined
): Promise<void> {
  try {
    await finishInvoiceCluster(context.dbConnection, plan.planId, plan.clusterIndex, 'done', workdayInvoiceWid);
  } catch (error) {
    // The row stays processing and becomes claimable after the TTL, so AP must know it may be reprocessed.
    debug('Failed to mark invoice cluster done', { ...plan, error });
    await notifyResult(
      'create_invoice',
      'error',
      Date.now() - input.startTime,
      slackInvoiceDetails({
        ...plan,
        ...(workdayInvoiceWid ? { invoiceWID: workdayInvoiceWid } : {}),
        attachments: input.files.map((file) => file.fileName),
      }, input.conversationId, input.intercomAppId),
      new Error('The invoice was processed but its cluster plan row could not be marked done; a later retry of this cluster could process it again.')
    );
  }
}

async function processInvoiceCluster(
  context: ProcessingContext,
  input: ClusterInvoiceInput,
  run: ClusterRunState
): Promise<void> {
  const {
    files,
    unrelated,
    emailContext: requestEmailContext,
    conversationId,
    intercomAppId,
    assigneeEmail,
    conversationCreatedAt,
    conversationPdf,
    latestMessageAt,
    otherClustersLatestReceivedAt,
    preloadedBuffers,
    startTime,
    clustered,
  } = input;
  const [primary] = files;
  const { s3Key, fileName, contentType } = primary;
  const emailContext = requestEmailContext ?? primary.emailContext;

  try {
    debug(`Processing new invoice from S3: ${s3Key}`, clustered ? { clusterFiles: files.map((file) => file.fileName) } : {});
    const loaded: LoadedClusterFile[] = await Promise.all(files.map(async (file) => {
      const [buffer, presignedUrl] = await Promise.all([
        preloadedBuffers?.get(file.s3Key) ?? getBinaryFromS3(context.s3Config, file.s3Key),
        getPresignedUrl(context.s3Config, file.s3Key),
      ]);
      return { ...file, buffer, presignedUrl };
    }));
    const conversationPdfBuffer = conversationPdf
      ? await getBinaryFromS3(context.s3Config, conversationPdf.s3Key)
      : undefined;
    const toSubmitAttachment = (file: LoadedClusterFile) => ({
      fileName: file.fileName,
      contentType: file.contentType,
      base64Content: file.buffer.toString('base64'),
    });
    const transcriptAttachments = conversationPdf && conversationPdfBuffer ? [{
      fileName: conversationPdf.fileName,
      contentType: 'application/pdf',
      base64Content: conversationPdfBuffer.toString('base64'),
    }] : [];
    const submitAttachments = [...loaded.map(toSubmitAttachment), ...transcriptAttachments];
    const buffer = loaded[0].buffer;
    // Resends often reuse one name (for example two `Invoice.pdf` versions in one cluster), so enrichment
    // sees numbered names, matching classification, to tell the invoice from its backup.
    const numberFileNames = clustered && loaded.length > 1;
    const enrichmentFileName = (file: LoadedClusterFile, index: number) =>
      numberFileNames ? `${index + 1}-${file.fileName}` : file.fileName;
    const processedAttachments = loaded.map((file, index) => ({
      id: file.s3Key,
      fileName: enrichmentFileName(file, index),
      contentType: file.contentType,
      presignedUrl: file.presignedUrl,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      s3Key: file.s3Key,
      buffer: file.buffer,
    }));
    const attachmentRoles: InvoiceAttachmentRole[] | undefined =
      numberFileNames
        ? loaded.map((file, index) => ({
          fileName: enrichmentFileName(file, index),
          role: index === 0 ? 'invoice' as const : 'supporting' as const,
        }))
        : undefined;

    // Enrich against a stub with no existing supplier, even on a resend update, so the latest documents
    // decide the supplier. Prefer the PO company when a matching PO is found;
    // otherwise use Default OCR Company.
    const stubInvoice: WorkdayInvoice = {};
    const parsedPo = await resolvePurchaseOrder(context, fileName, emailContext);
    const stubCompany = enrichmentStubCompany(parsedPo);

    const result = await enrichInvoiceFromAttachments(
      stubInvoice,
      processedAttachments,
      undefined,
      stubCompany,
      emailContext,
      parsedPo ? toPurchaseOrderEnrichmentContext(parsedPo) : undefined,
      attachmentRoles
    );
    debug('Enrichment result:', result);

    if (result.supplier.status === 'error') {
      throw new Error(`Invoice enrichment returned error status: ${result.supplier.reason}`);
    }

    const extractedInvoiceDate = result.extractedInvoiceDate || undefined;

    const targetSupplierWID = result.supplier.resolvedSupplier?.workdayId ?? DEFAULT_SUPPLIER_WID;
    const recommendedCompanyWID = result.companyVerification?.status === 'different'
      ? result.companyVerification.recommended?.workdayId ?? undefined
      : undefined;
    const emailCompany = await resolveCompanyFromEmail({
      db: context.dbConnection,
      emailBody: emailContext?.plainTextBody,
      emailCompany: result.emailWorktags?.company,
    });

    const extractedSuppliersInvoiceNumber = composeSuppliersInvoiceNumber({
      invoiceNumber: result.extractedSuppliersInvoiceNumber,
      accountNumber: result.extractedAccountNumber,
      invoiceDate: extractedInvoiceDate,
      supplierName: supplierNameForInvoiceNumber(
        result.supplier.extractedInformation?.supplierName,
        result.supplier.resolvedSupplier?.supplierName,
      ),
    });
    const extractedAmountDue = result.extractedAmountDue ?? undefined;
    const extractedTaxAmount = result.extractedTaxAmount ?? undefined;
    const enrichmentPoNumber = normalizePurchaseOrderNumber(result.extractedPurchaseOrderNumber);
    let matchedPo = parsedPo;
    if (enrichmentPoNumber && enrichmentPoNumber !== matchedPo?.documentNumber) {
      debug(`Fetching PO data for extracted PO number: ${enrichmentPoNumber}`);
      matchedPo = await loadPurchaseOrder(context, enrichmentPoNumber);
    }

    const poCompanyWID = matchedPo?.company?.workdayId;
    const defaultCompany = resolveDefaultCompany();
    const selectedCompany = selectCompanyForCreateInvoice({
      emailCompany,
      recommendedCompanyWID,
      poCompanyWID,
      defaultCompany: { companyId: defaultCompany.id, companyReferenceType: defaultCompany.companyReferenceType },
    });
    const companyWID = selectedCompany.companyId;
    const companyReferenceType = selectedCompany.companyReferenceType;
    const usedDefaultCompany = selectedCompany.source === 'default';
    const extractedPurchaseOrderNumber = matchedPo?.documentNumber ?? enrichmentPoNumber;
    const matchedPoLines = usedDefaultCompany ? undefined : matchedPo?.lines;
    const poClosedForInvoicing = Boolean(matchedPoLines?.length) && isPurchaseOrderClosedForInvoicing(matchedPo);
    const poLines = poClosedForInvoicing ? matchedPoLines : markPurchaseOrderLineAvailability(matchedPoLines);
    if (poClosedForInvoicing) {
      debug(`PO ${matchedPo?.documentNumber} is ${matchedPo?.documentStatus?.descriptor ?? matchedPo?.documentStatus?.id}; coding lines from the PO without Purchase_Order_Line_Reference`);
    }
    const purchaseOrderLineFallbackLabel = (label: string) =>
      purchaseOrderLineFallbackNote(label, extractedPurchaseOrderNumber) ?? label;
    const memoIdentifiers = memoIdentifiersFromEnrichment(result, extractedPurchaseOrderNumber);
    const memo = composeInvoiceMemo({
      ...memoIdentifiers,
      description: result.supplier.extractedInformation?.memo,
    });

    debug(`Supplier resolution: status=${result.supplier.status}, targetSupplierWID=${targetSupplierWID ?? 'none'}`);
    debug(`Company resolution: status=${result.companyVerification?.status}, emailCompany=${emailCompany?.referenceId ?? emailCompany?.workdayId ?? 'none'}, poCompany=${poCompanyWID ?? 'none'}, companyWID=${companyWID} (${companyReferenceType})`);

    const { merchandiseLines, freightAmountFromLines } = splitFreightLines(
      (result.extractedInvoiceLines ?? [])
        .filter(l => l.description && (l.totalPrice || l.unitCost))
    );
    const extractedFreightAmount = result.extractedFreightAmount
      ?? (freightAmountFromLines != null ? String(freightAmountFromLines) : undefined);
    const chargeReconciliation = reconcileSubmittedCharges(merchandiseLines, {
      amountDue: extractedAmountDue,
      freight: extractedFreightAmount,
      tax: extractedTaxAmount,
    });
    const chargeCheck = chargeReconciliationMessages(chargeReconciliation);
    if (chargeCheck.length) debug('Invoice amount check', { chargeCheck });
    const candidateLines = withComposedLineDescriptions(chargeReconciliation.lines);

    const invoiceLineQuantityDisplayed = resolveInvoiceLineQuantityDisplayed(
      result.invoiceLineQuantityDisplayed,
      candidateLines
    );

    const fallbackIds = {
      fundId: process.env.FALLBACK_FUND_ID,
      costCenterId: process.env.FALLBACK_COST_CENTER_ID,
      spendCategoryId: process.env.FALLBACK_SPEND_CATEGORY_ID,
      lineOfBusinessId: process.env.FALLBACK_LOB_ID,
    };
    const emailWorktags = usedDefaultCompany
      ? undefined
      : (result.emailWorktags ? {
          costCenterId: costCenterCodeExcludingCompany(result.emailWorktags.costCenter?.code, emailCompany),
          eventWid: result.emailWorktags.event?.workdayId ?? null,
          lobReferenceId: result.emailWorktags.lineOfBusiness?.referenceId ?? null,
          fundReferenceId: result.emailWorktags.fund?.referenceId ?? null,
          spendCategoryReferenceId: result.emailWorktags.spendCategory?.referenceId ?? null,
        } : undefined);

    const relatedLobLookup = (costCenterIds: string[]) =>
      getCostCenterRelatedLobsByCodes(context.dbConnection, costCenterIds);
    const merged = await buildFinalInvoiceLines(
      candidateLines,
      poLines,
      emailContext?.plainTextBody,
      fallbackIds,
      emailWorktags,
      relatedLobLookup,
      invoiceLineQuantityDisplayed,
      // A Closed or Pending Close PO omits every line reference, so it skips date-based selection.
      poClosedForInvoicing ? undefined : { invoiceDate: extractedInvoiceDate, servicePeriod: result.extractedServicePeriod }
    );
    let relatedLobByCostCenter = merged.relatedLobByCostCenter;
    let finalLines = merged.lines;

    // Workday requires at least one invoice line to create a Supplier Invoice. If nothing
    // could be extracted or matched to a PO, synthesize a single line from the merchandise
    // remainder (amount due minus freight and tax). Do not re-include freight in that line.
    if (finalLines.length === 0) {
      const amountDue = extractedAmountDue ? parseExtractedAmount(extractedAmountDue) : undefined;
      const freight = extractedFreightAmount ? parseExtractedAmount(extractedFreightAmount) : 0;
      const tax = extractedTaxAmount ? parseExtractedAmount(extractedTaxAmount) : 0;
      const remainder = amountDue != null
        ? Math.round((amountDue - (freight ?? 0) - (tax ?? 0)) * 100) / 100
        : undefined;
      if (remainder != null && remainder > 0) {
        debug('No merchandise invoice lines remain after excluding freight; synthesizing a line from the non-freight remainder');
        const synthetic = await buildFinalInvoiceLines(
          [{
            // Keep memo on the invoice header. A freight-like memo would be
            // stripped again in the SOAP builder and drop this remainder line.
            description: 'Invoice',
            quantity: invoiceLineQuantityDisplayed ? 1 : null,
            unitCost: invoiceLineQuantityDisplayed ? String(remainder) : null,
            totalPrice: String(remainder),
            hasDiscount: null,
          }],
          undefined,
          emailContext?.plainTextBody,
          fallbackIds,
          emailWorktags,
          relatedLobLookup,
          invoiceLineQuantityDisplayed
        );
        finalLines = overlaySharedPoWorktagsOnUnmatchedLines(synthetic.lines, poLines);
        relatedLobByCostCenter = synthetic.relatedLobByCostCenter;
      } else if (remainder != null && remainder <= 0) {
        debug('No merchandise invoice lines remain after excluding freight; submitting Freight_Amount without a merchandise line');
      } else if (!extractedFreightAmount) {
        debug('No invoice lines could be extracted or matched to a PO; synthesizing a single line from the extracted total');
        const synthetic = await buildFinalInvoiceLines(
          [{
            description: 'Invoice',
            quantity: invoiceLineQuantityDisplayed ? 1 : null,
            unitCost: invoiceLineQuantityDisplayed ? (extractedAmountDue ?? null) : null,
            totalPrice: extractedAmountDue ?? null,
            hasDiscount: null,
          }],
          undefined,
          emailContext?.plainTextBody,
          fallbackIds,
          emailWorktags,
          relatedLobLookup,
          invoiceLineQuantityDisplayed
        );
        finalLines = overlaySharedPoWorktagsOnUnmatchedLines(synthetic.lines, poLines);
        relatedLobByCostCenter = synthetic.relatedLobByCostCenter;
      } else {
        debug('No merchandise invoice lines remain after excluding freight; submitting Freight_Amount without a merchandise line');
      }
    }

    if (usedDefaultCompany && finalLines.length > 0) {
      finalLines = applyDefaultCompanyLineWorktags(finalLines, fallbackIds);
      relatedLobByCostCenter = new Map();
    }

    if (finalLines.length > 0) {
      finalLines = applyInvoiceMemoIdentifiersToLines(finalLines, memoIdentifiers);
      finalLines = normalizeSupplierInvoiceLineAmounts(finalLines, invoiceLineQuantityDisplayed);
    }

    const appliedRecommended = selectedCompany.source === 'recommended';
    // existingCompany here is a synthetic placeholder fed to the AI for comparison, not a
    // real prior state (this is a brand-new invoice) — omit it from the note's "was" wording.
    const emailWorktagNotes = formatEmailWorktagNotes(result);
    const emailOrDefaultWorktagNotes = usedDefaultCompany
      ? (emailWorktagNotes
        ? '\n\nLine worktags: Default OCR fallback coding applied; email worktags were not used on this invoice.'
        : '')
      : emailWorktagNotes;
    const assigneeMatch = await getEmployeeWidByEmail(context.dbConnection, assigneeEmail);
    const assigneeName = assigneeMatch ? employeeDisplayName(assigneeMatch) : undefined;
    if (assigneeEmail && !assigneeMatch) {
      debug('Assignee email did not match AP agent workers report cache; omitting Assignee_Reference', {
        assigneeEmail,
      });
    }

    const baseNotes = formatSupplierNotes(result) + formatCompanyNotes(result, undefined, { appliedRecommended }) + formatInvoiceDateNotes(result) + formatAmountNotes(result) + formatFreightAmountNotes(result) + formatTaxAmountNotes(result) + formatChargeReconciliationNotes(chargeReconciliation) + formatInvoiceNumberNotes(result) + formatPurchaseOrderNotes(result) + formatMemoIdentifierNotes(result) + formatInvoiceLinesNotes(result, invoiceLineQuantityDisplayed) + formatPaymentTermsNotes(result) + emailOrDefaultWorktagNotes;
    const buildNotes = (appliedFallbacks: AppliedFallback[]) => {
      const assigneeOmitted = appliedFallbacks.some((f) => f.label === 'omitted assignee');
      const listedFallbacks = appliedFallbacks.filter((f) => !isPurchaseOrderLineFallback(f));
      return baseNotes
        + formatWorkQueueAssigneeNotes(appliedFallbacks, {
          assigneeEmail,
          assigneeName,
          assigneeSetInWorkday: Boolean(assigneeMatch) && !assigneeOmitted,
        })
        + formatPurchaseOrderLineFallbackNotes(appliedFallbacks, extractedPurchaseOrderNumber)
        + (listedFallbacks.length ? `\n\nFallback values applied: ${listedFallbacks.map(f => f.label).join('; ')}` : '');
    };

    const paymentTermsId = result.extractedPaymentTerms?.workdayId ?? undefined;
    const conversationUrl = intercomConversationUrl(conversationId, intercomAppId);

    const companyNotification = selectedCompany.source === 'email' && emailCompany ? {
      status: 'email_resolved',
      appliedFrom: 'email',
      appliedFromEmail: true,
      appliedName: emailCompany.name,
      appliedId: companyWID,
      appliedReferenceId: emailCompany.referenceId,
      recommendedName: result.companyVerification?.recommended?.companyName,
    } : selectedCompany.source === 'po' ? {
      status: 'po',
      appliedFrom: 'po',
      appliedName: matchedPo?.company?.descriptor,
      appliedId: companyWID,
      recommendedName: result.companyVerification?.recommended?.companyName,
    } : selectedCompany.source === 'recommended' ? {
      status: result.companyVerification?.status ?? 'different',
      appliedFrom: 'recommended',
      appliedName: result.companyVerification?.recommended?.companyName,
      appliedId: companyWID,
      recommendedName: result.companyVerification?.recommended?.companyName,
    } : {
      status: 'default',
      appliedFrom: 'default',
      appliedName: defaultCompany.descriptor,
      appliedId: companyWID,
    };

    const sharedSlackDetails = {
      attachment: {
        fileName,
        contentType,
        sizeBytes: buffer.length,
        includedInline: true,
      },
      ...(clustered ? { attachments: clusterSlackAttachments(loaded) } : {}),
      ...(unrelated.length ? { unrelatedAttachments: unrelated.map((doc) => doc.fileName) } : {}),
      ...(conversationPdf ? { conversationTranscriptFileName: conversationPdf.fileName } : {}),
      supplier: {
        status: result.supplier.status,
        resolvedName: result.supplier.resolvedSupplier?.supplierName,
        isDefault: !result.supplier.resolvedSupplier?.workdayId,
      },
      company: companyNotification,
      extracted: {
        invoiceDate: extractedInvoiceDate,
        amountDue: extractedAmountDue,
        suppliersInvoiceNumber: extractedSuppliersInvoiceNumber,
        freightAmount: extractedFreightAmount,
        purchaseOrderNumber: extractedPurchaseOrderNumber,
        paymentTerms: result.extractedPaymentTerms?.name,
      },
      ...(chargeCheck.length ? { chargeCheck } : {}),
      lineCount: finalLines.length,
    };

    const clusteringEnabled = isInvoiceAttachmentClusteringEnabled();
    // Key resends on the number printed on the document, never a generated submit value: a number composed
    // from the supplier name and date would give two unnumbered invoices on the same day one registry row.
    const registryNumber = normalizeClusterInvoiceNumber(result.extractedSuppliersInvoiceNumber);
    const clusterReceivedAt = clusterMaxReceivedAt([...loaded, { receivedAt: latestMessageAt }]);
    const clusterFilesReceivedAt = clusterMaxReceivedAt(loaded);

    // The default supplier means "not resolved", not a different supplier: a resend often moves
    // resolution between default and real (for example once a W-9 arrives), which must still update.
    const isRealSupplier = (wid?: string | null): wid is string => Boolean(wid) && wid !== DEFAULT_SUPPLIER_WID;
    const resolvedSupplierWID = isRealSupplier(result.supplier.resolvedSupplier?.workdayId)
      ? result.supplier.resolvedSupplier.workdayId
      : undefined;
    let replacedInvoice: ConversationSupplierInvoice | undefined;

    if (clusteringEnabled && conversationId && registryNumber) {
      // Claim before reading the registry, so two racing triggers cannot both decide to create or update.
      const claimToken = randomUUID();
      if (!(await acquireConversationInvoiceClaim(context.dbConnection, conversationId, registryNumber, claimToken))) {
        debug('Another run holds the claim for this conversation invoice; skipping', { conversationId, registryNumber });
        run.invoiceClaimContended = true;
        await notifyResult('create_invoice', 'success', Date.now() - startTime, slackInvoiceDetails({
          ...sharedSlackDetails,
          skipped: true,
          inProgressElsewhere: true,
          skipReason: `Another run is already processing supplier invoice ${extractedSuppliersInvoiceNumber} for this conversation; skipped to avoid a duplicate.`,
        }, conversationId, intercomAppId));
        return;
      }
      run.invoiceClaim = { conversationId, supplierInvoiceNumber: registryNumber, claimToken };
      const existing = await getConversationSupplierInvoice(context.dbConnection, conversationId, registryNumber);
      const registeredSupplierWID = isRealSupplier(existing?.supplierWid) ? existing.supplierWid : undefined;
      const supplierChanged = Boolean(
        registeredSupplierWID && resolvedSupplierWID && registeredSupplierWID !== resolvedSupplierWID
      );
      const editability = existing && !supplierChanged
        ? await getSupplierInvoiceEditability(context, existing.workdayInvoiceWid)
        : undefined;
      const watermark = existing?.lastProcessedReceivedAt ?? undefined;
      const hasNewerFile = watermark == null
        || (clusterFilesReceivedAt != null && clusterFilesReceivedAt > watermark);
      // A supplier reply or an AP note (for example coding instructions) can change the invoice with no
      // new PDF, so a newer message counts too — unless the newest message is the one that brought a file
      // for another invoice in this conversation, in which case it is about that invoice.
      const newestMessageBroughtOtherInvoice = otherClustersLatestReceivedAt != null
        && latestMessageAt != null
        && otherClustersLatestReceivedAt >= latestMessageAt;
      const hasNewerMessage = watermark != null
        && latestMessageAt != null
        && latestMessageAt > watermark
        && !newestMessageBroughtOtherInvoice;
      const receivedAtUnknown = clusterFilesReceivedAt == null && latestMessageAt == null;
      const hasNewerInformation = receivedAtUnknown || hasNewerFile || hasNewerMessage;
      const invoiceLabel = existing ? existing.workdayInvoiceNumber ?? existing.workdayInvoiceWid : undefined;

      const skipResend = async (skipReason: string, extra: Record<string, unknown> = {}) => {
        let skipRegistrySyncFailed = false;
        if (existing && clusterReceivedAt != null && (watermark == null || clusterReceivedAt > watermark)) {
          // Everything up to now has been seen and judged not new for this invoice, so a later
          // text-only reply about it still counts as new.
          try {
            await upsertConversationSupplierInvoice(context.dbConnection, {
              conversationId,
              supplierInvoiceNumber: registryNumber,
              supplierWid: existing.supplierWid,
              workdayInvoiceWid: existing.workdayInvoiceWid,
              workdayInvoiceNumber: existing.workdayInvoiceNumber,
              lastProcessedReceivedAt: clusterReceivedAt,
            });
          } catch (error) {
            debug('Failed to advance conversation invoice registry watermark after skip:', error);
            skipRegistrySyncFailed = true;
          }
        }
        await notifyResult('create_invoice', 'success', Date.now() - startTime, slackInvoiceDetails({
          ...sharedSlackDetails,
          invoiceWID: existing?.workdayInvoiceWid,
          invoiceNumber: existing?.workdayInvoiceNumber,
          skipped: true,
          skipReason,
          ...extra,
          ...(skipRegistrySyncFailed ? { registrySync: 'failed' } : {}),
        }, conversationId, intercomAppId));
      };

      // AP canceled (or deleted) the registered invoice. Only a newer document for this invoice means
      // the supplier re-sent it; anything else in the conversation must not bring it back.
      const registeredInvoiceWasRemoved = Boolean(
        editability && (!editability.found || editability.isCanceled || editability.status === 'Canceled')
      );
      if (existing && registeredInvoiceWasRemoved) {
        if (!hasNewerFile) {
          debug('Registered invoice is canceled or gone and has no newer document; not replacing', {
            conversationId,
            invoiceLabel,
          });
          await skipResend(
            `Invoice ${invoiceLabel} was canceled and no newer document for it arrived, so no replacement was created.`,
            { canceledNotReplaced: true },
          );
          return;
        }
        replacedInvoice = existing;
        debug('Registered invoice is canceled or gone; creating a new supplier invoice', {
          conversationId,
          replacedInvoice: invoiceLabel,
        });
      }
      if (existing && editability && !registeredInvoiceWasRemoved) {
        if (!hasNewerInformation) {
          debug('Skipping resend: nothing newer for this invoice since the last processing', {
            conversationId,
            invoiceLabel,
          });
          await skipResend(`No documents or messages for ${invoiceLabel} newer than the last processing.`);
          return;
        }
        if (!editability.editable) {
          const reason = `Invoice ${invoiceLabel} is ${editability.status ?? 'not editable'}${editability.isPaid ? ' (paid)' : ''}${editability.isPartiallyPaid ? ' (partially paid)' : ''}; re-sent documents need manual review.`;
          debug('Skipping resend update: invoice is not editable', {
            conversationId,
            invoiceLabel,
            editability,
          });
          await notifyResult('create_invoice', 'success', Date.now() - startTime, slackInvoiceDetails({
            ...sharedSlackDetails,
            invoiceWID: existing.workdayInvoiceWid,
            invoiceNumber: existing.workdayInvoiceNumber,
            skipped: true,
            needsManualReview: true,
            skipReason: reason,
          }, conversationId, intercomAppId));
          return;
        }
        // Submit_Supplier_Invoice replaces Attachment_Data with what each call sends, so the update
        // resends every cluster document plus a fresh transcript; newFiles only feeds notes and Slack.
        const newFiles = watermark == null
          ? loaded
          : loaded.filter((file) => file.receivedAt != null && file.receivedAt > watermark);
        const buildUpdateNotes = (appliedFallbacks: AppliedFallback[]) => {
          const listedFallbacks = appliedFallbacks.filter((f) => !isPurchaseOrderLineFallback(f));
          return `${baseNotes}\n\nResubmission: conversation re-triggered; updated with the latest documents and messages.` +
            (newFiles.length ? ` New attachments: ${newFiles.map((file) => file.fileName).join(', ')}.` : ' No new attachments.') +
            formatPurchaseOrderLineFallbackNotes(appliedFallbacks, extractedPurchaseOrderNumber) +
            (listedFallbacks.length ? `\n\nFallback values applied: ${listedFallbacks.map(f => f.label).join('; ')}` : '');
        };
        const updateOutcome = await submitSupplierInvoiceUpdate(context, {
          invoiceWorkdayID: existing.workdayInvoiceWid,
          supplierWID: resolvedSupplierWID ?? registeredSupplierWID ?? targetSupplierWID,
          buildNotes: buildUpdateNotes,
          memo,
          invoiceDate: extractedInvoiceDate,
          companyWID,
          companyReferenceType,
          extractedAmountDue,
          suppliersInvoiceNumber: extractedSuppliersInvoiceNumber,
          extractedFreightAmount,
          extractedTaxAmount,
          finalLines,
          invoiceLineQuantityDisplayed: invoiceLineQuantityDisplayed ? undefined : false,
          relatedLobByCostCenter,
          resolveCostCenterWorkdayIds: (costCenterIds) =>
            getCostCenterWorkdayIdsByCodes(context.dbConnection, costCenterIds),
          resolveOrgWorktagKinds: (ids) => getOrgWorktagKindsByIds(context.dbConnection, ids),
          paymentTermsId,
          attachments: submitAttachments,
          ...(poClosedForInvoicing ? { omitPurchaseOrderLineReference: true } : {}),
        });
        run.workdayInvoiceWid = existing.workdayInvoiceWid;
        let updateRegistrySyncFailed = false;
        try {
          await upsertConversationSupplierInvoice(context.dbConnection, {
            conversationId,
            supplierInvoiceNumber: registryNumber,
            supplierWid: resolvedSupplierWID ?? registeredSupplierWID ?? null,
            workdayInvoiceWid: existing.workdayInvoiceWid,
            workdayInvoiceNumber: existing.workdayInvoiceNumber,
            lastProcessedReceivedAt: clusterReceivedAt ?? existing.lastProcessedReceivedAt,
          });
        } catch (error) {
          debug('Failed to update conversation invoice registry after update:', error);
          updateRegistrySyncFailed = true;
        }
        const processingTime = Date.now() - startTime;
        await notifyResult('create_invoice', 'success', processingTime, slackInvoiceDetails({
          ...sharedSlackDetails,
          extracted: {
            ...sharedSlackDetails.extracted,
            suppliersInvoiceNumber: updateOutcome.suppliersInvoiceNumber ?? extractedSuppliersInvoiceNumber,
          },
          updated: true,
          newAttachments: newFiles.map((file) => file.fileName),
          invoiceWID: existing.workdayInvoiceWid,
          invoiceNumber: existing.workdayInvoiceNumber,
          appliedFallbacks: updateOutcome.appliedFallbacks.map(f => purchaseOrderLineFallbackLabel(f.label)),
          ...(updateOutcome.priorFailures?.length ? { priorFailures: updateOutcome.priorFailures } : {}),
          ...(updateRegistrySyncFailed ? { registrySync: 'failed' } : {}),
        }, conversationId, intercomAppId));
        return;
      }
    }

    const replacedInvoiceLabel = replacedInvoice
      ? replacedInvoice.workdayInvoiceNumber ?? replacedInvoice.workdayInvoiceWid
      : undefined;
    const trackResends = Boolean(clusteringEnabled && conversationId && registryNumber);
    const createOutcome = await submitNewSupplierInvoice(context, {
      supplierWID: targetSupplierWID,
      companyWID,
      companyReferenceType,
      buildNotes: (appliedFallbacks) =>
        buildNotes(appliedFallbacks) +
        (replacedInvoiceLabel ? `\n\nReplaces canceled invoice ${replacedInvoiceLabel} from the same conversation.` : ''),
      memo,
      invoiceDate: extractedInvoiceDate,
      ...(conversationCreatedAt ? { invoiceReceivedDate: conversationCreatedAt } : {}),
      extractedAmountDue,
      suppliersInvoiceNumber: extractedSuppliersInvoiceNumber,
      extractedFreightAmount,
      extractedTaxAmount,
      finalLines,
      invoiceLineQuantityDisplayed: invoiceLineQuantityDisplayed ? undefined : false,
      relatedLobByCostCenter,
      resolveCostCenterWorkdayIds: (costCenterIds) =>
        getCostCenterWorkdayIdsByCodes(context.dbConnection, costCenterIds),
      resolveOrgWorktagKinds: (ids) => getOrgWorktagKindsByIds(context.dbConnection, ids),
      paymentTermsId,
      attachments: submitAttachments,
      ...(assigneeMatch ? { assigneeWID: assigneeMatch.workdayId } : {}),
      ...(poClosedForInvoicing ? { omitPurchaseOrderLineReference: true } : {}),
      ...(conversationUrl ? { conversationUrl } : {}),
    });

    const processingTime = Date.now() - startTime;

    run.workdayInvoiceWid = createOutcome.invoiceWID;
    let registrySyncFailed = false;
    if (trackResends && conversationId && registryNumber) {
      if (!createOutcome.invoiceWID) {
        registrySyncFailed = true;
      } else {
        try {
          await upsertConversationSupplierInvoice(context.dbConnection, {
            conversationId,
            supplierInvoiceNumber: registryNumber,
            supplierWid: resolvedSupplierWID ?? null,
            workdayInvoiceWid: createOutcome.invoiceWID,
            workdayInvoiceNumber: createOutcome.invoiceNumber ?? null,
            lastProcessedReceivedAt: clusterReceivedAt ?? null,
          });
        } catch (error) {
          debug('Failed to record conversation invoice registry after create:', error);
          registrySyncFailed = true;
        }
      }
    }

    await notifyResult('create_invoice', 'success', processingTime, slackInvoiceDetails({
      ...sharedSlackDetails,
      extracted: {
        ...sharedSlackDetails.extracted,
        suppliersInvoiceNumber: createOutcome.suppliersInvoiceNumber ?? extractedSuppliersInvoiceNumber,
      },
      invoiceWID: createOutcome.invoiceWID,
      invoiceNumber: createOutcome.invoiceNumber,
      ...(replacedInvoiceLabel ? { replacesCanceledInvoice: replacedInvoiceLabel } : {}),
      ...(assigneeEmail ? { assigneeEmail } : {}),
      ...(assigneeMatch ? {
        assigneeWorkdayId: assigneeMatch.workdayId,
        ...(assigneeName ? { assigneeName } : {}),
      } : {}),
      appliedFallbacks: createOutcome.appliedFallbacks.map(f => purchaseOrderLineFallbackLabel(f.label)),
      ...(createOutcome.priorFailures?.length ? { priorFailures: createOutcome.priorFailures } : {}),
      ...(registrySyncFailed ? { registrySync: 'failed' } : {}),
    }, conversationId, intercomAppId));
  } catch (error) {
    const processingTime = Date.now() - startTime;
    debug('Error creating new supplier invoice:', error);
    await notifyResult(
      'create_invoice',
      'error',
      processingTime,
      slackInvoiceDetails({
        s3Key,
        fileName,
        ...(clustered ? { attachments: files.map((file) => file.fileName) } : {}),
        ...(unrelated.length ? { unrelatedAttachments: unrelated.map((doc) => doc.fileName) } : {}),
      }, conversationId, intercomAppId),
      error
    );
    throw error;
  }
}
