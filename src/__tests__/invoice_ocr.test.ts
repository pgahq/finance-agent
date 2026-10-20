import { enrichInvoiceFromAttachments } from '../lib/invoice_enrichment.js';
import { extractInvoiceDocuments, mergeInvoiceEnrichment } from '../lib/invoice_ocr.js';
import { DEFAULT_OCR_MODEL_ID, getOcrModel } from '../lib/models.js';
import { InvoiceMatchingSchema } from '../prompts/enrich_invoice_prompt.js';
import { invoiceOcrPrompt, InvoiceOcrSchema, normalizeInvoiceOcrResult, normalizePrintedDate, type InvoiceOcrResponse, type InvoiceOcrResult } from '../prompts/invoice_ocr_prompt.js';
import type { InvoiceMatchingResult } from '../prompts/enrich_invoice_prompt.js';
import type { PurchaseOrderEnrichmentContext } from '../lib/purchase_order.js';
import type { PresignedAttachment } from '../lib/types.js';

jest.mock('@pga/logger', () => ({ debug: jest.fn() }));

jest.mock('../lib/ai.js', () => ({ getAiResponse: jest.fn() }));

jest.mock('../lib/database.js', () => ({
  getDatabaseConnection: jest.fn().mockResolvedValue({ query: jest.fn().mockResolvedValue([]) }),
}));

jest.mock('../lib/reference_ids.js', () => ({
  resolveReferenceCodesFromText: jest.fn().mockResolvedValue([]),
  formatReferenceDirectory: jest.fn().mockReturnValue(''),
}));

const pdfBuffer = Buffer.from('invoice-pdf');

const pdf: PresignedAttachment = {
  id: 'pdf-1',
  fileName: 'invoice.pdf',
  contentType: 'application/pdf',
  presignedUrl: 'https://example.com/invoice.pdf',
  expiresAt: new Date('2026-10-08T00:00:00Z'),
  s3Key: 'new-invoices/req/invoice.pdf',
  buffer: pdfBuffer,
};

const backup: PresignedAttachment = {
  ...pdf,
  id: 'pdf-2',
  fileName: 'timesheet.pdf',
  s3Key: 'new-invoices/req/timesheet.pdf',
};

const ocrResult: InvoiceOcrResult = {
  printedSupplier: {
    supplierName: 'Kristina Sawyer Privacy Consultants',
    address: '6767 Collins Ave Apt 302, Miami Beach, FL 33141',
    remitToAddress: 'PO Box 100, Miami, FL 33101',
    phone: null,
    email: 'kristysawyer@sawyerprivacyconsultants.com',
    taxId: '12-3456789',
    website: null,
    industry: 'Privacy consulting',
    contactPerson: null,
    memo: 'Privacy consulting services for the week of Sept 28',
  },
  printedBillTo: {
    companyName: 'The PGA of America',
    address: '1916 PGA Pkwy, Frisco, TX 75033',
    phone: null,
    email: null,
  },
  extractedInvoiceDate: '2026-10-02',
  extractedDueDate: '2026-11-01',
  extractedAmountDue: '$1,540.00',
  extractedSuppliersInvoiceNumber: '401',
  extractedFreightAmount: null,
  extractedFreightLabel: null,
  extractedTaxAmount: '$40.00',
  extractedTaxLabel: 'Sales Tax',
  extractedOtherCharges: [{ label: 'EnvChg Tax', amount: '$17.00' }],
  extractedPurchaseOrderNumber: 'PO-414007',
  extractedAccountNumber: 'AC-1033562',
  extractedSupplierReference: null,
  extractedSupplierReferenceKind: null,
  extractedCustomerId: null,
  extractedServicePeriod: 'Sept 28 - Oct 2',
  extractedPaymentTerms: { name: 'Due on receipt' },
  invoiceLineQuantityDisplayed: true,
  extractedInvoiceLines: [{
    description: 'Privacy consulting',
    descriptionCells: null,
    quantity: 14,
    unitCost: '$110.00',
    totalPrice: '$1,540.00',
    hasDiscount: null,
    tableNumber: 1,
  }],
};

