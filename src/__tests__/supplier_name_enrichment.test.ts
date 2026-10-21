jest.mock('@pga/logger', () => ({ debug: jest.fn() }));
jest.mock('../lib/ai.js', () => ({ getAiResponse: jest.fn() }));
jest.mock('../lib/invoice_ocr.js', () => ({
  ...jest.requireActual('../lib/invoice_ocr.js'),
  extractInvoiceDocuments: jest.fn(),
}));
jest.mock('../lib/database.js', () => ({
  getDatabaseConnection: jest.fn(),
  findDocumentsContainingWords: jest.fn(),
  findSuppliersByNameWord: jest.fn(),
}));
jest.mock('../lib/rag.js', () => ({
  ...jest.requireActual('../lib/rag.js'),
  queryDocuments: jest.fn(),
}));

import { findDocumentsContainingWords, findSuppliersByNameWord, getDatabaseConnection } from '../lib/database.js';
import { queryDocuments } from '../lib/rag.js';
import { getAiResponse } from '../lib/ai.js';
import { extractInvoiceDocuments } from '../lib/invoice_ocr.js';
import { enrichInvoiceFromAttachments, resolveSupplierByNameEvidence, formatSupplierNotes } from '../lib/invoice_enrichment.js';
import type { InvoiceEnrichmentResult } from '../prompts/enrich_invoice_prompt.js';

const findDocuments = findDocumentsContainingWords as jest.Mock;
const connect = getDatabaseConnection as jest.Mock;
const findByWord = findSuppliersByNameWord as jest.Mock;
const nameSearch = queryDocuments as jest.Mock;

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
  findByWord.mockReset().mockResolvedValue([]);
  nameSearch.mockReset().mockResolvedValue([]);
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

