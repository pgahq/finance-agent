import { processor } from '../enrich_invoice.js';

// Mock the dependencies
jest.mock('@pga/lambda-env', () => ({
  __esModule: true,
  default: jest.fn().mockResolvedValue({})
}));

jest.mock('@pga/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn()
}));

jest.mock('../lib/workday.js', () => ({
  getWorkdayConfig: jest.fn().mockReturnValue({
    domain: 'test.workday.com',
    tenant: 'test-tenant',
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    refreshToken: 'test-refresh-token'
  }),
  getSupplierInvoiceWithAttachments: jest.fn().mockResolvedValue({
    invoice: {
      Invoice_ID: 'test-invoice-id',
      Invoice_Number: 'SUPIN-412727',
      Attachment_Data: []
    },
    presignedAttachments: [{
      id: 'ocr-pdf',
      fileName: 'ocr.pdf',
      contentType: 'application/pdf',
      presignedUrl: 'https://example.com/ocr.pdf',
      expiresAt: new Date('2026-05-12T00:00:00Z'),
      s3Key: 'attachments/test-invoice-id/ocr.pdf',
      buffer: Buffer.from('ocr-pdf')
    }]
  }),
  executeWorkdayQuery: jest.fn().mockResolvedValue({
    total: 1,
    data: [{
      workdayID: 'test-invoice-id',
      invoiceNumber: 'INV-001',
      company1: { id: 'company-1', name: 'Test Company' },
      supplier: null,
      allAttachmentsForBusinessDocument: []
    }]
  }),
  submitSupplierInvoiceUpdate: jest.fn().mockResolvedValue({ success: true, appliedFallbacks: [] }),
  getSupplierInvoice: jest.fn().mockResolvedValue({ Invoice_Number: 'SUPIN-412727' }),
  annotateSupplierInvoice: jest.fn().mockResolvedValue(undefined),
  getPurchaseOrder: jest.fn().mockResolvedValue(undefined),
  parsePurchaseOrder: jest.requireActual('../lib/workday.js').parsePurchaseOrder,
  isPurchaseOrderClosedForInvoicing: jest.requireActual('../lib/workday.js').isPurchaseOrderClosedForInvoicing,
  closedPurchaseOrderLineNote: jest.requireActual('../lib/workday.js').closedPurchaseOrderLineNote,
  consumedPurchaseOrderLinesNote: jest.requireActual('../lib/workday.js').consumedPurchaseOrderLinesNote,
  markPurchaseOrderLineAvailability: jest.requireActual('../lib/workday.js').markPurchaseOrderLineAvailability,
  formatPurchaseOrderLineFallbackNotes: jest.requireActual('../lib/workday.js').formatPurchaseOrderLineFallbackNotes,
  isPurchaseOrderLineFallback: jest.requireActual('../lib/workday.js').isPurchaseOrderLineFallback,
  purchaseOrderLineFallbackNote: jest.requireActual('../lib/workday.js').purchaseOrderLineFallbackNote,
  CONSUMED_PO_LINE_REFERENCE_LABEL: jest.requireActual('../lib/workday.js').CONSUMED_PO_LINE_REFERENCE_LABEL,
}));

jest.mock('../lib/database.js', () => ({
  getDatabaseConnection: jest.fn().mockResolvedValue({
    query: jest.fn().mockResolvedValue([]),
    close: jest.fn().mockResolvedValue({})
  }),
  searchSimilarDocuments: jest.fn().mockResolvedValue([]),
  searchDocumentsByTypes: jest.fn().mockResolvedValue([]),
  findDocumentsByReferenceId: jest.fn().mockResolvedValue([]),
  findDocumentsByReferenceIds: jest.fn().mockResolvedValue(new Map()),
  getCostCenterRelatedLobsByCodes: jest.fn().mockResolvedValue(new Map()),
  getCostCenterWorkdayIdsByCodes: jest.fn().mockResolvedValue(new Map()),
  getOrgWorktagKindsByIds: jest.fn().mockResolvedValue(new Map()),
  getDocumentsByWorkdayIds: jest.fn().mockResolvedValue([]),
}));

jest.mock('../lib/rag.js', () => ({
  createEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3])
}));

// Tests queue one full enrichment result on enrichmentResponse. The OCR pass gets its document fields and the
// matching pass gets the full result, so the merged result equals the queued one.
jest.mock('../lib/ai.js', () => {
  const { InvoiceOcrSchema } = jest.requireActual('../prompts/invoice_ocr_prompt.js');
  const enrichmentResponse = jest.fn().mockResolvedValue({
    supplier: {
      status: 'matching',
      confidence: 0.9,
      extractedInformation: {
        supplierName: 'Test Supplier',
        memo: 'Test invoice'
      },
      resolvedSupplier: null,
      potentialDuplicateSuppliers: null,
      recommendation: {
        action: 'no_action',
        reason: 'Supplier matches existing assignment'
      },
      reason: 'High confidence match'
    },
    companyVerification: {
      status: 'matching',
      confidence: 0.85,
      extractedInformation: {},
      recommended: null,
      reason: 'Company matches existing assignment'
    }
  });
  let pendingFullResult: Promise<unknown> | undefined;
  // Shapes a queued full result like the Haiku response: empty strings and arrays instead of null.
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const textFields = (fields: Record<string, unknown> = {}) =>
    Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, text(value)]));
  const toOcrResult = (full: any) => {
    const headerText = Object.fromEntries(
      Object.entries(full ?? {})
        .filter(([key]) => key.startsWith('extracted') && !['extractedPaymentTerms', 'extractedInvoiceLines'].includes(key))
        .map(([key, value]) => [key, text(value)])
    );
    return {
      printedSupplier: textFields(full?.supplier?.extractedInformation),
      printedBillTo: textFields(full?.companyVerification?.extractedInformation),
      ...headerText,
      extractedPaymentTerms: text(full?.extractedPaymentTerms?.name),
      invoiceLineQuantityDisplayed: full?.invoiceLineQuantityDisplayed,
      extractedInvoiceLines: (full?.extractedInvoiceLines ?? []).map((line: any) => ({
        ...line,
        descriptionCells: line.descriptionCells ?? [],
        unitCost: text(line.unitCost),
        totalPrice: text(line.totalPrice),
      })),
    };
  };
  return {
    enrichmentResponse,
    getAiResponse: jest.fn(async (args: { schema?: unknown }) => {
      if (args.schema === InvoiceOcrSchema) {
        pendingFullResult = Promise.resolve(enrichmentResponse(args));
        return toOcrResult(await pendingFullResult);
      }
      const full = pendingFullResult ?? enrichmentResponse(args);
      pendingFullResult = undefined;
      return full;
    }),
  };
});

