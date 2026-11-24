import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { createHash, randomUUID } from 'node:crypto';
import { debug } from '@pga/logger';
import { normalizePrintedDate } from './prompts/invoice_ocr_prompt.js';
import { throwIfDeadlineReached, withProcessorHandler, type ProcessingContext } from './lib/handlers.js';
import {
  enrichInvoiceFromAttachments,
  formatAmountNotes,
  formatChargeReviewNotes,
  formatCompanyNotes,
  describeEmailCompanyReview,
  formatEmailCompanyNotes,
  formatEmailWorktagNotes,
  formatEmailBudgetSplitNotes,
  describeEmailBudgetSplit,
  formatFreightAmountNotes,
  formatInvoiceDateNotes,
  formatDueDateNotes,
  formatInvoiceLinesNotes,
  formatInvoiceNumberNotes,
  formatGeneratedInvoiceNumberNotes,
  describeGeneratedNumberClash,
  type GeneratedInvoiceNumberClash,
  formatFreeRowsNotes,
  formatLinePriceReviewNotes,
  formatLineTotalReviewNotes,
  formatPoLineReviewNotes,
  formatPositivePoQuantityNotes,
  formatMemoIdentifierNotes,
  formatBankingInfoNotes,
  formatPaymentTermsNotes,
  formatPurchaseOrderNotes,
  formatRepeatedLineNotes,
  formatBreakdownRowNotes,
  formatSupplierNotes,
  formatTotalsChargeReviewNotes,
  formatTaxAmountNotes,
  formatWorkQueueAssigneeNotes,
  type InvoiceAttachmentRole,
} from './lib/invoice_enrichment.js';
import { describePaymentTerms } from './lib/payment_terms_match.js';
import {
  clusterMaxReceivedAt,
  isInvoiceAttachmentClusteringEnabled,
  normalizeClusterInvoiceNumber,
  parseAndClusterInvoiceAttachments,
  type ClassifiedAttachment,
  type ClusterableAttachment,
} from './lib/invoice_attachment_clustering.js';
import { invoiceAttachmentClusteringMode } from './lib/invoice_attachment_clustering_flag.js';
import { snapshotAgentWrite } from './lib/invoice_snapshots.js';
import {
  acquireConversationInvoiceClaim,
  getConversationSupplierInvoice,
  findGeneratedInvoicesForDocument,
  generatedNumberAmountKey,
  recordGeneratedInvoiceNumberInvoice,
  releaseConversationInvoiceClaim,
  reserveGeneratedInvoiceNumber,
  settleGeneratedInvoiceNumber,
  upsertConversationSupplierInvoice,
  type ConversationSupplierInvoice,
} from './lib/conversation_invoices.js';
import {
  applyInvoiceMemoIdentifiersToLines,
  composeInvoiceMemo,
  describeSuppliersInvoiceNumber,
  supplierNameForInvoiceNumber,
  memoIdentifiersFromEnrichment,
} from './lib/invoice_memo.js';
import {
  decideReimbursement,
  readReimbursementPacket,
  reimbursementCodingLine,
  reimbursementCodingNote,
  reimbursementNote,
  reimbursementSlackLines,
} from './lib/reimbursement_packet.js';
import { getCostCenterRelatedLobsByCodes, getCostCenterWorkdayIdsByCodes, getOrgWorktagKindsByIds } from './lib/database.js';
import { employeeDisplayName, getEmployeeWidByEmail, type EmployeeLookupResult } from './lib/employees.js';
import {
  applyDefaultCompanyLineWorktags,
  buildFinalInvoiceLines,
  unlinkedPoRowsNote,
  chargeReconciliationLogSummary,
  chargeReconciliationMessages,
  CHARGE_RECONCILIATION_FALLBACK_FIELD,
  isAmountMismatchMessage,
  formatAmountCheckNotes,
  mergeAmountCheckMessages,
  lineTotalMismatchNote,
  normalizeSupplierInvoiceLineAmounts,
  positivePoQuantityNote,
  unitCostFromLineTotalNote,
  overlaySharedPoWorktagsOnUnmatchedLines,
  unappliedEmailBudgetSplit,
  parseExtractedAmount,
  prepareInvoiceCharges,
  removeRepeatedLineTables,
  resolveHeaderChargeAmounts,
  restoreClearedFreightFromRows,
  freeRowsNote,
  zeroAmountLinesNote,
  removeFreeRows,
  removeZeroAmountLines,
  resolveInvoiceLineQuantityDisplayed,
  freightFromRowsMessage,
  splitFreightLines,
  withComposedLineDescriptions,
  type FinalInvoiceLine,
} from './lib/invoice_lines.js';
import { applyPrintedTaxCharges, deriveTaxFromPrintedRate, hasPrintedSettlement, removeBreakdownRows, isPayrollTaxCharge, placeChargesOnPoServiceLines, placePayrollTaxCharges, placeSummaryCharges, summaryCreditCents, reinterpretSinglePriceLinesForCharges, settlePlacedSummaryLines, type PlacedSummaryCharges } from './lib/header_charges.js';
import { hasPrintedRetainage, reviewAmountDueGapCents, subtotalFreightCents, formatLineSubtotalNotes, formatPartialPaymentNotes, lineSubtotalReviewNote, planBalanceInvoice, planPartialPayment, poTotalReviewNote, secondReadRowsNote } from './lib/partial_payment.js';
import {
  findNotePurchaseOrders,
  findNotePurchaseOrdersForOtherInvoices,
  findPurchaseOrderNumber,
  findPurchaseOrderNumbers,
  findSolePurchaseOrderNumber,
  normalizePurchaseOrderNumber,
  noteLineForInvoice,
  selectNotePurchaseOrder,
  type NotePurchaseOrder,
  type PurchaseOrderEnrichmentContext,
} from './lib/purchase_order.js';
import { isUnreadableOffice } from './lib/office_to_pdf.js';
import { getBinaryFromS3, getPresignedUrl } from './lib/s3.js';
import { notifyResult } from './lib/slack.js';
import { formatMultiInvoiceNotes, multiInvoiceReview } from './lib/multi_invoice_pdf.js';
import type { InvoiceData, WorkdayInvoice } from './lib/types.js';
import { buildIntercomConversationUrl } from './lib/intercom.js';
import { htmlToText } from './lib/html_text.js';
import { emailCodingText, sourceEmailBody } from './lib/email_coding_text.js';
import { budgetCompanyOptions, budgetSplitOptions, buildEmailWorktags } from './lib/email_worktags.js';
import {
  resolveCompanyFromEmail,
  selectCompanyForCreateInvoice,
  type EmailCompanyMatch,
} from './lib/reference_ids.js';
import {
  claimInvoiceCluster,
  createInvoiceClusterPlan,
  finishInvoiceCluster,
  markInvoiceClusterUndispatched,
  releaseInvoiceCluster,
} from './lib/invoice_cluster_plans.js';
import { formatPurchaseOrderSupplierNotes, purchaseOrderSupplierReviewLine, resolvePurchaseOrderSupplier } from './lib/po_supplier.js';
import { detectInvoiceCurrency, formatCurrencyNotes, resolveInvoiceCurrency, type InvoiceCurrencyDecision } from './lib/invoice_currency.js';
import {
  formatPurchaseOrderLineFallbackNotes,
  getSupplierAcceptedCurrencies,
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

interface EmailPurchaseOrders {
  /** PO from the supplier's own text (subject, source email, filename); stands in for the invoice PO before enrichment. */
  supplierPurchaseOrderNumber?: string;
  /** PO to use when neither a note PO nor an invoice PO resolves. */
  fallbackPurchaseOrderNumber?: string;
  /**
   * The one PO the message that carried this attachment (its subject only for the source email) and the filename
   * name, leaving out POs an AP note mentions. It wins over the invoice PO; when they name several POs it is unset. Older messages in the thread
   * never count, since they often name another invoice's PO.
   */
  conversationPurchaseOrderNumber?: string;
}

function findEmailPurchaseOrders(
  emailContext: InvoiceData['emailContext'] | undefined,
  fileName: string,
  notePurchaseOrders: NotePurchaseOrder[]
): EmailPurchaseOrders {
  // Other text never supplies a PO that an AP note mentions, so a PO AP rejected is never used.
  const notePurchaseOrderNumbers = new Set([
    ...notePurchaseOrders.map((po) => po.purchaseOrderNumber),
    ...findPurchaseOrderNumbers(htmlToText(emailContext?.adminConversationParts ?? '')),
  ]);
  const messageTexts = emailContext?.messageBody !== undefined
    ? [emailContext.messageSubject, htmlToText(emailContext.messageBody)]
    : [emailContext?.subject, sourceEmailBody(emailContext)];
  const conversationPurchaseOrderNumber = findSolePurchaseOrderNumber([...messageTexts, fileName], notePurchaseOrderNumbers);
  if (!notePurchaseOrders.length) {
    const purchaseOrderNumber = findPurchaseOrderNumber(emailContext?.subject, emailContext?.plainTextBody, fileName);
    return {
      supplierPurchaseOrderNumber: purchaseOrderNumber,
      fallbackPurchaseOrderNumber: purchaseOrderNumber,
      conversationPurchaseOrderNumber,
    };
  }
  const sourceBody = sourceEmailBody(emailContext);
  const conversationText = htmlToText(emailContext?.conversationParts ?? '');
  const supplierPurchaseOrderNumber = findPurchaseOrderNumber(emailContext?.subject, sourceBody, fileName);
  const fallbackPurchaseOrderNumber = supplierPurchaseOrderNumber
    ?? findPurchaseOrderNumbers(conversationText).find((po) => !notePurchaseOrderNumbers.has(po));
  return {
    supplierPurchaseOrderNumber,
    fallbackPurchaseOrderNumber,
    conversationPurchaseOrderNumber,
  };
}

interface PrefetchedPurchaseOrder {
  purchaseOrderNumber?: string;
  purchaseOrder?: ParsedPurchaseOrder;
  /** POs Workday did not return before enrichment, so they are not fetched again. */
  notFoundPurchaseOrderNumbers?: Set<string>;
}

async function resolvePurchaseOrder(
  context: ProcessingContext,
  emailPurchaseOrders: EmailPurchaseOrders,
  notePurchaseOrders: NotePurchaseOrder[]
): Promise<PrefetchedPurchaseOrder> {
  const notePurchaseOrderNumber = selectNotePurchaseOrder(notePurchaseOrders, emailPurchaseOrders.supplierPurchaseOrderNumber)
    ?.purchaseOrderNumber;
  const { conversationPurchaseOrderNumber, fallbackPurchaseOrderNumber } = emailPurchaseOrders;
  const notFoundPurchaseOrderNumbers = new Set<string>();
  for (const purchaseOrderNumber of new Set([notePurchaseOrderNumber, conversationPurchaseOrderNumber, fallbackPurchaseOrderNumber])) {
    if (!purchaseOrderNumber) continue;
    debug(`Fetching PO data before enrichment: ${purchaseOrderNumber}`);
    const purchaseOrder = await loadPurchaseOrder(context, purchaseOrderNumber);
    if (purchaseOrder) return { purchaseOrderNumber, purchaseOrder, notFoundPurchaseOrderNumbers };
    notFoundPurchaseOrderNumbers.add(purchaseOrderNumber);
  }
  return { notFoundPurchaseOrderNumbers };
}

interface SelectedPurchaseOrder {
  purchaseOrder?: ParsedPurchaseOrder;
  /** Set when an Intercom note chose the PO. */
  fromNote?: NotePurchaseOrder;
  /** Set when the email or conversation PO was used. */
  fromConversation?: boolean;
  /** A note PO that Workday did not return. */
  notePurchaseOrderNotFound?: string;
  /** An email or conversation PO that Workday did not return. */
  conversationPurchaseOrderNotFound?: string;
  /** Note POs tied to other invoice numbers, set when the notes tie none to this invoice. */
  notePurchaseOrdersForOtherInvoices?: NotePurchaseOrder[];
  invoiceNumber?: string;
}

// An Intercom note from AP wins, then the one PO the email or conversation names, then the PO printed on the
// invoice; invoices often carry a stale PO.
async function selectPurchaseOrder(
  context: ProcessingContext,
  prefetched: PrefetchedPurchaseOrder,
  notePurchaseOrders: NotePurchaseOrder[],
  emailPurchaseOrders: EmailPurchaseOrders,
  invoicePurchaseOrderNumber?: string,
  invoiceNumber?: string | null
): Promise<SelectedPurchaseOrder> {
  const load = async (purchaseOrderNumber: string) => {
    if (purchaseOrderNumber === prefetched.purchaseOrderNumber) return prefetched.purchaseOrder;
    if (prefetched.notFoundPurchaseOrderNumbers?.has(purchaseOrderNumber)) return undefined;
    debug(`Fetching PO data for ${purchaseOrderNumber}`);
    return loadPurchaseOrder(context, purchaseOrderNumber);
  };
  const notePurchaseOrder = selectNotePurchaseOrder(
    notePurchaseOrders,
    invoicePurchaseOrderNumber ?? emailPurchaseOrders.supplierPurchaseOrderNumber,
    invoiceNumber
  );
  let notePurchaseOrderNotFound: string | undefined;
  if (notePurchaseOrder) {
    const purchaseOrder = await load(notePurchaseOrder.purchaseOrderNumber);
    if (purchaseOrder) {
      if (invoicePurchaseOrderNumber && invoicePurchaseOrderNumber !== purchaseOrder.documentNumber) {
        debug(`Using ${purchaseOrder.documentNumber} from the Intercom note instead of invoice PO ${invoicePurchaseOrderNumber}`);
      }
      return { purchaseOrder, fromNote: notePurchaseOrder };
    }
    notePurchaseOrderNotFound = notePurchaseOrder.purchaseOrderNumber;
  }
  const { conversationPurchaseOrderNumber } = emailPurchaseOrders;
  let conversationPurchaseOrder: ParsedPurchaseOrder | undefined;
  let conversationPurchaseOrderNotFound: string | undefined;
  if (conversationPurchaseOrderNumber && conversationPurchaseOrderNumber !== notePurchaseOrderNotFound) {
    conversationPurchaseOrder = await load(conversationPurchaseOrderNumber);
    if (conversationPurchaseOrder) {
      if (invoicePurchaseOrderNumber && invoicePurchaseOrderNumber !== conversationPurchaseOrder.documentNumber) {
        debug(`Using ${conversationPurchaseOrder.documentNumber} from the email or conversation instead of invoice PO ${invoicePurchaseOrderNumber}`);
      }
    } else {
      conversationPurchaseOrderNotFound = conversationPurchaseOrderNumber;
    }
  }
  const fallbackPurchaseOrderNumber = invoicePurchaseOrderNumber ?? emailPurchaseOrders.fallbackPurchaseOrderNumber;
  const purchaseOrder = conversationPurchaseOrder ?? (
    fallbackPurchaseOrderNumber
      && fallbackPurchaseOrderNumber !== notePurchaseOrderNotFound
      && fallbackPurchaseOrderNumber !== conversationPurchaseOrderNotFound
      ? await load(fallbackPurchaseOrderNumber)
      : undefined
  );
  const forOtherInvoices = notePurchaseOrder ? [] : findNotePurchaseOrdersForOtherInvoices(notePurchaseOrders, invoiceNumber);
  return {
    purchaseOrder,
    ...(conversationPurchaseOrder ? { fromConversation: true } : {}),
    ...(notePurchaseOrderNotFound ? { notePurchaseOrderNotFound } : {}),
    ...(conversationPurchaseOrderNotFound ? { conversationPurchaseOrderNotFound } : {}),
    ...(forOtherInvoices.length
      ? { notePurchaseOrdersForOtherInvoices: forOtherInvoices, ...(invoiceNumber ? { invoiceNumber } : {}) }
      : {}),
  };
}

// Narrows the PO to the line an Intercom note names ("PO-413672 Line 7") so line matching cannot pick another.
function pinNotePurchaseOrderLine(
  purchaseOrder: ParsedPurchaseOrder | undefined,
  lineNumber: number | undefined
): { purchaseOrder?: ParsedPurchaseOrder; lineMissing: boolean } {
  if (!purchaseOrder || !lineNumber) return { purchaseOrder, lineMissing: false };
  const lines = purchaseOrder.lines.filter((line) => Number(line.lineOrder) === lineNumber);
  if (!lines.length) {
    debug(`Intercom note names line ${lineNumber}, which is not on ${purchaseOrder.documentNumber}; matching against every PO line`);
    return { purchaseOrder, lineMissing: true };
  }
  return { purchaseOrder: { ...purchaseOrder, lines }, lineMissing: false };
}

function formatPurchaseOrderSelectionNotes(input: {
  selected: SelectedPurchaseOrder;
  invoicePurchaseOrderNumber?: string;
  /** PO from the subject, source email, or filename; reported only when the invoice shows no PO. */
  emailPurchaseOrderNumber?: string;
  /** The note line the invoice lines were coded from; unset when PO lines were not used. */
  appliedLineNumber?: number;
  /** The line the notes give this invoice, even when it is not on the PO. */
  noteLineNumber?: number;
  noteLineMissing: boolean;
  /** The notes give this invoice a line they contradict ("Line 7, not Line 8"), so none was pinned. */
  noteLineConflict: boolean;
}): string {
  const { selected, invoicePurchaseOrderNumber, emailPurchaseOrderNumber, appliedLineNumber, noteLineNumber, noteLineMissing, noteLineConflict } = input;
  const loadedPurchaseOrderNumber = selected.purchaseOrder?.documentNumber;
  if (selected.notePurchaseOrderNotFound) {
    return `\n\nPurchase order: ${selected.notePurchaseOrderNotFound} from the Intercom note was not found in Workday; ${loadedPurchaseOrderNumber ? `used ${loadedPurchaseOrderNumber} instead` : 'no PO was loaded'}.`;
  }
  if (selected.notePurchaseOrdersForOtherInvoices?.length) {
    const named = selected.notePurchaseOrdersForOtherInvoices
      .map((po) => `${po.purchaseOrderNumber} for invoice ${po.invoiceNumbers?.join(', ')}`)
      .join(' and ');
    const thisInvoice = selected.invoiceNumber ? ` (${selected.invoiceNumber})` : '';
    return `\n\nPurchase order: The Intercom note names ${named}, not this invoice${thisInvoice}; ${loadedPurchaseOrderNumber ? `kept ${loadedPurchaseOrderNumber}` : 'no PO was loaded'}.`;
  }
  if (selected.fromConversation && loadedPurchaseOrderNumber) {
    return invoicePurchaseOrderNumber && invoicePurchaseOrderNumber !== loadedPurchaseOrderNumber
      ? `\n\nPurchase order: Used ${loadedPurchaseOrderNumber} from the email or conversation instead of ${invoicePurchaseOrderNumber} on the invoice.`
      : '';
  }
  if (selected.conversationPurchaseOrderNotFound) {
    return `\n\nPurchase order: ${selected.conversationPurchaseOrderNotFound} from the email or conversation was not found in Workday; ${loadedPurchaseOrderNumber ? `used ${loadedPurchaseOrderNumber} instead` : 'no PO was loaded'}.`;
  }
  const { fromNote } = selected;
  if (!fromNote || !loadedPurchaseOrderNumber) return '';
  if (!appliedLineNumber && !noteLineMissing && !noteLineConflict && invoicePurchaseOrderNumber === loadedPurchaseOrderNumber) return '';
  const used = `${loadedPurchaseOrderNumber}${appliedLineNumber ? ` Line ${appliedLineNumber}` : ''}`;
  const instead = invoicePurchaseOrderNumber
    ? (invoicePurchaseOrderNumber !== loadedPurchaseOrderNumber ? ` instead of ${invoicePurchaseOrderNumber} on the invoice` : '')
    : (emailPurchaseOrderNumber && emailPurchaseOrderNumber !== loadedPurchaseOrderNumber
      ? ` instead of ${emailPurchaseOrderNumber} in the email`
      : '');
  const missingLine = noteLineMissing && noteLineNumber
    ? ` The note names Line ${noteLineNumber}, which is not on ${loadedPurchaseOrderNumber}, so every PO line was considered.`
    : '';
  const conflictingLine = noteLineConflict
    ? ' The note gives this invoice conflicting PO lines, so no line was pinned and every PO line was considered.'
    : '';
  return `\n\nPurchase order: Used ${used} from the Intercom note${instead}.${missingLine}${conflictingLine}`;
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
  /** File names of older copies of a document left out of this cluster; reported in Slack only. */
  supersededFileNames?: string[];
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
  intercomAppId?: string,
  triggeredBy?: { email?: string; name?: string }
): Record<string, unknown> {
  const conversationUrl = intercomConversationUrl(conversationId, intercomAppId);
  return {
    ...details,
    ...(conversationId ? { conversationId } : {}),
    ...(conversationUrl ? { conversationUrl } : {}),
    ...(triggeredBy?.email ? { triggeredByEmail: triggeredBy.email } : {}),
    ...(triggeredBy?.email && triggeredBy.name ? { triggeredByName: triggeredBy.name } : {}),
  };
}

// Processor function - invoked by trigger_create_invoice
export const processor = withProcessorHandler(async (context, requests, _event, options) => {
  const abortSignal = options?.abortSignal;
  for (const request of requests) {
    await throwIfDeadlineReached(abortSignal);
    await processNewInvoice(context, request as CreateInvoiceRequest, abortSignal);
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
    'emailContext' | 'conversationId' | 'intercomAppId' | 'assigneeEmail' | 'conversationCreatedAt' | 'conversationPdf' | 'latestMessageAt' | 'otherClustersLatestReceivedAt' | 'supersededFileNames' | 'planId' | 'clusterIndex'
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

async function reportShadowClustering(
  context: ProcessingContext,
  request: CreateInvoiceRequest,
  abortSignal?: AbortSignal
): Promise<void> {
  const startTime = Date.now();
  const attachments = request.attachments ?? [];
  const details = { mode: 'shadow', attachments: requestFilenames(request) };
  try {
    const { clustering } = await parseAndClusterInvoiceAttachments(
      attachments,
      (key) => getBinaryFromS3(context.s3Config, key),
      { abortSignal }
    );
    const describe = (file: ClassifiedAttachment) =>
      `${file.fileName} (${file.kind}${file.supportingKind ? `: ${file.supportingKind}` : ''}${file.invoiceNumber ? `, #${file.invoiceNumber}` : ''})`;
    await notifyResult('create_invoice_shadow', 'success', Date.now() - startTime, slackInvoiceDetails({
      ...details,
      wouldCreateInvoices: clustering.clusters.length,
      clusters: clustering.clusters.map((cluster) => ({
        invoice: describe(cluster.primary),
        ...(cluster.supporting.length ? { supporting: cluster.supporting.map(describe) } : {}),
        ...(cluster.superseded?.length ? { superseded: cluster.superseded.map(describe) } : {}),
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
      slackInvoiceDetails(details, request.conversationId, request.intercomAppId, { email: request.assigneeEmail }),
      error
    );
    throw error;
  }
}

async function processNewInvoice(
  context: ProcessingContext,
  request: CreateInvoiceRequest,
  abortSignal?: AbortSignal
): Promise<void> {
  if (request.shadow) {
    // A shadow record never writes to Workday or the registry, whatever this container's flag says.
    await reportShadowClustering(context, request, abortSignal);
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
    supersededFileNames,
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
      slackInvoiceDetails(
        { s3Key, fileName, ...(attachments?.length ? { attachments: requestFilenames(request) } : {}) },
        conversationId,
        intercomAppId,
        { email: assigneeEmail }
      ),
      new Error('INVOICE_MOD_ENABLED is false; cannot create new invoices')
    );
    return;
  }

  if (clusteringEnabled && attachments?.length && !clustered) {
    let firstClusterFiles: CreateInvoiceAttachment[] = [];
    let firstOtherClustersLatestReceivedAt: number | undefined;
    let firstSupersededFileNames: string[] = [];
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
        },
        { abortSignal }
      );
      if (clustering.clusters.length === 0) {
        throw new Error('Invoice attachment clustering returned no clusters');
      }
      const clusterFiles = clustering.clusters.map((cluster) => [cluster.primary, ...cluster.supporting]);
      const othersLatest = (index: number) =>
        clusterMaxReceivedAt(clusterFiles.filter((_, other) => other !== index).flat());
      const supersededNames = (index: number) => (clustering.clusters[index].superseded ?? []).map((file) => file.fileName);
      firstClusterFiles = clusterFiles[0];
      firstSupersededFileNames = supersededNames(0);
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
            ...(supersededNames(offset + 1).length ? { supersededFileNames: supersededNames(offset + 1) } : {}),
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
        slackInvoiceDetails({ attachments: requestFilenames(request) }, conversationId, intercomAppId, { email: assigneeEmail }),
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
        supersededFileNames: firstSupersededFileNames,
        preloadedBuffers,
        plan: { planId, clusterIndex: 0 },
        startTime,
        clustered: true,
      }, abortSignal);
    } finally {
      if (undispatched.length) {
        await notifyResult(
          'create_invoice',
          'error',
          Date.now() - startTime,
          slackInvoiceDetails({
            planId,
            undispatchedClusters: undispatched.map(({ files }) => files.map((file) => file.fileName)),
          }, conversationId, intercomAppId, { email: assigneeEmail }),
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
      supersededFileNames,
      ...(clustered && requestPlanId && requestClusterIndex != null
        ? { plan: { planId: requestPlanId, clusterIndex: requestClusterIndex } }
        : {}),
      startTime,
      clustered: true,
    }, abortSignal);
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
      }, abortSignal);
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
  }, abortSignal);
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
  supersededFileNames?: string[];
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

async function createInvoiceFromCluster(
  context: ProcessingContext,
  input: ClusterInvoiceInput,
  abortSignal?: AbortSignal
): Promise<void> {
  const { plan } = input;
  if (plan && !(await claimInvoiceCluster(context.dbConnection, plan.planId, plan.clusterIndex))) {
    debug('Invoice cluster already done or being processed by another run; skipping', plan);
    return;
  }
  const run: ClusterRunState = {};
  try {
    await processInvoiceCluster(context, input, run, abortSignal);
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
      }, input.conversationId, input.intercomAppId, { email: input.assigneeEmail }),
      new Error('The invoice was processed but its cluster plan row could not be marked done; a later retry of this cluster could process it again.')
    );
  }
}

