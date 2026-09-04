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
} from './lib/invoice_enrichment.js';
import {
  applyInvoiceMemoIdentifiersToLines,
  composeInvoiceMemo,
  memoIdentifiersFromEnrichment,
} from './lib/invoice_memo.js';
import { getCostCenterRelatedLobsByCodes, getCostCenterWorkdayIdsByCodes } from './lib/database.js';
import {
  applyDefaultCompanyLineWorktags,
  buildFinalInvoiceLines,
  parseExtractedAmount,
  splitFreightLines,
} from './lib/invoice_lines.js';
import {
  findPurchaseOrderNumber,
  normalizePurchaseOrderNumber,
  type PurchaseOrderEnrichmentContext,
} from './lib/purchase_order.js';
import { getBinaryFromS3, getPresignedUrl } from './lib/s3.js';
import { notifyResult } from './lib/slack.js';
import { reportError } from './lib/divot_error_report.js';
import type { InvoiceData, WorkdayInvoice } from './lib/types.js';
import { buildIntercomConversationUrl } from './lib/intercom.js';
import {
  costCenterCodeExcludingCompany,
  resolveCompanyFromEmail,
  selectCompanyForCreateInvoice,
} from './lib/reference_ids.js';
import { loadPurchaseOrder, submitNewSupplierInvoice, type AppliedFallback, type ParsedPurchaseOrder } from './lib/workday.js';

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

export interface CreateInvoiceRequest {
  s3Key: string;
  fileName: string;
  contentType: string;
  emailContext?: InvoiceData['emailContext'];
  conversationId?: string;
  intercomAppId?: string;
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

async function processNewInvoice(context: ProcessingContext, request: CreateInvoiceRequest): Promise<void> {
  const startTime = Date.now();
  const { s3Key, fileName, contentType, emailContext, conversationId, intercomAppId } = request;

  if (!INVOICE_MOD_ENABLED) {
    debug('Invoice modification is disabled - skipping new invoice creation', { s3Key });
    await notifyResult(
      'create_invoice',
      'error',
      Date.now() - startTime,
      slackInvoiceDetails({ s3Key, fileName }, conversationId, intercomAppId),
      new Error('INVOICE_MOD_ENABLED is false; cannot create new invoices')
    );
    await reportError(new Error('INVOICE_MOD_ENABLED is false; cannot create new invoices'), {
      functionName: 'create_invoice',
    });
    return;
  }

  try {
    debug(`Processing new invoice from S3: ${s3Key}`);
    const [buffer, presignedUrl] = await Promise.all([
      getBinaryFromS3(context.s3Config, s3Key),
      getPresignedUrl(context.s3Config, s3Key),
    ]);
    const attachment = {
      id: s3Key,
      fileName,
      contentType,
      presignedUrl,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      s3Key,
      buffer,
    };

    // There's no existing Workday invoice yet, so enrich against a stub with no
    // existing supplier. Prefer the PO company when a matching PO is found;
    // otherwise use Default OCR Company.
    const stubInvoice: WorkdayInvoice = {};
    const parsedPo = await resolvePurchaseOrder(context, fileName, emailContext);
    const stubCompany = enrichmentStubCompany(parsedPo);

    const result = await enrichInvoiceFromAttachments(
      stubInvoice,
      [attachment],
      undefined,
      stubCompany,
      emailContext,
      parsedPo ? toPurchaseOrderEnrichmentContext(parsedPo) : undefined
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

    const extractedSuppliersInvoiceNumber = result.extractedSuppliersInvoiceNumber || undefined;
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

    const { merchandiseLines: candidateLines, freightAmountFromLines } = splitFreightLines(
      (result.extractedInvoiceLines ?? [])
        .filter(l => l.description && (l.totalPrice || l.unitCost))
    );
    const extractedFreightAmount = result.extractedFreightAmount
      ?? (freightAmountFromLines != null ? String(freightAmountFromLines) : undefined);

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
      relatedLobLookup
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
            quantity: 1,
            unitCost: String(remainder),
            totalPrice: String(remainder),
            hasDiscount: null,
          }],
          undefined,
          emailContext?.plainTextBody,
          fallbackIds,
          emailWorktags,
          relatedLobLookup
        );
        finalLines = synthetic.lines;
        relatedLobByCostCenter = synthetic.relatedLobByCostCenter;
      } else if (remainder != null && remainder <= 0) {
        debug('No merchandise invoice lines remain after excluding freight; submitting Freight_Amount without a merchandise line');
      } else if (!extractedFreightAmount) {
        debug('No invoice lines could be extracted or matched to a PO; synthesizing a single line from the extracted total');
        const synthetic = await buildFinalInvoiceLines(
          [{
            description: 'Invoice',
            quantity: 1,
            unitCost: extractedAmountDue ?? null,
            totalPrice: extractedAmountDue ?? null,
            hasDiscount: null,
          }],
          undefined,
          emailContext?.plainTextBody,
          fallbackIds,
          emailWorktags,
          relatedLobLookup
        );
        finalLines = synthetic.lines;
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
    const baseNotes = formatSupplierNotes(result) + formatCompanyNotes(result, undefined, { appliedRecommended }) + formatInvoiceDateNotes(result) + formatAmountNotes(result) + formatFreightAmountNotes(result) + formatTaxAmountNotes(result) + formatInvoiceNumberNotes(result) + formatPurchaseOrderNotes(result) + formatMemoIdentifierNotes(result) + formatInvoiceLinesNotes(result) + formatPaymentTermsNotes(result) + emailOrDefaultWorktagNotes;
    const buildNotes = (appliedFallbacks: AppliedFallback[]) =>
      baseNotes + (appliedFallbacks.length ? `\n\nFallback values applied: ${appliedFallbacks.map(f => f.label).join('; ')}` : '');

    const paymentTermsId = result.extractedPaymentTerms?.workdayId ?? undefined;

    const createOutcome = await submitNewSupplierInvoice(context, {
      supplierWID: targetSupplierWID,
      companyWID,
      companyReferenceType,
      buildNotes,
      memo,
      invoiceDate: extractedInvoiceDate,
      extractedAmountDue,
      suppliersInvoiceNumber: extractedSuppliersInvoiceNumber,
      extractedFreightAmount,
      extractedTaxAmount,
      finalLines,
      relatedLobByCostCenter,
      resolveCostCenterWorkdayIds: (costCenterIds) =>
        getCostCenterWorkdayIdsByCodes(context.dbConnection, costCenterIds),
      paymentTermsId,
      attachment: {
        fileName,
        contentType,
        base64Content: buffer.toString('base64'),
      },
    });

    const processingTime = Date.now() - startTime;

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

    await notifyResult('create_invoice', 'success', processingTime, slackInvoiceDetails({
      invoiceWID: createOutcome.invoiceWID,
      attachment: {
        fileName,
        contentType,
        sizeBytes: buffer.length,
        includedInline: true,
      },
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
      appliedFallbacks: createOutcome.appliedFallbacks.map(f => f.label),
      ...(createOutcome.priorFailures?.length ? { priorFailures: createOutcome.priorFailures } : {}),
    }, conversationId, intercomAppId));
  } catch (error) {
    const processingTime = Date.now() - startTime;
    debug('Error creating new supplier invoice:', error);
    await notifyResult(
      'create_invoice',
      'error',
      processingTime,
      slackInvoiceDetails({ s3Key, fileName }, conversationId, intercomAppId),
      error
    );
    await reportError(error, { functionName: 'create_invoice' });
    throw error;
  }
}
