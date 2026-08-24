import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { debug } from '@pga/logger';
import { withHandler, withProcessorHandler, type ProcessingContext } from './lib/handlers.js';
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
import { buildFinalInvoiceLines, type EmailWorktags, type ExtractedInvoiceLine, type FinalInvoiceLine, type LineFallbacks } from './lib/invoice_lines.js';
import { isInvoiceMarkedForSkip, isWorkdayValidationError, recordInvoiceValidationFailure } from './lib/invoice_validation_failures.js';
import { notifyEnrichmentResult, notifyResult } from './lib/slack.js';
import type { InvoiceData } from './lib/types.js';
import type { AppliedFallback, PurchaseOrderLine } from './lib/workday.js';
import { costCenterCodeExcludingCompany, resolveCompanyFromEmail } from './lib/reference_ids.js';
import { annotateSupplierInvoice, executeWorkdayQuery, getInboundEmailsForOCRInvoices, getPurchaseOrder, getSupplierInvoiceWithAttachments, getWorkQueueTagWIDs, parsePurchaseOrderLines, submitSupplierInvoiceUpdate } from './lib/workday.js';

const MODIFIED_TAG_REF_ID = process.env.WORKDAY_AGENT_MODIFIED_TAG_REF_ID || 'FINAGENT-invoice-modified';
const DEFAULT_SUPPLIER_WID = process.env.WORKDAY_DEFAULT_SUPPLIER_WID;
const INVOICE_MOD_ENABLED = process.env.INVOICE_MOD_ENABLED !== 'false'; // enabled by default
const WORKDAY_TASK_NOT_AUTHORIZED_MESSAGE = 'The task submitted is not authorized';

function errorText(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }

  if (error instanceof Error) {
    return `${error.name}: ${error.message}\n${error.stack ?? ''}`;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return '';
  }
}

function isWorkdayTaskNotAuthorizedError(error: unknown): boolean {
  return errorText(error).includes(WORKDAY_TASK_NOT_AUTHORIZED_MESSAGE);
}

async function buildQuery(context: Parameters<typeof getWorkQueueTagWIDs>[0]): Promise<string> {
  const wids = await getWorkQueueTagWIDs(context, [MODIFIED_TAG_REF_ID]);

  const widList = wids.map(wid => `'${wid}'`).join(', ');

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  return `
  SELECT
    workdayID,
    OCRSupplierInvoice,
    supplier,
    company1
  FROM supplierInvoices (dataSourceFilter = supplierInvoicesFilter)
  WHERE OCRSupplierInvoice is not empty
    AND workQueueTags not in (${widList})
    AND invoiceStatusAsText = 'Draft'
    AND isCanceled = false
    AND invoiceReceivedDate >= '${yesterdayStr}'
    AND invoiceIsPaid = false
    AND invoiceIsPartiallyPaid = false
  LIMIT 5
`;
}


// Query function - scheduled daily
export const handler = withHandler(async (context) => {
  const processorFunctionName = `${process.env.AWS_STACK_NAME}-EnrichInvoiceProcessor`;

  const [invoiceQuery, emailMap] = await Promise.all([
    buildQuery(context).then(query => executeWorkdayQuery(context.workdayConfig, query)),
    getInboundEmailsForOCRInvoices(context.workdayConfig),
  ]);

  const allData = invoiceQuery.data;
  if (!allData || !Array.isArray(allData) || allData.length === 0) {
    debug('No invoices found to process');
    return;
  }

  debug(`Found ${allData.length} invoices, ${emailMap.size} email mappings`);

  const lambda = new LambdaClient({ region: process.env.AWS_REGION });

  for (const invoice of allData) {
    const inv = invoice as any;
    const emailContext = emailMap.get(inv.workdayID) || undefined;
    debug(`Invoice ${inv.workdayID}: emailContext ${emailContext ? 'found' : 'not found'}`);
    if (emailContext) {
      debug(`Email context for ${inv.workdayID}:`, emailContext);
    }
    const enrichedInvoice = { ...inv, emailContext };

    await lambda.send(new InvokeCommand({
      FunctionName: processorFunctionName,
      InvocationType: 'Event',
      Payload: JSON.stringify({
        data: [enrichedInvoice],
        page: 1,
        totalPages: 1
      })
    }));
  }
});