describe('resolveSupplierByNameEvidence distinctive word and candidates', () => {
  const masekRow = {
    workday_id: 'wid-masek',
    content: 'Company Name: MASEK GOLF CARS ALBUQUERQUE\nSupplier ID: S-030001\nAddress: 100 Other Rd, Santa Fe, NM',
    metadata: { supplierName: 'MASEK GOLF CARS ALBUQUERQUE', supplierId: 'S-030001' },
  };
  const gcsa = {
    workday_id: 'wid-gcsa',
    type: 'supplier',
    content: 'Company Name: ROCKY MOUNTAIN GOLF COURSE SUPERINTENDENTS ASSOCIATION\nSupplier ID: S-020312',
    metadata: { supplierName: 'ROCKY MOUNTAIN GOLF COURSE SUPERINTENDENTS ASSOCIATION', supplierId: 'S-020312' },
    similarity: 0.71,
  };

  function masekNotFound(): InvoiceEnrichmentResult {
    const base = notFound();
    return {
      ...base,
      supplier: {
        ...base.supplier,
        confidence: 0.26,
        extractedInformation: {
          ...base.supplier.extractedInformation,
          supplierName: 'MASEK ROCKY MOUNTAIN GOLF CARS',
          address: '5225 Pino Ave. NE, Albuquerque, NM 87109',
          phone: '505-452-2222',
        },
        reason: 'The closest Masek record does not match the printed supplier name, address, or phone.',
      },
    } as InvoiceEnrichmentResult;
  }

  beforeEach(() => {
    findDocuments.mockResolvedValue([]);
  });

  it('resolves SUPIN-470327 to the one supplier with the distinctive word MASEK', async () => {
    findByWord.mockImplementation(async (_db: unknown, word: string) => (word === 'masek' ? [masekRow] : []));

    const result = await resolveSupplierByNameEvidence(masekNotFound(), null);

    expect(result.supplier.status).toBe('found');
    expect(result.supplier.confidence).toBe(0.8);
    expect(result.supplier.resolvedSupplier).toMatchObject({ workdayId: 'wid-masek', supplierName: 'MASEK GOLF CARS ALBUQUERQUE' });
    expect(result.supplier.recommendation.action).toBe('update_invoice');
    const notes = formatSupplierNotes(result);
    expect(notes).toContain('S-030001 MASEK GOLF CARS ALBUQUERQUE');
    expect(notes).toContain('"MASEK"');
    expect(notes).toContain('The closest Masek record does not match');
    expect(nameSearch).not.toHaveBeenCalled();
  });

  it('prefers the exact name or alternate name match over the distinctive word', async () => {
    findDocuments.mockResolvedValue([siteOne]);

    const result = await resolveSupplierByNameEvidence(notFound(), REMIT_TO);

    expect(result.supplier.confidence).toBe(0.85);
    expect(findByWord).not.toHaveBeenCalled();
  });

  it('lists the name-search candidates and keeps not_found when only common words match', async () => {
    nameSearch.mockResolvedValue([gcsa]);
    const original = masekNotFound();
    original.supplier.extractedInformation.supplierName = 'Rocky Mountain Golf Cars';

    const result = await resolveSupplierByNameEvidence(original, null);

    expect(result.supplier.status).toBe('not_found');
    expect(result.supplier.resolvedSupplier).toBeNull();
    expect(findByWord).not.toHaveBeenCalled();
    const notes = formatSupplierNotes(result);
    expect(notes).toContain('The closest Masek record does not match');
    expect(notes).toContain('Possible Workday suppliers the agent did not apply');
    expect(notes).toContain('S-020312 ROCKY MOUNTAIN GOLF COURSE SUPERINTENDENTS ASSOCIATION');
    expect(nameSearch).toHaveBeenCalledWith(expect.objectContaining({ query: 'Rocky Mountain Golf Cars', documentType: 'supplier' }));
  });

  it('lists every supplier that shares the distinctive word and picks none', async () => {
    const twin = { ...masekRow, workday_id: 'wid-masek-2', content: 'Company Name: MASEK ELECTRIC\nSupplier ID: S-030002', metadata: { supplierName: 'MASEK ELECTRIC', supplierId: 'S-030002' } };
    findByWord.mockImplementation(async (_db: unknown, word: string) => (word === 'masek' ? [masekRow, twin] : []));

    const result = await resolveSupplierByNameEvidence(masekNotFound(), null);

    expect(result.supplier.status).toBe('not_found');
    const notes = formatSupplierNotes(result);
    expect(notes).toContain('S-030001 MASEK GOLF CARS ALBUQUERQUE (name has "MASEK")');
    expect(notes).toContain('S-030002 MASEK ELECTRIC (name has "MASEK")');
  });

  it('lists a name-search hit once when the word lookup found the same supplier', async () => {
    const twin = { ...masekRow, workday_id: 'wid-masek-2', content: 'Company Name: MASEK ELECTRIC\nSupplier ID: S-030002', metadata: { supplierName: 'MASEK ELECTRIC', supplierId: 'S-030002' } };
    findByWord.mockImplementation(async (_db: unknown, word: string) => (word === 'masek' ? [masekRow, twin] : []));
    nameSearch.mockResolvedValue([{ ...masekRow, type: 'supplier', similarity: 0.9 }]);

    const notes = formatSupplierNotes(await resolveSupplierByNameEvidence(masekNotFound(), null));

    expect(notes.match(/S-030001/g)).toHaveLength(1);
  });

  it('never lists or picks the default supplier', async () => {
    process.env.WORKDAY_DEFAULT_SUPPLIER_WID = 'wid-masek';
    findByWord.mockResolvedValue([masekRow]);
    nameSearch.mockResolvedValue([{ ...masekRow, type: 'supplier', similarity: 0.9 }]);
    const original = masekNotFound();

    expect(await resolveSupplierByNameEvidence(original, null)).toBe(original);
  });

  it('keeps the model result when nothing is close', async () => {
    const original = masekNotFound();

    expect(await resolveSupplierByNameEvidence(original, null)).toBe(original);
  });

  it('still lists the word matches when the name-only search fails', async () => {
    const twin = { ...masekRow, workday_id: 'wid-masek-2', content: 'Company Name: MASEK ELECTRIC\nSupplier ID: S-030002', metadata: { supplierName: 'MASEK ELECTRIC', supplierId: 'S-030002' } };
    findByWord.mockImplementation(async (_db: unknown, word: string) => (word === 'masek' ? [masekRow, twin] : []));
    nameSearch.mockRejectedValue(new Error('embedding down'));

    const notes = formatSupplierNotes(await resolveSupplierByNameEvidence(masekNotFound(), null));

    expect(notes).toContain('S-030001');
    expect(notes).toContain('S-030002');
  });

  it('keeps not_found when the word lookup fails', async () => {
    findByWord.mockRejectedValue(new Error('db down'));
    const original = masekNotFound();

    expect(await resolveSupplierByNameEvidence(original, null)).toBe(original);
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
