import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
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
  getConversationSupplierInvoice,
  upsertConversationSupplierInvoice,
  type ConversationSupplierInvoice,
} from './lib/conversation_invoices.js';
import {
  applyInvoiceMemoIdentifiersToLines,
  composeInvoiceMemo,
  memoIdentifiersFromEnrichment,
  sanitizeSuppliersInvoiceNumber,
} from './lib/invoice_memo.js';
import { getCostCenterRelatedLobsByCodes, getCostCenterWorkdayIdsByCodes } from './lib/database.js';
import { employeeDisplayName, getEmployeeWidByEmail } from './lib/employees.js';
import {
  applyDefaultCompanyLineWorktags,
  buildFinalInvoiceLines,
  normalizeSupplierInvoiceLineAmounts,
  overlaySharedPoWorktagsOnUnmatchedLines,
  parseExtractedAmount,
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
import { getSupplierInvoiceEditability, loadPurchaseOrder, submitNewSupplierInvoice, submitSupplierInvoiceUpdate, type AppliedFallback, type ParsedPurchaseOrder } from './lib/workday.js';

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
  conversationPdf?: {
    s3Key: string;
    fileName: string;
  };
}

function slackInvoiceDetails(
  details: Record<string, unknown>,
  conversationId?: string,
  intercomAppId?: string
): Record<string, unknown> {
  const conversationUrl = conversationId
    ? buildIntercomConversationUrl(conversationId, INTERCOM_APP_ID || intercomAppId)
    : undefined;
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
    'emailContext' | 'conversationId' | 'intercomAppId' | 'assigneeEmail' | 'conversationCreatedAt' | 'conversationPdf' | 'latestMessageAt'
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
    let firstCluster;
    let unrelated: ClassifiedAttachment[] = [];
    try {
      const { clustering } = await parseAndClusterInvoiceAttachments(
        attachments,
        (key) => getBinaryFromS3(context.s3Config, key)
      );
      if (clustering.clusters.length === 0) {
        throw new Error('Invoice attachment clustering returned no clusters');
      }
      const [first, ...rest] = clustering.clusters;
      firstCluster = first;
      unrelated = clustering.unrelated;
      const shared = { emailContext, conversationId, intercomAppId, assigneeEmail, conversationCreatedAt, conversationPdf, latestMessageAt };
      await Promise.all(
        rest.map((cluster) => fanOutCluster([cluster.primary, ...cluster.supporting], shared))
      );
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
    await createInvoiceFromCluster(context, {
      files: [firstCluster.primary, ...firstCluster.supporting],
      unrelated,
      emailContext,
      conversationId,
      intercomAppId,
      assigneeEmail,
      conversationCreatedAt,
      conversationPdf,
      latestMessageAt,
      startTime,
      clustered: true,
    });
    return;
  }

  if (attachments?.length && (clustered || clusteringEnabled)) {
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
  startTime: number;
  clustered: boolean;
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
        getBinaryFromS3(context.s3Config, file.s3Key),
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
    const processedAttachments = loaded.map((file) => ({
      id: file.s3Key,
      fileName: file.fileName,
      contentType: file.contentType,
      presignedUrl: file.presignedUrl,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      s3Key: file.s3Key,
      buffer: file.buffer,
    }));
    const attachmentRoles: InvoiceAttachmentRole[] | undefined =
      clustered && loaded.length > 1
        ? loaded.map((file, index) => ({
          fileName: file.fileName,
          role: index === 0 ? 'invoice' as const : 'supporting' as const,
        }))
        : undefined;

    // There's no existing Workday invoice yet, so enrich against a stub with no
    // existing supplier. Prefer the PO company when a matching PO is found;
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

    const extractedSuppliersInvoiceNumber = sanitizeSuppliersInvoiceNumber(result.extractedSuppliersInvoiceNumber);
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
    const poLines = usedDefaultCompany ? undefined : matchedPo?.lines;
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
    const candidateLines = withComposedLineDescriptions(merchandiseLines);
    const extractedFreightAmount = result.extractedFreightAmount
      ?? (freightAmountFromLines != null ? String(freightAmountFromLines) : undefined);

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
      invoiceLineQuantityDisplayed
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

    const baseNotes = formatSupplierNotes(result) + formatCompanyNotes(result, undefined, { appliedRecommended }) + formatInvoiceDateNotes(result) + formatAmountNotes(result) + formatFreightAmountNotes(result) + formatTaxAmountNotes(result) + formatInvoiceNumberNotes(result) + formatPurchaseOrderNotes(result) + formatMemoIdentifierNotes(result) + formatInvoiceLinesNotes(result, invoiceLineQuantityDisplayed) + formatPaymentTermsNotes(result) + emailOrDefaultWorktagNotes;
    const buildNotes = (appliedFallbacks: AppliedFallback[]) => {
      const assigneeOmitted = appliedFallbacks.some((f) => f.label === 'omitted assignee');
      return baseNotes
        + formatWorkQueueAssigneeNotes(appliedFallbacks, {
          assigneeEmail,
          assigneeName,
          assigneeSetInWorkday: Boolean(assigneeMatch) && !assigneeOmitted,
        })
        + (appliedFallbacks.length ? `\n\nFallback values applied: ${appliedFallbacks.map(f => f.label).join('; ')}` : '');
    };

    const paymentTermsId = result.extractedPaymentTerms?.workdayId ?? undefined;

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
      lineCount: finalLines.length,
    };

    const clusteringEnabled = isInvoiceAttachmentClusteringEnabled();
    const registryNumber = extractedSuppliersInvoiceNumber
      ? normalizeClusterInvoiceNumber(extractedSuppliersInvoiceNumber)
      : undefined;
    // A supplier can answer AP's request for missing info in the email body with no new PDF,
    // so the newest message counts as new information alongside the newest document.
    const clusterReceivedAt = clusterMaxReceivedAt([...loaded, { receivedAt: latestMessageAt }]);

    // The default supplier means "not resolved", not a different supplier: a resend often moves
    // resolution between default and real (for example once a W-9 arrives), which must still update.
    const isRealSupplier = (wid?: string | null): wid is string => Boolean(wid) && wid !== DEFAULT_SUPPLIER_WID;
    const resolvedSupplierWID = isRealSupplier(result.supplier.resolvedSupplier?.workdayId)
      ? result.supplier.resolvedSupplier.workdayId
      : undefined;
    let replacedInvoice: ConversationSupplierInvoice | undefined;

    if (clusteringEnabled && conversationId && registryNumber) {
      const existing = await getConversationSupplierInvoice(context.dbConnection, conversationId, registryNumber);
      const registeredSupplierWID = isRealSupplier(existing?.supplierWid) ? existing.supplierWid : undefined;
      const supplierChanged = Boolean(
        registeredSupplierWID && resolvedSupplierWID && registeredSupplierWID !== resolvedSupplierWID
      );
      const editability = existing && !supplierChanged
        ? await getSupplierInvoiceEditability(context, existing.workdayInvoiceWid)
        : undefined;
      // AP canceled (or deleted) the registered invoice, so a new trigger creates a fresh one.
      const registeredInvoiceWasRemoved = Boolean(
        editability && (!editability.found || editability.isCanceled || editability.status === 'Canceled')
      );
      if (existing && registeredInvoiceWasRemoved) {
        replacedInvoice = existing;
        debug('Registered invoice is canceled or gone; creating a new supplier invoice', {
          conversationId,
          replacedInvoice: existing.workdayInvoiceNumber ?? existing.workdayInvoiceWid,
        });
      }
      if (existing && editability && !registeredInvoiceWasRemoved) {
        const hasNewerInformation =
          clusterReceivedAt == null ||
          existing.lastProcessedReceivedAt == null ||
          clusterReceivedAt > existing.lastProcessedReceivedAt;
        if (!hasNewerInformation) {
          const processingTime = Date.now() - startTime;
          const invoiceLabel = existing.workdayInvoiceNumber ?? existing.workdayInvoiceWid;
          debug('Skipping resend: no documents or messages newer than the last processing', {
            conversationId,
            invoiceLabel,
          });
          await notifyResult('create_invoice', 'success', processingTime, slackInvoiceDetails({
            ...sharedSlackDetails,
            invoiceWID: existing.workdayInvoiceWid,
            invoiceNumber: existing.workdayInvoiceNumber,
            skipped: true,
            skipReason: `No documents or messages newer than the last processing of ${invoiceLabel}.`,
          }, conversationId, intercomAppId));
          return;
        }
        if (!editability.editable) {
          const processingTime = Date.now() - startTime;
          const invoiceLabel = existing.workdayInvoiceNumber ?? existing.workdayInvoiceWid;
          const reason = `Invoice ${invoiceLabel} is ${editability.status ?? 'not editable'}${editability.isPaid ? ' (paid)' : ''}${editability.isPartiallyPaid ? ' (partially paid)' : ''}; re-sent documents need manual review.`;
          debug('Skipping resend update: invoice is not editable', {
            conversationId,
            invoiceLabel,
            editability,
          });
          await notifyResult('create_invoice', 'success', processingTime, slackInvoiceDetails({
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
        const watermark = existing.lastProcessedReceivedAt;
        const newFiles = watermark == null
          ? loaded
          : loaded.filter((file) => file.receivedAt != null && file.receivedAt > watermark);
        const buildUpdateNotes = (appliedFallbacks: AppliedFallback[]) =>
          `${baseNotes}\n\nResubmission: conversation re-triggered; updated with the latest documents and messages.` +
          (newFiles.length ? ` New attachments: ${newFiles.map((file) => file.fileName).join(', ')}.` : ' No new attachments.') +
          (appliedFallbacks.length ? `\n\nFallback values applied: ${appliedFallbacks.map(f => f.label).join('; ')}` : '');
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
          paymentTermsId,
          attachments: submitAttachments,
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
          updated: true,
          newAttachments: newFiles.map((file) => file.fileName),
          invoiceWID: existing.workdayInvoiceWid,
          invoiceNumber: existing.workdayInvoiceNumber,
          appliedFallbacks: updateOutcome.appliedFallbacks.map(f => f.label),
          ...(updateOutcome.priorFailures?.length ? { priorFailures: updateOutcome.priorFailures } : {}),
          ...(updateRegistrySyncFailed ? { registrySync: 'failed' } : {}),
        }, conversationId, intercomAppId));
        return;
      }
    }

    const replacedInvoiceLabel = replacedInvoice
      ? replacedInvoice.workdayInvoiceNumber ?? replacedInvoice.workdayInvoiceWid
      : undefined;
    const createOutcome = await submitNewSupplierInvoice(context, {
      supplierWID: targetSupplierWID,
      companyWID,
      companyReferenceType,
      buildNotes: replacedInvoiceLabel
        ? (appliedFallbacks: AppliedFallback[]) =>
          `${buildNotes(appliedFallbacks)}\n\nReplaces canceled invoice ${replacedInvoiceLabel} from the same conversation.`
        : buildNotes,
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
      paymentTermsId,
      attachments: submitAttachments,
      ...(assigneeMatch ? { assigneeWID: assigneeMatch.workdayId } : {}),
    });

    const processingTime = Date.now() - startTime;

    let registrySyncFailed = false;
    if (clusteringEnabled && conversationId && registryNumber) {
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
      invoiceWID: createOutcome.invoiceWID,
      invoiceNumber: createOutcome.invoiceNumber,
      ...(replacedInvoiceLabel ? { replacesCanceledInvoice: replacedInvoiceLabel } : {}),
      ...(assigneeEmail ? { assigneeEmail } : {}),
      ...(assigneeMatch ? {
        assigneeWorkdayId: assigneeMatch.workdayId,
        ...(assigneeName ? { assigneeName } : {}),
      } : {}),
      appliedFallbacks: createOutcome.appliedFallbacks.map(f => f.label),
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
