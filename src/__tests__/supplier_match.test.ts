jest.mock('@pga/logger', () => ({ debug: jest.fn() }));
jest.mock('../lib/database.js', () => ({
  findDocumentsContainingWords: jest.fn(),
}));

import { findDocumentsContainingWords } from '../lib/database.js';
import {
  SUPPLIER_CANDIDATE_LIMIT,
  findUniqueSupplierByNameEvidence,
  matchSuppliersByName,
  printedSupplierNameCandidates,
  remitToCompanyName,
  supplierRecordFromDocument,
} from '../lib/supplier_match.js';

const findDocuments = findDocumentsContainingWords as jest.Mock;

const SITEONE_CONTENT = [
  'Company Name: SITEONE LANDSCAPE SUPPLY LLC',
  'Supplier ID: S-021845',
  'Alternate Names: ALL PRO HORTICULTURE',
  'Status: Active',
].join('\n');

const siteOne = {
  workday_id: 'wid-siteone',
  content: SITEONE_CONTENT,
  metadata: { supplierName: 'SITEONE LANDSCAPE SUPPLY LLC', supplierId: 'S-021845' },
};

const REMIT_TO = 'SiteOne Landscape Supply, LLC, 24110 Network Place, Chicago, IL 60673-1241';
const PRINTED = 'Lindenhurst NY - All Pro Horticulture #433';

const db = {} as never;

beforeEach(() => {
  findDocuments.mockReset();
});

describe('supplierRecordFromDocument', () => {
  it('reads exact lists from metadata when cached', () => {
    const record = supplierRecordFromDocument({
      content: SITEONE_CONTENT,
      metadata: {
        supplierName: 'SITEONE LANDSCAPE SUPPLY LLC',
        supplierId: 'S-021845',
        alternateNames: ['ALL PRO HORTICULTURE', 'SiteOne Landscape Supply, LLC'],
        addresses: ['24110 Network Place, Chicago, IL'],
        phones: ['+1 (800) 555 0100'],
        emails: [],
      },
    });
    expect(record).toEqual({
      supplierId: 'S-021845',
      supplierName: 'SITEONE LANDSCAPE SUPPLY LLC',
      alternateNames: ['ALL PRO HORTICULTURE', 'SiteOne Landscape Supply, LLC'],
      addresses: ['24110 Network Place, Chicago, IL'],
      phones: ['+1 (800) 555 0100'],
      emails: [],
    });
  });

  it('falls back to the content lines for rows cached before the lists shipped', () => {
    const record = supplierRecordFromDocument({
      content: `${SITEONE_CONTENT}\nPhone: +1 (800) 555 0100\nAddress: 24110 Network Place, Chicago, IL`,
      metadata: { supplierName: 'SITEONE LANDSCAPE SUPPLY LLC' },
    });
    expect(record.supplierId).toBe('S-021845');
    expect(record.alternateNames).toEqual(['ALL PRO HORTICULTURE']);
    expect(record.phones).toEqual(['+1 (800) 555 0100']);
    expect(record.addresses).toEqual(['24110 Network Place, Chicago, IL']);
  });
});

describe('printedSupplierNameCandidates', () => {
  it('drops the store number and the city label from a branch name', () => {
    expect(printedSupplierNameCandidates(PRINTED)).toEqual(['All Pro Horticulture', 'Lindenhurst NY - All Pro Horticulture']);
  });

  it('keeps a plain single-segment name even when it ends in two capitals', () => {
    expect(printedSupplierNameCandidates('Smith Landscape IT')).toEqual(['Smith Landscape IT']);
  });

  it('does not split a name on a dash when no part is a location label', () => {
    expect(printedSupplierNameCandidates('Pinehurst Resort - Pro Shop')).toEqual(['Pinehurst Resort - Pro Shop']);
    expect(printedSupplierNameCandidates('Golf Course Maintenance | Turf Care')).toEqual(['Golf Course Maintenance | Turf Care']);
  });

  it('returns nothing for an empty name', () => {
    expect(printedSupplierNameCandidates(null)).toEqual([]);
    expect(printedSupplierNameCandidates('  ')).toEqual([]);
  });
});