// Processor function - invoked by query function
export const processor = withProcessorHandler(async (context, invoices, _event) => {
  // Process single invoice (invoices will be array with one item)
  for (const invoice of invoices) {
    await processInvoice(context, invoice as InvoiceData);
  }
});
async function processInvoice(context: ProcessingContext, invoiceData: InvoiceData): Promise<void> {
  const startTime = Date.now();

  if (await isInvoiceMarkedForSkip(context.invoiceValidationFailuresConfig, invoiceData.workdayID)) {
    debug(`Skipping invoice ${invoiceData.workdayID} because it is already marked in the validation skip registry`);
    return;
  }

  debug(`Processing invoice with workdayID: ${invoiceData.workdayID}`);

  try {
    // Get detailed invoice data with attachments using SOAP API
    const { invoice: detailedInvoice, presignedAttachments: processedAttachments } = await getSupplierInvoiceWithAttachments(
      context,
      invoiceData.workdayID
    );

    debug(`Successfully processed ${processedAttachments.length} attachments`);

    const canModifyInvoice = INVOICE_MOD_ENABLED;

    const existingSupplier = invoiceData.supplier?.descriptor
      ? { descriptor: invoiceData.supplier.descriptor, id: invoiceData.supplier.id }
      : undefined;

    const existingCompany = invoiceData.company1?.descriptor
      ? { descriptor: invoiceData.company1.descriptor, id: invoiceData.company1.id }
      : undefined;

    debug(existingSupplier ? 'Enriching invoice with existing supplier' : 'Enriching invoice - no supplier assigned');
    const result = await enrichInvoiceFromAttachments(detailedInvoice, processedAttachments, existingSupplier, existingCompany, invoiceData.emailContext);
    debug('Enrichment result:', result);

    if (result.supplier.status === 'error') {
      throw new Error(`Invoice enrichment returned error status: ${result.supplier.reason}`);
    }

    const processingTime = Date.now() - startTime;
    const memo = result.supplier.extractedInformation?.memo || undefined;
    const extractedInvoiceDate = result.extractedInvoiceDate || undefined;

    const resolvedSupplierWID = result.supplier.resolvedSupplier?.workdayId
      ?? (result.supplier.status === 'matching' ? existingSupplier?.id : undefined);
    const targetSupplierWID = resolvedSupplierWID ?? DEFAULT_SUPPLIER_WID;
    const recommendedCompanyWID = result.companyVerification?.status === 'different'
      ? result.companyVerification.recommended?.workdayId ?? undefined
      : undefined;
    const emailCompany = await resolveCompanyFromEmail({
      db: context.dbConnection,
      emailBody: invoiceData.emailContext?.plainTextBody,
      emailCompany: result.emailWorktags?.company,
    });
    const companyWID = emailCompany?.workdayId ?? recommendedCompanyWID;

    debug(`Supplier resolution: status=${result.supplier.status}, targetSupplierWID=${targetSupplierWID ?? 'none'}`);
    debug(`Company resolution: status=${result.companyVerification?.status}, emailCompany=${emailCompany?.referenceId ?? emailCompany?.workdayId ?? 'none'}, companyWID=${companyWID ?? '(none - keeping existing)'}`);

    const extractedSuppliersInvoiceNumber = result.extractedSuppliersInvoiceNumber || undefined;
    const extractedAmountDue = result.extractedAmountDue ?? undefined;
    const extractedFreightAmount = result.extractedFreightAmount ?? undefined;
    const extractedTaxAmount = result.extractedTaxAmount ?? undefined;
    const rawPurchaseOrderNumber = result.extractedPurchaseOrderNumber || undefined;
    const normalizedPurchaseOrderNumber = rawPurchaseOrderNumber
      ? `PO-${rawPurchaseOrderNumber.replace(/^[Pp][Oo]-?/, '')}`
      : undefined;
    let extractedPurchaseOrderNumber: string | undefined = /^PO-\w{6}$/.test(normalizedPurchaseOrderNumber ?? '')
      ? normalizedPurchaseOrderNumber
      : undefined;
    let poLines: Awaited<ReturnType<typeof parsePurchaseOrderLines>> | undefined;
    if (canModifyInvoice && extractedPurchaseOrderNumber) {
      debug(`Fetching PO data for extracted PO number: ${extractedPurchaseOrderNumber}`);
      try {
        const poResponse = await getPurchaseOrder(context, extractedPurchaseOrderNumber);
        debug(`PO response for ${extractedPurchaseOrderNumber}: ${JSON.stringify(poResponse)}`);
        poLines = parsePurchaseOrderLines(poResponse);
        debug(`Parsed ${poLines.length} line(s) from PO ${extractedPurchaseOrderNumber}`);
        const returnedPoNumber = poLines[0]?.purchaseOrderDocumentNumber;
        if (poLines.length === 0 || returnedPoNumber !== extractedPurchaseOrderNumber) {
          debug(`PO ${extractedPurchaseOrderNumber} not found in Workday (returned: ${returnedPoNumber ?? 'none'}) - skipping PO processing`);
          poLines = undefined;
          extractedPurchaseOrderNumber = undefined;
        }
      } catch (poError) {
        debug(`Failed to fetch PO ${extractedPurchaseOrderNumber} from Workday - skipping PO processing:`, poError);
        extractedPurchaseOrderNumber = undefined;
      }
    }

    const emailWorktags: EmailWorktags | undefined = result.emailWorktags ? {
      costCenterId: costCenterCodeExcludingCompany(result.emailWorktags.costCenter?.code, emailCompany),
      eventWid: result.emailWorktags.event?.workdayId ?? null,
      lobReferenceId: result.emailWorktags.lineOfBusiness?.referenceId ?? null,
      fundReferenceId: result.emailWorktags.fund?.referenceId ?? null,
      spendCategoryReferenceId: result.emailWorktags.spendCategory?.referenceId ?? null,
    } : undefined;

    const candidateLines: ExtractedInvoiceLine[] = canModifyInvoice
      ? (result.extractedInvoiceLines ?? []).filter(l => l.description && (l.totalPrice || l.unitCost))
      : [];

    let finalLines: FinalInvoiceLine[] | undefined;
    let lineFallbacks: LineFallbacks | undefined;
    if (candidateLines.length > 0) {
      debug(`Building final invoice lines from ${candidateLines.length} extracted line(s)`);
      const built = await buildFinalInvoiceLines(
        candidateLines,
        poLines,
        invoiceData.emailContext?.plainTextBody,
        {
          fundId: process.env.FALLBACK_FUND_ID,
          costCenterId: process.env.FALLBACK_COST_CENTER_ID,
          spendCategoryId: process.env.FALLBACK_SPEND_CATEGORY_ID,
        },
        emailWorktags
      );
      finalLines = built.lines;
      lineFallbacks = built.appliedFallbacks;
      debug(`Built ${finalLines.length} final invoice line(s)`);
    }

    const upfrontFallbacks = getUpfrontFallbacks(resolvedSupplierWID, detailedInvoice, poLines, lineFallbacks);
    const baseNotes = formatSupplierNotes(result) + formatCompanyNotes(result, existingCompany?.descriptor) + formatInvoiceDateNotes(result) + formatAmountNotes(result) + formatFreightAmountNotes(result) + formatTaxAmountNotes(result) + formatInvoiceNumberNotes(result) + formatPurchaseOrderNotes(result) + formatInvoiceLinesNotes(result) + formatPaymentTermsNotes(result) + formatEmailWorktagNotes(result);
    const buildNotes = (submissionFallbacks: AppliedFallback[]) =>
      baseNotes + formatFallbackNotes(mergeFallbacks(upfrontFallbacks, submissionFallbacks));

    let fallbacks: Fallbacks;
    if (canModifyInvoice && targetSupplierWID) {
      debug(`Setting supplier to WID=${targetSupplierWID}`);

      const paymentTermsId = result.extractedPaymentTerms?.workdayId ?? undefined;

      const updateOutcome = await submitSupplierInvoiceUpdate(context, {
        invoiceWorkdayID: invoiceData.workdayID,
        supplierWID: targetSupplierWID,
        buildNotes,
        memo,
        invoiceDate: extractedInvoiceDate,
        companyWID,
        extractedAmountDue,
        suppliersInvoiceNumber: extractedSuppliersInvoiceNumber,
        extractedFreightAmount,
        extractedTaxAmount,
        finalLines,
        paymentTermsId
      });
      if (!updateOutcome.success) {
        debug(`Skipping enrichment notification — Workday update failed: ${updateOutcome.message ?? '(no message)'}`);
        return;
      }
      fallbacks = mergeFallbacks(upfrontFallbacks, updateOutcome.appliedFallbacks);
    } else {
      debug('Invoice modification disabled or no supplier available - recording notes only');
      fallbacks = mergeFallbacks(upfrontFallbacks, []);
      await annotateSupplierInvoice(context, {
        invoiceWorkdayID: invoiceData.workdayID,
        notes: buildNotes([]),
        memo
      });
    }

    await notifyEnrichmentResult({
      processingTime,
      invoiceNumber: detailedInvoice.Invoice_Number || 'Unknown',
      canModify: canModifyInvoice && !!targetSupplierWID,
      supplier: {
        status: result.supplier.status,
        resolvedName: result.supplier.resolvedSupplier?.supplierName,
        existingName: existingSupplier?.descriptor,
        isDefault: fallbacks.defaultSupplier,
      },
      company: emailCompany ? {
        status: 'email_resolved',
        existingName: existingCompany?.descriptor,
        recommendedName: result.companyVerification?.recommended?.companyName,
        appliedFromEmail: true,
        appliedName: emailCompany.name,
        appliedReferenceId: emailCompany.referenceId,
      } : result.companyVerification ? {
        status: result.companyVerification.status,
        existingName: existingCompany?.descriptor,
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
      poLineCount: poLines?.length,
      suggestedCostCenters: result.emailWorktags?.costCenter
        ? [{ name: result.emailWorktags.costCenter.name ?? result.emailWorktags.costCenter.extracted ?? '', code: result.emailWorktags.costCenter.code }]
        : undefined,
      fallbacks: {
        defaultSupplier: fallbacks.defaultSupplier,
        fallbackFund: fallbacks.fund ? process.env.FALLBACK_FUND_ID : undefined,
        fallbackCostCenter: fallbacks.costCenter ? process.env.FALLBACK_COST_CENTER_ID : undefined,
        fallbackPaymentTerms: fallbacks.paymentTerms || undefined,
      },
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    debug('Error in supplier enrichment process:', error);
    const shouldSkipRetry = isWorkdayTaskNotAuthorizedError(error);

    await notifyResult(
      'enrich_invoice',
      'error',
      processingTime,
      {
        workdayId: invoiceData.workdayID,
        processingTime: `${processingTime}ms`,
        ...(shouldSkipRetry && {
          note: 'Workday returned "The task submitted is not authorized"; not retrying this Lambda invocation.'
        })
      },
      error,
      shouldSkipRetry ? 'Workday task not authorized - no retry' : undefined
    );

    if (shouldSkipRetry) {
      return;
    }

    if (isWorkdayValidationError(error)) {
      debug(`Validation failure detected for invoice ${invoiceData.workdayID} - recording in skip registry`);
      await recordInvoiceValidationFailure(context.invoiceValidationFailuresConfig, invoiceData.workdayID, error);
      return;
    }

    throw error;
  }
}

interface UpfrontFallbacks {
  defaultSupplier: boolean;
  fund: boolean;
  costCenter: boolean;
  spendCategory: boolean;
}

interface Fallbacks extends UpfrontFallbacks {
  paymentTerms: boolean;
  omittedWorktags?: string[];
  validationErrorFields?: Set<string>;
}

function mergeFallbacks(upfront: UpfrontFallbacks, submissionFallbacks: AppliedFallback[]): Fallbacks {
  const omittedWorktags: string[] = [];
  if (submissionFallbacks.some(f => f.field === 'worktag:event')) omittedWorktags.push('Event');
  if (submissionFallbacks.some(f => f.field === 'worktag:lob')) omittedWorktags.push('Line of Business');
  const validationErrorFields = new Set(
    submissionFallbacks.filter(f => f.dueToValidationError).map(f => f.field)
  );
  return {
    defaultSupplier: upfront.defaultSupplier || submissionFallbacks.some(f => f.field === 'supplier'),
    fund: upfront.fund || submissionFallbacks.some(f => f.field === 'worktag:fund'),
    costCenter: upfront.costCenter || submissionFallbacks.some(f => f.field === 'worktag:costCenter'),
    spendCategory: upfront.spendCategory || submissionFallbacks.some(f => f.field === 'worktag:spendCategory'),
    paymentTerms: submissionFallbacks.some(f => f.field === 'paymentTerms'),
    omittedWorktags: omittedWorktags.length ? omittedWorktags : undefined,
    validationErrorFields: validationErrorFields.size ? validationErrorFields : undefined,
  };
}

function lineHasWorktag(line: any, type: string): boolean {
  const worktags = ([] as any[]).concat(line.worktagsReference ?? line.Worktags_Reference ?? []);
  return worktags.some((t: any) =>
    ([] as any[]).concat(t.ID ?? []).some((id: any) => id.$attributes?.type === type)
  );
}

function getUpfrontFallbacks(
  resolvedSupplierWID: string | undefined,
  detailedInvoice: { [key: string]: unknown },
  poLines?: PurchaseOrderLine[],
  lineFallbacks?: LineFallbacks
): UpfrontFallbacks {
  if (lineFallbacks) {
    return {
      defaultSupplier: !resolvedSupplierWID && !!DEFAULT_SUPPLIER_WID,
      fund: lineFallbacks.fund,
      costCenter: lineFallbacks.costCenter,
      spendCategory: lineFallbacks.spendCategory,
    };
  }

  const usingPOLines = !!(poLines?.length);
  const effectiveLines: any[] = usingPOLines
    ? poLines!
    : ([] as any[]).concat((detailedInvoice as any).Invoice_Line_Replacement_Data ?? []);

  const fund = !!(process.env.FALLBACK_FUND_ID && effectiveLines.some(l => !lineHasWorktag(l, 'Fund_ID')));
  const costCenter = !!(process.env.FALLBACK_COST_CENTER_ID && effectiveLines.some(l => !lineHasWorktag(l, 'Cost_Center_Reference_ID')));
  // Spend category is only applied to raw invoice lines (not PO lines)
  const spendCategory = !usingPOLines && !!(process.env.FALLBACK_SPEND_CATEGORY_ID && effectiveLines.some(l => !l.Spend_Category_Reference && !l.Item_Reference));

  return {
    defaultSupplier: !resolvedSupplierWID && !!DEFAULT_SUPPLIER_WID,
    fund,
    costCenter,
    spendCategory,
  };
}

function formatFallbackNotes(fallbacks: Fallbacks): string {
  const parts: string[] = [];
  const isValidationError = (field: string) => fallbacks.validationErrorFields?.has(field) ?? false;
  if (fallbacks.defaultSupplier && DEFAULT_SUPPLIER_WID) {
    const reason = isValidationError('supplier') ? 'applied during retry due to a validation error from workday' : 'no match found, default applied';
    parts.push(`Supplier: ${DEFAULT_SUPPLIER_WID} (${reason})`);
  }
  if (fallbacks.fund && process.env.FALLBACK_FUND_ID) {
    const reason = isValidationError('worktag:fund') ? 'applied during retry due to a validation error from workday' : 'applied to lines without an existing fund';
    parts.push(`Fund: ${process.env.FALLBACK_FUND_ID} (${reason})`);
  }
  if (fallbacks.costCenter && process.env.FALLBACK_COST_CENTER_ID) {
    const reason = isValidationError('worktag:costCenter') ? 'applied during retry due to a validation error from workday' : 'applied to lines without an existing cost center';
    parts.push(`Cost Center: ${process.env.FALLBACK_COST_CENTER_ID} (${reason})`);
  }
  if (fallbacks.spendCategory && process.env.FALLBACK_SPEND_CATEGORY_ID) {
    const reason = isValidationError('worktag:spendCategory') ? 'applied during retry due to a validation error from workday' : 'applied to lines without an existing spend category';
    parts.push(`Spend Category: ${process.env.FALLBACK_SPEND_CATEGORY_ID} (${reason})`);
  }
  if (fallbacks.paymentTerms && process.env.FALLBACK_PAYMENT_TERMS_ID) {
    parts.push(`Payment Terms: ${process.env.FALLBACK_PAYMENT_TERMS_ID} (applied during retry due to a validation error from workday)`);
  }
  if (fallbacks.omittedWorktags?.length) {
    parts.push(`${fallbacks.omittedWorktags.join(', ')} worktag(s) removed (no fallback available, validation error)`);
  }
  if (!parts.length) return '';
  return `\n\nFallback values applied: ${parts.join('; ')}`;
}