async function processInvoiceCluster(
  context: ProcessingContext,
  input: ClusterInvoiceInput,
  run: ClusterRunState,
  abortSignal?: AbortSignal
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
    supersededFileNames,
    preloadedBuffers,
    startTime,
    clustered,
  } = input;
  const [primary] = files;
  const { s3Key, fileName, contentType } = primary;
  const emailContext = requestEmailContext ?? primary.emailContext;
  const snapshotContext = {
    ...(conversationId ? { conversationId } : {}),
    s3Keys: files.map((file) => file.s3Key),
    attachmentKinds: files.map((file) => file.kind ?? 'unclassified'),
    clusteringMode: invoiceAttachmentClusteringMode(),
  };
  let assigneeLookup: { match?: EmployeeLookupResult } | undefined;

  try {
    debug(`Processing new invoice from S3: ${s3Key}`, clustered ? { clusterFiles: files.map((file) => file.fileName) } : {});
    const loaded: LoadedClusterFile[] = await Promise.all(files.map(async (file) => {
      const [buffer, presignedUrl] = await Promise.all([
        preloadedBuffers?.get(file.s3Key) ?? getBinaryFromS3(context.s3Config, file.s3Key),
        getPresignedUrl(context.s3Config, file.s3Key),
      ]);
      return { ...file, buffer, presignedUrl };
    }));
    // A Word or Excel file that cannot be opened is never read by the model. Without its invoice file the
    // agent would draft from the email text alone, so stop and let AP handle it; unreadable backup files are
    // still attached and are named in the Slack post.
    const unreadableFlags = await Promise.all(loaded.map((file) => isUnreadableOffice(file)));
    if (unreadableFlags[0]) {
      throw new Error(`${loaded[0].fileName} could not be opened (it may be corrupt or password-protected); nothing was read from it, so no invoice was created`);
    }
    const unreadableAttachments = loaded.filter((_, index) => unreadableFlags[index]).map((file) => file.fileName);
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
    // A reimbursement packet pays the person the form names, so the folio inside it is never read as a supplier invoice.
    const reimbursementDecision = await decideReimbursement(
      context.dbConnection,
      await readReimbursementPacket(processedAttachments, emailContext, abortSignal),
      { defaultSupplierWid: DEFAULT_SUPPLIER_WID, emailContext }
    );
    if (reimbursementDecision.outcome === 'manual_entry') {
      debug('Reimbursement packet not booked', reimbursementDecision.manual);
      await notifyResult('create_invoice', 'success', Date.now() - startTime, slackInvoiceDetails({
        attachment: { fileName, contentType, sizeBytes: buffer.length, includedInline: true },
        ...(clustered ? { attachments: clusterSlackAttachments(loaded) } : {}),
        reimbursementManualEntry: reimbursementDecision.manual,
      }, conversationId, intercomAppId));
      return;
    }
    const reimbursement = reimbursementDecision.outcome === 'apply' ? reimbursementDecision.reimbursement : undefined;
    // A PO named in a reimbursement email does not apply: the payment is to a person, not against an order.
    const notePurchaseOrders = reimbursement ? [] : findNotePurchaseOrders(emailContext?.adminConversationParts);
    const emailPurchaseOrders = reimbursement ? {} : findEmailPurchaseOrders(emailContext, fileName, notePurchaseOrders);
    const prefetchedPo = reimbursement
      ? { notFoundPurchaseOrderNumbers: new Set<string>() }
      : await resolvePurchaseOrder(context, emailPurchaseOrders, notePurchaseOrders);
    const parsedPo = prefetchedPo.purchaseOrder;
    const stubCompany = enrichmentStubCompany(parsedPo);

    const result = await enrichInvoiceFromAttachments(
      stubInvoice,
      processedAttachments,
      undefined,
      stubCompany,
      emailContext,
      parsedPo ? toPurchaseOrderEnrichmentContext(parsedPo) : undefined,
      attachmentRoles,
      abortSignal,
      undefined,
      reimbursement
    );
    debug('Enrichment result:', result);

    if (result.supplier.status === 'error') {
      throw new Error(`Invoice enrichment returned error status: ${result.supplier.reason}`);
    }

    const multiInvoice = multiInvoiceReview({
      fileName,
      enteredInvoiceNumber: result.extractedSuppliersInvoiceNumber,
      invoiceNumbersInDocument: result.invoiceNumbersInDocument,
    });
    if (multiInvoice) debug(`Multiple invoices in one PDF: ${multiInvoice.message}`);

    const extractedInvoiceDate = result.extractedInvoiceDate || undefined;
    const extractedDueDate = normalizePrintedDate(result.extractedDueDate) ?? undefined;

    const targetSupplierWID = result.supplier.resolvedSupplier?.workdayId ?? DEFAULT_SUPPLIER_WID;
    const recommendedCompanyWID = result.companyVerification?.status === 'different'
      ? result.companyVerification.recommended?.workdayId ?? undefined
      : undefined;
    // The email text and AP notes name the company first. Only when they name none does the coding line printed on a
    // reimbursement form count as named coding, so a form company is verified like an emailed one and never trusted bare.
    const reimbursementCodingLineText = reimbursement ? reimbursementCodingLine(reimbursement) : undefined;
    const resolveEmailCompany = (formCodingLine?: string) => resolveCompanyFromEmail({
      db: context.dbConnection,
      emailBody: [emailContext?.plainTextBody, formCodingLine].filter(Boolean).join('\n'),
      codingText: [emailCodingText(emailContext), formCodingLine].filter(Boolean).join('\n'),
      apNotes: emailContext?.adminConversationParts,
      emailCompany: result.emailWorktags?.company,
    });
    const emailNamedCompany = await resolveEmailCompany();
    const formResolvedCompany = !emailNamedCompany && reimbursementCodingLineText
      ? await resolveEmailCompany(reimbursementCodingLineText)
      : undefined;
    // The form's coding value is untyped, so a company it resolves to must be the one the matching model claimed from
    // it; a company the cache happens to find for some other code on the line is never taken.
    const claimedCompany = result.emailWorktags?.company;
    const formNamedCompany: EmailCompanyMatch | undefined = formResolvedCompany
      && ((formResolvedCompany.workdayId && formResolvedCompany.workdayId === claimedCompany?.workdayId)
        || (formResolvedCompany.referenceId && formResolvedCompany.referenceId === claimedCompany?.referenceId))
      ? { ...formResolvedCompany, origin: 'form' }
      : undefined;
    const emailCompany = emailNamedCompany ?? formNamedCompany;

    const extractedServiceDate = normalizePrintedDate(result.extractedServiceDate) ?? undefined;
    const composedSuppliersInvoiceNumber = describeSuppliersInvoiceNumber({
      invoiceNumber: result.extractedSuppliersInvoiceNumber,
      accountNumber: result.extractedAccountNumber,
      invoiceDate: extractedInvoiceDate,
      serviceDate: extractedServiceDate,
      supplierName: supplierNameForInvoiceNumber(
        result.supplier.extractedInformation?.supplierName,
        result.supplier.resolvedSupplier?.supplierName,
      ),
    });
    const extractedAmountDue = result.extractedAmountDue ?? undefined;
    const enrichmentPoNumber = normalizePurchaseOrderNumber(result.extractedPurchaseOrderNumber);
    const selectedPo = await selectPurchaseOrder(
      context,
      prefetchedPo,
      notePurchaseOrders,
      emailPurchaseOrders,
      enrichmentPoNumber,
      result.extractedSuppliersInvoiceNumber
    );
    const noteLine = selectedPo.fromNote
      ? noteLineForInvoice(selectedPo.fromNote, result.extractedSuppliersInvoiceNumber)
      : { conflict: false };
    const pinnedPo = pinNotePurchaseOrderLine(selectedPo.purchaseOrder, noteLine.lineNumber);
    const matchedPo = pinnedPo.purchaseOrder;
    const purchaseOrderSupplier = await resolvePurchaseOrderSupplier(context.dbConnection, {
      purchaseOrderNumber: matchedPo?.documentNumber,
      purchaseOrderSupplier: matchedPo?.supplier,
      invoiceSupplierWID: result.supplier.resolvedSupplier?.workdayId ?? undefined,
      invoiceSupplier: {
        resolvedName: result.supplier.resolvedSupplier?.supplierName,
        extractedName: result.supplier.extractedInformation?.supplierName,
        phone: result.supplier.extractedInformation?.phone,
        email: result.supplier.extractedInformation?.email,
      },
    });
    const submitSupplierWID = purchaseOrderSupplier?.workdayId ?? targetSupplierWID;

    // Key resends on the number printed on the document, never a generated submit value: a number composed
    // from the supplier name and date would give two unnumbered invoices on the same day one registry row.
    const registryNumber = normalizeClusterInvoiceNumber(result.extractedSuppliersInvoiceNumber);
    // A number the agent made up is reserved per source document within the conversation, early in the run so a
    // sibling invoice that generates the same number sees it: the first takes the supplier plus invoice date, a
    // sibling takes the supplier plus service date, then -2, -3 ... A re-trigger of the same document keeps its number.
    const generatedNumberDocumentHash = createHash('sha256').update(buffer).digest('hex');
    const needsGeneratedNumberReservation = Boolean(
      composedSuppliersInvoiceNumber.generated && composedSuppliersInvoiceNumber.number && conversationId && !registryNumber
    );
    // The same document may already have a live invoice under another supplier (a re-trigger often resolves the
    // default supplier to a real one). Look before reserving, so a skipped run leaves no empty reservation behind.
    const earlierInvoicesForDocument = needsGeneratedNumberReservation && conversationId
      ? await findGeneratedInvoicesForDocument(context.dbConnection, {
        conversationId,
        supplierWid: submitSupplierWID ?? '',
        documentHash: generatedNumberDocumentHash,
      })
      : [];
    let liveEarlierInvoice: { assignedNumber: string; workdayInvoiceWid: string; otherSupplier: boolean } | undefined;
    for (const earlier of earlierInvoicesForDocument) {
      const earlierEditability = await getSupplierInvoiceEditability(context, earlier.workdayInvoiceWid);
      if (earlierEditability.found && !earlierEditability.isCanceled && earlierEditability.status !== 'Canceled') {
        liveEarlierInvoice = { assignedNumber: earlier.assignedNumber, workdayInvoiceWid: earlier.workdayInvoiceWid, otherSupplier: true };
        break;
      }
    }
    const generatedNumberReservation = needsGeneratedNumberReservation && !liveEarlierInvoice && conversationId && composedSuppliersInvoiceNumber.number
      ? await reserveGeneratedInvoiceNumber(context.dbConnection, {
        conversationId,
        supplierWid: submitSupplierWID ?? '',
        candidates: [composedSuppliersInvoiceNumber.number, composedSuppliersInvoiceNumber.serviceDateNumber].filter((number): number is string => Boolean(number)),
        documentHash: generatedNumberDocumentHash,
        amountDue: result.extractedAmountDue,
      })
      : undefined;

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
    // The default company codes no PO lines, so a note line is honored only when PO lines are used.
    const notePoLineNumber = pinnedPo.lineMissing || !matchedPoLines?.length ? undefined : noteLine.lineNumber;
    const purchaseOrderSelectionNotes = formatPurchaseOrderSelectionNotes({
      selected: selectedPo,
      invoicePurchaseOrderNumber: enrichmentPoNumber,
      emailPurchaseOrderNumber: emailPurchaseOrders.supplierPurchaseOrderNumber,
      appliedLineNumber: notePoLineNumber,
      noteLineNumber: noteLine.lineNumber,
      noteLineMissing: pinnedPo.lineMissing && !usedDefaultCompany,
      noteLineConflict: noteLine.conflict && Boolean(matchedPoLines?.length),
    });
    const memoIdentifiers = memoIdentifiersFromEnrichment(result, extractedPurchaseOrderNumber);
    // A reimbursement reads no supplier document, so its description is the only thing the memo can say.
    const memo = composeInvoiceMemo({
      ...memoIdentifiers,
      description: reimbursement ? reimbursement.description : result.supplier.extractedInformation?.memo,
    });

    // A bare "$" names no currency, so only a printed non-USD signal ever reaches Workday's Currency_Reference.
    const documentCurrency = detectInvoiceCurrency({
      extractedCurrency: result.extractedCurrency,
      amountTexts: [result.extractedAmountDue, result.extractedFreightAmount, result.extractedTaxAmount],
    }).code ?? undefined;
    let currencyDecision: InvoiceCurrencyDecision | undefined;
    const decideCurrency = async (supplierWID: string | undefined, existingInvoice: boolean) => {
      currencyDecision = await resolveInvoiceCurrency({
        extractedCurrency: result.extractedCurrency,
        amountTexts: [result.extractedAmountDue, result.extractedFreightAmount, result.extractedTaxAmount],
        supplierWID,
        defaultSupplierWID: DEFAULT_SUPPLIER_WID,
        existingInvoice,
        lookupSupplierCurrencies: (wid) => getSupplierAcceptedCurrencies(context, wid),
      });
      return currencyDecision;
    };

    debug(`Supplier resolution: status=${result.supplier.status}, targetSupplierWID=${targetSupplierWID ?? 'none'}, submitSupplierWID=${submitSupplierWID ?? 'none'}`);
    debug(`Company resolution: status=${result.companyVerification?.status}, emailCompany=${emailCompany?.referenceId ?? emailCompany?.workdayId ?? 'none'}, poCompany=${poCompanyWID ?? 'none'}, companyWID=${companyWID} (${companyReferenceType})`);

    // A row that bills nothing never reaches the PO line match, and does not count as a row dropped from its table.
    const { rows: extractedRows, removed: freeRows } = removeFreeRows(result.extractedInvoiceLines ?? []);
    if (freeRows.length) debug(`Free rows left off: ${freeRowsNote(freeRows)}`);
    // A row or printed charge that names a PO service line (delivery, pickup, a surcharge) is billed on that line
    // instead of being folded into header freight or tax.
    // Payroll or employment tax is not sales or use tax, so it stays an invoice line instead of joining header tax.
    const payrollTaxCharges = placePayrollTaxCharges({
      lines: extractedRows.filter(l => l.description && (l.totalPrice || l.unitCost)),
      // Classify from every printed row, including one removeFreeRows or the amount filter above dropped: a
      // free or unpriced payroll category (`Wages $0.00`) still signals a payroll recharge for its Taxes row.
      classificationLines: result.extractedInvoiceLines ?? [],
      otherCharges: result.extractedOtherCharges,
      tax: result.extractedTaxAmount,
      taxLabel: result.extractedTaxLabel,
      poLines,
    });
    if (payrollTaxCharges.message) debug(payrollTaxCharges.message);
    const placedCharges = placeChargesOnPoServiceLines({
      lines: payrollTaxCharges.lines,
      otherCharges: payrollTaxCharges.otherCharges,
      freightAmount: result.extractedFreightAmount,
      freightLabel: result.extractedFreightLabel,
      taxAmount: result.extractedTaxAmount,
      poLines: poClosedForInvoicing ? undefined : poLines,
      // Payroll or employment tax is coded like its sibling rows: never pinned to a PO service line, even a
      // long label (`Employer Payroll Taxes`) that would otherwise satisfy the matcher's length guard.
      excludeFromMatching: line => isPayrollTaxCharge(line.description, { lines: result.extractedInvoiceLines ?? payrollTaxCharges.lines, poLines }),
    });
    if (placedCharges.placed.length) debug('Placed on PO service lines', placedCharges.placed);
    const printedLines = placedCharges.lines;
    // Header amounts follow the printed labels first (tax read as freight, withheld or cleared values);
    // freight-as-lines and duplicate removal then work from those amounts.
    const {
      extractedFreightAmount: resolvedFreightAmount,
      extractedTaxAmount: resolvedHeaderTaxAmount,
      freightCleared: headerFreightCleared,
      taxCleared: resolvedHeaderTaxCleared,
      reviewNote: chargeReviewNote,
      chargeWithheld,
      freightFromRows: headerFreightFromRows,
    } = resolveHeaderChargeAmounts({
      extractedFreightAmount: placedCharges.freightAmount,
      extractedFreightLabel: placedCharges.freightLabel,
      extractedTaxAmount: result.extractedTaxAmount,
      extractedTaxLabel: result.extractedTaxLabel,
      freightAmountFromLines: splitFreightLines(printedLines).freightAmountFromLines,
    });
    // The main Tax_Amount field itself can be a misread payroll tax (placePayrollTaxCharges already moved it onto
    // the lines above); clear it here too so it never reaches header tax, the same as a printed $0.00 would.
    const headerTaxCleared = resolvedHeaderTaxCleared || payrollTaxCharges.taxCleared === true;
    const resolvedTaxAmount = headerTaxCleared ? undefined : resolvedHeaderTaxAmount;
    const settlementPrinted = hasPrintedSettlement({
      extractedPartialPayment: result.extractedPartialPayment,
      extractedPriorPayments: result.extractedPriorPayments,
      extractedRetainage: result.extractedRetainage,
      emailBalanceDue: result.emailBalanceDue,
    });
    // A charge printed with its own breakdown under it (a usage total and its tier rows) is booked once, at the level
    // that matches the printed subtotal. This runs before any tax or freight gap is judged, which assumes the lines are right.
    const breakdown = chargeWithheld
      ? { lines: printedLines, removed: [] as typeof printedLines, note: undefined }
      : removeBreakdownRows(printedLines, {
        lineSubtotal: result.extractedLineSubtotal,
        amountDue: extractedAmountDue,
        freight: headerFreightCleared ? undefined : resolvedFreightAmount,
        tax: resolvedTaxAmount,
        taxLabel: result.extractedTaxLabel,
        printedTaxCharges: placedCharges.otherCharges,
        settlementPrinted,
        poLines,
      });
    if (breakdown.note) debug(`Breakdown rows: ${breakdown.note}`);
    const breakdownLines = breakdown.lines;
    const printedRowCount = extractedRows.length + payrollTaxCharges.addedLines + placedCharges.addedLines - breakdown.removed.length;
    // A quantity beside one price may be a unit price whose line total was left off, and a unit price beside a
    // line total that is not quantity x unit price may have a misread total; each is read that way only when
    // that is what makes the lines match the amount due.
    const { lines: extractedLines, note: linePriceNote } = reinterpretSinglePriceLinesForCharges(breakdownLines, {
      amountDue: extractedAmountDue,
      freight: resolvedFreightAmount,
      tax: resolvedTaxAmount,
      taxLabel: result.extractedTaxLabel,
      freightCleared: headerFreightCleared,
      taxCleared: headerTaxCleared,
      chargeWithheld,
      summaryChargesPlaceable: breakdownLines.length === printedRowCount,
      printedTaxCharges: placedCharges.otherCharges,
      printedSummaryCharges: result.extractedSummaryCharges,
      settlementPrinted,
      lineSubtotal: result.extractedLineSubtotal,
    });
    if (linePriceNote) debug(`Line price review: ${linePriceNote}`);
    const restoredFreight = restoreClearedFreightFromRows(extractedLines, {
      amountDue: extractedAmountDue,
      tax: resolvedTaxAmount,
      freightCleared: headerFreightCleared,
    });
    const freightCleared = headerFreightCleared && restoredFreight.freight == null;
    // A printed environmental or other tax-like charge joins header tax when it exactly explains the shortfall.
    const printedTaxCharges = applyPrintedTaxCharges({
      charges: placedCharges.otherCharges,
      amountDue: extractedAmountDue,
      lines: extractedLines,
      freight: restoredFreight.freight ?? resolvedFreightAmount,
      tax: resolvedTaxAmount,
      taxLabel: result.extractedTaxLabel,
      taxCleared: headerTaxCleared,
      chargeWithheld,
      poLines,
      lineSubtotal: result.extractedLineSubtotal,
      settlementPrinted,
    });
    // A printed rate without a printed tax amount gives the tax only when the amount due and the rate agree.
    const taxCharges = deriveTaxFromPrintedRate(printedTaxCharges, {
      rate: result.extractedTaxRate,
      amountDue: extractedAmountDue,
      lines: extractedLines,
      freight: restoredFreight.freight ?? resolvedFreightAmount,
      summaryCharges: result.extractedSummaryCharges,
      taxCharges: placedCharges.otherCharges,
      taxLabel: result.extractedTaxLabel,
      chargeWithheld,
      settlementPrinted,
      payrollTaxPlaced: payrollTaxCharges.addedLines > 0,
      classificationLines: result.extractedInvoiceLines ?? [],
      poLines,
    });
    const { taxAmount: extractedTaxAmount, taxCleared, computedFromRate: taxComputedFromRate } = taxCharges;
    const charges = prepareInvoiceCharges(
      extractedLines,
      { amountDue: extractedAmountDue, freight: restoredFreight.freight ?? resolvedFreightAmount, tax: extractedTaxAmount },
      { allowFreightAsLines: true, removeDuplicates: true }
    );
    const { freightAmount: extractedFreightAmount, freightAsLines, reconciliation: chargeReconciliation } = charges;
    const freightRowsMessage = restoredFreight.message || freightAsLines ? undefined : freightFromRowsMessage(extractedLines, { freight: extractedFreightAmount, headerFreightRead: !headerFreightFromRows });
    let chargeCheck = [
      ...(restoredFreight.message ? [restoredFreight.message] : []),
      ...(freightRowsMessage ? [freightRowsMessage] : []),
      ...(payrollTaxCharges.message ? [payrollTaxCharges.message] : []),
      ...(taxCharges.message ? [taxCharges.message] : []),
      ...chargeReconciliationMessages(chargeReconciliation),
    ];
    if (chargeCheck.length) debug('Invoice amount check', chargeReconciliationLogSummary(chargeReconciliation));
    const extractedCandidateLines = withComposedLineDescriptions(charges.lines);
    // A deposit invoice bills a printed amount smaller than its contract total, so one deposit line replaces the lines.
    // A document that prints retainage is a pay application, so the balance plan reconciles it (or flags unreadable figures), not the deposit plan.
    const depositPlan = chargeWithheld || freightAsLines || result.extractedRetainage != null
      ? undefined
      : planPartialPayment({
        currency: documentCurrency,
        partialPayment: result.extractedPartialPayment,
        lineSubtotal: result.extractedLineSubtotal,
        amountDue: extractedAmountDue,
        freightAmount: extractedFreightAmount,
        taxAmount: extractedTaxAmount,
        lines: extractedCandidateLines,
        poLines,
      });
    const depositApplied = Boolean(depositPlan?.applied);
    if (depositPlan) debug(`Deposit invoice: ${depositPlan.note}`);
    if (depositApplied) chargeCheck = [];

    // A withheld charge leaves the submitted header unknown, and a row dropped for a missing
    // description or amount leaves its table's total unknown, so no line can be judged a repeat.
    // Freight sent as lines is not on the header, so the header freight below would not apply.
    const repeatedLines = depositApplied || chargeWithheld || freightAsLines || extractedLines.length < printedRowCount
      ? { lines: extractedCandidateLines, note: undefined }
      : removeRepeatedLineTables(extractedCandidateLines, {
        amountDue: extractedAmountDue,
        freightAmount: extractedFreightAmount,
        taxAmount: extractedTaxAmount,
        freightCleared,
        taxCleared,
      }, poClosedForInvoicing ? undefined : poLines, { lineSubtotal: result.extractedLineSubtotal });
    if (repeatedLines.note) debug(`Repeated line review: ${repeatedLines.note}`);
    // Rows are compared as read, before freight, tax, and repeated tables are taken out; a removed repeated table
    // would otherwise look like rows read twice.
    // The amount due is the better judge of missing rows when the printed total covers only part of the table, but
    // it says nothing on an invoice that bills a deposit, an advance, or what is left after payments.
    const creditCents = summaryCreditCents(result.extractedSummaryCharges, charges.lines);
    const amountDueGap = depositApplied || chargeWithheld || freightAsLines || result.extractedPartialPayment || result.extractedPriorPayments?.length || hasPrintedRetainage(result.extractedRetainage)
      ? undefined
      : reviewAmountDueGapCents({
        lines: charges.lines,
        amountDue: extractedAmountDue,
        freight: freightCleared ? undefined : extractedFreightAmount,
        tax: taxCleared ? undefined : extractedTaxAmount,
        taxLabel: result.extractedTaxLabel,
        otherCharges: taxCharges.message ? undefined : placedCharges.otherCharges,
        summaryCharges: result.extractedSummaryCharges,
        creditCents,
      });
    const subtotalFreight = freightCleared ? 0 : subtotalFreightCents({
      subtotal: result.extractedLineSubtotal,
      amountDue: extractedAmountDue,
      // Only freight the document printed in its header: freight taken from a row is still one of the rows.
      freight: placedCharges.freightAmount ?? undefined,
      tax: taxCleared ? undefined : extractedTaxAmount,
      taxLabel: result.extractedTaxLabel,
      otherCharges: taxCharges.message ? undefined : placedCharges.otherCharges,
      creditCents,
    }) ?? 0;
    const subtotalMismatch = repeatedLines.note
      ? undefined
      : lineSubtotalReviewNote(extractedLines, result.extractedLineSubtotal, amountDueGap, subtotalFreight, result.extractedSecondReadOutcome);
    const lineSubtotalBaseNote = [
      secondReadRowsNote(result.extractedRowsAddedOnSecondRead),
      subtotalMismatch,
    ].filter(Boolean).join(' ') || undefined;
    // A fee or discount printed only in the totals block becomes an invoice line when it exactly explains the gap.
    const placedSummaryCharges: PlacedSummaryCharges = depositApplied || chargeWithheld || freightAsLines || extractedLines.length < printedRowCount
      ? { lines: [] }
      : placeSummaryCharges({
        charges: result.extractedSummaryCharges,
        amountDue: extractedAmountDue,
        lines: repeatedLines.lines,
        freight: extractedFreightAmount,
        tax: extractedTaxAmount,
        freightCleared,
        taxCleared,
      });
    // A remaining-balance invoice prints the full contract but bills only what is still unpaid, so one balance line replaces the lines.
    // It runs after repeated tables and totals charges so their explanations of the gap win.
    const balancePlan = depositPlan || chargeWithheld || freightAsLines
      ? undefined
      : planBalanceInvoice({
        currency: documentCurrency,
        priorPayments: result.extractedPriorPayments,
        retainage: result.extractedRetainage,
        emailBalanceDue: result.emailBalanceDue,
        lineSubtotal: result.extractedLineSubtotal,
        amountDue: extractedAmountDue,
        freightAmount: extractedFreightAmount,
        taxAmount: extractedTaxAmount,
        lines: [...repeatedLines.lines, ...placedSummaryCharges.lines],
        poLines,
      });
    const balanceApplied = Boolean(balancePlan?.applied);
    if (balancePlan) debug(`Balance invoice: ${balancePlan.note}`);
    if (balanceApplied) chargeCheck = [];
    const summaryCharges: PlacedSummaryCharges = balanceApplied ? { lines: [] } : placedSummaryCharges;
    const billedPlan = depositPlan ?? balancePlan;
    const billedPlanApplied = depositApplied || balanceApplied;
    const lineSubtotalNote = [
      lineSubtotalBaseNote,
      subtotalMismatch && !billedPlanApplied && !chargeWithheld && !freightAsLines ? poTotalReviewNote(poLines, extractedAmountDue, extractedLines.length) : undefined,
    ].filter(Boolean).join(' ') || undefined;
    if (lineSubtotalNote) debug(`Line subtotal review: ${lineSubtotalNote}`);
    if (summaryCharges.lines.length || summaryCharges.reviewNote) {
      debug('Totals charges', { placed: summaryCharges.lines.length, reviewNote: Boolean(summaryCharges.reviewNote) });
    }
    const candidateLines = billedPlan?.line ? [billedPlan.line] : [...repeatedLines.lines, ...summaryCharges.lines];

    // The deposit or balance line is a quantity 1 line at the billed amount, so it counts as one unit on its PO line.
    const invoiceLineQuantityDisplayed = billedPlanApplied
      ? true
      : resolveInvoiceLineQuantityDisplayed(result.invoiceLineQuantityDisplayed, candidateLines);

    const fallbackIds = {
      fundId: process.env.FALLBACK_FUND_ID,
      costCenterId: process.env.FALLBACK_COST_CENTER_ID,
      spendCategoryId: process.env.FALLBACK_SPEND_CATEGORY_ID,
      lineOfBusinessId: process.env.FALLBACK_LOB_ID,
    };
    const budgetCompanies = usedDefaultCompany ? {} : await budgetCompanyOptions({
      db: context.dbConnection,
      result,
      emailBody: emailContext?.plainTextBody,
      codingText: emailCodingText(emailContext),
      apNotes: emailContext?.adminConversationParts,
      emailCompany,
      headerCompanyId: companyWID,
      companyReferenceType,
    });
    const emailWorktags = usedDefaultCompany
      ? undefined
      : buildEmailWorktags(result, emailCompany, {
        ...budgetSplitOptions({
          charges: {
            amountDue: extractedAmountDue,
            freightAmount: extractedFreightAmount,
            taxAmount: extractedTaxAmount,
            freightCleared,
            taxCleared,
          },
          freightAsLines,
          chargeWithheld,
        }),
        ...budgetCompanies,
      });

    const relatedLobLookup = (costCenterIds: string[]) =>
      getCostCenterRelatedLobsByCodes(context.dbConnection, costCenterIds);
    const merged = await buildFinalInvoiceLines(
      candidateLines,
      billedPlan?.poLines ?? poLines,
      emailContext?.plainTextBody,
      fallbackIds,
      emailWorktags,
      relatedLobLookup,
      invoiceLineQuantityDisplayed,
      // A Closed or Pending Close PO omits every line reference, so it skips date-based selection.
      poClosedForInvoicing ? undefined : { invoiceDate: extractedInvoiceDate, servicePeriod: result.extractedServicePeriod },
      abortSignal
    );
    let relatedLobByCostCenter = merged.relatedLobByCostCenter;
    let finalLines = merged.lines;
    let emailBudgetSplit = merged.emailBudgetSplit;
    const poLineNote = unlinkedPoRowsNote(merged.unlinkedPoRows, poClosedForInvoicing ? undefined : merged.modelUnlinkedPoRows);
    if (poLineNote) debug(`PO line review: ${poLineNote}`);

    // An all-freight invoice must keep its coded freight line; if the PO merge returned none,
    // build it again without the PO, the way the remainder line below is built.
    if (finalLines.length === 0 && freightAsLines && candidateLines.length > 0) {
      debug('PO merge returned no lines for an all-freight invoice; rebuilding the freight line without the PO');
      const rebuilt = await buildFinalInvoiceLines(
        candidateLines,
        undefined,
        emailContext?.plainTextBody,
        fallbackIds,
        emailWorktags,
        relatedLobLookup,
        invoiceLineQuantityDisplayed
      );
      finalLines = overlaySharedPoWorktagsOnUnmatchedLines(rebuilt.lines, poLines);
      relatedLobByCostCenter = rebuilt.relatedLobByCostCenter;
      emailBudgetSplit = rebuilt.emailBudgetSplit;
    }

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
          invoiceLineQuantityDisplayed,
          undefined,
          abortSignal
        );
        finalLines = overlaySharedPoWorktagsOnUnmatchedLines(synthetic.lines, poLines);
        relatedLobByCostCenter = synthetic.relatedLobByCostCenter;
        emailBudgetSplit = synthetic.emailBudgetSplit;
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
          invoiceLineQuantityDisplayed,
          undefined,
          abortSignal
        );
        finalLines = overlaySharedPoWorktagsOnUnmatchedLines(synthetic.lines, poLines);
        relatedLobByCostCenter = synthetic.relatedLobByCostCenter;
        emailBudgetSplit = synthetic.emailBudgetSplit;
      } else {
        debug('No merchandise invoice lines remain after excluding freight; submitting Freight_Amount without a merchandise line');
      }
    }

    if (usedDefaultCompany && finalLines.length > 0) {
      finalLines = applyDefaultCompanyLineWorktags(finalLines, fallbackIds);
      relatedLobByCostCenter = new Map();
      const emailBudgets = result.emailBudgetSplits ?? [];
      emailBudgetSplit = emailBudgets.length > 1
        ? unappliedEmailBudgetSplit(emailBudgets, 'Default OCR fallback coding was applied to the lines')
        : undefined;
    }

    const settledSummary = settlePlacedSummaryLines(finalLines, summaryCharges, candidateLines);
    finalLines = settledSummary.lines;
    if (settledSummary.message) chargeCheck = [...chargeCheck, settledSummary.message];
    const totalsChargeReview = [summaryCharges.reviewNote, settledSummary.reviewNote].filter(Boolean).join(' ') || undefined;

    // Email budgets that total the amount due carry the header tax and freight in their lines, so the header
    // submits none; the notes above still show what the document printed.
    const chargesInLines = Boolean(emailBudgetSplit?.headerChargesRolledIn);
    const submitFreightAmount = chargesInLines ? undefined : extractedFreightAmount;
    const submitTaxAmount = chargesInLines ? undefined : extractedTaxAmount;
    const submitFreightCleared = chargesInLines || freightCleared;
    const submitTaxCleared = chargesInLines || taxCleared;
    if (chargesInLines) chargeCheck = [];

    let poQuantityNote: string | undefined;
    let zeroAmountLines: FinalInvoiceLine[] = [];
    if (finalLines.length > 0) {
      finalLines = applyInvoiceMemoIdentifiersToLines(finalLines, memoIdentifiers);
      const printedLines = finalLines;
      finalLines = normalizeSupplierInvoiceLineAmounts(finalLines, invoiceLineQuantityDisplayed);
      poQuantityNote = [positivePoQuantityNote(printedLines, finalLines), unitCostFromLineTotalNote(finalLines)].filter(Boolean).join(' ') || undefined;
      if (poQuantityNote) debug(`PO line quantity: ${poQuantityNote}`);
      // A line that still bills nothing would need a PO quantity of its own, which Workday counts against the priced lines.
      ({ lines: finalLines, removed: zeroAmountLines } = removeZeroAmountLines(finalLines));
    }
    const freeRowsReview = [freeRowsNote(freeRows), zeroAmountLinesNote(zeroAmountLines)].filter(Boolean).join(' ') || undefined;
    if (zeroAmountLines.length) debug(`Free lines left off: ${zeroAmountLinesNote(zeroAmountLines)}`);
    // A withheld charge leaves the submitted header unknown, and its own review note already asks AP to check it.
    // Freight sent as lines is not on the header; the submit-time Amount check reconciles that payload instead.
    const lineTotalReviewNote = chargeWithheld || freightAsLines ? undefined : lineTotalMismatchNote(finalLines, {
      amountDue: extractedAmountDue,
      freightAmount: submitFreightAmount,
      taxAmount: submitTaxAmount,
      freightCleared: submitFreightCleared,
      taxCleared: submitTaxCleared,
    });
    if (lineTotalReviewNote) debug(`Line total review: ${lineTotalReviewNote}`);
    const lineReview = [
      lineSubtotalNote && `Line subtotal review: ${lineSubtotalNote}`,
      breakdown.note && `Breakdown rows review: ${breakdown.note}`,
      repeatedLines.note && `Repeated line review: ${repeatedLines.note}`,
      totalsChargeReview && `Totals charge review: ${totalsChargeReview}`,
      linePriceNote && `Line price review: ${linePriceNote}`,
      lineTotalReviewNote && `Line total review: ${lineTotalReviewNote}`,
      poLineNote && `PO line review: ${poLineNote}`,
      poQuantityNote && `PO line quantity: ${poQuantityNote}`,
      emailBudgetSplit?.review && `Budget split review: ${emailBudgetSplit.review}`,
    ].filter((note): note is string => Boolean(note));

    const appliedRecommended = selectedCompany.source === 'recommended';
    const emailCompanyReview = selectedCompany.source === 'email' && emailCompany ? {
      appliedName: emailCompany.name,
      referenceId: emailCompany.referenceId,
      origin: selectedCompany.emailOrigin,
      conflictWith: selectedCompany.conflict?.with,
      conflictName: selectedCompany.conflict?.with === 'po'
        ? matchedPo?.company?.descriptor
        : result.companyVerification?.recommended?.companyName,
    } : undefined;
    const emailCompanyNotes = emailCompanyReview ? formatEmailCompanyNotes(emailCompanyReview) : '';
    // existingCompany here is a synthetic placeholder fed to the AI for comparison, not a
    // real prior state (this is a brand-new invoice) — omit it from the note's "was" wording.
    const emailWorktagNotes = formatEmailWorktagNotes(result);
    const emailOrDefaultWorktagNotes = usedDefaultCompany
      ? (emailWorktagNotes || emailBudgetSplit
        ? '\n\nLine worktags: Default OCR fallback coding applied; email worktags were not used on this invoice.'
        : '')
      : emailWorktagNotes;
    const assigneeMatch = await getEmployeeWidByEmail(context.dbConnection, assigneeEmail);
    assigneeLookup = { match: assigneeMatch };
    const assigneeName = assigneeMatch ? employeeDisplayName(assigneeMatch) : undefined;
    if (assigneeEmail && !assigneeMatch) {
      debug('Assignee email did not match AP agent workers report cache; omitting Assignee_Reference', {
        assigneeEmail,
      });
    }

    const reimbursementCodingText = reimbursement
      ? reimbursementCodingNote(reimbursement, { companyFromForm: Boolean(formNamedCompany), defaultCompany: usedDefaultCompany })
      : '';
    const reimbursementCodingNotes = reimbursementCodingText ? `\n\n${reimbursementCodingText}` : '';
    // A sibling that clashed with the default (invoice-date) number since this run reserved it marked it contested;
    // move to the service-date number now, before the notes name the number, so a batch of same-date invoices ends
    // up with service-date numbers. Nothing has been created yet, so the move is safe.
    const settledNumber = generatedNumberReservation && !generatedNumberReservation.reused && conversationId
      && composedSuppliersInvoiceNumber.number && composedSuppliersInvoiceNumber.serviceDateNumber
      && generatedNumberReservation.assignedNumber === composedSuppliersInvoiceNumber.number
      ? await settleGeneratedInvoiceNumber(context.dbConnection, {
        conversationId,
        supplierWid: submitSupplierWID ?? '',
        documentHash: generatedNumberDocumentHash,
        assignedNumber: generatedNumberReservation.assignedNumber,
        alternateNumber: composedSuppliersInvoiceNumber.serviceDateNumber,
        amountDue: result.extractedAmountDue,
      })
      : undefined;
    const extractedSuppliersInvoiceNumber = settledNumber?.assignedNumber ?? generatedNumberReservation?.assignedNumber ?? composedSuppliersInvoiceNumber.number;
    const takenServiceDateNumber = Boolean(
      extractedSuppliersInvoiceNumber && composedSuppliersInvoiceNumber.serviceDateNumber
      && extractedSuppliersInvoiceNumber.startsWith(composedSuppliersInvoiceNumber.serviceDateNumber)
    );
    const generatedNumberBasis = takenServiceDateNumber ? 'service_date' : composedSuppliersInvoiceNumber.basis;
    const amountDueKey = generatedNumberAmountKey(result.extractedAmountDue);
    const generatedNumberClash: GeneratedInvoiceNumberClash | undefined = settledNumber?.moved && composedSuppliersInvoiceNumber.number
      ? {
        clashedNumber: composedSuppliersInvoiceNumber.number,
        suffixed: false,
        invoiceDate: extractedInvoiceDate,
        amountDue: amountDueKey,
        clashedAmountDue: settledNumber.sameAmountSibling ? amountDueKey : null,
      }
      : generatedNumberReservation?.clashedNumber
        ? {
          clashedNumber: generatedNumberReservation.clashedNumber,
          suffixed: Boolean(generatedNumberReservation.suffixed),
          invoiceDate: extractedInvoiceDate,
          amountDue: amountDueKey,
          clashedAmountDue: generatedNumberReservation.clashedAmountDue,
        }
        : undefined;
    const generatedInvoiceNumberNotes = formatGeneratedInvoiceNumberNotes({
      number: extractedSuppliersInvoiceNumber,
      basis: generatedNumberBasis,
      serviceDate: extractedServiceDate,
      ...(generatedNumberClash ? { clash: generatedNumberClash } : {}),
    });
    const suffixedNumberReview = generatedNumberClash && extractedSuppliersInvoiceNumber
      ? `Supplier invoice number ${extractedSuppliersInvoiceNumber}: ${describeGeneratedNumberClash(generatedNumberClash)}`
      : undefined;
    const baseNotes = (appliedFallbacks: AppliedFallback[]) => formatMultiInvoiceNotes(multiInvoice) + formatSupplierNotes(result) + (reimbursement ? `\n\n${reimbursementNote(reimbursement)}` : '') + reimbursementCodingNotes + formatPurchaseOrderSupplierNotes(purchaseOrderSupplier) + formatCompanyNotes(result, undefined, { appliedRecommended, overriddenByEmail: selectedCompany.source === 'email' }) + emailCompanyNotes + formatInvoiceDateNotes(result) + formatDueDateNotes(result, appliedFallbacks) + formatAmountNotes(result) + formatFreightAmountNotes(extractedFreightAmount, freightCleared) + formatTaxAmountNotes(extractedTaxAmount, taxCleared, taxCharges.breakdown, taxCharges.computedFromRate) + formatChargeReviewNotes(chargeReviewNote) + formatInvoiceNumberNotes(result) + generatedInvoiceNumberNotes + formatPurchaseOrderNotes(result) + purchaseOrderSelectionNotes + formatMemoIdentifierNotes(result) + formatInvoiceLinesNotes(result, invoiceLineQuantityDisplayed) + formatPartialPaymentNotes(billedPlan?.note, billedPlan?.noteLabel) + formatLineSubtotalNotes(lineSubtotalNote) + formatBreakdownRowNotes(breakdown.note) + formatRepeatedLineNotes(repeatedLines.note) + formatTotalsChargeReviewNotes(totalsChargeReview) + formatFreeRowsNotes(freeRowsReview) + formatLinePriceReviewNotes(linePriceNote) + formatLineTotalReviewNotes(lineTotalReviewNote) + formatPoLineReviewNotes(poLineNote) + formatPositivePoQuantityNotes(poQuantityNote) + formatPaymentTermsNotes(result) + formatBankingInfoNotes(result) + emailOrDefaultWorktagNotes + formatEmailBudgetSplitNotes(emailBudgetSplit);
    const isAmountCheck = (f: AppliedFallback) => f.field === CHARGE_RECONCILIATION_FALLBACK_FIELD;
    const amountCheckLines = (appliedFallbacks: AppliedFallback[]) => mergeAmountCheckMessages(
      chargeCheck,
      appliedFallbacks.filter(isAmountCheck).map(f => f.label)
    );
    const submittedSlackAmountCheck = (appliedFallbacks: AppliedFallback[]) => {
      const lines = amountCheckLines(appliedFallbacks);
      return lines.length
        ? { chargeCheck: lines, ...(lines.some(isAmountMismatchMessage) ? { amountMismatch: true } : {}) }
        : {};
    };
    const isDueDateFallback = (f: AppliedFallback) => f.field === 'dueDate';
    const isCurrencyFallback = (f: AppliedFallback) => f.field === 'currency';
    const isListedInNotes = (f: AppliedFallback) => !isPurchaseOrderLineFallback(f) && !isAmountCheck(f) && !isDueDateFallback(f);
    const buildNotes = (appliedFallbacks: AppliedFallback[]) => {
      const assigneeOmitted = appliedFallbacks.some((f) => f.label === 'omitted assignee');
      const listedFallbacks = appliedFallbacks.filter(isListedInNotes);
      const amountCheck = amountCheckLines(appliedFallbacks);
      // An unexplained gap goes first so AP sees it before the supporting detail.
      const mismatchFirst = amountCheck.some(isAmountMismatchMessage);
      return (mismatchFirst ? formatAmountCheckNotes(amountCheck).trimStart() + '\n\n' : '')
        + baseNotes(appliedFallbacks)
        + (mismatchFirst ? '' : formatAmountCheckNotes(amountCheck))
        + formatWorkQueueAssigneeNotes(appliedFallbacks, {
          assigneeEmail,
          assigneeName,
          assigneeSetInWorkday: Boolean(assigneeMatch) && !assigneeOmitted,
        })
        + formatPurchaseOrderLineFallbackNotes(appliedFallbacks, extractedPurchaseOrderNumber)
        + formatCurrencyNotes(currencyDecision, appliedFallbacks.some(isCurrencyFallback))
        + (listedFallbacks.length ? `\n\nFallback values applied: ${listedFallbacks.map(f => f.label).join('; ')}` : '');
    };

    const paymentTermsId = result.extractedPaymentTerms?.workdayId ?? undefined;
    const conversationUrl = intercomConversationUrl(conversationId, intercomAppId);

    const companyNotification = selectedCompany.source === 'email' && emailCompany ? {
      status: 'email_resolved',
      appliedFrom: 'email',
      appliedFromEmail: true,
      emailOrigin: selectedCompany.emailOrigin,
      appliedName: emailCompany.name,
      appliedId: companyWID,
      appliedReferenceId: emailCompany.referenceId,
      ...(emailCompanyReview && describeEmailCompanyReview(emailCompanyReview).review
        ? { review: describeEmailCompanyReview(emailCompanyReview).review }
        : {}),
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
      ...(supersededFileNames?.length ? { supersededAttachments: supersededFileNames } : {}),
      ...(unreadableAttachments.length ? { unreadableAttachments } : {}),
      ...(multiInvoice ? { multipleInvoices: { fileName: multiInvoice.fileName, invoiceNumbers: multiInvoice.invoiceNumbers, message: multiInvoice.message } } : {}),
      ...(conversationPdf ? { conversationTranscriptFileName: conversationPdf.fileName } : {}),
      supplier: purchaseOrderSupplier && purchaseOrderSupplier.relation !== 'same' ? {
        status: 'po',
        resolvedName: purchaseOrderSupplier.descriptor,
        isDefault: false,
        purchaseOrderNumber: purchaseOrderSupplier.purchaseOrderNumber,
        ...(purchaseOrderSupplierReviewLine(purchaseOrderSupplier) ? { review: purchaseOrderSupplierReviewLine(purchaseOrderSupplier) } : {}),
      } : {
        status: result.supplier.status,
        resolvedName: result.supplier.resolvedSupplier?.supplierName,
        isDefault: !result.supplier.resolvedSupplier?.workdayId,
      },
      company: companyNotification,
      extracted: {
        invoiceDate: extractedInvoiceDate,
        dueDate: extractedDueDate,
        amountDue: extractedAmountDue,
        ...(billedPlan?.amountDueNote && billedPlanApplied ? { amountDueNote: billedPlan.amountDueNote } : {}),
        suppliersInvoiceNumber: extractedSuppliersInvoiceNumber,
        freightAmount: extractedFreightAmount,
        taxAmount: extractedTaxAmount,
        ...(taxComputedFromRate ? { taxComputedFromRate } : {}),
        freightCleared,
        taxCleared,
        purchaseOrderNumber: extractedPurchaseOrderNumber,
        ...(selectedPo.fromNote && matchedPo ? {
          purchaseOrderSource: 'note',
          ...(notePoLineNumber ? { purchaseOrderLine: notePoLineNumber } : {}),
          ...(enrichmentPoNumber
            ? (enrichmentPoNumber !== matchedPo.documentNumber ? { invoicePurchaseOrderNumber: enrichmentPoNumber } : {})
            : (emailPurchaseOrders.supplierPurchaseOrderNumber
              && emailPurchaseOrders.supplierPurchaseOrderNumber !== matchedPo.documentNumber
              ? { emailPurchaseOrderNumber: emailPurchaseOrders.supplierPurchaseOrderNumber }
              : {})),
        } : {}),
        ...(selectedPo.fromConversation && matchedPo && enrichmentPoNumber && enrichmentPoNumber !== matchedPo.documentNumber ? {
          purchaseOrderSource: 'conversation',
          invoicePurchaseOrderNumber: enrichmentPoNumber,
        } : {}),
        paymentTerms: result.extractedPaymentTerms ? describePaymentTerms(result.extractedPaymentTerms) : undefined,
      },
      lineCount: finalLines.length,
      ...(lineReview.length || suffixedNumberReview ? { lineReview: [...lineReview, ...(suffixedNumberReview ? [suffixedNumberReview] : [])] } : {}),
      ...(depositPlan?.slackLines.length ? { deposit: depositPlan.slackLines } : {}),
      ...(balancePlan?.slackLines.length ? { balanceInvoice: balancePlan.slackLines } : {}),
      ...(reimbursement ? { reimbursement: reimbursementSlackLines(reimbursement) } : {}),
      ...(emailBudgetSplit?.applied ? { budgetSplit: describeEmailBudgetSplit(emailBudgetSplit) } : {}),
    };

    // This document already produced an invoice, under its reserved number or under another supplier an earlier
    // run resolved. Resubmitting would only hit Workday's duplicate-number fault or make a second invoice for the
    // same document, so nothing is written. A canceled or deleted earlier invoice does not count.
    let skipForInvoice = liveEarlierInvoice;
    if (!skipForInvoice && generatedNumberReservation?.reused && generatedNumberReservation.workdayInvoiceWid) {
      const existingEditability = await getSupplierInvoiceEditability(context, generatedNumberReservation.workdayInvoiceWid);
      if (existingEditability.found && !existingEditability.isCanceled && existingEditability.status !== 'Canceled') {
        skipForInvoice = {
          assignedNumber: generatedNumberReservation.assignedNumber,
          workdayInvoiceWid: generatedNumberReservation.workdayInvoiceWid,
          otherSupplier: false,
        };
      }
    }
    if (skipForInvoice) {
      debug('Document already has an invoice under a generated number; skipping', {
        conversationId,
        suppliersInvoiceNumber: skipForInvoice.assignedNumber,
      });
      await notifyResult('create_invoice', 'success', Date.now() - startTime, slackInvoiceDetails({
        ...sharedSlackDetails,
        invoiceWID: skipForInvoice.workdayInvoiceWid,
        skipped: true,
        skipReason: `This document already has supplier invoice ${skipForInvoice.assignedNumber} in Workday from an earlier run for this conversation, so no new invoice was created.`
          + (skipForInvoice.otherSupplier ? ' That invoice is on a different supplier than this run resolved; move it to the right supplier in Workday if needed.' : ''),
      }, conversationId, intercomAppId));
      return;
    }

    const clusteringEnabled = isInvoiceAttachmentClusteringEnabled();
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
          const listedFallbacks = appliedFallbacks.filter(isListedInNotes);
          return `${baseNotes(appliedFallbacks)}${formatAmountCheckNotes(amountCheckLines(appliedFallbacks))}\n\nResubmission: conversation re-triggered; updated with the latest documents and messages.` +
            (newFiles.length ? ` New attachments: ${newFiles.map((file) => file.fileName).join(', ')}.` : ' No new attachments.') +
            formatPurchaseOrderLineFallbackNotes(appliedFallbacks, extractedPurchaseOrderNumber) +
            formatCurrencyNotes(currencyDecision, appliedFallbacks.some(isCurrencyFallback)) +
            (listedFallbacks.length ? `\n\nFallback values applied: ${listedFallbacks.map(f => f.label).join('; ')}` : '');
        };
        const updateSupplierWID = purchaseOrderSupplier?.workdayId ?? resolvedSupplierWID ?? registeredSupplierWID ?? targetSupplierWID;
        const updateCurrency = await decideCurrency(updateSupplierWID, true);
        const updateOutcome = await submitSupplierInvoiceUpdate(context, {
          invoiceWorkdayID: existing.workdayInvoiceWid,
          supplierWID: updateSupplierWID,
          ...(updateCurrency.currencyWID ? { currencyWID: updateCurrency.currencyWID } : {}),
          ...(updateCurrency.fallbackLabel ? { currencyFallbackLabel: updateCurrency.fallbackLabel } : {}),
          buildNotes: buildUpdateNotes,
          memo,
          invoiceDate: extractedInvoiceDate,
          dueDate: extractedDueDate,
          companyWID,
          companyReferenceType,
          extractedAmountDue,
          suppliersInvoiceNumber: extractedSuppliersInvoiceNumber,
          extractedFreightAmount: submitFreightAmount,
          freightAsLines,
          extractedTaxAmount: submitTaxAmount,
          freightCleared: submitFreightCleared,
          taxCleared: submitTaxCleared,
          finalLines,
          invoiceLineQuantityDisplayed: invoiceLineQuantityDisplayed ? undefined : false,
          relatedLobByCostCenter,
          resolveCostCenterWorkdayIds: (costCenterIds) =>
            getCostCenterWorkdayIdsByCodes(context.dbConnection, costCenterIds),
          resolveOrgWorktagKinds: (ids) => getOrgWorktagKindsByIds(context.dbConnection, ids),
          paymentTermsId,
          attachments: submitAttachments,
          ...(poClosedForInvoicing ? { omitPurchaseOrderLineReference: true } : {}),
          ...(result.bankingInfoPrinted ? { bankingInfoIncluded: true } : {}),
        });
        run.workdayInvoiceWid = existing.workdayInvoiceWid;
        const updateSnapshotSaved = await snapshotAgentWrite(context, {
          workdayInvoiceWid: existing.workdayInvoiceWid,
          source: 'resend_update',
          previousInvoice: updateOutcome.previousInvoice,
          ...(existing.workdayInvoiceNumber ? { workdayInvoiceNumber: existing.workdayInvoiceNumber } : {}),
          ...snapshotContext,
        });
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
            ...(updateOutcome.appliedFallbacks.some(isPurchaseOrderLineFallback) ? { purchaseOrderNotLinked: true } : {}),
            ...(updateOutcome.appliedFallbacks.some(isDueDateFallback) ? { dueDateNotApplied: true } : {}),
            ...(updateCurrency.currencyWID && updateCurrency.currencyWID !== 'USD' && !updateOutcome.appliedFallbacks.some(isCurrencyFallback) ? { currency: updateCurrency.currencyWID } : {}),
          },
          updated: true,
          newAttachments: newFiles.map((file) => file.fileName),
          invoiceWID: existing.workdayInvoiceWid,
          invoiceNumber: existing.workdayInvoiceNumber,
          ...submittedSlackAmountCheck(updateOutcome.appliedFallbacks),
          appliedFallbacks: updateOutcome.appliedFallbacks.filter(f => !isAmountCheck(f)).map(f => purchaseOrderLineFallbackLabel(f.label)),
          ...(updateOutcome.priorFailures?.length ? { priorFailures: updateOutcome.priorFailures } : {}),
          ...(updateRegistrySyncFailed ? { registrySync: 'failed' } : {}),
          ...(updateSnapshotSaved ? {} : { snapshotSync: 'failed' }),
        }, conversationId, intercomAppId));
        return;
      }
    }

    const replacedInvoiceLabel = replacedInvoice
      ? replacedInvoice.workdayInvoiceNumber ?? replacedInvoice.workdayInvoiceWid
      : undefined;
    const trackResends = Boolean(clusteringEnabled && conversationId && registryNumber);
    const createCurrency = await decideCurrency(submitSupplierWID, false);
    const createOutcome = await submitNewSupplierInvoice(context, {
      supplierWID: submitSupplierWID,
      companyWID,
      companyReferenceType,
      ...(createCurrency.currencyWID ? { currencyWID: createCurrency.currencyWID } : {}),
      ...(createCurrency.fallbackLabel ? { currencyFallbackLabel: createCurrency.fallbackLabel } : {}),
      buildNotes: (appliedFallbacks) =>
        buildNotes(appliedFallbacks) +
        (replacedInvoiceLabel ? `\n\nReplaces canceled invoice ${replacedInvoiceLabel} from the same conversation.` : ''),
      memo,
      invoiceDate: extractedInvoiceDate,
      dueDate: extractedDueDate,
      ...(conversationCreatedAt ? { invoiceReceivedDate: conversationCreatedAt } : {}),
      extractedAmountDue,
      suppliersInvoiceNumber: extractedSuppliersInvoiceNumber,
      extractedFreightAmount: submitFreightAmount,
      freightAsLines,
      extractedTaxAmount: submitTaxAmount,
      freightCleared: submitFreightCleared,
      taxCleared: submitTaxCleared,
      finalLines,
      invoiceLineQuantityDisplayed: invoiceLineQuantityDisplayed ? undefined : false,
      relatedLobByCostCenter,
      resolveCostCenterWorkdayIds: (costCenterIds) =>
        getCostCenterWorkdayIdsByCodes(context.dbConnection, costCenterIds),
      resolveOrgWorktagKinds: (ids) => getOrgWorktagKindsByIds(context.dbConnection, ids),
      paymentTermsId,
      attachments: submitAttachments,
      ...(assigneeMatch ? { assigneeWID: assigneeMatch.workdayId } : {}),
      ...(result.bankingInfoPrinted ? { bankingInfoIncluded: true } : {}),
      ...(poClosedForInvoicing ? { omitPurchaseOrderLineReference: true } : {}),
      ...(conversationUrl ? { conversationUrl } : {}),
      ...(reimbursement ? { keepSupplier: true } : {}),
    });

    const processingTime = Date.now() - startTime;

    run.workdayInvoiceWid = createOutcome.invoiceWID;
    const snapshotSaved = createOutcome.invoiceWID
      ? await snapshotAgentWrite(context, {
        workdayInvoiceWid: createOutcome.invoiceWID,
        source: 'create',
        ...(createOutcome.createdInvoice ? { invoice: createOutcome.createdInvoice } : {}),
        ...(createOutcome.invoiceNumber ? { workdayInvoiceNumber: createOutcome.invoiceNumber } : {}),
        ...snapshotContext,
      })
      : false;
    let registrySyncFailed = false;
    if (generatedNumberReservation && conversationId && extractedSuppliersInvoiceNumber) {
      if (!createOutcome.invoiceWID) {
        registrySyncFailed = true;
      } else {
        try {
          await recordGeneratedInvoiceNumberInvoice(context.dbConnection, {
            conversationId,
            supplierWid: submitSupplierWID ?? '',
            assignedNumber: extractedSuppliersInvoiceNumber,
            workdayInvoiceWid: createOutcome.invoiceWID,
          });
        } catch (error) {
          debug('Failed to record the invoice under its generated number:', error);
          registrySyncFailed = true;
        }
      }
    }
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
        ...(createOutcome.appliedFallbacks.some(isPurchaseOrderLineFallback) ? { purchaseOrderNotLinked: true } : {}),
        ...(createOutcome.appliedFallbacks.some(isDueDateFallback) ? { dueDateNotApplied: true } : {}),
        ...(createCurrency.currencyWID && createCurrency.currencyWID !== 'USD' && !createOutcome.appliedFallbacks.some(isCurrencyFallback) ? { currency: createCurrency.currencyWID } : {}),
      },
      invoiceWID: createOutcome.invoiceWID,
      invoiceNumber: createOutcome.invoiceNumber,
      ...(replacedInvoiceLabel ? { replacesCanceledInvoice: replacedInvoiceLabel } : {}),
      ...(assigneeEmail ? { assigneeEmail } : {}),
      ...(assigneeMatch ? {
        assigneeWorkdayId: assigneeMatch.workdayId,
        ...(assigneeName ? { assigneeName } : {}),
      } : {}),
      ...submittedSlackAmountCheck(createOutcome.appliedFallbacks),
      appliedFallbacks: createOutcome.appliedFallbacks.filter(f => !isAmountCheck(f)).map(f => purchaseOrderLineFallbackLabel(f.label)),
      ...(createOutcome.priorFailures?.length ? { priorFailures: createOutcome.priorFailures } : {}),
      ...(registrySyncFailed ? { registrySync: 'failed' } : {}),
      ...(snapshotSaved ? {} : { snapshotSync: 'failed' }),
    }, conversationId, intercomAppId));
  } catch (error) {
    const processingTime = Date.now() - startTime;
    debug('Error creating new supplier invoice:', error);
    const triggeredByMatch = assigneeLookup
      ? assigneeLookup.match
      : await getEmployeeWidByEmail(context.dbConnection, assigneeEmail);
    await notifyResult(
      'create_invoice',
      'error',
      processingTime,
      slackInvoiceDetails({
        s3Key,
        fileName,
        ...(clustered ? { attachments: files.map((file) => file.fileName) } : {}),
        ...(unrelated.length ? { unrelatedAttachments: unrelated.map((doc) => doc.fileName) } : {}),
      }, conversationId, intercomAppId, {
        email: assigneeEmail,
        name: triggeredByMatch ? employeeDisplayName(triggeredByMatch) : undefined,
      }),
      error
    );
    throw error;
  }
}