// The same extraction as Haiku returns it: empty strings and arrays instead of null.
const ocrResponse: InvoiceOcrResponse = {
  printedSupplier: {
    supplierName: 'Kristina Sawyer Privacy Consultants',
    address: '6767 Collins Ave Apt 302, Miami Beach, FL 33141',
    remitToAddress: 'PO Box 100, Miami, FL 33101',
    phone: '',
    email: 'kristysawyer@sawyerprivacyconsultants.com',
    taxId: '12-3456789',
    website: '',
    industry: 'Privacy consulting',
    contactPerson: '',
    memo: 'Privacy consulting services for the week of Sept 28',
  },
  printedBillTo: {
    companyName: 'The PGA of America',
    address: '1916 PGA Pkwy, Frisco, TX 75033',
    phone: '',
    email: '',
  },
  extractedInvoiceDate: '2026-10-02',
  extractedDueDate: '2026-11-01',
  extractedAmountDue: '$1,540.00',
  extractedSuppliersInvoiceNumber: '401',
  extractedFreightAmount: '',
  extractedFreightLabel: '',
  extractedTaxAmount: '$40.00',
  extractedTaxLabel: 'Sales Tax',
  extractedOtherCharges: [{ label: ' EnvChg Tax ', amount: '$17.00' }, { label: '', amount: '$3.00' }, { label: 'Fuel Surcharge', amount: ' ' }],
  extractedPurchaseOrderNumber: 'PO-414007',
  extractedAccountNumber: 'AC-1033562',
  extractedSupplierReference: '',
  extractedSupplierReferenceKind: '',
  extractedCustomerId: ' ',
  extractedServicePeriod: 'Sept 28 - Oct 2',
  extractedPaymentTerms: 'Due on receipt',
  invoiceLineQuantityDisplayed: true,
  extractedInvoiceLines: [{
    description: 'Privacy consulting',
    descriptionCells: [],
    quantity: 14,
    unitCost: '$110.00',
    totalPrice: '$1,540.00',
    hasDiscount: null,
    tableNumber: 1,
  }],
};

const matchingResult: InvoiceMatchingResult = {
  supplier: {
    status: 'found',
    confidence: 0.86,
    extractedInformation: {
      supplierName: 'Kristina Sawyer Privacy Consultants (copied)',
      address: null,
      phone: null,
      email: null,
      taxId: null,
      website: null,
      industry: null,
      contactPerson: null,
      memo: null,
    },
    resolvedSupplier: {
      workdayId: 'supplier-wid',
      supplierName: 'Kristy Sawyer Privacy Consultants LLC',
      confidence: 0.86,
      reason: 'Name and street address match',
    },
    potentialDuplicateSuppliers: null,
    recommendation: { action: 'update_invoice', reason: 'Strong match' },
    reason: 'One strong match',
  },
  companyVerification: {
    status: 'different',
    confidence: 0.92,
    extractedInformation: { companyName: 'copied', address: null, phone: null, email: null },
    recommended: {
      workdayId: 'company-wid',
      companyName: 'The Professional Golfers Association of America',
      confidence: 0.92,
      reason: 'Alias and street match',
    },
    reason: 'Default OCR Company placeholder',
  },
  emailSummary: 'AP forwarded the invoice.',
  extractedPaymentTerms: { name: 'Due on receipt', workdayId: 'Immediate' },
  emailWorktags: null,
  emailBudgetSplits: null,
};

