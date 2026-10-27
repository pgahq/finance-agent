import {
  clusterClassifiedAttachments,
  clusterMaxReceivedAt,
  invoiceAttachmentClusteringMode,
  isInvoiceAttachmentClusteringEnabled,
  joinClassifications,
  normalizeClusterInvoiceNumber,
  parseAndClusterInvoiceAttachments,
  supplierNamesAgree,
  type ClassifiedAttachment,
} from '../lib/invoice_attachment_clustering.js';
import ExcelJS from 'exceljs';
import { getAiResponse } from '../lib/ai.js';

jest.mock('../lib/ai.js', () => ({
  getAiResponse: jest.fn(),
}));

const mockGetAiResponse = getAiResponse as jest.MockedFunction<typeof getAiResponse>;

function classified(
  overrides: Partial<ClassifiedAttachment> & { fileName: string }
): ClassifiedAttachment {
  return {
    s3Key: `new-invoices/req-1/${overrides.fileName}`,
    contentType: 'application/pdf',
    kind: 'supplier_invoice',
    confidence: 0.9,
    ...overrides,
  };
}

describe('isInvoiceAttachmentClusteringEnabled', () => {
  it('is off unless explicitly true', () => {
    expect(isInvoiceAttachmentClusteringEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isInvoiceAttachmentClusteringEnabled({ INVOICE_ATTACHMENT_CLUSTERING_ENABLED: undefined } as NodeJS.ProcessEnv)).toBe(false);
    expect(isInvoiceAttachmentClusteringEnabled({ INVOICE_ATTACHMENT_CLUSTERING_ENABLED: '' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isInvoiceAttachmentClusteringEnabled({
      INVOICE_ATTACHMENT_CLUSTERING_ENABLED: 'ssm:/finance-agent/invoice-attachment-clustering-enabled',
    } as NodeJS.ProcessEnv)).toBe(false);
    expect(isInvoiceAttachmentClusteringEnabled({ INVOICE_ATTACHMENT_CLUSTERING_ENABLED: 'false' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isInvoiceAttachmentClusteringEnabled({ INVOICE_ATTACHMENT_CLUSTERING_ENABLED: 'true' } as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe('invoiceAttachmentClusteringMode', () => {
  it('maps true to on, shadow to shadow, and everything else to off', () => {
    const mode = (value?: string) =>
      invoiceAttachmentClusteringMode({ INVOICE_ATTACHMENT_CLUSTERING_ENABLED: value } as NodeJS.ProcessEnv);
    expect(mode('true')).toBe('on');
    expect(mode('shadow')).toBe('shadow');
    expect(mode(undefined)).toBe('off');
    expect(mode('false')).toBe('off');
    expect(mode('SHADOW')).toBe('off');
    expect(isInvoiceAttachmentClusteringEnabled({ INVOICE_ATTACHMENT_CLUSTERING_ENABLED: 'shadow' } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('normalizeClusterInvoiceNumber', () => {
  it('trims, uppercases, and strips whitespace', () => {
    expect(normalizeClusterInvoiceNumber('  inv-123 ')).toBe('INV-123');
    expect(normalizeClusterInvoiceNumber('INV 123')).toBe('INV-123');
    expect(normalizeClusterInvoiceNumber('')).toBeUndefined();
    expect(normalizeClusterInvoiceNumber(null)).toBeUndefined();
  });
});

describe('supplierNamesAgree', () => {
  it('treats a missing side as agreement', () => {
    expect(supplierNamesAgree(undefined, 'Acme')).toBe(true);
    expect(supplierNamesAgree('Acme', null)).toBe(true);
  });

  it('compares normalized names', () => {
    expect(supplierNamesAgree('Acme Corp.', 'acme corp')).toBe(true);
    expect(supplierNamesAgree('Acme', 'Globex')).toBe(false);
  });

  it('ignores legal suffixes and ampersands so one supplier is not split in two', () => {
    expect(supplierNamesAgree('Acme Inc', 'ACME Incorporated')).toBe(true);
    expect(supplierNamesAgree('The Acme Company, LLC', 'Acme')).toBe(true);
    expect(supplierNamesAgree('Smith & Sons Ltd', 'Smith and Sons')).toBe(true);
    expect(supplierNamesAgree('Acme Supply', 'Acme Services')).toBe(false);
  });
});

describe('clusterClassifiedAttachments', () => {
  it('merges invoice PDFs with the same invoice number', () => {
    const clustering = clusterClassifiedAttachments([
      classified({ fileName: 'invoice-p1.pdf', invoiceNumber: 'INV-100', supplierName: 'Acme' }),
      classified({ fileName: 'invoice-p2.pdf', invoiceNumber: 'inv-100', supplierName: 'Acme' }),
    ]);

    expect(clustering.clusters).toHaveLength(1);
    expect(clustering.clusters[0].primary.fileName).toBe('invoice-p1.pdf');
    expect(clustering.clusters[0].supporting.map((doc) => doc.fileName)).toEqual(['invoice-p2.pdf']);
    expect(clustering.clusters[0].superseded).toBeUndefined();
    expect(clustering.clusters[0].fallback).toBe(false);
    expect(clustering.unrelated).toHaveLength(0);
  });

  it('splits invoice PDFs with different invoice numbers', () => {
    const clustering = clusterClassifiedAttachments([
      classified({ fileName: 'a.pdf', invoiceNumber: 'INV-100', supplierName: 'Acme' }),
      classified({ fileName: 'b.pdf', invoiceNumber: 'INV-101', supplierName: 'Acme' }),
    ]);

    expect(clustering.clusters).toHaveLength(2);
    expect(clustering.clusters.map((cluster) => cluster.primary.fileName)).toEqual(['a.pdf', 'b.pdf']);
  });

  it('keeps invoice PDFs in separate clusters when the invoice number is missing', () => {
    const clustering = clusterClassifiedAttachments([
      classified({ fileName: 'a.pdf', supplierName: 'Acme' }),
      classified({ fileName: 'b.pdf', supplierName: 'Acme' }),
    ]);

    expect(clustering.clusters).toHaveLength(2);
  });

  it('keeps the same invoice number separate when suppliers disagree', () => {
    const clustering = clusterClassifiedAttachments([
      classified({ fileName: 'a.pdf', invoiceNumber: 'INV-100', supplierName: 'Acme' }),
      classified({ fileName: 'b.pdf', invoiceNumber: 'INV-100', supplierName: 'Globex' }),
    ]);

    expect(clustering.clusters).toHaveLength(2);
  });

  it('attaches supporting docs to the single invoice cluster', () => {
    const clustering = clusterClassifiedAttachments([
      classified({ fileName: 'invoice.pdf', invoiceNumber: 'INV-100', supplierName: 'Acme' }),
      classified({ fileName: 'packing.pdf', kind: 'supporting', supportingKind: 'packing_slip' }),
    ]);

    expect(clustering.clusters).toHaveLength(1);
    expect(clustering.clusters[0].supporting.map((doc) => doc.fileName)).toEqual(['packing.pdf']);
  });

  it('routes supporting docs by invoice number when several invoices exist', () => {
    const clustering = clusterClassifiedAttachments([
      classified({ fileName: 'a.pdf', invoiceNumber: 'INV-100', supplierName: 'Acme' }),
      classified({ fileName: 'b.pdf', invoiceNumber: 'INV-101', supplierName: 'Acme' }),
      classified({ fileName: 'pack-b.pdf', kind: 'supporting', invoiceNumber: 'INV-101' }),
    ]);

    expect(clustering.clusters).toHaveLength(2);
    expect(clustering.clusters[0].supporting).toHaveLength(0);
    expect(clustering.clusters[1].supporting.map((doc) => doc.fileName)).toEqual(['pack-b.pdf']);
  });

  it('routes supporting docs by PO when the invoice number is absent', () => {
    const clustering = clusterClassifiedAttachments([
      classified({ fileName: 'a.pdf', invoiceNumber: 'INV-100', purchaseOrderNumber: 'PO-413898' }),
      classified({ fileName: 'b.pdf', invoiceNumber: 'INV-101', purchaseOrderNumber: 'PO-413899' }),
      classified({ fileName: 'pack-a.pdf', kind: 'supporting', purchaseOrderNumber: 'PO-413898' }),
    ]);

    expect(clustering.clusters[0].supporting.map((doc) => doc.fileName)).toEqual(['pack-a.pdf']);
    expect(clustering.clusters[1].supporting).toHaveLength(0);
  });

  it('leaves unrelated docs off the invoice cluster', () => {
    const clustering = clusterClassifiedAttachments([
      classified({ fileName: 'invoice.pdf', invoiceNumber: 'INV-100' }),
      classified({ fileName: 'other.pdf', kind: 'unrelated', confidence: 0.8 }),
    ]);

    expect(clustering.clusters).toHaveLength(1);
    expect(clustering.clusters[0].supporting).toHaveLength(0);
    expect(clustering.unrelated.map((doc) => doc.fileName)).toEqual(['other.pdf']);
  });

  it('falls back to one cluster from the best guess when no invoice is identified', () => {
    const clustering = clusterClassifiedAttachments([
      classified({ fileName: 'pack.pdf', kind: 'supporting', confidence: 0.6 }),
      classified({ fileName: 'w9.pdf', kind: 'supporting', confidence: 0.9 }),
    ]);

    expect(clustering.clusters).toHaveLength(1);
    expect(clustering.clusters[0].fallback).toBe(true);
    expect(clustering.clusters[0].primary.fileName).toBe('w9.pdf');
    expect(clustering.clusters[0].supporting.map((doc) => doc.fileName)).toEqual(['pack.pdf']);
    expect(clustering.unrelated).toHaveLength(0);
  });

  it('prefers a supporting document over a confidently unrelated one in the fallback cluster', () => {
    const clustering = clusterClassifiedAttachments([
      classified({ fileName: 'marketing.pdf', kind: 'unrelated', confidence: 0.99 }),
      classified({ fileName: 'statement.pdf', kind: 'supporting', confidence: 0.6 }),
    ]);

    expect(clustering.clusters[0].fallback).toBe(true);
    expect(clustering.clusters[0].primary.fileName).toBe('statement.pdf');
  });

  it('still creates from unrelated-only attachments instead of dropping the conversation', () => {
    const clustering = clusterClassifiedAttachments([
      classified({ fileName: 'a.pdf', kind: 'unrelated', confidence: 0.4 }),
      classified({ fileName: 'b.pdf', kind: 'unrelated', confidence: 0.7 }),
    ]);

    expect(clustering.clusters).toHaveLength(1);
    expect(clustering.clusters[0].fallback).toBe(true);
    expect(clustering.clusters[0].primary.fileName).toBe('b.pdf');
  });

  it('uses the latest-received file as primary for same-invoice versions', () => {
    const clustering = clusterClassifiedAttachments([
      classified({ fileName: 'v1.pdf', invoiceNumber: 'INV-100', supplierName: 'Acme', receivedAt: 100 }),
      classified({ fileName: 'v2.pdf', invoiceNumber: 'INV-100', supplierName: 'Acme', receivedAt: 200 }),
    ]);

    expect(clustering.clusters).toHaveLength(1);
    expect(clustering.clusters[0].primary.fileName).toBe('v2.pdf');
    expect(clustering.clusters[0].supporting).toEqual([]);
    expect(clustering.clusters[0].superseded?.map((doc) => doc.fileName)).toEqual(['v1.pdf']);
  });

  it('treats files without receivedAt as older than timestamped versions', () => {
    const clustering = clusterClassifiedAttachments([
      classified({ fileName: 'new.pdf', invoiceNumber: 'INV-100', receivedAt: 200 }),
      classified({ fileName: 'old.pdf', invoiceNumber: 'INV-100' }),
    ]);

    expect(clustering.clusters[0].primary.fileName).toBe('new.pdf');
  });
});

describe('clusterClassifiedAttachments superseded copies', () => {
  const names = (files?: ClassifiedAttachment[]) => (files ?? []).map((doc) => doc.fileName);

  it('keeps same-message PDFs for one invoice, since they are pages and not versions', () => {
    const clustering = clusterClassifiedAttachments([
      classified({ fileName: 'p1.pdf', invoiceNumber: 'INV-100', receivedAt: 200, contentHash: 'a' }),
      classified({ fileName: 'p2.pdf', invoiceNumber: 'INV-100', receivedAt: 200, contentHash: 'b' }),
      classified({ fileName: 'p3.pdf', invoiceNumber: 'INV-100', contentHash: 'c' }),
      classified({ fileName: 'p4.pdf', invoiceNumber: 'INV-100', contentHash: 'd' }),
    ]);

    const [cluster] = clustering.clusters;
    expect(cluster.primary.fileName).toBe('p1.pdf');
    expect(names(cluster.supporting)).toEqual(['p2.pdf']);
    expect(names(cluster.superseded)).toEqual(['p3.pdf', 'p4.pdf']);
  });

  it('keeps same-message PDFs when no file has a receivedAt', () => {
    const clustering = clusterClassifiedAttachments([
      classified({ fileName: 'p1.pdf', invoiceNumber: 'INV-100', contentHash: 'a' }),
      classified({ fileName: 'p2.pdf', invoiceNumber: 'INV-100', contentHash: 'b' }),
    ]);

    expect(names(clustering.clusters[0].supporting)).toEqual(['p2.pdf']);
    expect(clustering.clusters[0].superseded).toBeUndefined();
  });

  it('drops older byte-identical supporting files, keeping the latest', () => {
    const clustering = clusterClassifiedAttachments([
      classified({ fileName: 'invoice.pdf', invoiceNumber: 'INV-100' }),
      classified({ fileName: 'slip-a.pdf', kind: 'supporting', receivedAt: 100, contentHash: 'abc' }),
      classified({ fileName: 'slip-b.pdf', kind: 'supporting', receivedAt: 200, contentHash: 'abc' }),
    ]);

    const [cluster] = clustering.clusters;
    expect(names(cluster.supporting)).toEqual(['slip-b.pdf']);
    expect(names(cluster.superseded)).toEqual(['slip-a.pdf']);
  });

  it('keeps different files that reuse a generic name', () => {
    const clustering = clusterClassifiedAttachments([
      classified({ fileName: 'invoice.pdf', invoiceNumber: 'INV-100' }),
      classified({ fileName: 'scan.pdf', kind: 'supporting', receivedAt: 100, contentHash: 'a' }),
      classified({ fileName: 'scan.pdf', kind: 'supporting', receivedAt: 200, contentHash: 'b' }),
    ]);

    const [cluster] = clustering.clusters;
    expect(names(cluster.supporting)).toEqual(['scan.pdf', 'scan.pdf']);
    expect(cluster.superseded).toBeUndefined();
  });

  it('lets the later position win a tie and treats a missing receivedAt as oldest', () => {
    const tie = clusterClassifiedAttachments([
      classified({ fileName: 'invoice.pdf', invoiceNumber: 'INV-100' }),
      classified({ fileName: 'w9.pdf', kind: 'supporting', receivedAt: 100, s3Key: 'k/first', contentHash: 'w' }),
      classified({ fileName: 'w9.pdf', kind: 'supporting', receivedAt: 100, s3Key: 'k/second', contentHash: 'w' }),
    ]);
    expect(tie.clusters[0].supporting.map((doc) => doc.s3Key)).toEqual(['k/second']);

    const missing = clusterClassifiedAttachments([
      classified({ fileName: 'invoice.pdf', invoiceNumber: 'INV-100' }),
      classified({ fileName: 'w9.pdf', kind: 'supporting', receivedAt: 100, s3Key: 'k/timed', contentHash: 'w' }),
      classified({ fileName: 'w9.pdf', kind: 'supporting', s3Key: 'k/untimed', contentHash: 'w' }),
    ]);
    expect(missing.clusters[0].supporting.map((doc) => doc.s3Key)).toEqual(['k/timed']);
  });

  it('does not dedupe across different invoice clusters', () => {
    const clustering = clusterClassifiedAttachments([
      classified({ fileName: 'Invoice.pdf', invoiceNumber: 'INV-100', supplierName: 'Acme', s3Key: 'k/a', contentHash: 'same' }),
      classified({ fileName: 'Invoice.pdf', invoiceNumber: 'INV-200', supplierName: 'Acme', s3Key: 'k/b', contentHash: 'same' }),
    ]);

    expect(clustering.clusters.map((cluster) => cluster.primary.s3Key)).toEqual(['k/a', 'k/b']);
    expect(clustering.clusters.every((cluster) => cluster.superseded === undefined)).toBe(true);
  });

  it('picks the fallback primary from the latest copies, never an older duplicate', () => {
    const clustering = clusterClassifiedAttachments([
      classified({ fileName: 'w9.pdf', kind: 'supporting', confidence: 0.9, receivedAt: 100, s3Key: 'k/old', contentHash: 'w' }),
      classified({ fileName: 'w9.pdf', kind: 'supporting', confidence: 0.5, receivedAt: 200, s3Key: 'k/new', contentHash: 'w' }),
      classified({ fileName: 'other.pdf', kind: 'supporting', confidence: 0.6, receivedAt: 150, s3Key: 'k/other', contentHash: 'o' }),
    ]);

    const [cluster] = clustering.clusters;
    expect(cluster.fallback).toBe(true);
    expect(cluster.primary.s3Key).toBe('k/other');
    expect(cluster.supporting.map((doc) => doc.s3Key)).toEqual(['k/new']);
    expect(cluster.superseded?.map((doc) => doc.s3Key)).toEqual(['k/old']);
  });
});

describe('clusterMaxReceivedAt', () => {
  it('returns the newest receivedAt and undefined when no file has one', () => {
    expect(clusterMaxReceivedAt([{ receivedAt: 100 }, {}, { receivedAt: 300 }])).toBe(300);
    expect(clusterMaxReceivedAt([{}, {}])).toBeUndefined();
    expect(clusterMaxReceivedAt([])).toBeUndefined();
  });
});

function parsedDoc(overrides: Record<string, unknown>) {
  return {
    fileNumber: 1,
    fileName: 'invoice.pdf',
    kind: 'supplier_invoice' as const,
    supportingKind: null,
    supplierName: 'Acme',
    invoiceNumber: 'INV-100',
    purchaseOrderNumber: null,
    invoiceDate: null,
    amountDue: null,
    confidence: 0.9,
    reason: 'test',
    ...overrides,
  };
}

describe('joinClassifications', () => {
  it('joins by fileNumber so repeated file names keep their own classification', () => {
    const joined = joinClassifications(
      [
        { s3Key: 'new-invoices/req-1/1-invoice.pdf', fileName: 'invoice.pdf', contentType: 'application/pdf' },
        { s3Key: 'new-invoices/req-1/2-invoice.pdf', fileName: 'invoice.pdf', contentType: 'application/pdf' },
      ],
      [
        parsedDoc({ fileNumber: 2, invoiceNumber: 'INV-200' }),
        parsedDoc({ fileNumber: 1, invoiceNumber: 'INV-100' }),
      ]
    );

    expect(joined[0].invoiceNumber).toBe('INV-100');
    expect(joined[1].invoiceNumber).toBe('INV-200');
    expect(clusterClassifiedAttachments(joined).clusters).toHaveLength(2);
  });

  it('treats a file the model skipped as supporting instead of a new invoice', () => {
    const joined = joinClassifications(
      [
        { s3Key: 'new-invoices/req-1/1-invoice.pdf', fileName: 'invoice.pdf', contentType: 'application/pdf' },
        { s3Key: 'new-invoices/req-1/2-w9.pdf', fileName: 'w9.pdf', contentType: 'application/pdf' },
      ],
      [parsedDoc({ fileNumber: 1 })]
    );

    expect(joined[1].kind).toBe('supporting');
    expect(joined[1].confidence).toBe(0);
    const clustering = clusterClassifiedAttachments(joined);
    expect(clustering.clusters).toHaveLength(1);
    expect(clustering.clusters[0].supporting.map((doc) => doc.fileName)).toEqual(['w9.pdf']);
  });

  it('falls back to a unique fileName when fileNumber is wrong', () => {
    const joined = joinClassifications(
      [
        { s3Key: 'new-invoices/req-1/1-a.pdf', fileName: 'a.pdf', contentType: 'application/pdf' },
        { s3Key: 'new-invoices/req-1/2-b.pdf', fileName: 'b.pdf', contentType: 'application/pdf' },
      ],
      [
        parsedDoc({ fileNumber: 7, fileName: 'b.pdf', kind: 'supporting' }),
        parsedDoc({ fileNumber: 7, fileName: 'a.pdf' }),
      ]
    );

    expect(joined[0].kind).toBe('supplier_invoice');
    expect(joined[1].kind).toBe('supporting');
  });

  it('joins model output back to S3 objects by fileName', () => {
    const joined = joinClassifications(
      [
        { s3Key: 'new-invoices/req-1/1-a.pdf', fileName: 'a.pdf', contentType: 'application/pdf' },
        { s3Key: 'new-invoices/req-1/2-b.pdf', fileName: 'b.pdf', contentType: 'application/pdf' },
      ],
      [
        {
          fileNumber: 2,
          fileName: 'b.pdf',
          kind: 'supporting',
          supportingKind: 'packing_slip',
          supplierName: null,
          invoiceNumber: 'INV-100',
          purchaseOrderNumber: null,
          invoiceDate: null,
          amountDue: null,
          confidence: 0.8,
          reason: 'Packing slip for INV-100',
        },
        {
          fileNumber: 1,
          fileName: 'a.pdf',
          kind: 'supplier_invoice',
          supportingKind: null,
          supplierName: 'Acme',
          invoiceNumber: 'INV-100',
          purchaseOrderNumber: null,
          invoiceDate: '2026-01-15',
          amountDue: '$100.00',
          confidence: 0.95,
          reason: 'Invoice with number and total',
        },
      ]
    );

    expect(joined[0].s3Key).toBe('new-invoices/req-1/1-a.pdf');
    expect(joined[0].kind).toBe('supplier_invoice');
    expect(joined[1].s3Key).toBe('new-invoices/req-1/2-b.pdf');
    expect(joined[1].kind).toBe('supporting');
  });
});

describe('parseAndClusterInvoiceAttachments', () => {
  it('forwards the abort signal to the classification AI call', async () => {
    const { signal } = new AbortController();
    mockGetAiResponse.mockRejectedValueOnce(new Error('stop after the AI call'));

    await expect(parseAndClusterInvoiceAttachments(
      [{ s3Key: 'new-invoices/req-1/a.pdf', fileName: 'a.pdf', contentType: 'application/pdf' }] as any,
      async () => Buffer.from('pdf'),
      { abortSignal: signal }
    )).rejects.toThrow('stop after the AI call');

    expect(mockGetAiResponse.mock.calls[0][0].abortSignal).toBe(signal);
  });

  it('shows Word and Excel files to the classifier as PDFs and keeps numbering for unreadable ones', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Hours').addRow(['Golfer', 'Hours']);
    const buffers: Record<string, Buffer> = {
      'new-invoices/req-1/1-invoice.pdf': Buffer.from('pdf'),
      'new-invoices/req-1/2-hours.xlsx': Buffer.from(await workbook.xlsx.writeBuffer()),
      'new-invoices/req-1/3-broken.docx': Buffer.from('not a docx'),
    };
    mockGetAiResponse.mockRejectedValueOnce(new Error('stop after the AI call'));

    await expect(parseAndClusterInvoiceAttachments(
      [
        { s3Key: 'new-invoices/req-1/1-invoice.pdf', fileName: 'invoice.pdf', contentType: 'application/pdf' },
        { s3Key: 'new-invoices/req-1/2-hours.xlsx', fileName: 'hours.xlsx', contentType: 'application/octet-stream' },
        {
          s3Key: 'new-invoices/req-1/3-broken.docx',
          fileName: 'broken.docx',
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
      ] as any,
      async (key) => buffers[key]
    )).rejects.toThrow('stop after the AI call');

    const content = (mockGetAiResponse.mock.calls[mockGetAiResponse.mock.calls.length - 1][0].messages[0] as any).content.slice(1);
    expect(content).toEqual([
      { type: 'file', data: Buffer.from('pdf'), mediaType: 'application/pdf', filename: '1-invoice.pdf' },
      { type: 'file', data: expect.any(Buffer), mediaType: 'application/pdf', filename: '2-hours.xlsx' },
      { type: 'text', text: '3-broken.docx: unreadable document (could not be opened)' },
    ]);
    expect(content[1].data.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('never lets an unreadable Word file be the invoice, whatever the model guessed from its name', async () => {
    const doc = (fileNumber: number, fileName: string, kind: 'supplier_invoice' | 'supporting') => ({
      fileNumber,
      fileName,
      kind,
      supportingKind: null,
      supplierName: null,
      invoiceNumber: null,
      purchaseOrderNumber: null,
      invoiceDate: null,
      amountDue: null,
      confidence: 0.9,
      reason: 'guess',
    });
    mockGetAiResponse.mockResolvedValueOnce({
      documents: [doc(1, '1-Invoice 1042.docx', 'supplier_invoice'), doc(2, '2-invoice.pdf', 'supplier_invoice')],
    } as any);
    const buffers: Record<string, Buffer> = {
      'new-invoices/req-1/1-Invoice 1042.docx': Buffer.from('not a docx'),
      'new-invoices/req-1/2-invoice.pdf': Buffer.from('pdf'),
    };

    const { clustering, classified } = await parseAndClusterInvoiceAttachments(
      [
        {
          s3Key: 'new-invoices/req-1/1-Invoice 1042.docx',
          fileName: 'Invoice 1042.docx',
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
        { s3Key: 'new-invoices/req-1/2-invoice.pdf', fileName: 'invoice.pdf', contentType: 'application/pdf' },
      ] as any,
      async (key) => buffers[key]
    );

    expect(classified[0]).toMatchObject({ fileName: 'Invoice 1042.docx', kind: 'supporting', reason: 'Document could not be opened' });
    expect(classified[1]).toMatchObject({ fileName: 'invoice.pdf', kind: 'supplier_invoice' });
    expect(clustering.clusters.map((cluster) => cluster.primary.fileName)).toEqual(['invoice.pdf']);
  });

  it('hashes file bytes so identical resends under different names are superseded', async () => {
    const doc = (fileNumber: number, fileName: string, kind: 'supplier_invoice' | 'supporting') => ({
      fileNumber,
      fileName,
      kind,
      supportingKind: null,
      supplierName: 'Acme',
      invoiceNumber: 'INV-100',
      purchaseOrderNumber: null,
      invoiceDate: null,
      amountDue: null,
      confidence: 0.9,
      reason: 'test',
    });
    mockGetAiResponse.mockResolvedValueOnce({
      documents: [doc(1, '1-invoice.pdf', 'supplier_invoice'), doc(2, '2-slip.pdf', 'supporting'), doc(3, '3-slip-copy.pdf', 'supporting')],
    } as any);
    const buffers: Record<string, Buffer> = {
      'k/1': Buffer.from('invoice'),
      'k/2': Buffer.from('slip'),
      'k/3': Buffer.from('slip'),
    };

    const { clustering } = await parseAndClusterInvoiceAttachments(
      [
        { s3Key: 'k/1', fileName: 'invoice.pdf', contentType: 'application/pdf', receivedAt: 100 },
        { s3Key: 'k/2', fileName: 'slip.pdf', contentType: 'application/pdf', receivedAt: 110 },
        { s3Key: 'k/3', fileName: 'slip-copy.pdf', contentType: 'application/pdf', receivedAt: 120 },
      ] as any,
      async (key) => buffers[key]
    );

    expect(clustering.clusters[0].supporting.map((file) => file.fileName)).toEqual(['slip-copy.pdf']);
    expect(clustering.clusters[0].superseded?.map((file) => file.fileName)).toEqual(['slip.pdf']);
  });
});