describe('remitToCompanyName', () => {
  it('takes the company name that leads the remit-to block', () => {
    expect(remitToCompanyName(REMIT_TO)).toBe('SiteOne Landscape Supply, LLC');
  });

  it('does not mistake a bare city for the payee name', () => {
    expect(remitToCompanyName('New York, NY 10001')).toBeUndefined();
    expect(remitToCompanyName('Riviera Finance of Texas, PO Box 202485, Dallas TX')).toBe('Riviera Finance of Texas');
  });

  it.each([
    ['a PO Box only', 'PO Box 100, Miami, FL 33101'],
    ['a street only', '24110 Network Place, Chicago, IL'],
    ['empty', ''],
  ])('returns nothing for %s', (_label, address) => {
    expect(remitToCompanyName(address)).toBeUndefined();
  });
});

describe('matchSuppliersByName', () => {
  it('matches the remit-to company by name and the printed branch by alternate name', () => {
    const matches = matchSuppliersByName(
      [
        { source: 'remit_to', name: 'SiteOne Landscape Supply, LLC' },
        { source: 'printed', name: 'All Pro Horticulture' },
      ],
      [siteOne]
    );
    expect([...matches.keys()]).toEqual(['wid-siteone']);
    expect(matches.get('wid-siteone')?.evidence).toEqual([
      'remit-to company "SiteOne Landscape Supply, LLC" matches supplier name "SITEONE LANDSCAPE SUPPLY LLC"',
      'printed name "All Pro Horticulture" matches alternate name "ALL PRO HORTICULTURE"',
    ]);
  });

  it('does not match a near-miss name', () => {
    const matches = matchSuppliersByName(
      [{ source: 'remit_to', name: 'SiteOne Turf Supply' }],
      [siteOne]
    );
    expect(matches.size).toBe(0);
  });

  it('does not match a one-word name', () => {
    const golf = { workday_id: 'wid-golf', content: 'Company Name: Golf', metadata: { supplierName: 'Golf' } };
    expect(matchSuppliersByName([{ source: 'printed', name: 'Golf' }], [golf]).size).toBe(0);
  });
});

