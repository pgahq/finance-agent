jest.mock('@pga/logger', () => ({ debug: jest.fn() }));
jest.mock('../lib/ai.js', () => ({ getAiResponse: jest.fn() }));
jest.mock('../lib/invoice_ocr.js', () => ({
  ...jest.requireActual('../lib/invoice_ocr.js'),
  extractInvoiceDocuments: jest.fn(),
}));
jest.mock('../lib/database.js', () => ({
  getDatabaseConnection: jest.fn(),
  findDocumentsContainingWords: jest.fn(),
}));

import { findDocumentsContainingWords, getDatabaseConnection } from '../lib/database.js';
import { getAiResponse } from '../lib/ai.js';
import { extractInvoiceDocuments } from '../lib/invoice_ocr.js';
import { enrichInvoiceFromAttachments, resolveSupplierByNameEvidence, formatSupplierNotes } from '../lib/invoice_enrichment.js';
import type { InvoiceEnrichmentResult } from '../prompts/enrich_invoice_prompt.js';

const findDocuments = findDocumentsContainingWords as jest.Mock;
const connect = getDatabaseConnection as jest.Mock;

const REMIT_TO = 'SiteOne Landscape Supply, LLC, 24110 Network Place, Chicago, IL 60673-1241';

const siteOne = {
  workday_id: 'wid-siteone',
  content: 'Company Name: SITEONE LANDSCAPE SUPPLY LLC\nSupplier ID: S-021845\nAlternate Names: ALL PRO HORTICULTURE',
  metadata: { supplierName: 'SITEONE LANDSCAPE SUPPLY LLC', supplierId: 'S-021845' },
};

function notFound(status: InvoiceEnrichmentResult['supplier']['status'] = 'not_found'): InvoiceEnrichmentResult {
  return {
    supplier: {
      status,
      confidence: 0.62,
      extractedInformation: {
        supplierName: 'Lindenhurst NY - All Pro Horticulture #433',
        address: '80 E Gates Ave, Lindenhurst, NY 11757-5037',
        phone: '(631)789-6680',
        email: null,
        taxId: null,
        website: null,
        industry: null,
        contactPerson: null,
        memo: null,
      },
      resolvedSupplier: null,
      potentialDuplicateSuppliers: null,
      recommendation: { action: 'register_supplier', reason: 'No confirmed match' },
      reason: 'Branch address and phone are not on the record.',
    },
  } as unknown as InvoiceEnrichmentResult;
}

beforeEach(() => {
  findDocuments.mockReset().mockResolvedValue([siteOne]);
  connect.mockReset().mockResolvedValue({});
  delete process.env.WORKDAY_DEFAULT_SUPPLIER_WID;
});

describe('resolveSupplierByNameEvidence', () => {
  it('upgrades not_found to found for a unique remit-to and alternate-name match', async () => {
    const result = await resolveSupplierByNameEvidence(notFound(), REMIT_TO);

    expect(result.supplier.status).toBe('found');
    expect(result.supplier.confidence).toBe(0.85);
    expect(result.supplier.resolvedSupplier).toMatchObject({ workdayId: 'wid-siteone', supplierName: 'SITEONE LANDSCAPE SUPPLY LLC' });
    expect(result.supplier.recommendation.action).toBe('update_invoice');
    expect(result.supplier.extractedInformation.supplierName).toBe('Lindenhurst NY - All Pro Horticulture #433');
    const notes = formatSupplierNotes(result);
    expect(notes).toContain('S-021845 SITEONE LANDSCAPE SUPPLY LLC');
    expect(notes).toContain('Branch address and phone are not on the record.');
  });

  it('keeps not_found when two suppliers match', async () => {
    findDocuments.mockResolvedValue([
      siteOne,
      { workday_id: 'wid-twin', content: 'Company Name: SITEONE LANDSCAPE SUPPLY INC', metadata: { supplierName: 'SITEONE LANDSCAPE SUPPLY INC' } },
    ]);
    const original = notFound();

    expect(await resolveSupplierByNameEvidence(original, REMIT_TO)).toBe(original);
  });

  it.each(['ambiguous', 'found', 'uncertain', 'error'] as const)('leaves a %s result alone', async (status) => {
    const original = notFound(status);

    expect(await resolveSupplierByNameEvidence(original, REMIT_TO)).toBe(original);
    expect(connect).not.toHaveBeenCalled();
  });

  it('keeps not_found when the supplier cache lookup fails', async () => {
    findDocuments.mockRejectedValue(new Error('db down'));
    const original = notFound();

    expect(await resolveSupplierByNameEvidence(original, REMIT_TO)).toBe(original);
  });

  it('never resolves to the default supplier', async () => {
    process.env.WORKDAY_DEFAULT_SUPPLIER_WID = 'wid-siteone';
    const original = notFound();

    expect(await resolveSupplierByNameEvidence(original, REMIT_TO)).toBe(original);
  });
});

describe('enrichInvoiceFromAttachments supplier name check', () => {
  const ocr = {
    printedSupplier: {
      supplierName: 'Lindenhurst NY - All Pro Horticulture #433',
      address: '80 E Gates Ave, Lindenhurst, NY 11757-5037',
      phone: '(631)789-6680',
      email: null,
      taxId: null,
      website: null,
      industry: null,
      contactPerson: null,
      memo: null,
      remitToAddress: REMIT_TO,
    },
    printedBillTo: { companyName: 'PGA Tournament Corporation, Inc', address: null, phone: null, email: null },
    extractedOtherCharges: null,
    extractedPaymentTerms: null,
    extractedInvoiceLines: null,
  };
  const matching = {
    supplier: { ...notFound().supplier, extractedInformation: {} },
    companyVerification: { status: 'matching', confidence: 0.9, extractedInformation: {}, recommended: null, reason: 'ok' },
    emailSummary: null,
    extractedPaymentTerms: null,
    emailWorktags: null,
    emailBudgetSplits: null,
  };

  beforeEach(() => {
    (extractInvoiceDocuments as jest.Mock).mockReset().mockResolvedValue(ocr);
    (getAiResponse as jest.Mock).mockReset().mockResolvedValue(matching);
  });

  it('resolves the logged SiteOne invoice to S-021845 when no supplier is assigned', async () => {
    const result = await enrichInvoiceFromAttachments({} as never, []);

    expect(result.supplier.status).toBe('found');
    expect(result.supplier.resolvedSupplier?.workdayId).toBe('wid-siteone');
  });

  it('does not run the name check when a supplier is already assigned', async () => {
    const result = await enrichInvoiceFromAttachments({} as never, [], { descriptor: 'Current Supplier', id: 'wid-current' });

    expect(result.supplier.status).toBe('not_found');
    expect(findDocuments).not.toHaveBeenCalled();
  });
});
