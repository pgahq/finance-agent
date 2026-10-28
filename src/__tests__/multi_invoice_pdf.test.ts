import PDFDocument from 'pdfkit';
import { extractInvoiceDocuments, mergeInvoiceEnrichment } from '../lib/invoice_ocr.js';
import { formatMultiInvoiceNotes, multiInvoiceReview } from '../lib/multi_invoice_pdf.js';
import { invoiceOcrPrompt, InvoiceOcrSchema, normalizeInvoiceOcrResult, type InvoiceOcrResponse } from '../prompts/invoice_ocr_prompt.js';
import type { InvoiceMatchingResult } from '../prompts/enrich_invoice_prompt.js';
import type { PresignedAttachment } from '../lib/types.js';

jest.mock('@pga/logger', () => ({ debug: jest.fn() }));
jest.mock('../lib/ai.js', () => ({ getAiResponse: jest.fn() }));

const mockGetAiResponse = jest.requireMock<{ getAiResponse: jest.Mock }>('../lib/ai.js').getAiResponse;

// KNIGHT JV LLC (LevelBlue), Intercom conversation 215476370619232: two PDFs, each one invoice per page for
// March through September 2026.
const PO_412640 = ['LBL20428245', 'LBL20453710', 'LBL20475512', 'LBL20488608', 'LBL20499004', 'LBL20508800', 'LBL20518206'];
const PO_412641 = ['LBL20428246', 'LBL20453711', 'LBL20475513', 'LBL20488609', 'LBL20499005', 'LBL20508801', 'LBL20518207'];

// A PDF shaped like the supplier's: one invoice per page, each with its own number and amount due. The real PDFs
// hold supplier tax and remittance details, so the fixture is generated instead of committed to this public repo.
function bundledInvoicesPdf(numbers: string[], amountDue: string): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    numbers.forEach((number, index) => {
      doc.addPage();
      doc.text('Invoice');
      doc.text(`Invoice Number: ${number}`);
      doc.text(`Invoice Date: ${index + 3}/03/2026`);
      doc.text(`Amount Due: ${amountDue}`);
    });
    doc.end();
  });
}

function pageCount(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type \/Page\b(?!s)/g) ?? []).length;
}

function attachment(fileName: string, buffer: Buffer): PresignedAttachment {
  return {
    id: fileName,
    fileName,
    contentType: 'application/pdf',
    presignedUrl: `https://example.com/${fileName}`,
    expiresAt: new Date('2026-10-28T00:00:00Z'),
    s3Key: `new-invoices/req/${fileName}`,
    buffer,
  };
}

function ocrResponseFor(numbers: string[], amountDue: string, poNumber: string): InvoiceOcrResponse {
  return {
    printedSupplier: {
      supplierName: 'LevelBlue, LLC', address: '', remitToAddress: '', phone: '', email: '', taxId: '', website: '', industry: '', contactPerson: '', memo: '',
    },
    printedBillTo: { companyName: 'The PGA of America', address: '', phone: '', email: '' },
    extractedInvoiceDate: '2026-03-03',
    extractedDueDate: '',
    extractedAmountDue: amountDue,
    extractedSuppliersInvoiceNumber: numbers[0],
    invoiceNumbersInDocument: numbers,
    extractedFreightAmount: '',
    extractedFreightLabel: '',
    extractedTaxAmount: '',
    extractedTaxLabel: '',
    extractedOtherCharges: [],
    extractedSummaryCharges: [],
    extractedLineSubtotal: { label: '', amount: '' },
    extractedPartialPayment: { label: '', percent: '', amount: '' },
    extractedPriorPayments: [],
    extractedPurchaseOrderNumber: poNumber,
    extractedAccountNumber: '',
    extractedSupplierReference: '',
    extractedSupplierReferenceKind: '',
    extractedCustomerId: '',
    extractedServicePeriod: '',
    extractedPaymentTerms: 'Net 30',
    invoiceLineQuantityDisplayed: false,
    extractedInvoiceLines: [],
  };
}

const matching: InvoiceMatchingResult = {
  supplier: {
    status: 'found', confidence: 0.9, extractedInformation: null, resolvedSupplier: null,
    potentialDuplicateSuppliers: null, recommendation: { action: 'use_existing', reason: '' }, reason: '',
  },
  companyVerification: { status: 'matching', confidence: 0.9, extractedInformation: null, recommended: null, reason: '' },
  emailSummary: null,
  extractedPaymentTerms: null,
  emailWorktags: null,
  emailBudgetSplits: null,
  emailBalanceDue: null,
} as unknown as InvoiceMatchingResult;