describe('findUniqueSupplierByNameEvidence', () => {
  it('finds S-021845 for the SiteOne branch invoice', async () => {
    findDocuments.mockResolvedValue([siteOne]);

    const match = await findUniqueSupplierByNameEvidence(db, { printedName: PRINTED, remitToAddress: REMIT_TO });

    expect(match).toMatchObject({ workdayId: 'wid-siteone', supplierId: 'S-021845', supplierName: 'SITEONE LANDSCAPE SUPPLY LLC' });
    expect(match?.evidence).toHaveLength(2);
    expect(findDocuments).toHaveBeenCalledWith(db, 'supplier', expect.arrayContaining(['siteone', 'landscape', 'supply']), SUPPLIER_CANDIDATE_LIMIT);
    expect(findDocuments).toHaveBeenCalledWith(db, 'supplier', expect.arrayContaining(['all', 'pro', 'horticulture']), SUPPLIER_CANDIDATE_LIMIT);
  });

  it('matches on the alternate name alone when the remit-to names no company', async () => {
    findDocuments.mockResolvedValue([siteOne]);

    const match = await findUniqueSupplierByNameEvidence(db, { printedName: PRINTED, remitToAddress: 'PO Box 100, Chicago, IL' });

    expect(match?.workdayId).toBe('wid-siteone');
  });

  it('matches on the remit-to company alone when the printed name shares a word with the record', async () => {
    findDocuments.mockResolvedValue([siteOne]);

    const match = await findUniqueSupplierByNameEvidence(db, { printedName: 'SiteOne Field Depot #12', remitToAddress: REMIT_TO });

    expect(match?.workdayId).toBe('wid-siteone');
    expect(match?.sources).toEqual(['remit_to']);
  });

  it('does not let a factoring company payee claim an unrelated vendor invoice', async () => {
    const factor = {
      workday_id: 'wid-factor',
      content: 'Company Name: RIVIERA FINANCE OF TEXAS',
      metadata: { supplierName: 'RIVIERA FINANCE OF TEXAS' },
    };
    findDocuments.mockResolvedValue([factor]);

    const match = await findUniqueSupplierByNameEvidence(db, {
      printedName: 'Bethpage Field Depot #12',
      remitToAddress: 'Riviera Finance of Texas, PO Box 202485, Dallas TX',
    });

    expect(match).toBeUndefined();
  });

  it('counts a second remit-to match before the shared-word check', async () => {
    const twin = { workday_id: 'wid-twin', content: 'Company Name: SITEONE LANDSCAPE SUPPLY INC', metadata: { supplierName: 'SITEONE LANDSCAPE SUPPLY INC' } };
    findDocuments.mockResolvedValue([siteOne, twin]);

    expect(await findUniqueSupplierByNameEvidence(db, { printedName: 'SiteOne Field Depot #12', remitToAddress: REMIT_TO })).toBeUndefined();
  });

  it('does not match a remit-to only match when no supplier name is printed', async () => {
    findDocuments.mockResolvedValue([siteOne]);

    expect(await findUniqueSupplierByNameEvidence(db, { printedName: null, remitToAddress: REMIT_TO })).toBeUndefined();
  });

  it('does not match a generic part of a non-branch name on its own', async () => {
    const proShop = { workday_id: 'wid-proshop', content: 'Company Name: THE PRO SHOP LLC', metadata: { supplierName: 'THE PRO SHOP LLC' } };
    findDocuments.mockResolvedValue([proShop]);

    const match = await findUniqueSupplierByNameEvidence(db, { printedName: 'Pinehurst Resort - Pro Shop', remitToAddress: null });

    expect(match).toBeUndefined();
  });

  it('treats a full candidate page as ambiguous', async () => {
    findDocuments.mockResolvedValue(Array.from({ length: SUPPLIER_CANDIDATE_LIMIT }, (_, index) => (
      index === 0 ? siteOne : { workday_id: `wid-${index}`, content: 'Company Name: UNRELATED', metadata: { supplierName: 'UNRELATED' } }
    )));

    expect(await findUniqueSupplierByNameEvidence(db, { printedName: PRINTED, remitToAddress: REMIT_TO })).toBeUndefined();
    expect(findDocuments).toHaveBeenCalledWith(db, 'supplier', expect.any(Array), SUPPLIER_CANDIDATE_LIMIT);
  });

  it('stays unmatched when the remit-to and the printed name point at different suppliers', async () => {
    const otherSupplier = {
      workday_id: 'wid-other',
      content: 'Company Name: ACME PRO TURF\nAlternate Names: ALL PRO HORTICULTURE',
      metadata: { supplierName: 'ACME PRO TURF' },
    };
    findDocuments.mockResolvedValue([siteOne, otherSupplier]);

    const match = await findUniqueSupplierByNameEvidence(db, { printedName: PRINTED, remitToAddress: REMIT_TO });

    expect(match).toBeUndefined();
  });

  it('stays unmatched when two suppliers share the matching alternate name', async () => {
    const duplicate = {
      workday_id: 'wid-duplicate',
      content: 'Company Name: SITEONE LANDSCAPE SUPPLY INC\nAlternate Names: ALL PRO HORTICULTURE',
      metadata: { supplierName: 'SITEONE LANDSCAPE SUPPLY INC' },
    };
    findDocuments.mockResolvedValue([siteOne, duplicate]);

    expect(await findUniqueSupplierByNameEvidence(db, { printedName: PRINTED, remitToAddress: null })).toBeUndefined();
  });

  it('never matches on a shared remit-to street', async () => {
    const lockboxNeighbor = {
      workday_id: 'wid-neighbor',
      content: 'Company Name: OTHER VENDOR LLC\nAddress: 24110 Network Place, Chicago, IL 60673',
      metadata: { supplierName: 'OTHER VENDOR LLC' },
    };
    findDocuments.mockResolvedValue([lockboxNeighbor]);

    expect(await findUniqueSupplierByNameEvidence(db, { printedName: 'Unrelated Mulch Co', remitToAddress: '24110 Network Place, Chicago, IL' })).toBeUndefined();
  });

  it('skips the default supplier', async () => {
    findDocuments.mockResolvedValue([siteOne]);

    const match = await findUniqueSupplierByNameEvidence(db, {
      printedName: PRINTED,
      remitToAddress: REMIT_TO,
      excludeWorkdayIds: ['wid-siteone'],
    });

    expect(match).toBeUndefined();
  });

  it('does not query when there is no usable name evidence', async () => {
    const match = await findUniqueSupplierByNameEvidence(db, { printedName: 'Golf', remitToAddress: 'PO Box 1, Miami, FL' });

    expect(match).toBeUndefined();
    expect(findDocuments).not.toHaveBeenCalled();
  });
});
