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
  formatPaymentTermsNotes,
  formatPurchaseOrderNotes,
  formatSupplierNotes,
  formatTaxAmountNotes,
} from './lib/invoice_enrichment.js';
import { buildFinalInvoiceLines, type ExtractedInvoiceLine } from './lib/invoice_lines.js';
import { applyProcessorLabelOutcome, getGmailConfig } from './lib/gmail.js';
import { getBinaryFromS3, getPresignedUrl } from './lib/s3.js';
import { notifyResult } from './lib/slack.js';
import type { InvoiceData, WorkdayInvoice } from './lib/types.js';
import type { AppliedFallback } from './lib/workday.js';
import { getPurchaseOrder, parsePurchaseOrderLines, submitNewSupplierInvoice } from './lib/workday.js';

const DEFAULT_SUPPLIER_WID = process.env.WORKDAY_DEFAULT_SUPPLIER_WID;
// Default_OCR_Company is a Workday Company_Reference_ID for a placeholder company used
// when the real company hasn't been determined yet — the same one OCR ingestion assigns.
const DEFAULT_COMPANY_REFERENCE_ID = process.env.WORKDAY_DEFAULT_COMPANY_REFERENCE_ID || 'Default_OCR_Company';
const INVOICE_MOD_ENABLED = process.env.INVOICE_MOD_ENABLED !== 'false'; // enabled by default

export interface CreateInvoiceRequest {
  s3Key: string;
  fileName: string;
  contentType: string;
  emailContext?: InvoiceData['emailContext'];
  gmailMessageId?: string;
  userEmail?: string;
  gmailAccessToken?: string;
}

// Processor function - invoked by trigger_create_invoice
export const processor = withProcessorHandler(async (context, requests) => {
  for (const request of requests) {
    await processNewInvoice(context, request as CreateInvoiceRequest);
  }
});