describe('multiInvoiceReview', () => {
  it('lists every invoice number, leads with the one that was entered, and tells AP to enter the rest', () => {
    const review = multiInvoiceReview({
      fileName: 'PO-412640.pdf',
      enteredInvoiceNumber: 'LBL20428245',
      invoiceNumbersInDocument: PO_412640,
    });

    expect(review).toEqual({
      fileName: 'PO-412640.pdf',
      invoiceNumbers: PO_412640,
      enteredInvoiceNumber: 'LBL20428245',
      message: 'PO-412640.pdf appears to contain 7 invoices (LBL20428245, LBL20453710, LBL20475512, LBL20488608, LBL20499004, LBL20508800, LBL20518206); only LBL20428245 was entered. Enter the rest manually.',
    });
  });

  it('puts the entered number first even when the reader lists it later, and adds it when the list lacks it', () => {
    expect(multiInvoiceReview({
      fileName: 'a.pdf', enteredInvoiceNumber: 'B-2', invoiceNumbersInDocument: ['B-1', 'B-2', 'B-3'],
    })?.invoiceNumbers).toEqual(['B-2', 'B-1', 'B-3']);
    expect(multiInvoiceReview({
      fileName: 'a.pdf', enteredInvoiceNumber: 'B-1', invoiceNumbersInDocument: ['B-2', 'B-3'],
    })).toMatchObject({ invoiceNumbers: ['B-1', 'B-2', 'B-3'], message: expect.stringContaining('3 invoices (B-1, B-2, B-3); only B-1 was entered') });
  });

  it('counts a number once however it is cased, spaced, or repeated', () => {
    expect(multiInvoiceReview({
      fileName: 'a.pdf', enteredInvoiceNumber: 'inv 100', invoiceNumbersInDocument: ['INV 100', 'INV-100', ' inv  100 '],
    })).toBeUndefined();
    expect(multiInvoiceReview({
      fileName: 'a.pdf', enteredInvoiceNumber: 'INV-100', invoiceNumbersInDocument: ['INV-100', 'inv-100', 'INV-101', ''],
    })).toMatchObject({ invoiceNumbers: ['INV-100', 'INV-101'] });
  });

  it('adds nothing for one invoice or a list the reader did not fill in', () => {
    expect(multiInvoiceReview({ fileName: 'a.pdf', enteredInvoiceNumber: 'INV-1', invoiceNumbersInDocument: ['INV-1'] })).toBeUndefined();
    expect(multiInvoiceReview({ fileName: 'a.pdf', enteredInvoiceNumber: 'INV-1', invoiceNumbersInDocument: [] })).toBeUndefined();
    expect(multiInvoiceReview({ fileName: 'a.pdf', enteredInvoiceNumber: 'INV-1', invoiceNumbersInDocument: null })).toBeUndefined();
    expect(multiInvoiceReview({ fileName: 'a.pdf', enteredInvoiceNumber: 'INV-1' })).toBeUndefined();
    expect(multiInvoiceReview({ fileName: 'a.pdf', enteredInvoiceNumber: null, invoiceNumbersInDocument: ['INV-1'] })).toBeUndefined();
    expect(multiInvoiceReview({ fileName: 'a.pdf', enteredInvoiceNumber: null, invoiceNumbersInDocument: null })).toBeUndefined();
  });

  it('does not name an entered number when the entered invoice printed none', () => {
    expect(multiInvoiceReview({
      fileName: 'a.pdf', enteredInvoiceNumber: null, invoiceNumbersInDocument: ['INV-1', 'INV-2'],
    })).toMatchObject({
      enteredInvoiceNumber: null,
      message: 'a.pdf appears to contain 2 invoices (INV-1, INV-2); only the first invoice was entered. Enter the rest manually.',
    });
  });

  it('caps a long list and long numbers so the note stays readable', () => {
    const numbers = Array.from({ length: 14 }, (_, index) => `INV-${index + 1}`);
    const review = multiInvoiceReview({ fileName: 'stack.pdf', enteredInvoiceNumber: 'INV-1', invoiceNumbersInDocument: numbers });

    expect(review?.invoiceNumbers).toHaveLength(14);
    expect(review?.message).toBe(
      'stack.pdf appears to contain 14 invoices (INV-1, INV-2, INV-3, INV-4, INV-5, INV-6, INV-7, INV-8, INV-9, INV-10, and 4 more); only INV-1 was entered. Enter the rest manually.'
    );
    const long = multiInvoiceReview({ fileName: 'a.pdf', enteredInvoiceNumber: 'X'.repeat(80), invoiceNumbersInDocument: ['Y'] });
    expect(long?.enteredInvoiceNumber).toBe(`${'X'.repeat(39)}…`);
  });

  it('formats the Workday note line, or nothing', () => {
    const review = multiInvoiceReview({ fileName: 'a.pdf', enteredInvoiceNumber: 'A', invoiceNumbersInDocument: ['A', 'B'] });

    expect(formatMultiInvoiceNotes(review)).toBe('Multiple invoices in one PDF: a.pdf appears to contain 2 invoices (A, B); only A was entered. Enter the rest manually.\n\n');
    expect(formatMultiInvoiceNotes(undefined)).toBe('');
  });
});