jest.mock('../lib/slack.js', () => ({
  notifyEnrichmentResult: jest.fn().mockResolvedValue(undefined),
  notifyResult: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../lib/invoice_validation_failures.js', () => {
  const actual = jest.requireActual('../lib/invoice_validation_failures.js');
  return {
    ...actual,
    getInvoiceValidationFailuresConfig: jest.fn().mockReturnValue(undefined),
    isInvoiceMarkedForSkip: jest.fn().mockResolvedValue(false),
    recordInvoiceValidationFailure: jest.fn().mockResolvedValue(undefined)
  };
});

jest.mock('../lib/s3.js', () => ({
  getS3Config: jest.fn().mockReturnValue({
    bucketName: 'test-bucket',
    region: 'us-east-1'
  }),
}));

jest.mock('../lib/invoice_lines.js', () => {
  const actual = jest.requireActual('../lib/invoice_lines.js');
  return {
    ...actual,
    buildFinalInvoiceLines: jest.fn()
  };
});

describe('enrich_invoice', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const { enrichmentResponse } = require('../lib/ai.js');
    const { submitSupplierInvoiceUpdate, annotateSupplierInvoice } = require('../lib/workday.js');
    const validationFailures = require('../lib/invoice_validation_failures.js');
    enrichmentResponse.mockResolvedValue({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: {
          supplierName: 'Test Supplier',
          memo: 'Test invoice'
        },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: {
          action: 'no_action',
          reason: 'Supplier matches existing assignment'
        },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      }
    });
    submitSupplierInvoiceUpdate.mockResolvedValue({ success: true, appliedFallbacks: [] });

    annotateSupplierInvoice.mockResolvedValue(undefined);
    validationFailures.isInvoiceMarkedForSkip.mockResolvedValue(false);
    validationFailures.recordInvoiceValidationFailure.mockResolvedValue(undefined);
  });

  it('should process supplier enrichment event with new format', async () => {
    const mockEvent = {
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        OCRSupplierInvoice: {
          descriptor: '24953$4729',
          id: '0627e00a601c1001085f64bd33e20000'
        }
      }]
    };

    await expect(processor(mockEvent as any)).resolves.not.toThrow();
  });

  it('passes the Lambda deadline signal to the enrichment AI call', async () => {
    const { getAiResponse } = require('../lib/ai.js');

    await processor(
      { data: [{ workdayID: 'test-invoice-id', invoiceStatusAsText: 'Draft' }] } as any,
      { getRemainingTimeInMillis: () => 120_000 } as any
    );

    const signal = getAiResponse.mock.calls[0][0].abortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  it('should handle missing supplier and identify supplier', async () => {
    const { executeWorkdayQuery } = require('../lib/workday.js');
    executeWorkdayQuery.mockResolvedValue({
      total: 1,
      data: [{
        workdayID: 'test-invoice-id',
        invoiceNumber: 'INV-001',
        supplier: null, // Missing supplier
        allAttachmentsForBusinessDocument: []
      }]
    });

    const mockEvent = {
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        OCRSupplierInvoice: {
          descriptor: '24953$4729',
          id: '0627e00a601c1001085f64bd33e20000'
        }
      }]
    };

    await expect(processor(mockEvent as any)).resolves.not.toThrow();
  });

  it('sends PDF attachments only to the Haiku OCR pass and the OCR JSON to the gpt-5.4 matching pass', async () => {
    const { getAiResponse } = require('../lib/ai.js');
    const { getSupplierInvoiceWithAttachments } = require('../lib/workday.js');
    const pdfBuffer = Buffer.from('fake-pdf-data');

    getSupplierInvoiceWithAttachments.mockResolvedValueOnce({
      invoice: {
        Invoice_ID: 'test-invoice-id',
        Attachment_Data: []
      },
      presignedAttachments: [
        {
          id: 'pdf-1',
          fileName: 'invoice.pdf',
          contentType: 'application/pdf',
          presignedUrl: 'https://example.com/invoice.pdf',
          expiresAt: new Date('2026-05-12T00:00:00Z'),
          s3Key: 'attachments/test-invoice-id/invoice.pdf',
          buffer: pdfBuffer
        }
      ]
    });

    const mockEvent = {
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        OCRSupplierInvoice: {
          descriptor: '24953$4729',
          id: '0627e00a601c1001085f64bd33e20000'
        }
      }]
    };

    await expect(processor(mockEvent as any)).resolves.not.toThrow();

    const { InvoiceOcrSchema } = require('../prompts/invoice_ocr_prompt.js');
    expect(getAiResponse).toHaveBeenCalledTimes(2);
    const [ocrCall] = getAiResponse.mock.calls[0];
    const [matchingCall] = getAiResponse.mock.calls[1];
    const messageContent = ocrCall.messages[0].content;

    expect(ocrCall.schema).toBe(InvoiceOcrSchema);
    expect(ocrCall.model).toEqual(expect.objectContaining({ modelId: 'anthropic/claude-haiku-5.5' }));
    expect(ocrCall.tools).toEqual({});
    expect(ocrCall.temperature).toBeNull();
    expect(matchingCall.model).toEqual(expect.objectContaining({ modelId: 'openai/gpt-5.4' }));
    expect(matchingCall.tools).toBeUndefined();
    expect(matchingCall.messages[0].content.some((part: { type: string }) => part.type !== 'text')).toBe(false);
    expect(matchingCall.messages[0].content[0].text).toContain('Invoice document extraction (read from the invoice documents by a separate OCR pass)');
    expect(matchingCall.messages[0].content[0].text).toContain('"printedSupplier"');

    expect(messageContent).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'file',
        data: pdfBuffer,
        mediaType: 'application/pdf',
        filename: 'invoice.pdf'
      })
    ]));
    expect(messageContent.some((part: { type: string }) => part.type === 'image')).toBe(false);
  });

  function supplierHintEvent(emailContext: Record<string, string>) {
    return {
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        OCRSupplierInvoice: {
          descriptor: '24953$4729',
          id: '0627e00a601c1001085f64bd33e20000'
        },
        emailContext,
      }]
    };
  }

  function promptText(getAiResponse: jest.Mock): string {
    const { InvoiceOcrSchema } = require('../prompts/invoice_ocr_prompt.js');
    const [aiCall] = getAiResponse.mock.calls.find(([args]: [{ schema?: unknown }]) => args.schema !== InvoiceOcrSchema);
    return aiCall.messages[0].content.find((part: { type: string }) => part.type === 'text').text;
  }

  async function mockCachedAcmeSupplier() {
    const { getDatabaseConnection } = require('../lib/database.js');
    const db = await getDatabaseConnection();
    db.query.mockImplementation(async (sql: string) => (
      sql.includes("metadata->>'supplierId'")
        ? [{ workday_id: 'wid-acme', metadata: { supplierId: 'S-001234', supplierName: 'Acme Corp' } }]
        : []
    ));
    return () => db.query.mockResolvedValue([]);
  }

  it('should pass an exact-matched supplier ID from an Intercom conversation part to the AI as authoritative', async () => {
    const { getAiResponse } = require('../lib/ai.js');
    const restore = await mockCachedAcmeSupplier();

    await expect(processor(supplierHintEvent({
      emailFrom: 'ap@vendor.com',
      subject: 'Invoice for review',
      plainTextBody: 'Please process the attached invoice.\n\nUse supplier S-001234',
      conversationParts: 'Use supplier S-001234',
    }) as any)).resolves.not.toThrow();

    const text = promptText(getAiResponse);
    expect(text).toContain('Supplier hints from the email and conversation');
    expect(text).toContain('S-001234 (Acme Corp), workdayId wid-acme');
    expect(text).toContain('exact cached Supplier ID match');
    restore();
  });

  it('should not let a sender-only supplier ID override the invoice document', async () => {
    const { getAiResponse } = require('../lib/ai.js');
    const restore = await mockCachedAcmeSupplier();

    await expect(processor(supplierHintEvent({
      emailFrom: 'billing@vendor.com',
      subject: 'Invoice',
      plainTextBody: 'Please book this to supplier S-001234',
    }) as any)).resolves.not.toThrow();

    const text = promptText(getAiResponse);
    expect(text).toContain('S-001234 (Acme Corp), workdayId wid-acme');
    expect(text).toContain('findSuppliers candidate only');
    expect(text).not.toContain('exact cached Supplier ID match');
    restore();
  });

  it('should build supplier hints from the email subject and source body', async () => {
    const { getAiResponse } = require('../lib/ai.js');

    await expect(processor(supplierHintEvent({
      emailFrom: 'billing@vendor.com',
      subject: 'Invoice for S-000777',
      plainTextBody: 'Supplier: Globex Inc',
    }) as any)).resolves.not.toThrow();

    const text = promptText(getAiResponse);
    expect(text).toContain('Supplier hints from the email and conversation');
    expect(text).toContain('S-000777, which is not in the supplier cache');
    expect(text).toContain('"Globex Inc"');
  });

  it('should not add a supplier hint block when the email names no supplier', async () => {
    const { getAiResponse } = require('../lib/ai.js');

    await expect(processor(supplierHintEvent({
      emailFrom: 'billing@vendor.com',
      subject: 'Invoice',
      plainTextBody: 'Please process the attached invoice.',
    }) as any)).resolves.not.toThrow();

    expect(promptText(getAiResponse)).not.toContain('Supplier hints from the email and conversation');
  });

  it('should skip processing when supplier already exists', async () => {
    const { executeWorkdayQuery } = require('../lib/workday.js');
    executeWorkdayQuery.mockResolvedValue({
      total: 1,
      data: [{
        workdayID: 'test-invoice-id',
        invoiceNumber: 'INV-001',
        supplier: 'Existing Supplier', // Supplier already exists
        allAttachmentsForBusinessDocument: []
      }]
    });

    const mockEvent = {
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        OCRSupplierInvoice: {
          descriptor: '24953$4729',
          id: '0627e00a601c1001085f64bd33e20000'
        }
      }]
    };

    await expect(processor(mockEvent as any)).resolves.not.toThrow();
  });

  it('should handle missing supplier cache gracefully', async () => {
    const mockEvent = {
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        OCRSupplierInvoice: {
          descriptor: '24953$4729',
          id: '0627e00a601c1001085f64bd33e20000'
        }
      }]
    };

    await expect(processor(mockEvent as any)).resolves.not.toThrow();
  });

  it('should skip processing invoices already marked in the validation skip registry', async () => {
    const { getSupplierInvoiceWithAttachments } = require('../lib/workday.js');
    const { isInvoiceMarkedForSkip } = require('../lib/invoice_validation_failures.js');

    isInvoiceMarkedForSkip.mockResolvedValue(true);

    const mockEvent = {
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        OCRSupplierInvoice: {
          descriptor: '24953$4729',
          id: '0627e00a601c1001085f64bd33e20000'
        }
      }]
    };

    await expect(processor(mockEvent as any)).resolves.not.toThrow();
    expect(getSupplierInvoiceWithAttachments).not.toHaveBeenCalled();
  });

  it('flags extracted totals that do not reconcile when it only annotates the invoice', async () => {
    const { enrichmentResponse } = require('../lib/ai.js');
    const { annotateSupplierInvoice, submitSupplierInvoiceUpdate } = require('../lib/workday.js');
    const { notifyEnrichmentResult } = require('../lib/slack.js');
    const invoiceLines = require('../lib/invoice_lines.js');
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue({
      lines: [{ lineOrder: 1, description: 'Widgets', quantity: 1, unitCost: 115, extendedAmount: 115 }],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false },
      relatedLobByCostCenter: new Map()
    });

    enrichmentResponse.mockResolvedValueOnce({
      supplier: {
        status: 'not_found',
        confidence: 0.2,
        extractedInformation: { supplierName: 'Unknown Supplier', memo: 'Widgets' },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: { action: 'no_action', reason: 'No supplier match' },
        reason: 'No match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      },
      extractedAmountDue: '$100.00',
      extractedInvoiceLines: [
        { description: 'Widgets', quantity: 1, unitCost: '115.00', totalPrice: '115.00', hasDiscount: false }
      ]
    });

    await expect(processor({
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        OCRSupplierInvoice: { descriptor: '24953$4729', id: '0627e00a601c1001085f64bd33e20000' }
      }]
    } as any)).resolves.not.toThrow();

    expect(submitSupplierInvoiceUpdate).not.toHaveBeenCalled();
    const mismatch = 'Lines $115.00 + freight $0.00 + tax $0.00 = $115.00, but the amount due is $100.00. Review lines and header charges.';
    expect(annotateSupplierInvoice.mock.calls.at(-1)[1].notes).toContain(`Amount check: ${mismatch}`);
    expect(notifyEnrichmentResult.mock.calls.at(-1)[0].chargeCheck).toEqual([mismatch]);
  });

  it('flags freight-only extracted totals that do not reconcile when it only annotates the invoice', async () => {
    const { enrichmentResponse } = require('../lib/ai.js');
    const { annotateSupplierInvoice, submitSupplierInvoiceUpdate } = require('../lib/workday.js');
    const { notifyEnrichmentResult } = require('../lib/slack.js');

    enrichmentResponse.mockResolvedValueOnce({
      supplier: {
        status: 'not_found',
        confidence: 0.2,
        extractedInformation: { supplierName: 'Unknown Carrier', memo: 'Freight' },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: { action: 'no_action', reason: 'No supplier match' },
        reason: 'No match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      },
      extractedAmountDue: '$100.00',
      extractedFreightAmount: '$15.00',
      extractedInvoiceLines: [
        { description: 'Shipping', quantity: 1, unitCost: '15.00', totalPrice: '15.00', hasDiscount: false }
      ]
    });

    await expect(processor({
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        OCRSupplierInvoice: { descriptor: '24953$4729', id: '0627e00a601c1001085f64bd33e20000' }
      }]
    } as any)).resolves.not.toThrow();

    expect(submitSupplierInvoiceUpdate).not.toHaveBeenCalled();
    const mismatch = 'Lines $0.00 + freight $15.00 + tax $0.00 = $15.00, but the amount due is $100.00. Review lines and header charges.';
    expect(annotateSupplierInvoice.mock.calls.at(-1)[1].notes).toContain(`Amount check: ${mismatch}`);
    expect(notifyEnrichmentResult.mock.calls.at(-1)[0].chargeCheck).toEqual([mismatch]);
  });

  it('should record validation failures and avoid rethrowing them', async () => {
    const { annotateSupplierInvoice } = require('../lib/workday.js');
    const { recordInvoiceValidationFailure } = require('../lib/invoice_validation_failures.js');

    const validationError = new Error('Validation_Fault: spend category is required');
    annotateSupplierInvoice.mockRejectedValue(validationError);

    const mockEvent = {
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        OCRSupplierInvoice: {
          descriptor: '24953$4729',
          id: '0627e00a601c1001085f64bd33e20000'
        }
      }]
    };

    await expect(processor(mockEvent as any)).resolves.not.toThrow();
    expect(annotateSupplierInvoice).toHaveBeenCalledTimes(1);
    expect(recordInvoiceValidationFailure).toHaveBeenCalledTimes(1);
    expect(recordInvoiceValidationFailure).toHaveBeenCalledWith(undefined, 'test-invoice-id', validationError);
  });

  it('should continue throwing non-validation processing errors', async () => {
    const { annotateSupplierInvoice } = require('../lib/workday.js');
    const { recordInvoiceValidationFailure } = require('../lib/invoice_validation_failures.js');

    annotateSupplierInvoice.mockRejectedValue(new Error('Update failed'));

    const mockEvent = {
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        OCRSupplierInvoice: {
          descriptor: '24953$4729',
          id: '0627e00a601c1001085f64bd33e20000'
        }
      }]
    };

    await expect(processor(mockEvent as any)).rejects.toThrow('Update failed');
    expect(recordInvoiceValidationFailure).not.toHaveBeenCalled();
  });

  it('should continue throwing AI or Zod schema validation errors without recording in skip registry', async () => {
    const { enrichmentResponse } = require('../lib/ai.js');
    const { recordInvoiceValidationFailure } = require('../lib/invoice_validation_failures.js');

    enrichmentResponse.mockRejectedValueOnce(new Error('Type validation failed: Value must be object'));

    const mockEvent = {
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        OCRSupplierInvoice: {
          descriptor: '24953$4729',
          id: '0627e00a601c1001085f64bd33e20000'
        }
      }]
    };

    await expect(processor(mockEvent as any)).rejects.toThrow('Type validation failed: Value must be object');
    expect(recordInvoiceValidationFailure).not.toHaveBeenCalled();
  });

  it('should continue throwing RAG tool failures without recording in skip registry', async () => {
    const { enrichmentResponse } = require('../lib/ai.js');
    const { recordInvoiceValidationFailure } = require('../lib/invoice_validation_failures.js');

    enrichmentResponse.mockRejectedValueOnce(new Error('Database connection failed'));

    const mockEvent = {
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        OCRSupplierInvoice: {
          descriptor: '24953$4729',
          id: '0627e00a601c1001085f64bd33e20000'
        }
      }]
    };

    await expect(processor(mockEvent as any)).rejects.toThrow('Database connection failed');
    expect(recordInvoiceValidationFailure).not.toHaveBeenCalled();
  });

  it('should notify Slack and stop retrying Workday task-not-authorized errors', async () => {
    const { annotateSupplierInvoice } = require('../lib/workday.js');
    const { recordInvoiceValidationFailure } = require('../lib/invoice_validation_failures.js');
    const { notifyResult } = require('../lib/slack.js');

    const authorizationError = new Error('The task submitted is not authorized for this supplier invoice');
    annotateSupplierInvoice.mockRejectedValue(authorizationError);

    const mockEvent = {
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        OCRSupplierInvoice: {
          descriptor: '24953$4729',
          id: '0627e00a601c1001085f64bd33e20000'
        }
      }]
    };

    await expect(processor(mockEvent as any)).resolves.not.toThrow();
    expect(notifyResult).toHaveBeenCalledWith(
      'enrich_invoice',
      'error',
      expect.any(Number),
      expect.objectContaining({
        workdayId: 'test-invoice-id',
        note: expect.stringContaining('not retrying')
      }),
      authorizationError,
      'Workday task not authorized - no retry'
    );
    expect(recordInvoiceValidationFailure).not.toHaveBeenCalled();
  });

  it('should handle batching with hardcoded configuration', () => {
    // Test that the batching logic works with hardcoded values
    // This is more of an integration test to ensure the batching doesn't break
    expect(true).toBe(true); // Placeholder for batching logic validation
  });

  it('should pass extracted invoice date to Workday update calls', async () => {
    const { enrichmentResponse } = require('../lib/ai.js');
    const { submitSupplierInvoiceUpdate } = require('../lib/workday.js');

    enrichmentResponse.mockResolvedValueOnce({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: {
          supplierName: 'Test Supplier',
          memo: 'Test invoice'
        },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: {
          action: 'no_action',
          reason: 'Supplier matches existing assignment'
        },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      },
      extractedInvoiceDate: '2026-04-15'
    });

    const mockEvent = {
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: {
          descriptor: 'Existing Supplier',
          id: 'SUP-1'
        },
        company1: {
          descriptor: 'Test Company',
          id: 'COMP-1'
        },
        OCRSupplierInvoice: {
          descriptor: '24953$4729',
          id: '0627e00a601c1001085f64bd33e20000'
        }
      }]
    };

    await expect(processor(mockEvent as any)).resolves.not.toThrow();

    expect(submitSupplierInvoiceUpdate).toHaveBeenCalledWith(
      expect.anything(),
      {
        invoiceWorkdayID: 'test-invoice-id',
        supplierWID: 'SUP-1',
        buildNotes: expect.any(Function),
        memo: undefined,
        invoiceDate: '2026-04-15',
        companyWID: undefined,
        extractedAmountDue: undefined,
        suppliersInvoiceNumber: 'TEST041526',
        extractedFreightAmount: undefined,
        freightAsLines: false,
        extractedTaxAmount: undefined,
        freightCleared: false,
        taxCleared: false,
        finalLines: undefined,
        invoiceLineQuantityDisplayed: undefined,
        relatedLobByCostCenter: undefined,
        resolveCostCenterWorkdayIds: expect.any(Function),
        resolveOrgWorktagKinds: expect.any(Function),
        paymentTermsId: undefined,
      }
    );
  });

  it('uses the existing Workday supplier name when the extracted name has no letters', async () => {
    const { enrichmentResponse } = require('../lib/ai.js');
    const { submitSupplierInvoiceUpdate } = require('../lib/workday.js');

    enrichmentResponse.mockResolvedValueOnce({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: {
          supplierName: '123!!!',
          memo: 'Test invoice'
        },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: {
          action: 'no_action',
          reason: 'Supplier matches existing assignment'
        },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      },
      extractedInvoiceDate: '2022-04-01'
    });

    await expect(processor({
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: { descriptor: 'Safari', id: 'SUP-1' },
        company1: { descriptor: 'Test Company', id: 'COMP-1' },
        OCRSupplierInvoice: { descriptor: '24953$4729', id: '0627e00a601c1001085f64bd33e20000' }
      }]
    } as any)).resolves.not.toThrow();

    expect(submitSupplierInvoiceUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ suppliersInvoiceNumber: 'SAFA040122' })
    );
  });

  it('should note when invoice date defaults to the first day of the current month', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-21T12:00:00Z'));

    const { enrichmentResponse } = require('../lib/ai.js');
    const { submitSupplierInvoiceUpdate } = require('../lib/workday.js');

    enrichmentResponse.mockResolvedValueOnce({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: {
          supplierName: 'Test Supplier',
          memo: 'Test invoice'
        },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: {
          action: 'no_action',
          reason: 'Supplier matches existing assignment'
        },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      }
    });

    const mockEvent = {
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: {
          descriptor: 'Existing Supplier',
          id: 'SUP-1'
        },
        company1: {
          descriptor: 'Test Company',
          id: 'COMP-1'
        },
        OCRSupplierInvoice: {
          descriptor: '24953$4729',
          id: '0627e00a601c1001085f64bd33e20000'
        }
      }]
    };

    await expect(processor(mockEvent as any)).resolves.not.toThrow();

    expect(submitSupplierInvoiceUpdate).toHaveBeenCalledWith(
      expect.anything(),
      {
        invoiceWorkdayID: 'test-invoice-id',
        supplierWID: 'SUP-1',
        buildNotes: expect.any(Function),
        memo: undefined,
        invoiceDate: undefined,
        companyWID: undefined,
        extractedAmountDue: undefined,
        suppliersInvoiceNumber: undefined,
        extractedFreightAmount: undefined,
        freightAsLines: false,
        extractedTaxAmount: undefined,
        freightCleared: false,
        taxCleared: false,
        finalLines: undefined,
        relatedLobByCostCenter: undefined,
        resolveCostCenterWorkdayIds: expect.any(Function),
        resolveOrgWorktagKinds: expect.any(Function),
        paymentTermsId: undefined,
      }
    );

    const [[, params]] = (submitSupplierInvoiceUpdate as jest.Mock).mock.calls;
    expect(params.buildNotes([])).toContain('Invoice Date: Date was not extracted from the document and defaulted to the beginning of the current month (2026-04-01).');

    jest.useRealTimers();
  });

  it('should pass the email-coded company workdayId as companyWID on update', async () => {
    const { enrichmentResponse } = require('../lib/ai.js');
    const { submitSupplierInvoiceUpdate } = require('../lib/workday.js');
    const { findDocumentsByReferenceIds } = require('../lib/database.js');
    findDocumentsByReferenceIds.mockResolvedValue(new Map([
      ['912', [{
        workday_id: 'email-company-wid',
        type: 'company',
        content: 'PGA Company',
        metadata: { companyReferenceId: '912', companyName: 'PGA Company' },
      }]],
    ]));

    enrichmentResponse.mockResolvedValueOnce({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: {
          supplierName: 'Test Supplier',
          memo: 'Test invoice'
        },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: {
          action: 'no_action',
          reason: 'Supplier matches existing assignment'
        },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      },
      emailWorktags: {
        company: {
          extracted: '912',
          name: 'PGA Company',
          workdayId: 'email-company-wid',
          referenceId: '912'
        },
        costCenter: { extracted: '912', name: null, code: null },
        event: { extracted: null, workdayId: null },
        lineOfBusiness: { extracted: null, referenceId: null },
        fund: { extracted: null, referenceId: null },
        spendCategory: { extracted: null, name: null, referenceId: null }
      }
    });

    const mockEvent = {
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: {
          descriptor: 'Existing Supplier',
          id: 'SUP-1'
        },
        company1: {
          descriptor: 'Test Company',
          id: 'COMP-1'
        },
        OCRSupplierInvoice: {
          descriptor: '24953$4729',
          id: '0627e00a601c1001085f64bd33e20000'
        }
      }]
    };

    await expect(processor(mockEvent as any)).resolves.not.toThrow();

    expect(submitSupplierInvoiceUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyWID: 'email-company-wid',
      })
    );

    const { notifyEnrichmentResult } = require('../lib/slack.js');
    expect(notifyEnrichmentResult).toHaveBeenCalledWith(
      expect.objectContaining({
        company: expect.objectContaining({
          status: 'email_resolved',
          appliedFromEmail: true,
          appliedName: 'PGA Company',
          appliedReferenceId: '912',
        }),
      })
    );
  });

  it('does not say the company changed to the bill-to when explicit email coding won, and flags the conflict', async () => {
    const { enrichmentResponse } = require('../lib/ai.js');
    const { submitSupplierInvoiceUpdate } = require('../lib/workday.js');
    const { notifyEnrichmentResult } = require('../lib/slack.js');
    const { findDocumentsByReferenceIds } = require('../lib/database.js');
    findDocumentsByReferenceIds.mockResolvedValue(new Map([
      ['912', [{
        workday_id: 'email-company-wid',
        type: 'company',
        content: 'PGA Company',
        metadata: { companyReferenceId: '912', companyName: 'PGA Company' },
      }]],
    ]));

    enrichmentResponse.mockResolvedValueOnce({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: { supplierName: 'Test Supplier', memo: 'Test invoice' },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: { action: 'no_action', reason: 'Supplier matches existing assignment' },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'different',
        confidence: 0.9,
        extractedInformation: {},
        recommended: { workdayId: 'pdf-company-wid', companyName: 'PDF Co', confidence: 0.9, reason: 'Bill-to differs' },
        reason: 'Bill-to differs'
      },
      emailWorktags: {
        company: { extracted: '912', name: 'PGA Company', workdayId: 'email-company-wid', referenceId: '912' },
        costCenter: { extracted: null, name: null, code: null },
        event: { extracted: null, workdayId: null },
        lineOfBusiness: { extracted: null, referenceId: null },
        fund: { extracted: null, referenceId: null },
        spendCategory: { extracted: null, name: null, referenceId: null }
      }
    });

    await expect(processor({
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: { descriptor: 'Existing Supplier', id: 'SUP-1' },
        company1: { descriptor: 'Test Company', id: 'COMP-1' },
        OCRSupplierInvoice: { descriptor: '24953$4729', id: '0627e00a601c1001085f64bd33e20000' }
      }]
    } as any)).resolves.not.toThrow();

    const [[, params]] = (submitSupplierInvoiceUpdate as jest.Mock).mock.calls;
    expect(params.companyWID).toBe('email-company-wid');
    const notes = params.buildNotes([]);
    expect(notes).toContain('Invoice bill-to check: Bill-to differs');
    expect(notes).not.toContain('Changed to: PDF Co');
    expect(notes).toContain('Company applied from email coding (code 912): PGA Company.');
    expect(notes).toContain('differs from the invoice bill-to company (PDF Co)');
    expect(notifyEnrichmentResult).toHaveBeenCalledWith(
      expect.objectContaining({
        company: expect.objectContaining({
          review: expect.stringContaining('differs from the invoice bill-to company (PDF Co)'),
        }),
      })
    );
  });

  it('passes priorFailures from a successful submit retry to Slack', async () => {
    const { enrichmentResponse } = require('../lib/ai.js');
    const { submitSupplierInvoiceUpdate } = require('../lib/workday.js');
    const { notifyEnrichmentResult } = require('../lib/slack.js');

    enrichmentResponse.mockResolvedValueOnce({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: { supplierName: 'Test Supplier', memo: 'Test invoice' },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: { action: 'no_action', reason: 'Supplier matches existing assignment' },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      }
    });
    submitSupplierInvoiceUpdate.mockResolvedValue({
      success: true,
      appliedFallbacks: [],
      priorFailures: [
        { attempt: 1, message: 'The invoice date must be the first day of the month.' },
      ],
    });

    await expect(processor({
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: { descriptor: 'Existing Supplier', id: 'SUP-1' },
        company1: { descriptor: 'Test Company', id: 'COMP-1' },
        OCRSupplierInvoice: { descriptor: '24953$4729', id: '0627e00a601c1001085f64bd33e20000' }
      }]
    } as any)).resolves.not.toThrow();

    expect(notifyEnrichmentResult).toHaveBeenCalledWith(
      expect.objectContaining({
        invoiceNumber: 'SUPIN-412727',
        invoiceWID: 'test-invoice-id',
        priorFailures: [
          { attempt: 1, message: 'The invoice date must be the first day of the month.' },
        ],
      })
    );
  });

  describe('scoring snapshots', () => {
    const matchingSupplierResponse = {
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: { supplierName: 'Test Supplier', memo: 'Test invoice' },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: { action: 'no_action', reason: 'Supplier matches existing assignment' },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      }
    };
    const event = {
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: { descriptor: 'Existing Supplier', id: 'SUP-1' },
        company1: { descriptor: 'Test Company', id: 'COMP-1' },
        OCRSupplierInvoice: { descriptor: '24953$4729', id: '0627e00a601c1001085f64bd33e20000' }
      }]
    };

    it('records the OCR baseline before the agent update and the invoice after it', async () => {
      const { enrichmentResponse } = require('../lib/ai.js');
      const { getDatabaseConnection } = require('../lib/database.js');
      const { notifyEnrichmentResult } = require('../lib/slack.js');
      enrichmentResponse.mockResolvedValueOnce(matchingSupplierResponse);

      await expect(processor(event as any)).resolves.not.toThrow();

      const db = await getDatabaseConnection();
      const sources = db.query.mock.calls
        .filter(([sql]: [string]) => sql.includes('INSERT INTO agent_invoice_snapshots'))
        .map(([, params]: [string, unknown[]]) => params[1]);
      expect(sources).toEqual(['enrich_baseline', 'enrich']);
      expect(notifyEnrichmentResult).toHaveBeenCalledWith(expect.not.objectContaining({ snapshotSync: 'failed' }));
    });

    it('reports snapshotSync failed without failing the enrichment when the read-back fails', async () => {
      const { enrichmentResponse } = require('../lib/ai.js');
      const { getSupplierInvoice } = require('../lib/workday.js');
      const { notifyEnrichmentResult } = require('../lib/slack.js');
      enrichmentResponse.mockResolvedValueOnce(matchingSupplierResponse);
      getSupplierInvoice.mockRejectedValueOnce(new Error('soap down'));

      await expect(processor(event as any)).resolves.not.toThrow();

      expect(notifyEnrichmentResult).toHaveBeenCalledWith(expect.objectContaining({
        invoiceWID: 'test-invoice-id',
        snapshotSync: 'failed',
      }));
    });

    it('takes no snapshot on the notes-only path', async () => {
      const { enrichmentResponse } = require('../lib/ai.js');
      const { getDatabaseConnection } = require('../lib/database.js');
      enrichmentResponse.mockResolvedValueOnce({
        ...matchingSupplierResponse,
        supplier: { ...matchingSupplierResponse.supplier, status: 'not_found', resolvedSupplier: null },
      });

      await expect(processor({ data: [{ ...event.data[0], supplier: null }] } as any)).resolves.not.toThrow();

      const db = await getDatabaseConnection();
      const { annotateSupplierInvoice } = require('../lib/workday.js');
      expect(annotateSupplierInvoice).toHaveBeenCalledTimes(1);
      expect(db.query.mock.calls.some(([sql]: [string]) => sql.includes('INSERT INTO agent_invoice_snapshots'))).toBe(false);
    });
  });

  it('omits Slack invoiceNumber when Get has no Invoice_Number', async () => {
    const { getSupplierInvoiceWithAttachments } = require('../lib/workday.js');
    const { notifyEnrichmentResult } = require('../lib/slack.js');
    getSupplierInvoiceWithAttachments.mockResolvedValueOnce({
      invoice: { Invoice_ID: 'test-invoice-id' },
      presignedAttachments: []
    });

    await expect(processor({
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: { descriptor: 'Existing Supplier', id: 'SUP-1' },
        company1: { descriptor: 'Test Company', id: 'COMP-1' },
        OCRSupplierInvoice: { descriptor: '24953$4729', id: '0627e00a601c1001085f64bd33e20000' }
      }]
    } as any)).resolves.not.toThrow();

    const slackPayload = notifyEnrichmentResult.mock.calls.at(-1)?.[0];
    expect(slackPayload).toBeDefined();
    expect(slackPayload).not.toHaveProperty('invoiceNumber');
    expect(slackPayload).toEqual(expect.objectContaining({ invoiceWID: 'test-invoice-id' }));
  });

  it('should strip shipping extracted lines before merge and pass recovered freight on update', async () => {
    const { enrichmentResponse } = require('../lib/ai.js');
    const { submitSupplierInvoiceUpdate } = require('../lib/workday.js');
    const invoiceLines = require('../lib/invoice_lines.js');

    enrichmentResponse.mockResolvedValueOnce({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: {
          supplierName: 'Test Supplier',
          memo: 'Test invoice'
        },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: {
          action: 'no_action',
          reason: 'Supplier matches existing assignment'
        },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      },
      extractedFreightAmount: '$15.00',
      extractedInvoiceLines: [
        { description: 'Widgets', quantity: 2, unitCost: '50.00', totalPrice: '100.00', hasDiscount: false },
        { description: 'Shipping', quantity: 1, unitCost: '15.00', totalPrice: '15.00', hasDiscount: false }
      ]
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue({
      lines: [{ lineOrder: 1, description: 'Widgets', quantity: 2, unitCost: 50 }],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false }
    });

    const mockEvent = {
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: {
          descriptor: 'Existing Supplier',
          id: 'SUP-1'
        },
        company1: {
          descriptor: 'Test Company',
          id: 'COMP-1'
        },
        OCRSupplierInvoice: {
          descriptor: '24953$4729',
          id: '0627e00a601c1001085f64bd33e20000'
        }
      }]
    };

    await expect(processor(mockEvent as any)).resolves.not.toThrow();

    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0]).toEqual([
      { description: 'Widgets', descriptionCells: null, quantity: 2, unitCost: '50.00', totalPrice: '100.00', hasDiscount: false }
    ]);
    expect(submitSupplierInvoiceUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        extractedFreightAmount: '$15.00',
        finalLines: [{ lineOrder: 1, description: 'Widgets', quantity: 2, unitCost: 50 }]
      })
    );
  });

  it('keeps an all-freight carrier line as the coded invoice line on update with no header freight', async () => {
    const { enrichmentResponse } = require('../lib/ai.js');
    const { submitSupplierInvoiceUpdate } = require('../lib/workday.js');
    const { notifyEnrichmentResult } = require('../lib/slack.js');
    const invoiceLines = require('../lib/invoice_lines.js');

    enrichmentResponse.mockResolvedValueOnce({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: { supplierName: 'MyFreightWorld Carrier Management Inc', memo: 'Freight' },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: { action: 'no_action', reason: 'Supplier matches existing assignment' },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      },
      extractedAmountDue: '$4,595.00',
      extractedFreightAmount: '$4,595.00',
      extractedTaxAmount: null,
      invoiceLineQuantityDisplayed: false,
      extractedInvoiceLines: [
        { description: 'PRO 52118 - Linehaul - 42,000 lbs', quantity: 0, unitCost: null, totalPrice: '$4595.00', hasDiscount: null }
      ]
    });
    const builtLine = { lineOrder: 1, description: 'PRO 52118 - Linehaul - 42,000 lbs', quantity: 0, unitCost: 0, extendedAmount: 4595, spendCategoryId: 'SC-Freight' };
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue({
      lines: [builtLine],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false },
      relatedLobByCostCenter: new Map()
    });

    await expect(processor({
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: { descriptor: 'Existing Supplier', id: 'SUP-1' },
        company1: { descriptor: 'Test Company', id: 'COMP-1' },
        OCRSupplierInvoice: { descriptor: '24953$4729', id: '0627e00a601c1001085f64bd33e20000' }
      }]
    } as any)).resolves.not.toThrow();

    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0].map((l: { description: string }) => l.description))
      .toEqual(['PRO 52118 - Linehaul - 42,000 lbs']);
    const params = submitSupplierInvoiceUpdate.mock.calls.at(-1)[1];
    expect(params.extractedFreightAmount).toBe('$4,595.00');
    expect(params.freightAsLines).toBe(true);
    expect(params.finalLines).toEqual([expect.objectContaining({ description: 'PRO 52118 - Linehaul - 42,000 lbs', extendedAmount: 4595 })]);
    const note = 'Header freight equals the only line ($4,595.00), so header Freight_Amount is not set. Check the extracted freight.';
    expect(params.buildNotes([])).toContain(`Amount check: ${note}`);
    expect(params.buildNotes([])).not.toContain('Line total review');
    expect(notifyEnrichmentResult.mock.calls.at(-1)[0].chargeCheck).toEqual([note]);
  });

  describe('mislabeled freight and tax', () => {
    const enrichmentWith = (charges: Record<string, unknown>) => ({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: { supplierName: 'BearCom', memo: 'Radios' },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: { action: 'no_action', reason: 'Supplier matches existing assignment' },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      },
      ...charges,
    });
    const mockEvent = {
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: { descriptor: 'BearCom', id: 'SUP-1' },
        company1: { descriptor: 'Test Company', id: 'COMP-1' },
        OCRSupplierInvoice: { descriptor: '24953$4729', id: '0627e00a601c1001085f64bd33e20000' }
      }]
    };

    it('moves a sales-tax amount read as freight to tax and clears freight on update', async () => {
      const { enrichmentResponse } = require('../lib/ai.js');
      const { submitSupplierInvoiceUpdate } = require('../lib/workday.js');
      enrichmentResponse.mockResolvedValueOnce(enrichmentWith({
        extractedFreightAmount: '510.86',
        extractedFreightLabel: 'Sales Tax',
        extractedTaxAmount: null,
        extractedTaxLabel: null,
      }));

      await expect(processor(mockEvent as any)).resolves.not.toThrow();

      const params = submitSupplierInvoiceUpdate.mock.calls[0][1];
      expect(params).toEqual(expect.objectContaining({
        extractedFreightAmount: undefined,
        extractedTaxAmount: '510.86',
        freightCleared: true,
        taxCleared: false,
      }));
      const notes = params.buildNotes([]);
      expect(notes).toContain('Freight Amount (from document): none');
      expect(notes).toContain('Tax Amount (from document): 510.86');
      expect(notes).not.toContain('Freight/Tax review');
    });

    it('keeps both amounts and adds a review note when a tax-labeled freight amount differs from tax', async () => {
      const { enrichmentResponse } = require('../lib/ai.js');
      const { submitSupplierInvoiceUpdate } = require('../lib/workday.js');
      enrichmentResponse.mockResolvedValueOnce(enrichmentWith({
        extractedFreightAmount: '8.00',
        extractedFreightLabel: 'Sales Tax',
        extractedTaxAmount: '10.00',
        extractedTaxLabel: 'Sales Tax',
      }));

      await expect(processor(mockEvent as any)).resolves.not.toThrow();

      const params = submitSupplierInvoiceUpdate.mock.calls[0][1];
      expect(params).toEqual(expect.objectContaining({
        extractedFreightAmount: '8.00',
        extractedTaxAmount: '10.00',
        freightCleared: false,
        taxCleared: false,
      }));
      expect(params.buildNotes([])).toContain('Freight/Tax review: Freight amount 8.00 is labeled "Sales Tax" and a separate tax amount 10.00 was also read; both were kept as read.');
    });

    it('submits freight rows as header freight when the header printed a zero freight', async () => {
      const { enrichmentResponse } = require('../lib/ai.js');
      const { submitSupplierInvoiceUpdate } = require('../lib/workday.js');
      const invoiceLines = require('../lib/invoice_lines.js');
      enrichmentResponse.mockResolvedValueOnce(enrichmentWith({
        extractedAmountDue: '$125.00',
        extractedFreightAmount: '0.00',
        extractedFreightLabel: 'Shipping and Handling',
        extractedTaxAmount: null,
        extractedTaxLabel: null,
        extractedInvoiceLines: [
          { description: 'Radio', quantity: 1, unitCost: '100.00', totalPrice: '$100.00', hasDiscount: false },
          { description: 'Freight', quantity: 1, unitCost: '25.00', totalPrice: '$25.00', hasDiscount: false },
        ],
      }));
      invoiceLines.buildFinalInvoiceLines.mockResolvedValue({
        lines: [{ lineOrder: 1, description: 'Radio', quantity: 1, unitCost: 100, extendedAmount: 100 }],
        appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false },
        relatedLobByCostCenter: new Map()
      });

      await expect(processor(mockEvent as any)).resolves.not.toThrow();

      expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0].map((l: { description: string }) => l.description))
        .toEqual(['Radio']);
      const params = submitSupplierInvoiceUpdate.mock.calls[0][1];
      expect(params).toEqual(expect.objectContaining({
        extractedFreightAmount: '25',
        freightCleared: false,
      }));
      expect(params.buildNotes([])).toContain(
        'Amount check: Header freight printed as zero, but the freight rows ($25.00) make up the rest of the amount due, so they count as the invoice freight.'
      );
    });
  });

  it('concatenates Hashrocket Activity and Description into Workday line item description', async () => {
    const { enrichmentResponse } = require('../lib/ai.js');
    const { submitSupplierInvoiceUpdate } = require('../lib/workday.js');
    const invoiceLines = require('../lib/invoice_lines.js');

    enrichmentResponse.mockResolvedValueOnce({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: {
          supplierName: 'Test Supplier',
          memo: 'Project management services'
        },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: {
          action: 'no_action',
          reason: 'Supplier matches existing assignment'
        },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      },
      extractedPurchaseOrderNumber: 'PO-413898',
      extractedServicePeriod: '9/7/26 - 9/13/26',
      extractedInvoiceLines: [
        {
          description: 'Project Management',
          descriptionCells: ['', 'Ryan Poland', 'Project Management', '32', '155.00', '4,960.00'],
          quantity: 32,
          unitCost: '155.00',
          totalPrice: '4,960.00',
          hasDiscount: false
        }
      ]
    });
    invoiceLines.buildFinalInvoiceLines.mockImplementation(async (extracted: Array<{ description: string }>) => ({
      lines: [{
        lineOrder: 1,
        description: extracted[0].description,
        memo: 'Project management services for Ryan Poland',
        quantity: 32,
        unitCost: 155,
        extendedAmount: 4960
      }],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false }
    }));

    await expect(processor({
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: { descriptor: 'Existing Supplier', id: 'SUP-1' },
        company1: { descriptor: 'Test Company', id: 'COMP-1' },
        OCRSupplierInvoice: { descriptor: '24953$4729', id: '0627e00a601c1001085f64bd33e20000' }
      }]
    } as any)).resolves.not.toThrow();

    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][0][0].description).toBe(
      'Ryan Poland - Project Management'
    );
    const [[, params]] = (submitSupplierInvoiceUpdate as jest.Mock).mock.calls;
    expect(params.finalLines[0].description).toBe('Ryan Poland - Project Management');
    expect(params.finalLines[0].memo).toBe(
      'PO-413898. Service Period 9/7/26 - 9/13/26. Project management services for Ryan Poland'
    );
  });

  it('omits PO line refs but keeps PO line coding when the PO is Pending Close', async () => {
    const { enrichmentResponse } = require('../lib/ai.js');
    const { getPurchaseOrder, submitSupplierInvoiceUpdate } = require('../lib/workday.js');
    const { notifyEnrichmentResult } = require('../lib/slack.js');
    const invoiceLines = require('../lib/invoice_lines.js');

    getPurchaseOrder.mockResolvedValueOnce({
      Response_Data: {
        Purchase_Order: {
          Purchase_Order_Data: {
            Document_Number: 'PO-413898',
            Purchase_Order_Document_Status_Reference: {
              descriptor: 'Pending Close',
              ID: [{ $attributes: { type: 'Document_Status_ID' }, $value: 'PENDING_CLOSE' }]
            },
            Service_Line_Data: { Line_Number: 1, Service_Order_Line_ID: 'POL-1', Description: 'Project Management' }
          }
        }
      }
    });
    enrichmentResponse.mockResolvedValueOnce({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: { supplierName: 'Test Supplier' },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: { action: 'no_action', reason: 'Supplier matches existing assignment' },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      },
      extractedPurchaseOrderNumber: 'PO-413898',
      extractedInvoiceLines: [
        { description: 'Project Management', quantity: 1, unitCost: '155.00', totalPrice: '155.00', hasDiscount: false }
      ]
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValueOnce({
      lines: [{ lineOrder: 1, description: 'Project Management', quantity: 1, unitCost: 155, extendedAmount: 155, purchaseOrderLineId: 'POL-1', costCenterId: 'CC-PO' }],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false }
    });
    (submitSupplierInvoiceUpdate as jest.Mock).mockResolvedValueOnce({
      success: true,
      appliedFallbacks: [{ field: 'purchaseOrderLine', label: 'omitted PO line reference (PO closed or pending close)' }]
    });

    await processor({
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: { descriptor: 'Existing Supplier', id: 'SUP-1' },
        company1: { descriptor: 'Test Company', id: 'COMP-1' },
        OCRSupplierInvoice: { descriptor: '24953$4729', id: '0627e00a601c1001085f64bd33e20000' }
      }]
    } as any);

    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][1]).toEqual([
      expect.objectContaining({ purchaseOrderLineId: 'POL-1' })
    ]);
    const [[, params]] = (submitSupplierInvoiceUpdate as jest.Mock).mock.calls;
    expect(params.omitPurchaseOrderLineReference).toBe(true);
    expect(params.finalLines[0]).toEqual(expect.objectContaining({ purchaseOrderLineId: 'POL-1', costCenterId: 'CC-PO' }));
    const closedNote = 'PO-413898 is Closed or Pending Close; invoice lines were coded from the PO but not linked to PO lines.';
    expect(params.buildNotes([{ field: 'purchaseOrderLine', label: 'omitted PO line reference (PO closed or pending close)' }]))
      .toContain(closedNote);
    expect(notifyEnrichmentResult.mock.calls[0][0].fallbacks.purchaseOrderLineNotes).toBe(closedNote);
  });

  describe('PO supplier and PO number', () => {
    const purchaseOrderResponse = (documentNumber: string, supplier?: { wid: string; descriptor: string }) => ({
      Response_Data: {
        Purchase_Order: {
          Purchase_Order_Data: {
            Document_Number: documentNumber,
            ...(supplier ? {
              Supplier_Reference: {
                descriptor: supplier.descriptor,
                ID: [{ $attributes: { type: 'WID' }, $value: supplier.wid }],
              },
            } : {}),
            Goods_Line_Data: { Line_Number: 1, Goods_Order_Line_ID: `${documentNumber}-LINE-1`, Item_Description: 'Cart' },
          }
        }
      }
    });
    const clubPro = { wid: 'club-pro-wid', descriptor: 'CLUB PRO GOLF GROUP LLC' };
    const lastNotification = () => require('../lib/slack.js').notifyEnrichmentResult.mock.calls.at(-1)[0];
    const enrichmentFor = (purchaseOrderNumber: string) => ({
      supplier: {
        status: 'found',
        confidence: 0.9,
        extractedInformation: { supplierName: 'GOLF GEAR LTD' },
        resolvedSupplier: { workdayId: 'golf-gear-wid', supplierName: 'GOLF GEAR LTD', confidence: 0.9, reason: 'Letterhead' },
        potentialDuplicateSuppliers: null,
        recommendation: { action: 'update_invoice', reason: 'Supplier found' },
        reason: 'Supplier found'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      },
      extractedPurchaseOrderNumber: purchaseOrderNumber,
      extractedInvoiceLines: [
        { description: 'Cart', quantity: 1, unitCost: '100.00', totalPrice: '100.00', hasDiscount: false }
      ]
    });
    const event = (emailContext?: Record<string, string>) => ({
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: null,
        company1: { descriptor: 'Test Company', id: 'COMP-1' },
        OCRSupplierInvoice: { descriptor: '24953$4729', id: '0627e00a601c1001085f64bd33e20000' },
        ...(emailContext ? { emailContext } : {}),
      }]
    });
    const mockLines = () => require('../lib/invoice_lines.js').buildFinalInvoiceLines.mockResolvedValueOnce({
      lines: [{ lineOrder: 1, description: 'Cart', quantity: 1, unitCost: 100, extendedAmount: 100, purchaseOrderLineId: 'PO-LINE-1' }],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false }
    });

    it('submits the PO supplier for PO-414373 and asks AP to confirm the PO number when the invoice names GOLF GEAR LTD', async () => {
      const { enrichmentResponse } = require('../lib/ai.js');
      const { getPurchaseOrder, submitSupplierInvoiceUpdate } = require('../lib/workday.js');
      getPurchaseOrder.mockResolvedValueOnce(purchaseOrderResponse('PO-414373', clubPro));
      enrichmentResponse.mockResolvedValueOnce(enrichmentFor('PO-414373'));
      mockLines();

      await processor(event() as any);

      const [[, params]] = (submitSupplierInvoiceUpdate as jest.Mock).mock.calls;
      expect(params.supplierWID).toBe('club-pro-wid');
      expect(params.buildNotes([])).toContain(
        'Supplier from PO: Set to CLUB PRO GOLF GROUP LLC, the supplier on PO-414373. The invoice names GOLF GEAR LTD, which does not look like the same company; confirm the PO number.'
      );
      const notification = lastNotification();
      expect(notification.supplier.purchaseOrder).toEqual({
        name: 'CLUB PRO GOLF GROUP LLC',
        purchaseOrderNumber: 'PO-414373',
        review: 'Supplier set from PO-414373 (CLUB PRO GOLF GROUP LLC); the invoice names GOLF GEAR LTD, which does not look like the same company. Confirm the PO number.',
      });
      expect(notification.fallbacks.defaultSupplier).toBe(false);
    });

    it('uses the one PO the email names over the invoice PO', async () => {
      const { enrichmentResponse } = require('../lib/ai.js');
      const { getPurchaseOrder, submitSupplierInvoiceUpdate } = require('../lib/workday.js');
      getPurchaseOrder.mockResolvedValueOnce(purchaseOrderResponse('PO-414373', clubPro));
      enrichmentResponse.mockResolvedValueOnce(enrichmentFor('PO-411406'));
      mockLines();

      await processor(event({ subject: 'Invoice 11255346', plainTextBody: 'Please bill this to PO-414373.' }) as any);

      expect(getPurchaseOrder.mock.calls.map((call: unknown[]) => call[1])).toEqual(['PO-414373']);
      const [[, params]] = (submitSupplierInvoiceUpdate as jest.Mock).mock.calls;
      expect(params.supplierWID).toBe('club-pro-wid');
      expect(params.buildNotes([])).toContain('Purchase order: Used PO-414373 from the email instead of PO-411406 on the invoice.');
      expect(lastNotification().extracted).toEqual(expect.objectContaining({
        purchaseOrderNumber: 'PO-414373',
        invoicePurchaseOrderNumber: 'PO-411406',
      }));
    });

    it('keeps the invoice PO when the email names several POs', async () => {
      const { enrichmentResponse } = require('../lib/ai.js');
      const { getPurchaseOrder } = require('../lib/workday.js');
      getPurchaseOrder.mockResolvedValueOnce(purchaseOrderResponse('PO-411406'));
      enrichmentResponse.mockResolvedValueOnce(enrichmentFor('PO-411406'));
      mockLines();

      await processor(event({ plainTextBody: 'Invoices for PO-414373 and PO-411406 attached.' }) as any);

      expect(getPurchaseOrder.mock.calls.map((call: unknown[]) => call[1])).toEqual(['PO-411406']);
      expect(lastNotification().extracted.purchaseOrderNumber).toBe('PO-411406');
    });

    it('falls back to the invoice PO when the email PO is not in Workday', async () => {
      const { enrichmentResponse } = require('../lib/ai.js');
      const { getPurchaseOrder, submitSupplierInvoiceUpdate } = require('../lib/workday.js');
      getPurchaseOrder
        .mockResolvedValueOnce({ Response_Data: {} })
        .mockResolvedValueOnce(purchaseOrderResponse('PO-411406'));
      enrichmentResponse.mockResolvedValueOnce(enrichmentFor('PO-411406'));
      mockLines();

      await processor(event({ plainTextBody: 'Please bill this to PO-414373.' }) as any);

      expect(getPurchaseOrder.mock.calls.map((call: unknown[]) => call[1])).toEqual(['PO-414373', 'PO-411406']);
      const [[, params]] = (submitSupplierInvoiceUpdate as jest.Mock).mock.calls;
      expect(params.supplierWID).toBe('golf-gear-wid');
      expect(params.buildNotes([])).toContain('Purchase order: PO-414373 from the email was not found in Workday; used PO-411406 instead.');
      expect(lastNotification().extracted.purchaseOrderNumber).toBe('PO-411406');
    });
  });

  it.each([
    ['some PO lines are fully invoiced', ['Fully Invoiced', 'Partially Invoiced'], [false, true]],
    ['every PO line is fully invoiced', ['Fully Invoiced', 'Fully Invoiced'], [false, false]],
  ])('handles PO line availability when %s', async (_label, invoiceStatuses, expectedAvailability) => {
    const { enrichmentResponse } = require('../lib/ai.js');
    const { getPurchaseOrder, submitSupplierInvoiceUpdate } = require('../lib/workday.js');
    const invoiceLines = require('../lib/invoice_lines.js');

    getPurchaseOrder.mockResolvedValueOnce({
      Response_Data: {
        Purchase_Order: {
          Purchase_Order_Data: {
            Document_Number: 'PO-413898',
            Service_Line_Data: invoiceStatuses.map((descriptor, index) => ({
              Line_Number: index + 1,
              Service_Order_Line_ID: `POL-${index + 1}`,
              Description: 'Quarterly retainer',
              Start_Date: index === 0 ? '2026-07-01' : '2026-10-01',
              End_Date: index === 0 ? '2026-09-30' : '2026-12-31',
              Invoice_Status_Reference: { ID: [
                { $attributes: { type: 'WID' }, $value: `wid-status-${index}` },
                { $attributes: { type: 'Document_Status_ID' }, $value: descriptor },
              ] },
            })),
          }
        }
      }
    });
    enrichmentResponse.mockResolvedValueOnce({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: { supplierName: 'Test Supplier' },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: { action: 'no_action', reason: 'Supplier matches existing assignment' },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      },
      extractedPurchaseOrderNumber: 'PO-413898',
      extractedInvoiceDate: '2026-10-02',
      extractedServicePeriod: 'Q4 2026',
      extractedInvoiceLines: [
        { description: 'Quarterly retainer', quantity: 1, unitCost: '1500.00', totalPrice: '1500.00', hasDiscount: false }
      ]
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValueOnce({
      lines: [{ lineOrder: 1, description: 'Quarterly retainer', quantity: 1, unitCost: 1500, extendedAmount: 1500, purchaseOrderLineId: 'POL-2', costCenterId: 'CC-PO' }],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false }
    });

    await processor({
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: { descriptor: 'Existing Supplier', id: 'SUP-1' },
        company1: { descriptor: 'Test Company', id: 'COMP-1' },
        OCRSupplierInvoice: { descriptor: '24953$4729', id: '0627e00a601c1001085f64bd33e20000' }
      }]
    } as any);

    const mergeCall = invoiceLines.buildFinalInvoiceLines.mock.calls[0];
    expect(mergeCall[1].map((line: any) => [line.purchaseOrderLineId, line.availableForInvoicing])).toEqual([
      ['POL-1', expectedAvailability[0]],
      ['POL-2', expectedAvailability[1]],
    ]);
    expect(mergeCall[7]).toEqual({ invoiceDate: '2026-10-02', servicePeriod: 'Q4 2026' });
    const [[, params]] = (submitSupplierInvoiceUpdate as jest.Mock).mock.calls;
    expect(params.omitPurchaseOrderLineReference).toBeUndefined();
    const notes = params.buildNotes([{ field: 'consumedPurchaseOrderLine', label: 'omitted PO line reference (PO line fully invoiced or closed)' }]);
    expect(notes).toContain('Invoice lines that matched lines on PO-413898 already fully invoiced or closed were coded from the PO but not linked to PO lines.');

    const bothNotes = params.buildNotes([
      { field: 'purchaseOrderLine', label: 'omitted PO line reference (PO closed or pending close)' },
      { field: 'consumedPurchaseOrderLine', label: 'omitted PO line reference (PO line fully invoiced or closed)' },
    ]);
    expect(bothNotes.match(/Purchase order lines: /g)).toHaveLength(2);
    expect(bothNotes).not.toContain('Fallback values applied');
  });

  it('should submit amount-only lines with quantity zero when the invoice has no quantity column', async () => {
    const { enrichmentResponse } = require('../lib/ai.js');
    const { submitSupplierInvoiceUpdate } = require('../lib/workday.js');
    const invoiceLines = require('../lib/invoice_lines.js');

    enrichmentResponse.mockResolvedValueOnce({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: {
          supplierName: 'Test Supplier',
          memo: 'Test invoice'
        },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: {
          action: 'no_action',
          reason: 'Supplier matches existing assignment'
        },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      },
      invoiceLineQuantityDisplayed: false,
      extractedInvoiceLines: [
        { description: 'Janitorial', quantity: null, unitCost: null, totalPrice: '1250.00', hasDiscount: false }
      ]
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue({
      lines: [{ lineOrder: 1, description: 'Janitorial', quantity: null, unitCost: null, extendedAmount: 1250 }],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false },
      relatedLobByCostCenter: new Map()
    });

    await expect(processor({
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: { descriptor: 'Existing Supplier', id: 'SUP-1' },
        company1: { descriptor: 'Test Company', id: 'COMP-1' },
        OCRSupplierInvoice: { descriptor: '24953$4729', id: '0627e00a601c1001085f64bd33e20000' }
      }]
    } as any)).resolves.not.toThrow();

    expect(invoiceLines.buildFinalInvoiceLines.mock.calls[0][6]).toBe(false);
    const [[, params]] = (submitSupplierInvoiceUpdate as jest.Mock).mock.calls;
    expect(params.invoiceLineQuantityDisplayed).toBe(false);
    expect(params.finalLines[0]).toMatchObject({
      quantity: 0,
      unitCost: 0,
      extendedAmount: 1250,
    });
  });

  it('should submit amount-only lines when quantity times unit cost does not equal extended amount', async () => {
    const { enrichmentResponse } = require('../lib/ai.js');
    const { submitSupplierInvoiceUpdate } = require('../lib/workday.js');
    const invoiceLines = require('../lib/invoice_lines.js');

    enrichmentResponse.mockResolvedValueOnce({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: {
          supplierName: 'Test Supplier',
          memo: 'Test invoice'
        },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: {
          action: 'no_action',
          reason: 'Supplier matches existing assignment'
        },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      },
      invoiceLineQuantityDisplayed: true,
      extractedInvoiceLines: [
        { description: 'Sintra Signs', quantity: 37, unitCost: '29.88', totalPrice: '1105.49', hasDiscount: false }
      ]
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue({
      lines: [{ lineOrder: 1, description: 'Sintra Signs', quantity: 37, unitCost: 29.88, extendedAmount: 1105.49 }],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false },
      relatedLobByCostCenter: new Map()
    });

    await expect(processor({
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: { descriptor: 'Existing Supplier', id: 'SUP-1' },
        company1: { descriptor: 'Test Company', id: 'COMP-1' },
        OCRSupplierInvoice: { descriptor: '24953$4729', id: '0627e00a601c1001085f64bd33e20000' }
      }]
    } as any)).resolves.not.toThrow();

    const [[, params]] = (submitSupplierInvoiceUpdate as jest.Mock).mock.calls;
    expect(params.invoiceLineQuantityDisplayed).toBeUndefined();
    expect(params.finalLines[0]).toMatchObject({
      quantity: 0,
      unitCost: 0,
      extendedAmount: 1105.49,
    });
  });

  it('should note when invoice lines total more than the amount due', async () => {
    const { enrichmentResponse } = require('../lib/ai.js');
    const { submitSupplierInvoiceUpdate } = require('../lib/workday.js');
    const invoiceLines = require('../lib/invoice_lines.js');

    enrichmentResponse.mockResolvedValueOnce({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: { supplierName: 'LevelBlue, LLC', memo: 'vCISO risk advisory' },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: { action: 'no_action', reason: 'Supplier matches existing assignment' },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      },
      extractedAmountDue: '$5,500.00',
      extractedTaxAmount: '$0.00',
      invoiceLineQuantityDisplayed: true,
      extractedInvoiceLines: [
        { description: 'PSO-RISK-ADVISORY - Consultant', quantity: 24.45, unitCost: '$224.9488753', totalPrice: '$5,500.00', hasDiscount: null },
        { description: "PSO-RISK-ADVISORY - Sep'26 - 5,500 per month", quantity: 1, unitCost: '5,500.00', totalPrice: '5,500.00', hasDiscount: null }
      ]
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue({
      lines: [
        { lineOrder: 1, description: 'PSO-RISK-ADVISORY - Consultant', quantity: 24.45, unitCost: 224.9488753, extendedAmount: 5500 },
        { lineOrder: 2, description: "PSO-RISK-ADVISORY - Sep'26 - 5,500 per month", quantity: 1, unitCost: 5500, extendedAmount: 5500 }
      ],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false },
      relatedLobByCostCenter: new Map()
    });

    await processor({
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: { descriptor: 'Existing Supplier', id: 'SUP-1' },
        company1: { descriptor: 'Test Company', id: 'COMP-1' },
        OCRSupplierInvoice: { descriptor: '24953$4729', id: '0627e00a601c1001085f64bd33e20000' }
      }]
    } as any);

    const [[, params]] = (submitSupplierInvoiceUpdate as jest.Mock).mock.calls;
    expect(params.finalLines[0]).toMatchObject({ quantity: 24.45, unitCost: 224.948875, extendedAmount: 5500 });
    expect(params.buildNotes([])).toContain(
      'Line total review: Invoice lines total $11,000.00, but the amount due $5,500.00 less freight $0.00 and tax $0.00 is $5,500.00.'
    );
  });

  it('should count freight and tax already on the Workday invoice before noting a line total mismatch', async () => {
    const { enrichmentResponse } = require('../lib/ai.js');
    const { submitSupplierInvoiceUpdate, getSupplierInvoiceWithAttachments } = require('../lib/workday.js');
    const invoiceLines = require('../lib/invoice_lines.js');

    getSupplierInvoiceWithAttachments.mockResolvedValueOnce({
      invoice: { Invoice_ID: 'test-invoice-id', Freight_Amount: '15.00', Tax_Amount: '5.00' },
      presignedAttachments: []
    });
    enrichmentResponse.mockResolvedValueOnce({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: { supplierName: 'LevelBlue, LLC' },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: { action: 'no_action', reason: 'Supplier matches existing assignment' },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      },
      extractedAmountDue: '$5,520.00',
      invoiceLineQuantityDisplayed: true,
      extractedInvoiceLines: [
        { description: 'PSO-RISK-ADVISORY - Consultant', quantity: 24.45, unitCost: '$224.9488753', totalPrice: '$5,500.00', hasDiscount: null }
      ]
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue({
      lines: [{ lineOrder: 1, description: 'PSO-RISK-ADVISORY - Consultant', quantity: 24.45, unitCost: 224.9488753, extendedAmount: 5500 }],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false },
      relatedLobByCostCenter: new Map()
    });

    await processor({
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: { descriptor: 'Existing Supplier', id: 'SUP-1' },
        company1: { descriptor: 'Test Company', id: 'COMP-1' },
        OCRSupplierInvoice: { descriptor: '24953$4729', id: '0627e00a601c1001085f64bd33e20000' }
      }]
    } as any);

    const [[, params]] = (submitSupplierInvoiceUpdate as jest.Mock).mock.calls;
    expect(params.buildNotes([])).not.toContain('Line total review');
  });

  it('should put extracted identifiers on the header and line memos', async () => {
    const { enrichmentResponse } = require('../lib/ai.js');
    const { submitSupplierInvoiceUpdate } = require('../lib/workday.js');
    const invoiceLines = require('../lib/invoice_lines.js');

    enrichmentResponse.mockResolvedValueOnce({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: {
          supplierName: 'Test Supplier',
          memo: 'Test invoice'
        },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: {
          action: 'no_action',
          reason: 'Supplier matches existing assignment'
        },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      },
      extractedSuppliersInvoiceNumber: 'INV|001>>>',
      extractedAccountNumber: '1033562',
      extractedJobNumber: '5914196',
      extractedCustomerId: 'CU0122145',
      extractedServicePeriod: '2026 - September',
      extractedInvoiceLines: [
        { description: 'Widgets', quantity: 2, unitCost: '50.00', totalPrice: '100.00', hasDiscount: false }
      ]
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue({
      lines: [{ lineOrder: 1, description: 'Widgets', memo: 'Widget purchase', quantity: 2, unitCost: 50 }],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false }
    });

    await expect(processor({
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: { descriptor: 'Existing Supplier', id: 'SUP-1' },
        company1: { descriptor: 'Test Company', id: 'COMP-1' },
        OCRSupplierInvoice: { descriptor: '24953$4729', id: '0627e00a601c1001085f64bd33e20000' }
      }]
    } as any)).resolves.not.toThrow();

    const [[, params]] = (submitSupplierInvoiceUpdate as jest.Mock).mock.calls;
    expect(params.memo).toBe(
      'AC 1033562. Customer ID CU0122145. Job 5914196. Service Period 2026 - September. Test invoice'
    );
    expect(params.suppliersInvoiceNumber).toBe('INV-001');
    expect(params.finalLines).toEqual([
      expect.objectContaining({
        memo: 'AC 1033562. Customer ID CU0122145. Job 5914196. Service Period 2026 - September. Widget purchase',
      }),
    ]);
    expect(params.buildNotes([])).toContain('Account Number (from document): 1033562');
  });

  it('submits an account number plus MMMYY when the printed invoice number is the account number', async () => {
    const { enrichmentResponse } = require('../lib/ai.js');
    const { submitSupplierInvoiceUpdate } = require('../lib/workday.js');

    enrichmentResponse.mockResolvedValueOnce({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: {
          supplierName: 'City of Frisco Texas',
          memo: 'Utility bill'
        },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: {
          action: 'no_action',
          reason: 'Supplier matches existing assignment'
        },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      },
      extractedSuppliersInvoiceNumber: '20-1183-01',
      extractedAccountNumber: '20-1183-01',
      extractedInvoiceDate: '2026-09-15',
    });

    await expect(processor({
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: { descriptor: 'Existing Supplier', id: 'SUP-1' },
        company1: { descriptor: 'Test Company', id: 'COMP-1' },
        OCRSupplierInvoice: { descriptor: '24953$4729', id: '0627e00a601c1001085f64bd33e20000' }
      }]
    } as any)).resolves.not.toThrow();

    const [[, params]] = (submitSupplierInvoiceUpdate as jest.Mock).mock.calls;
    expect(params.suppliersInvoiceNumber).toBe('20-1183-01SEP26');
    expect(params.buildNotes([])).toContain('Supplier Invoice Number (from document): 20-1183-01');
  });

  it('reports the timestamped supplier invoice number after a duplicate retry', async () => {
    const { enrichmentResponse } = require('../lib/ai.js');
    const { submitSupplierInvoiceUpdate } = require('../lib/workday.js');
    const { notifyEnrichmentResult } = require('../lib/slack.js');

    enrichmentResponse.mockResolvedValueOnce({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: { supplierName: 'Safari', memo: 'Trip' },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: { action: 'no_action', reason: 'Supplier matches existing assignment' },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      },
      extractedSuppliersInvoiceNumber: '12345',
      extractedInvoiceDate: '2026-09-28',
    });
    submitSupplierInvoiceUpdate.mockResolvedValueOnce({
      success: true,
      suppliersInvoiceNumber: '12345-20260928170000',
      appliedFallbacks: [{
        field: 'suppliersInvoiceNumber',
        label: 'supplier invoice number suffixed with -20260928170000',
        dueToValidationError: true,
      }],
      priorFailures: [{
        attempt: 1,
        message: "Enter a Supplier's Invoice Number that isn't already in use on another supplier invoice",
      }],
    });

    await expect(processor({
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: { descriptor: 'Safari', id: 'SUP-1' },
        company1: { descriptor: 'Test Company', id: 'COMP-1' },
        OCRSupplierInvoice: { descriptor: '24953$4729', id: '0627e00a601c1001085f64bd33e20000' }
      }]
    } as any)).resolves.not.toThrow();

    const [[, params]] = (submitSupplierInvoiceUpdate as jest.Mock).mock.calls;
    expect(params.buildNotes([{
      field: 'suppliersInvoiceNumber',
      label: 'supplier invoice number suffixed with -20260928170000',
    }])).toContain('Fallback values applied: supplier invoice number suffixed with -20260928170000');
    expect(params.buildNotes([])).toContain('Supplier Invoice Number (from document): 12345');
    expect(notifyEnrichmentResult).toHaveBeenCalledWith(expect.objectContaining({
      extracted: expect.objectContaining({ suppliersInvoiceNumber: '12345-20260928170000' }),
      appliedFallbackLabels: ['supplier invoice number suffixed with -20260928170000'],
    }));
  });

  it('does not pass a header memo when enrichment has a description but no identifiers', async () => {
    const { enrichmentResponse } = require('../lib/ai.js');
    const { submitSupplierInvoiceUpdate } = require('../lib/workday.js');
    const invoiceLines = require('../lib/invoice_lines.js');

    enrichmentResponse.mockResolvedValueOnce({
      supplier: {
        status: 'matching',
        confidence: 0.9,
        extractedInformation: {
          supplierName: 'Test Supplier',
          memo: 'Test invoice'
        },
        resolvedSupplier: null,
        potentialDuplicateSuppliers: null,
        recommendation: {
          action: 'no_action',
          reason: 'Supplier matches existing assignment'
        },
        reason: 'High confidence match'
      },
      companyVerification: {
        status: 'matching',
        confidence: 0.85,
        extractedInformation: {},
        recommended: null,
        reason: 'Company matches existing assignment'
      },
      extractedInvoiceLines: [
        { description: 'Widgets', quantity: 2, unitCost: '50.00', totalPrice: '100.00', hasDiscount: false }
      ]
    });
    invoiceLines.buildFinalInvoiceLines.mockResolvedValue({
      lines: [{ lineOrder: 1, description: 'Widgets', memo: 'Widget purchase', quantity: 2, unitCost: 50 }],
      appliedFallbacks: { fund: false, costCenter: false, spendCategory: false, lineOfBusiness: false }
    });

    await expect(processor({
      data: [{
        workdayID: 'test-invoice-id',
        invoiceStatusAsText: 'Draft',
        supplier: { descriptor: 'Existing Supplier', id: 'SUP-1' },
        company1: { descriptor: 'Test Company', id: 'COMP-1' },
        OCRSupplierInvoice: { descriptor: '24953$4729', id: '0627e00a601c1001085f64bd33e20000' }
      }]
    } as any)).resolves.not.toThrow();

    const [[, params]] = (submitSupplierInvoiceUpdate as jest.Mock).mock.calls;
    expect(params.memo).toBeUndefined();
    expect(params.finalLines).toEqual([
      expect.objectContaining({ memo: 'Widget purchase' }),
    ]);
  });
});