async function processNewInvoice(context: ProcessingContext, request: CreateInvoiceRequest): Promise<void> {
  const startTime = Date.now();
  const { s3Key, fileName, contentType, emailContext } = request;

  if (!INVOICE_MOD_ENABLED) {
    debug('Invoice modification is disabled - skipping new invoice creation', { s3Key });
    await notifyResult(
      'create_invoice',
      'error',
      Date.now() - startTime,
      { s3Key, fileName },
      new Error('INVOICE_MOD_ENABLED is false; cannot create new invoices')
    );
    await updateGmailProcessorLabel(request, 'failure');
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
    // existing supplier and the default placeholder company (to be verified/corrected).
    const stubInvoice: WorkdayInvoice = {};
    const existingCompany = { descriptor: 'Default Company', id: DEFAULT_COMPANY_REFERENCE_ID };

    const result = await enrichInvoiceFromAttachments(stubInvoice, [attachment], undefined, existingCompany, emailContext);
    debug('Enrichment result:', result);

    if (result.supplier.status === 'error') {
      throw new Error(`Invoice enrichment returned error status: ${result.supplier.reason}`);
    }

    const memo = result.supplier.extractedInformation?.memo || undefined;
    const extractedInvoiceDate = result.extractedInvoiceDate || undefined;

    const targetSupplierWID = result.supplier.resolvedSupplier?.workdayId ?? DEFAULT_SUPPLIER_WID;
    const recommendedCompanyWID = result.companyVerification?.status === 'different'
      ? result.companyVerification.recommended?.workdayId
      : undefined;
    const companyWID = recommendedCompanyWID ?? DEFAULT_COMPANY_REFERENCE_ID;
    const companyReferenceType = recommendedCompanyWID ? 'WID' : 'Company_Reference_ID';

    debug(`Supplier resolution: status=${result.supplier.status}, targetSupplierWID=${targetSupplierWID ?? 'none'}`);
    debug(`Company resolution: status=${result.companyVerification?.status}, companyWID=${companyWID} (${companyReferenceType})`);

    const extractedSuppliersInvoiceNumber = result.extractedSuppliersInvoiceNumber || undefined;
    const extractedAmountDue = result.extractedAmountDue ?? undefined;
    const extractedFreightAmount = result.extractedFreightAmount ?? undefined;
    const extractedTaxAmount = result.extractedTaxAmount ?? undefined;
    const rawPurchaseOrderNumber = result.extractedPurchaseOrderNumber || undefined;
    const normalizedPurchaseOrderNumber = rawPurchaseOrderNumber
      ? `PO-${rawPurchaseOrderNumber.replace(/^[Pp][Oo]-?/, '')}`
      : undefined;
    const extractedPurchaseOrderNumber: string | undefined = /^PO-\w{6}$/.test(normalizedPurchaseOrderNumber ?? '')
      ? normalizedPurchaseOrderNumber
      : undefined;

    let poLines: Awaited<ReturnType<typeof parsePurchaseOrderLines>> | undefined;
    if (extractedPurchaseOrderNumber) {
      debug(`Fetching PO data for extracted PO number: ${extractedPurchaseOrderNumber}`);
      try {
        const poResponse = await getPurchaseOrder(context, extractedPurchaseOrderNumber);
        poLines = parsePurchaseOrderLines(poResponse);
        const returnedPoNumber = poLines[0]?.purchaseOrderDocumentNumber;
        if (poLines.length === 0 || returnedPoNumber !== extractedPurchaseOrderNumber) {
          debug(`PO ${extractedPurchaseOrderNumber} not found in Workday (returned: ${returnedPoNumber ?? 'none'}) - skipping PO processing`);
          poLines = undefined;
        }
      } catch (poError) {
        debug(`Failed to fetch PO ${extractedPurchaseOrderNumber} from Workday - skipping PO processing:`, poError);
      }
    }

    const candidateLines: ExtractedInvoiceLine[] = (result.extractedInvoiceLines ?? [])
      .filter(l => l.description && (l.totalPrice || l.unitCost));

    const fallbackIds = {
      fundId: process.env.FALLBACK_FUND_ID,
      costCenterId: process.env.FALLBACK_COST_CENTER_ID,
      spendCategoryId: process.env.FALLBACK_SPEND_CATEGORY_ID,
    };
    const emailWorktags = result.emailWorktags ? {
      costCenterId: result.emailWorktags.costCenter?.code ?? null,
      eventWid: result.emailWorktags.event?.workdayId ?? null,
      lobReferenceId: result.emailWorktags.lineOfBusiness?.referenceId ?? null,
      fundReferenceId: result.emailWorktags.fund?.referenceId ?? null,
      spendCategoryReferenceId: result.emailWorktags.spendCategory?.referenceId ?? null,
    } : undefined;

    const merged = await buildFinalInvoiceLines(
      candidateLines,
      poLines,
      emailContext?.plainTextBody,
      fallbackIds,
      emailWorktags
    );
    let finalLines = merged.lines;

    // Workday requires at least one invoice line to create a Supplier Invoice. If nothing
    // could be extracted or matched to a PO, synthesize a single line from the total amount.
    if (finalLines.length === 0) {
      debug('No invoice lines could be extracted or matched to a PO; synthesizing a single line from the extracted total');
      const synthetic = await buildFinalInvoiceLines(
        [{
          description: memo || 'Invoice',
          quantity: 1,
          unitCost: extractedAmountDue ?? null,
          totalPrice: extractedAmountDue ?? null,
          hasDiscount: null,
        }],
        undefined,
        emailContext?.plainTextBody,
        fallbackIds,
        emailWorktags
      );
      finalLines = synthetic.lines;
    }

    const baseNotes = formatSupplierNotes(result) + formatCompanyNotes(result) + formatInvoiceDateNotes(result) + formatAmountNotes(result) + formatFreightAmountNotes(result) + formatTaxAmountNotes(result) + formatInvoiceNumberNotes(result) + formatPurchaseOrderNotes(result) + formatInvoiceLinesNotes(result) + formatPaymentTermsNotes(result) + formatEmailWorktagNotes(result);
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
      paymentTermsId,
      attachment: {
        fileName,
        contentType,
        base64Content: buffer.toString('base64'),
      },
    });

    const processingTime = Date.now() - startTime;
    await updateGmailProcessorLabel(request, 'success');

    await notifyResult('create_invoice', 'success', processingTime, {
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
      company: result.companyVerification ? {
        status: result.companyVerification.status,
        recommendedName: result.companyVerification.recommended?.companyName,
      } : undefined,
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
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    debug('Error creating new supplier invoice:', error);
    await notifyResult(
      'create_invoice',
      'error',
      processingTime,
      { s3Key, fileName },
      error
    );
    await updateGmailProcessorLabel(request, 'failure');
    throw error;
  }
}

async function updateGmailProcessorLabel(
  request: CreateInvoiceRequest,
  outcome: 'success' | 'failure',
): Promise<void> {
  const gmailMessageId = request.gmailMessageId?.trim();
  const userEmail = request.userEmail?.trim();
  if (!gmailMessageId || !userEmail) {
    return;
  }

  try {
    const gmailConfig = await getGmailConfig(process.env, userEmail, request.gmailAccessToken);
    await applyProcessorLabelOutcome(gmailConfig, gmailMessageId, outcome);
  } catch (error) {
    debug('Failed to update Gmail supplier invoice label', {
      gmailMessageId,
      outcome,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
