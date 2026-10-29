import ExcelJS from 'exceljs';
import { enrichInvoiceFromAttachments } from '../lib/invoice_enrichment.js';
import { extractInvoiceDocuments, mergeInvoiceEnrichment } from '../lib/invoice_ocr.js';
import { DEFAULT_OCR_MODEL_ID, getOcrModel } from '../lib/models.js';
import { InvoiceMatchingSchema } from '../prompts/enrich_invoice_prompt.js';
import { invoiceOcrPrompt, InvoiceOcrSchema, normalizeInvoiceOcrResult, normalizePrintedDate, type InvoiceOcrResponse, type InvoiceOcrResult } from '../prompts/invoice_ocr_prompt.js';
import type { InvoiceMatchingResult } from '../prompts/enrich_invoice_prompt.js';
import type { PurchaseOrderEnrichmentContext } from '../lib/purchase_order.js';
import type { PresignedAttachment } from '../lib/types.js';
import { supin470584ProductionRows, supin470584Rows } from './fixtures/supin_470584.js';
import { supin472322Header, supin472322MissedRows, supin472322ProductionRows, supin472322Rows } from './fixtures/supin_472322.js';
import { supin472108DeliveryRow, supin472108Header, supin472108PickupRow, supin472108ProductionRows, supin472108Rows } from './fixtures/supin_472108.js';

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
  invoiceNumbersInDocument: ['401'],
  extractedFreightAmount: null,
  extractedFreightLabel: null,
  extractedTaxAmount: '$40.00',
  extractedTaxLabel: 'Sales Tax',
  extractedOtherCharges: [{ label: 'EnvChg Tax', amount: '$17.00' }],
  extractedSummaryCharges: [{ label: 'Decoration', amount: '$5.00' }, { label: 'Discount 10%', amount: null }],
  extractedLineSubtotal: null,
  extractedPartialPayment: null,
  extractedPriorPayments: null,
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
    sectionLabel: null,
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
  invoiceNumbersInDocument: ['401'],
  extractedFreightAmount: '',
  extractedFreightLabel: '',
  extractedTaxAmount: '$40.00',
  extractedTaxLabel: 'Sales Tax',
  extractedOtherCharges: [{ label: ' EnvChg Tax ', amount: '$17.00' }, { label: '', amount: '$3.00' }, { label: 'Fuel Surcharge', amount: ' ' }],
  extractedSummaryCharges: [{ label: ' Decoration ', amount: ' $5.00 ' }, { label: '', amount: '$2.00' }, { label: 'Discount 10%', amount: '' }],
  extractedLineSubtotal: { label: '', amount: '' },
  extractedPartialPayment: { label: '', percent: '', amount: '' },
  extractedPriorPayments: [],
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
    sectionLabel: '',
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
  emailBalanceDue: null,
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

    it('reads Word and Excel attachments as PDFs converted in memory and leaves the stored attachment alone', async () => {
      mockGetAiResponse.mockResolvedValueOnce(ocrResponse);
      const xlsxType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      const workbook = new ExcelJS.Workbook();
      workbook.addWorksheet('Hours').addRow(['Golfer', 'Hours']);
      const xlsxBuffer = Buffer.from(await workbook.xlsx.writeBuffer());
      const sheet: PresignedAttachment = {
        ...pdf,
        id: 'xlsx-1',
        fileName: 'timesheet.xlsx',
        contentType: xlsxType,
        buffer: xlsxBuffer,
      };

      await extractInvoiceDocuments([pdf, sheet]);

      const [call] = mockGetAiResponse.mock.calls[0];
      const files = call.messages[0].content.filter((part: { type: string }) => part.type === 'file');
      expect(files).toEqual([
        { type: 'file', data: pdfBuffer, mediaType: 'application/pdf', filename: 'invoice.pdf' },
        { type: 'file', data: expect.any(Buffer), mediaType: 'application/pdf', filename: 'timesheet.xlsx' },
      ]);
      expect(files[1].data.subarray(0, 5).toString()).toBe('%PDF-');
      expect(call.messages[0].content[0].text).toContain('timesheet.xlsx');
      expect(sheet.contentType).toBe(xlsxType);
      expect(sheet.buffer).toBe(xlsxBuffer);
    });

    it('skips a Word file that cannot be opened and still reads the other documents', async () => {
      mockGetAiResponse.mockResolvedValueOnce(ocrResponse);
      const broken: PresignedAttachment = {
        ...pdf,
        id: 'docx-1',
        fileName: 'broken.docx',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: Buffer.from('not a docx'),
      };

      await extractInvoiceDocuments([pdf, broken]);

      const [call] = mockGetAiResponse.mock.calls[0];
      expect(call.messages[0].content.filter((part: { type: string }) => part.type === 'file')).toEqual([
        { type: 'file', data: pdfBuffer, mediaType: 'application/pdf', filename: 'invoice.pdf' },
      ]);
    });

    it('leaves an unreadable file out of the document list and roles the model sees', async () => {
      mockGetAiResponse.mockResolvedValueOnce(ocrResponse);
      const broken: PresignedAttachment = {
        ...pdf,
        id: 'docx-2',
        fileName: 'broken.docx',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: Buffer.from('not a docx'),
      };

      await extractInvoiceDocuments(
        [pdf, broken],
        [{ fileName: 'invoice.pdf', role: 'invoice' }, { fileName: 'broken.docx', role: 'supporting' }]
      );

      const [call] = mockGetAiResponse.mock.calls[0];
      const text = call.messages[0].content[0].text as string;
      expect(text).toContain('Documents: invoice.pdf (application/pdf)');
      expect(text).toContain('invoice.pdf is the supplier invoice');
      expect(text).not.toContain('broken.docx');
    });

    it('returns nothing when the only attachment is an unreadable Excel file', async () => {
      const broken: PresignedAttachment = { ...pdf, fileName: 'broken.xlsx', contentType: 'application/octet-stream', buffer: Buffer.from('nope') };

      expect(await extractInvoiceDocuments([broken])).toBeUndefined();
      expect(mockGetAiResponse).not.toHaveBeenCalled();
    });

    it('skips the model when there is no PDF or image to read', async () => {
      const result = await extractInvoiceDocuments([{ ...pdf, contentType: 'text/plain' }]);

      expect(result).toBeUndefined();
      expect(mockGetAiResponse).not.toHaveBeenCalled();
    });

    describe('missing rows against the printed line total', () => {
      const subtotal = { label: 'Total Cost of Contracted Services', amount: '$38,255.00' };
      const fullRows = supin470584Rows.map(row => ({ ...row, descriptionCells: [] as string[] }));
      const productionRows = supin470584ProductionRows.map(row => ({ ...row, descriptionCells: [] as string[] }));
      const responseWith = (rows: Array<Omit<(typeof fullRows)[number], 'hasDiscount'> & { hasDiscount: boolean | null }>): InvoiceOcrResponse => ({
        ...ocrResponse,
        extractedLineSubtotal: subtotal,
        extractedPartialPayment: { label: 'Advance Deposit Due', percent: '90%', amount: '$34,429.50' },
        extractedInvoiceLines: rows,
      });

      it('reads the document once more and uses the second read when it matches the printed total', async () => {
        mockGetAiResponse.mockResolvedValueOnce(responseWith(productionRows)).mockResolvedValueOnce(responseWith(fullRows));

        const result = await extractInvoiceDocuments([pdf]);

        expect(mockGetAiResponse).toHaveBeenCalledTimes(2);
        expect(result?.extractedInvoiceLines).toHaveLength(28);
        expect(result?.extractedLineSubtotal).toEqual(subtotal);
        expect(result?.extractedPartialPayment).toEqual({ label: 'Advance Deposit Due', percent: '90%', amount: '$34,429.50' });
        expect(result?.extractedRowsAddedOnSecondRead).toEqual([{ description: 'Fresh Cut Floral Centerpieces', totalPrice: '$4,050.00' }]);
        expect(jest.requireMock<{ debug: jest.Mock }>('@pga/logger').debug).toHaveBeenCalledWith('Invoice OCR missing-row retry', {
          outcome: 'accepted',
          firstRows: 27,
          durationMs: expect.any(Number),
        });
        const retryText = mockGetAiResponse.mock.calls[1][0].messages[0].content[0].text;
        expect(retryText).toContain('A first read returned 27 rows totaling $34,205.00');
        expect(retryText).toContain('"Total Cost of Contracted Services"');
        expect(retryText).toContain('identical to another row but printed under a different date, event, or section heading');
        expect(mockGetAiResponse.mock.calls[0][0].messages[0].content[0].text).not.toContain('A first read returned');
      });

      it('keeps the first read when the second read still does not match the printed total', async () => {
        const stillShort = productionRows.slice(0, 20);
        mockGetAiResponse.mockResolvedValueOnce(responseWith(productionRows)).mockResolvedValueOnce(responseWith(stillShort));

        const result = await extractInvoiceDocuments([pdf]);

        expect(mockGetAiResponse).toHaveBeenCalledTimes(2);
        expect(result?.extractedInvoiceLines).toHaveLength(27);
      });

      it('keeps the first read when the second read changes a row to reach the printed total', async () => {
        const tampered = productionRows.map((row, index) => (index === 0 ? { ...row, totalPrice: '$4,800.00' } : row));
        mockGetAiResponse.mockResolvedValueOnce(responseWith(productionRows)).mockResolvedValueOnce(responseWith(tampered));

        const result = await extractInvoiceDocuments([pdf]);

        expect(result?.extractedInvoiceLines).toHaveLength(27);
        expect(result?.extractedInvoiceLines?.[0].totalPrice).toBe('$750.00');
        expect(result?.extractedRowsAddedOnSecondRead).toBeUndefined();
        expect(jest.requireMock<{ debug: jest.Mock }>('@pga/logger').debug).toHaveBeenCalledWith('Invoice OCR missing-row retry', expect.objectContaining({ outcome: 'rejected' }));
      });

      it('keeps the first read when the second read drops a first-read row and adds others to reach the total', async () => {
        const swapped = [...fullRows.slice(1), { ...fullRows[0], description: 'Something else', totalPrice: '$750.00' }];
        mockGetAiResponse.mockResolvedValueOnce(responseWith(productionRows)).mockResolvedValueOnce(responseWith(swapped));

        const result = await extractInvoiceDocuments([pdf]);

        expect(result?.extractedInvoiceLines).toHaveLength(27);
      });

      it('does not read again when a row prints a net-of-discount total', async () => {
        const discounted = productionRows.map((row, index) => (index === 0 ? { ...row, hasDiscount: true } : row));
        mockGetAiResponse.mockResolvedValueOnce(responseWith(discounted));

        await extractInvoiceDocuments([pdf]);

        expect(mockGetAiResponse).toHaveBeenCalledTimes(1);
      });

      it('does not read again when the caller will not submit lines', async () => {
        mockGetAiResponse.mockResolvedValueOnce(responseWith(productionRows));

        const result = await extractInvoiceDocuments([pdf], undefined, undefined, { retryMissingRows: false });

        expect(mockGetAiResponse).toHaveBeenCalledTimes(1);
        expect(result?.extractedInvoiceLines).toHaveLength(27);
      });

      it('keeps the first read when the second read overshoots the printed total', async () => {
        mockGetAiResponse.mockResolvedValueOnce(responseWith(productionRows)).mockResolvedValueOnce(responseWith([...fullRows, fullRows[0]]));

        const result = await extractInvoiceDocuments([pdf]);

        expect(result?.extractedInvoiceLines).toHaveLength(27);
      });

      it('keeps the first read when the second read fails', async () => {
        mockGetAiResponse.mockResolvedValueOnce(responseWith(productionRows)).mockRejectedValueOnce(new Error('No object generated'));

        const result = await extractInvoiceDocuments([pdf]);

        expect(result?.extractedInvoiceLines).toHaveLength(27);
      });

      it('does not read again when the rows already total the printed line total', async () => {
        mockGetAiResponse.mockResolvedValueOnce(responseWith(fullRows));

        const result = await extractInvoiceDocuments([pdf]);

        expect(mockGetAiResponse).toHaveBeenCalledTimes(1);
        expect(result?.extractedInvoiceLines).toHaveLength(28);
      });

      it('does not read again when the rows total more than the printed line total', async () => {
        mockGetAiResponse.mockResolvedValueOnce(responseWith([...fullRows, fullRows[0]]));

        await extractInvoiceDocuments([pdf]);

        expect(mockGetAiResponse).toHaveBeenCalledTimes(1);
      });

      it('does not read again when the document prints no line total', async () => {
        mockGetAiResponse.mockResolvedValueOnce({ ...responseWith(productionRows), extractedLineSubtotal: { label: '', amount: '' } });

        await extractInvoiceDocuments([pdf]);

        expect(mockGetAiResponse).toHaveBeenCalledTimes(1);
      });

      it('does not read again when a row has no printed total', async () => {
        mockGetAiResponse.mockResolvedValueOnce(responseWith([{ ...productionRows[0], totalPrice: '' }]));

        await extractInvoiceDocuments([pdf]);

        expect(mockGetAiResponse).toHaveBeenCalledTimes(1);
      });

      it('stops when the run is aborted during the second read', async () => {
        const controller = new AbortController();
        mockGetAiResponse.mockResolvedValueOnce(responseWith(productionRows)).mockImplementationOnce(async () => {
          controller.abort();
          throw new Error('aborted');
        });

        await expect(extractInvoiceDocuments([pdf], undefined, controller.signal)).rejects.toThrow('aborted');
      });
    });

    describe('missing rows against the amount due (SUPIN-472108)', () => {
      const withCells = (rows: typeof supin472108Rows) => rows.map(row => ({ ...row, descriptionCells: [] as string[] }));
      const responseFor = (rows: typeof supin472108Rows, overrides: Partial<InvoiceOcrResponse> = {}): InvoiceOcrResponse => ({
        ...ocrResponse,
        extractedAmountDue: supin472108Header.extractedAmountDue,
        extractedTaxAmount: supin472108Header.extractedTaxAmount,
        extractedTaxLabel: 'Tax',
        extractedOtherCharges: [],
        extractedSummaryCharges: [],
        extractedLineSubtotal: supin472108Header.extractedLineSubtotal,
        extractedInvoiceLines: withCells(rows),
        ...overrides,
      });
      const retryLog = () => jest.requireMock<{ debug: jest.Mock }>('@pga/logger').debug;

      it('reads again when a no-charge row hides the shortfall, and accepts the delivery and pickup rows that close the gap', async () => {
        mockGetAiResponse
          .mockResolvedValueOnce(responseFor(supin472108ProductionRows))
          .mockResolvedValueOnce(responseFor(supin472108Rows));

        const result = await extractInvoiceDocuments([pdf]);

        expect(mockGetAiResponse).toHaveBeenCalledTimes(2);
        expect(result?.extractedInvoiceLines).toHaveLength(7);
        expect(result?.extractedRowsAddedOnSecondRead).toEqual([
          { description: 'DELIVERY CHARGE', totalPrice: '208.66' },
          { description: 'PICKUP CHARGE', totalPrice: '208.66' },
        ]);
        expect(retryLog()).toHaveBeenCalledWith('Invoice OCR missing-row retry', { outcome: 'accepted', firstRows: 5, durationMs: expect.any(Number) });
        const retryText = mockGetAiResponse.mock.calls[1][0].messages[0].content[0].text;
        expect(retryText).toContain('A first read returned 5 rows totaling $3,330.56');
        expect(retryText).toContain('$417.32 short of the amount due $4,045.99');
        expect(retryText).toContain('delivery, pickup, fuel');
      });

      it('accepts the second read although its rows pass the printed subtotal, which leaves the fuel row out', async () => {
        mockGetAiResponse
          .mockResolvedValueOnce(responseFor(supin472108ProductionRows))
          .mockResolvedValueOnce(responseFor(supin472108Rows));

        const result = await extractInvoiceDocuments([pdf]);

        expect(result?.extractedInvoiceLines?.map(row => row.description)).toContain('PICKUP CHARGE');
        expect(result?.extractedLineSubtotal).toEqual({ label: 'Agreement Subtotal', amount: '3,591.67' });
      });

      it('keeps the first read when the added rows do not total the shortfall', async () => {
        mockGetAiResponse
          .mockResolvedValueOnce(responseFor(supin472108ProductionRows))
          .mockResolvedValueOnce(responseFor([...supin472108ProductionRows, supin472108DeliveryRow]));

        const result = await extractInvoiceDocuments([pdf]);

        expect(result?.extractedInvoiceLines).toHaveLength(5);
        expect(result?.extractedRowsAddedOnSecondRead).toBeUndefined();
        expect(retryLog()).toHaveBeenCalledWith('Invoice OCR missing-row retry', expect.objectContaining({ outcome: 'rejected' }));
      });

      it('keeps the first read when the second read drops a first-read row', async () => {
        mockGetAiResponse
          .mockResolvedValueOnce(responseFor(supin472108ProductionRows))
          .mockResolvedValueOnce(responseFor([...supin472108ProductionRows.slice(1), supin472108DeliveryRow, supin472108PickupRow]));

        const result = await extractInvoiceDocuments([pdf]);

        expect(result?.extractedInvoiceLines).toHaveLength(5);
      });

      it('reads again on a rental row that prints a discounted total, since the amount due still decides', async () => {
        const discounted = supin472108ProductionRows.map((row, index) => (index === 1 ? { ...row, hasDiscount: true } : row));
        mockGetAiResponse
          .mockResolvedValueOnce(responseFor(discounted))
          .mockResolvedValueOnce(responseFor([...discounted, supin472108DeliveryRow, supin472108PickupRow]));

        const result = await extractInvoiceDocuments([pdf]);

        expect(mockGetAiResponse).toHaveBeenCalledTimes(2);
        expect(result?.extractedInvoiceLines).toHaveLength(7);
      });

      it('does not read again when delivery and pickup are already rows', async () => {
        mockGetAiResponse.mockResolvedValueOnce(responseFor(supin472108Rows));

        const result = await extractInvoiceDocuments([pdf]);

        expect(mockGetAiResponse).toHaveBeenCalledTimes(1);
        expect(result?.extractedInvoiceLines).toHaveLength(7);
      });

      it('does not read again when the delivery charge is already the header freight', async () => {
        mockGetAiResponse.mockResolvedValueOnce(responseFor(
          [...supin472108ProductionRows, supin472108PickupRow],
          { extractedFreightAmount: '$208.66', extractedFreightLabel: 'Delivery Charge' }
        ));

        await extractInvoiceDocuments([pdf]);

        expect(mockGetAiResponse).toHaveBeenCalledTimes(1);
      });

      it('does not read again when a totals-block row explains the shortfall', async () => {
        mockGetAiResponse.mockResolvedValueOnce(responseFor(
          supin472108ProductionRows,
          { extractedLineSubtotal: { label: '', amount: '' }, extractedSummaryCharges: [{ label: 'Delivery and pickup', amount: '$417.32' }] }
        ));

        await extractInvoiceDocuments([pdf]);

        expect(mockGetAiResponse).toHaveBeenCalledTimes(1);
      });

      it('does not use the amount due on an invoice that bills a deposit or payments received', async () => {
        const noSubtotal = { extractedLineSubtotal: { label: '', amount: '' } };
        mockGetAiResponse.mockResolvedValueOnce(responseFor(
          supin472108ProductionRows,
          { ...noSubtotal, extractedPartialPayment: { label: 'Advance Deposit Due', percent: '', amount: '$4,045.99' } }
        ));
        await extractInvoiceDocuments([pdf]);
        mockGetAiResponse.mockResolvedValueOnce(responseFor(
          supin472108ProductionRows,
          { ...noSubtotal, extractedPriorPayments: [{ label: 'Payments Received', amount: '$100.00' }] }
        ));
        await extractInvoiceDocuments([pdf]);

        expect(mockGetAiResponse).toHaveBeenCalledTimes(2);
      });

      it('does not read again when the amount due is not printed or a row has no readable total', async () => {
        mockGetAiResponse.mockResolvedValueOnce(responseFor(supin472108ProductionRows, { extractedAmountDue: '', extractedLineSubtotal: { label: '', amount: '' } }));
        await extractInvoiceDocuments([pdf]);
        mockGetAiResponse.mockResolvedValueOnce(responseFor(
          supin472108ProductionRows.map((row, index) => (index === 1 ? { ...row, totalPrice: '' } : row))
        ));
        await extractInvoiceDocuments([pdf]);

        expect(mockGetAiResponse).toHaveBeenCalledTimes(2);
      });
    });

    describe('freight inside the printed subtotal and an unlined discount (SUPIN-472322)', () => {
      const withCells = (rows: typeof supin472322Rows) => rows.map(row => ({ ...row, descriptionCells: [] as string[] }));
      const responseFor = (rows: typeof supin472322Rows, overrides: Partial<InvoiceOcrResponse> = {}): InvoiceOcrResponse => ({
        ...ocrResponse,
        extractedAmountDue: supin472322Header.extractedAmountDue,
        extractedFreightAmount: supin472322Header.extractedFreightAmount,
        extractedFreightLabel: 'Freight',
        extractedTaxAmount: supin472322Header.extractedTaxAmount,
        extractedTaxLabel: 'Tax',
        extractedOtherCharges: [],
        extractedSummaryCharges: supin472322Header.extractedSummaryCharges,
        extractedLineSubtotal: supin472322Header.extractedLineSubtotal,
        extractedInvoiceLines: withCells(rows),
        ...overrides,
      });
      const retryLog = () => jest.requireMock<{ debug: jest.Mock }>('@pga/logger').debug;

      it('names the $1,388.00 the first read missed, not $3,388.00, and accepts the second read that adds it', async () => {
        mockGetAiResponse
          .mockResolvedValueOnce(responseFor(supin472322ProductionRows))
          .mockResolvedValueOnce(responseFor(supin472322Rows));

        const result = await extractInvoiceDocuments([pdf]);

        expect(mockGetAiResponse).toHaveBeenCalledTimes(2);
        const retryText = mockGetAiResponse.mock.calls[1][0].messages[0].content[0].text;
        expect(retryText).toContain('A first read returned 59 rows totaling $44,714.66');
        expect(retryText).toContain('which includes $2,000.00 of freight');
        expect(retryText).toContain('after the printed discount, those rows are $1,388.00 short of the amount due $41,590.16');
        expect(result?.extractedInvoiceLines).toHaveLength(61);
        expect(result?.extractedRowsAddedOnSecondRead).toEqual(supin472322MissedRows.map(row => ({ description: row.description, totalPrice: row.totalPrice })));
        expect(retryLog()).toHaveBeenCalledWith('Invoice OCR missing-row retry', { outcome: 'accepted', firstRows: 59, durationMs: expect.any(Number) });
      });

      it('keeps the first read when the added rows do not total the $1,388.00', async () => {
        mockGetAiResponse
          .mockResolvedValueOnce(responseFor(supin472322ProductionRows))
          .mockResolvedValueOnce(responseFor([...supin472322ProductionRows, supin472322MissedRows[0]]));

        const result = await extractInvoiceDocuments([pdf]);

        expect(result?.extractedInvoiceLines).toHaveLength(59);
        expect(retryLog()).toHaveBeenCalledWith('Invoice OCR missing-row retry', expect.objectContaining({ outcome: 'rejected' }));
      });

      it('does not read again once the rows and discount reconcile', async () => {
        mockGetAiResponse.mockResolvedValueOnce(responseFor(supin472322Rows));

        await extractInvoiceDocuments([pdf]);

        expect(mockGetAiResponse).toHaveBeenCalledTimes(1);
      });

      it('does not count a charge-style totals row as a credit', async () => {
        mockGetAiResponse.mockResolvedValueOnce(responseFor(
          supin472322ProductionRows,
          { extractedSummaryCharges: [{ label: 'Service Fee', amount: '8866.66' }], extractedLineSubtotal: { label: '', amount: '' } }
        ));

        await extractInvoiceDocuments([pdf]);

        expect(mockGetAiResponse).toHaveBeenCalledTimes(1);
      });
    });

    it('throws an OCR failure without retrying on another model', async () => {
      mockGetAiResponse.mockRejectedValueOnce(new Error('No object generated'));

      await expect(extractInvoiceDocuments([pdf])).rejects.toThrow('No object generated');
      expect(mockGetAiResponse).toHaveBeenCalledTimes(1);
    });
  });

  describe('line total, deposit, and section fields', () => {
    const response = (overrides: Partial<InvoiceOcrResponse>): InvoiceOcrResponse => ({ ...ocrResponse, ...overrides });

    it('normalizes a printed line total and deposit, and turns empty strings into null', () => {
      const normalized = normalizeInvoiceOcrResult(response({
        extractedLineSubtotal: { label: ' Total Cost of Contracted Services ', amount: ' $38,255.00 ' },
        extractedPartialPayment: { label: ' Advance Deposit Due ', percent: ' 90% ', amount: ' $34,429.50 ' },
      }));

      expect(normalized.extractedLineSubtotal).toEqual({ label: 'Total Cost of Contracted Services', amount: '$38,255.00' });
      expect(normalized.extractedPartialPayment).toEqual({ label: 'Advance Deposit Due', percent: '90%', amount: '$34,429.50' });
      expect(normalizeInvoiceOcrResult(response({
        extractedPartialPayment: { label: 'Advance Deposit Due', percent: '', amount: '$34,429.50' },
      })).extractedPartialPayment).toEqual({ label: 'Advance Deposit Due', percent: null, amount: '$34,429.50' });
      expect(normalizeInvoiceOcrResult(response({
        extractedLineSubtotal: { label: 'Sub Total', amount: '' },
        extractedPartialPayment: { label: '', percent: '', amount: '' },
      }))).toMatchObject({ extractedLineSubtotal: null, extractedPartialPayment: null });
    });

    it('normalizes printed prior payments, dropping rows without an amount, and tolerates an older response', () => {
      const normalized = normalizeInvoiceOcrResult(response({
        extractedPriorPayments: [
          { label: ' Payments Received ', amount: ' $17,977.50 ' },
          { label: 'Blank', amount: '' },
        ],
      }));
      expect(normalized.extractedPriorPayments).toEqual([{ label: 'Payments Received', amount: '$17,977.50' }]);
      expect(normalizeInvoiceOcrResult(response({ extractedPriorPayments: [] })).extractedPriorPayments).toBeNull();
      const { extractedPriorPayments: _payments, ...older } = ocrResponse;
      expect(normalizeInvoiceOcrResult(older as InvoiceOcrResponse).extractedPriorPayments).toBeNull();
    });

    it('carries prior payments and the email balance through the merge, and is empty without OCR', () => {
      const payments = [{ label: 'Payments Received', amount: '$17,977.50' }];
      const emailBalanceDue = { amount: '$5,909.50', phrase: 'remaining balance' };
      const merged = mergeInvoiceEnrichment({ ...matchingResult, emailBalanceDue }, { ...ocrResult, extractedPriorPayments: payments });
      expect(merged.extractedPriorPayments).toEqual(payments);
      expect(merged.emailBalanceDue).toEqual(emailBalanceDue);
      expect(mergeInvoiceEnrichment({ ...matchingResult, emailBalanceDue }, undefined)).toMatchObject({ extractedPriorPayments: null, emailBalanceDue });
    });

    it('tolerates an older response without the new fields', () => {
      const { extractedLineSubtotal: _subtotal, extractedPartialPayment: _deposit, ...older } = ocrResponse;
      expect(normalizeInvoiceOcrResult(older as InvoiceOcrResponse)).toMatchObject({ extractedLineSubtotal: null, extractedPartialPayment: null });
    });

    it('keeps each row section label and turns a blank one into null', () => {
      const normalized = normalizeInvoiceOcrResult(response({
        extractedInvoiceLines: [
          { ...ocrResponse.extractedInvoiceLines[0], sectionLabel: 'Wednesday, November 4, 2026 - Awards Event Enhancements' },
          { ...ocrResponse.extractedInvoiceLines[0], sectionLabel: '' },
        ],
      }));

      expect(normalized.extractedInvoiceLines?.map(line => line.sectionLabel)).toEqual([
        'Wednesday, November 4, 2026 - Awards Event Enhancements',
        null,
      ]);
    });

    it('carries the line total and deposit through the merge, and is empty without OCR', () => {
      const withFields: InvoiceOcrResult = {
        ...ocrResult,
        extractedLineSubtotal: { label: 'Sub Total', amount: '$38,255.00' },
        extractedPartialPayment: { label: 'Advance Deposit Due', percent: '90%', amount: '$34,429.50' },
      };

      const merged = mergeInvoiceEnrichment(matchingResult, withFields);
      expect(merged.extractedLineSubtotal).toEqual(withFields.extractedLineSubtotal);
      expect(merged.extractedPartialPayment).toEqual(withFields.extractedPartialPayment);
      expect(mergeInvoiceEnrichment(matchingResult, undefined)).toMatchObject({ extractedLineSubtotal: null, extractedPartialPayment: null });
    });

    it('asks for every printed row, the section label, the printed line total, and the deposit with the SUPIN-470584 example', () => {
      expect(invoiceOcrPrompt).toContain('Extract every printed row, in document order.');
      expect(invoiceOcrPrompt).toContain('printed under different dates, events, or section headings');
      expect(invoiceOcrPrompt).toContain('**Section Label**');
      expect(invoiceOcrPrompt).toContain('Rows printed under different date or section headings in the same table share one table number.');
      expect(invoiceOcrPrompt).toContain('extractedLineSubtotal { label: "Total Cost of Contracted Services", amount: "$38,255.00" }');
      expect(invoiceOcrPrompt).toContain('extractedPartialPayment { label: "Advance Deposit Due", percent: "90%", amount: "$34,429.50" }');
      expect(invoiceOcrPrompt).toContain('Never compute an amount from a percentage.');
      expect(invoiceOcrPrompt).toContain('"Less deposit paid"');
    });
  });

  describe('mergeInvoiceEnrichment', () => {
    it('carries the email budget splits from the matching pass through the merge', () => {
      const emailBudgetSplits = [{
        label: 'Recruitment',
        amount: '$15,000',
        percent: null,
        equalShare: null,
        company: null,
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
      expect(Object.keys(merged).sort()).toEqual(Object.keys({ ...InvoiceMatchingSchema.shape, ...ocrResult, extractedRowsAddedOnSecondRead: null }).filter((key) => !key.startsWith('printed')).sort());
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

  describe('totals-block rows', () => {
    it('keeps labeled rows, turns a rate-only amount into null, and drops rows without a label', () => {
      expect(normalizeInvoiceOcrResult(ocrResponse).extractedSummaryCharges).toEqual([
        { label: 'Decoration', amount: '$5.00' },
        { label: 'Discount 10%', amount: null },
      ]);
      expect(normalizeInvoiceOcrResult({ ...ocrResponse, extractedSummaryCharges: [] }).extractedSummaryCharges).toBeNull();
    });

    it('carries the rows through the merge and leaves them null when no document was read', () => {
      expect(mergeInvoiceEnrichment(matchingResult, ocrResult).extractedSummaryCharges).toEqual(ocrResult.extractedSummaryCharges);
      expect(mergeInvoiceEnrichment(matchingResult, undefined).extractedSummaryCharges).toBeNull();
    });

    it('asks for totals-block fees and discounts with the SUPIN-470485 example, keeping printed signs', () => {
      expect(invoiceOcrPrompt).toContain('extractedSummaryCharges [{ label: "Decoration", amount: "$5.00" }]');
      expect(invoiceOcrPrompt).toContain('A label such as "Merchandise Discount" or "Merchandise Allowance" is a discount, not a subtotal');
      expect(invoiceOcrPrompt).toContain('Do not add a minus sign that is not printed');
      expect(invoiceOcrPrompt).toContain('payments, deposits, applied credits, credit memos, retainers, or refunds');
      expect(InvoiceOcrSchema.shape.extractedSummaryCharges).toBeDefined();
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