describe('invoice OCR pass', () => {
  const mockGetAiResponse = jest.requireMock<{ getAiResponse: jest.Mock }>('../lib/ai.js').getAiResponse;
  const originalOcrModel = process.env.OCR_MODEL;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.OCR_MODEL;
  });

  afterAll(() => {
    if (originalOcrModel === undefined) delete process.env.OCR_MODEL;
    else process.env.OCR_MODEL = originalOcrModel;
  });

  describe('getOcrModel', () => {
    it('defaults to Claude Haiku 5.5 through the gateway, pinned to Anthropic', () => {
      expect(DEFAULT_OCR_MODEL_ID).toBe('anthropic/claude-haiku-5.5');
      expect(getOcrModel()).toEqual(expect.objectContaining({ provider: 'gateway', modelId: 'anthropic/claude-haiku-5.5' }));
    });

    it('uses OCR_MODEL when set', () => {
      process.env.OCR_MODEL = 'anthropic/claude-haiku-4.5';
      expect(getOcrModel()).toEqual(expect.objectContaining({ modelId: 'anthropic/claude-haiku-4.5' }));
    });
  });

  it('stays within the Anthropic structured-output limits of 16 union-typed and 24 optional parameters', async () => {
    const { zodSchema } = jest.requireActual<typeof import('ai')>('ai');
    const jsonSchema = await zodSchema(InvoiceOcrSchema).jsonSchema;
    let unions = 0;
    let optional = 0;
    const walk = (node: any) => {
      if (!node || typeof node !== 'object') return;
      for (const [key, property] of Object.entries<any>(node.properties ?? {})) {
        if (Array.isArray(property.type) || property.anyOf) unions++;
        if (!(node.required ?? []).includes(key)) optional++;
        walk(property);
      }
      walk(node.items);
      (node.anyOf ?? []).forEach(walk);
    };
    walk(jsonSchema);

    expect(unions).toBeLessThanOrEqual(16);
    expect(unions).toBe(3);
    expect(optional).toBeLessThanOrEqual(24);
    expect(optional).toBe(0);
    expect((jsonSchema as any).properties.extractedDueDate).toMatchObject({ type: 'string' });
    expect((jsonSchema as any).required).toContain('extractedDueDate');
  });

  it('turns empty strings and arrays from Haiku back into null', () => {
    expect(normalizeInvoiceOcrResult(ocrResponse)).toEqual(ocrResult);
    expect(normalizeInvoiceOcrResult({ ...ocrResponse, extractedPaymentTerms: '', extractedInvoiceLines: [] })).toMatchObject({
      extractedPaymentTerms: null,
      extractedInvoiceLines: null,
    });
  });

  it('builds an OCR schema without numeric bounds, which Anthropic structured outputs reject', async () => {
    const { zodSchema } = jest.requireActual<typeof import('ai')>('ai');
    const jsonSchema = JSON.stringify(await zodSchema(InvoiceOcrSchema).jsonSchema);

    expect(jsonSchema).not.toMatch(/"(minimum|maximum|exclusiveMinimum|exclusiveMaximum)"/);
    expect(jsonSchema).toContain('Which table on the document this row came from');
  });

  describe('extractInvoiceDocuments', () => {
    it('sends the PDFs and document roles to the OCR model with no tools and no temperature', async () => {
      mockGetAiResponse.mockResolvedValueOnce(ocrResponse);

      const result = await extractInvoiceDocuments(
        [pdf, backup],
        [{ fileName: 'invoice.pdf', role: 'invoice' }, { fileName: 'timesheet.pdf', role: 'supporting' }]
      );

      expect(result).toEqual(normalizeInvoiceOcrResult(ocrResponse));
      expect(mockGetAiResponse).toHaveBeenCalledTimes(1);
      const [call] = mockGetAiResponse.mock.calls[0];
      expect(call.schema).toBe(InvoiceOcrSchema);
      expect(call.model).toEqual(expect.objectContaining({ modelId: 'anthropic/claude-haiku-5.5' }));
      expect(call.tools).toEqual({});
      expect(call.temperature).toBeNull();
      const content = call.messages[0].content;
      expect(content.filter((part: { type: string }) => part.type === 'file')).toEqual([
        { type: 'file', data: pdfBuffer, mediaType: 'application/pdf', filename: 'invoice.pdf' },
        { type: 'file', data: pdfBuffer, mediaType: 'application/pdf', filename: 'timesheet.pdf' },
      ]);
      expect(content[0].text).toContain('invoice.pdf is the supplier invoice; timesheet.pdf is supporting backup');
      expect(jest.requireMock<{ debug: jest.Mock }>('@pga/logger').debug).toHaveBeenCalledWith('Invoice OCR finished', {
        durationMs: expect.any(Number),
        documentCount: 2,
        documentBytes: pdfBuffer.byteLength * 2,
      });
    });

    it('skips the model when there is no PDF or image to read', async () => {
      const result = await extractInvoiceDocuments([{ ...pdf, contentType: 'text/plain' }]);

      expect(result).toBeUndefined();
      expect(mockGetAiResponse).not.toHaveBeenCalled();
    });

    it('throws an OCR failure without retrying on another model', async () => {
      mockGetAiResponse.mockRejectedValueOnce(new Error('No object generated'));

      await expect(extractInvoiceDocuments([pdf])).rejects.toThrow('No object generated');
      expect(mockGetAiResponse).toHaveBeenCalledTimes(1);
    });
  });

  describe('mergeInvoiceEnrichment', () => {
    it('carries the email budget splits from the matching pass through the merge', () => {
      const emailBudgetSplits = [{
        label: 'Recruitment',
        amount: '$15,000',
        percent: null,
        equalShare: null,
        event: null,
        lineOfBusiness: null,
        fund: null,
        costCenter: { extracted: 'Recruitment', name: 'CC-Recruitment', code: 'CC-Recruitment' },
        spendCategory: null,
      }];

      const merged = mergeInvoiceEnrichment({ ...matchingResult, emailBudgetSplits }, ocrResult);

      expect(merged.emailBudgetSplits).toEqual(emailBudgetSplits);
    });

    it('keeps every document field from OCR and matching, coding, and the payment terms ID from gpt-5.4', () => {
      const merged = mergeInvoiceEnrichment(matchingResult, ocrResult);

      expect(merged.supplier).toEqual({
        ...matchingResult.supplier,
        extractedInformation: {
          supplierName: 'Kristina Sawyer Privacy Consultants',
          address: '6767 Collins Ave Apt 302, Miami Beach, FL 33141',
          phone: null,
          email: 'kristysawyer@sawyerprivacyconsultants.com',
          taxId: '12-3456789',
          website: null,
          industry: 'Privacy consulting',
          contactPerson: null,
          memo: 'Privacy consulting services for the week of Sept 28',
        },
      });
      expect(merged.companyVerification).toEqual({ ...matchingResult.companyVerification, extractedInformation: ocrResult.printedBillTo });
      expect(merged.emailSummary).toBe('AP forwarded the invoice.');
      expect(merged.emailWorktags).toBeNull();
      expect(merged.emailBudgetSplits).toBeNull();
      expect(merged.extractedPaymentTerms).toEqual({ name: 'Due on receipt', workdayId: 'Immediate' });
      expect(merged).toMatchObject({
        extractedInvoiceDate: '2026-10-02',
        extractedAmountDue: '$1,540.00',
        extractedSuppliersInvoiceNumber: '401',
        extractedTaxAmount: '$40.00',
        extractedTaxLabel: 'Sales Tax',
        extractedOtherCharges: [{ label: 'EnvChg Tax', amount: '$17.00' }],
        extractedPurchaseOrderNumber: 'PO-414007',
        extractedAccountNumber: 'AC-1033562',
        extractedServicePeriod: 'Sept 28 - Oct 2',
        invoiceLineQuantityDisplayed: true,
        extractedInvoiceLines: ocrResult.extractedInvoiceLines,
      });
      expect(Object.keys(merged).sort()).toEqual(Object.keys({ ...InvoiceMatchingSchema.shape, ...ocrResult }).filter((key) => !key.startsWith('printed')).sort());
    });

    it('keeps the OCR payment terms name and drops terms the document does not print', () => {
      expect(mergeInvoiceEnrichment({ ...matchingResult, extractedPaymentTerms: null }, ocrResult).extractedPaymentTerms)
        .toEqual({ name: 'Due on receipt', workdayId: null });
      expect(mergeInvoiceEnrichment(matchingResult, { ...ocrResult, extractedPaymentTerms: null }).extractedPaymentTerms).toBeNull();
    });

    it('leaves document fields empty when no document was read', () => {
      const merged = mergeInvoiceEnrichment(matchingResult, undefined);

      expect(merged.supplier).toBe(matchingResult.supplier);
      expect(merged.extractedSuppliersInvoiceNumber).toBeNull();
      expect(merged.extractedInvoiceLines).toBeNull();
      expect(merged.invoiceLineQuantityDisplayed).toBe(false);
      expect(merged.extractedOtherCharges).toBeNull();
    });
  });

  describe('printed due date', () => {
    // IBS invoice 1026465 prints Invoice Date 10/10/26, Due Date 11/11/26, and PO-413821.
    const ibsResponse: InvoiceOcrResponse = {
      ...ocrResponse,
      extractedInvoiceDate: '2026-10-10',
      extractedDueDate: '11/11/26',
      extractedSuppliersInvoiceNumber: '1026465',
      extractedPurchaseOrderNumber: 'PO-413821',
      extractedPaymentTerms: 'Net 30',
    };

    it('normalizes the IBS 1026465 due date 11/11/26 to 2026-11-11 and keeps it through the merge', () => {
      const ocr = normalizeInvoiceOcrResult(ibsResponse);

      expect(ocr).toMatchObject({
        extractedInvoiceDate: '2026-10-10',
        extractedDueDate: '2026-11-11',
        extractedPurchaseOrderNumber: 'PO-413821',
      });
      expect(mergeInvoiceEnrichment(matchingResult, ocr)).toMatchObject({
        extractedDueDate: '2026-11-11',
        extractedPaymentTerms: { name: 'Net 30', workdayId: 'Immediate' },
      });
    });

    it('turns an empty or unreadable due date into null', () => {
      expect(normalizeInvoiceOcrResult({ ...ibsResponse, extractedDueDate: '' }).extractedDueDate).toBeNull();
      expect(normalizeInvoiceOcrResult({ ...ibsResponse, extractedDueDate: '  ' }).extractedDueDate).toBeNull();
      expect(normalizeInvoiceOcrResult({ ...ibsResponse, extractedDueDate: 'Due on receipt' }).extractedDueDate).toBeNull();
      expect(mergeInvoiceEnrichment(matchingResult, undefined).extractedDueDate).toBeNull();
    });

    it.each([
      ['2026-11-11', '2026-11-11'],
      ['11/11/2026', '2026-11-11'],
      ['1/5/26', '2026-01-05'],
      ['11-11-26', '2026-11-11'],
      ['Nov 11, 2026', '2026-11-11'],
      ['November 11 2026', '2026-11-11'],
      ['11 Nov 2026', '2026-11-11'],
      ['November 11th, 2026', '2026-11-11'],
      ['Sept 30, 2026', '2026-09-30'],
      ['September 3rd, 2026', '2026-09-03'],
      ['22nd Feb 2026', '2026-02-22'],
      ['November 11st, 2026', null],
      ['February 22th, 2026', null],
      ['1th March 2026', null],
      ['2/30/26', null],
      ['13/01/26', null],
      ['Net 30', null],
      ['2026-11-11Tgarbage', null],
      ['2026-11-11-08:00', null],
      ['11/11-26', null],
      ['05.11.2026', null],
      ['Mayday 11 2026', null],
      ['Novemberish 11, 2026', null],
      ['Nov 11, 26', null],
    ])('normalizes the printed date %s to %s', (printed, expected) => {
      expect(normalizePrintedDate(printed)).toBe(expected);
    });

    it('asks for an explicitly printed due date only, with the IBS example', () => {
      expect(InvoiceOcrSchema.shape.extractedDueDate).toBeDefined();
      expect(invoiceOcrPrompt).toContain('Never compute a due date from payment terms such as "Net 30"');
      expect(invoiceOcrPrompt).toContain('Invoice Date 10/10/26 and Due Date 11/11/26 must return extractedInvoiceDate "2026-10-10" and extractedDueDate "2026-11-11"');
    });
  });

  describe('other printed charges', () => {
    it('keeps printed charges with a label and an amount and drops blank entries', () => {
      expect(normalizeInvoiceOcrResult(ocrResponse).extractedOtherCharges).toEqual([{ label: 'EnvChg Tax', amount: '$17.00' }]);
      expect(normalizeInvoiceOcrResult({ ...ocrResponse, extractedOtherCharges: [] }).extractedOtherCharges).toBeNull();
    });

    it('asks the model for additional tax rows with the SUPIN-467011 example', () => {
      expect(invoiceOcrPrompt).toContain('extractedOtherCharges [{ label: "5% EnvChg Tax", amount: "$17.00" }]');
      expect(invoiceOcrPrompt).toContain('fuel surcharges, service charges, convenience fees, and similar rows stay exactly where Parts 5 and 9 put them');
      expect(invoiceOcrPrompt).toContain('Never compute an amount from a rate');
    });
  });

  describe('enrichInvoiceFromAttachments', () => {
    const purchaseOrder: PurchaseOrderEnrichmentContext = {
      documentNumber: 'PO-414007',
      company: { name: 'The Professional Golfers Association of America', workdayId: 'company-wid' },
      lines: [],
    };

    it('runs OCR on the PDFs, then matching on gpt-5.4 with the OCR JSON and no file parts', async () => {
      mockGetAiResponse.mockResolvedValueOnce(ocrResponse).mockResolvedValueOnce(matchingResult);

      const result = await enrichInvoiceFromAttachments(
        {},
        [pdf],
        undefined,
        { descriptor: 'Default OCR Company', id: 'default-company' },
        { emailFrom: 'ap@pgahq.com', subject: 'Invoice 401', plainTextBody: 'Please process.' },
        purchaseOrder,
        [{ fileName: 'invoice.pdf', role: 'invoice' }]
      );

      expect(mockGetAiResponse).toHaveBeenCalledTimes(2);
      const [ocrCall] = mockGetAiResponse.mock.calls[0];
      const [matchingCall] = mockGetAiResponse.mock.calls[1];
      expect(ocrCall.model).toEqual(expect.objectContaining({ modelId: 'anthropic/claude-haiku-5.5' }));
      expect(ocrCall.messages[0].content[0].text).not.toContain('PO-414007');

      expect(matchingCall.schema).toBe(InvoiceMatchingSchema);
      expect(matchingCall.model).toEqual(expect.objectContaining({ modelId: 'openai/gpt-5.4' }));
      expect(matchingCall.tools).toBeUndefined();
      const matchingContent = matchingCall.messages[0].content;
      expect(matchingContent).toHaveLength(1);
      expect(matchingContent[0].type).toBe('text');
      const { extractedDueDate, ...ocrForMatching } = normalizeInvoiceOcrResult(ocrResponse);
      expect(extractedDueDate).toBe('2026-11-01');
      expect(matchingContent[0].text).toContain(JSON.stringify(ocrForMatching, null, 2));
      expect(matchingContent[0].text).not.toContain('extractedDueDate');
      expect(matchingContent[0].text).toContain('Matching Workday purchase order PO-414007');
      expect(matchingContent[0].text).toContain('Subject: Invoice 401');

      expect(result).toEqual(mergeInvoiceEnrichment(matchingResult, normalizeInvoiceOcrResult(ocrResponse)));
    });

    it('throws when OCR fails and never calls the matching model', async () => {
      mockGetAiResponse.mockRejectedValueOnce(new Error('Gateway error: 529 Overloaded'));

      await expect(enrichInvoiceFromAttachments({}, [pdf])).rejects.toThrow('Gateway error: 529 Overloaded');
      expect(mockGetAiResponse).toHaveBeenCalledTimes(1);
    });
  });
});