describe('invoice numbers read from a PDF with several invoices', () => {
  beforeEach(() => {
    mockGetAiResponse.mockReset();
  });

  it.each([
    { fileName: 'PO-412640.pdf', numbers: PO_412640, amountDue: '$3,861.07', po: 'PO-412640' },
    { fileName: 'PO-412641.pdf', numbers: PO_412641, amountDue: '$3,315.00', po: 'PO-412641' },
  ])('sends $fileName (7 pages) whole to the reader and warns that only the first invoice was entered', async ({ fileName, numbers, amountDue, po }) => {
    const pdf = await bundledInvoicesPdf(numbers, amountDue);
    expect(pageCount(pdf)).toBe(7);
    mockGetAiResponse.mockResolvedValueOnce(ocrResponseFor(numbers, amountDue, po));

    const ocr = await extractInvoiceDocuments([attachment(fileName, pdf)]);

    const [call] = mockGetAiResponse.mock.calls[0];
    expect(call.messages[0].content.filter((part: { type: string }) => part.type === 'file'))
      .toEqual([{ type: 'file', data: pdf, mediaType: 'application/pdf', filename: fileName }]);
    expect(ocr?.invoiceNumbersInDocument).toEqual(numbers);

    const merged = mergeInvoiceEnrichment(matching, ocr);
    expect(merged.invoiceNumbersInDocument).toEqual(numbers);
    expect(merged.extractedSuppliersInvoiceNumber).toBe(numbers[0]);
    expect(multiInvoiceReview({
      fileName,
      enteredInvoiceNumber: merged.extractedSuppliersInvoiceNumber,
      invoiceNumbersInDocument: merged.invoiceNumbersInDocument,
    })?.message).toBe(
      `${fileName} appears to contain 7 invoices (${numbers.join(', ')}); only ${numbers[0]} was entered. Enter the rest manually.`
    );
  });

  it('asks the reader for every separate invoice number and for header values from the first invoice only', () => {
    expect(invoiceOcrPrompt).toContain('`invoiceNumbersInDocument`');
    expect(invoiceOcrPrompt).toContain('one invoice per month, one per page');
    expect(invoiceOcrPrompt).toContain('extract Parts 1 through 9 from the first invoice only');
    expect(invoiceOcrPrompt).toContain('Do not list a number that an invoice only mentions');
    expect(invoiceOcrPrompt).toContain('List invoices only. Do not list the number of a credit memo, statement, quote, packing slip, or delivery ticket');
    expect(Object.keys(InvoiceOcrSchema.shape)).toContain('invoiceNumbersInDocument');
  });

  it('normalizes the reader list: trims, drops blanks, and treats a missing or empty list as none', () => {
    const response = ocrResponseFor(['A-1'], '$1.00', 'PO-1');

    expect(normalizeInvoiceOcrResult({ ...response, invoiceNumbersInDocument: [' A-1 ', '', '  ', 'A-2'] }).invoiceNumbersInDocument).toEqual(['A-1', 'A-2']);
    expect(normalizeInvoiceOcrResult({ ...response, invoiceNumbersInDocument: [] }).invoiceNumbersInDocument).toBeNull();
    const { invoiceNumbersInDocument: _omitted, ...older } = response;
    expect(normalizeInvoiceOcrResult(older as InvoiceOcrResponse).invoiceNumbersInDocument).toBeNull();
  });

  it('has no invoice numbers when no document was read', () => {
    expect(mergeInvoiceEnrichment(matching, undefined).invoiceNumbersInDocument).toBeNull();
  });
});
