import {
  clusterClassifiedAttachments,
  clusterMaxReceivedAt,
  isInvoiceAttachmentClusteringEnabled,
  joinClassifications,
  normalizeClusterInvoiceNumber,
  supplierNamesAgree,
  type ClassifiedAttachment,
} from '../lib/invoice_attachment_clustering.js';

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
    expect(isInvoiceAttachmentClusteringEnabled({ INVOICE_ATTACHMENT_CLUSTERING_ENABLED: 'false' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isInvoiceAttachmentClusteringEnabled({ INVOICE_ATTACHMENT_CLUSTERING_ENABLED: 'true' } as NodeJS.ProcessEnv)).toBe(true);
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
    expect(clustering.clusters[0].supporting.map((doc) => doc.fileName)).toEqual(['v1.pdf']);
  });

  it('treats files without receivedAt as older than timestamped versions', () => {
    const clustering = clusterClassifiedAttachments([
      classified({ fileName: 'new.pdf', invoiceNumber: 'INV-100', receivedAt: 200 }),
      classified({ fileName: 'old.pdf', invoiceNumber: 'INV-100' }),
    ]);

    expect(clustering.clusters[0].primary.fileName).toBe('new.pdf');
  });
});

describe('clusterMaxReceivedAt', () => {
  it('returns the newest receivedAt and undefined when no file has one', () => {
    expect(clusterMaxReceivedAt([{ receivedAt: 100 }, {}, { receivedAt: 300 }])).toBe(300);
    expect(clusterMaxReceivedAt([{}, {}])).toBeUndefined();
    expect(clusterMaxReceivedAt([])).toBeUndefined();
  });
});

describe('joinClassifications', () => {
  it('joins model output back to S3 objects by fileName', () => {
    const joined = joinClassifications(
      [
        { s3Key: 'new-invoices/req-1/1-a.pdf', fileName: 'a.pdf', contentType: 'application/pdf' },
        { s3Key: 'new-invoices/req-1/2-b.pdf', fileName: 'b.pdf', contentType: 'application/pdf' },
      ],
      [
        {
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
