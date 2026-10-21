jest.mock('@pga/logger', () => ({ debug: jest.fn() }));
jest.mock('../lib/database.js', () => ({
  findDocumentsContainingWords: jest.fn(),
  findSuppliersByNameWord: jest.fn(),
}));

import { findDocumentsContainingWords, findSuppliersByNameWord } from '../lib/database.js';
import {
  DISTINCTIVE_WORD_SUPPLIER_LIMIT,
  MAX_DISTINCTIVE_WORDS,
  SUPPLIER_CANDIDATE_LIMIT,
  distinctiveNameWords,
  findSupplierByDistinctiveWord,
  findUniqueSupplierByNameEvidence,
  matchSuppliersByName,
  printedSupplierNameCandidates,
  remitToCompanyName,
  supplierRecordFromDocument,
} from '../lib/supplier_match.js';

const findDocuments = findDocumentsContainingWords as jest.Mock;
const findByWord = findSuppliersByNameWord as jest.Mock;

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
  findByWord.mockReset().mockResolvedValue([]);
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

function supplierRow(workdayId: string, supplierName: string, supplierId: string, alternateNames: string[] = []) {
  return {
    workday_id: workdayId,
    content: [`Company Name: ${supplierName}`, `Supplier ID: ${supplierId}`, ...(alternateNames.length ? [`Alternate Names: ${alternateNames.join(', ')}`] : [])].join('\n'),
    metadata: { supplierName, supplierId, alternateNames },
  };
}

function wordIndex(index: Record<string, Array<ReturnType<typeof supplierRow>>>) {
  findByWord.mockImplementation(async (_db: unknown, word: string) => index[word] ?? []);
}

const MASEK = 'MASEK ROCKY MOUNTAIN GOLF CARS';
const masek = supplierRow('wid-masek', 'MASEK GOLF CARS ALBUQUERQUE', 'S-030001');

describe('distinctiveNameWords', () => {
  it('keeps only the word that identifies the Masek business', () => {
    expect(distinctiveNameWords(MASEK)).toEqual(['masek']);
  });

  it.each(['Rocky Mountain Golf', 'The Golf Club', 'Country Club Pro Shop', 'ABC 123 LLC'])('finds nothing distinctive in "%s"', (name) => {
    expect(distinctiveNameWords(name)).toEqual([]);
  });

  it('drops the branch label and keeps the company words', () => {
    expect(distinctiveNameWords(PRINTED)).toEqual(['horticulture']);
  });

  it('returns nothing for an empty name', () => {
    expect(distinctiveNameWords(null)).toEqual([]);
  });
});

describe('findSupplierByDistinctiveWord', () => {
  it('picks the one supplier a distinctive word points to when the rest of the name differs', async () => {
    wordIndex({ masek: [masek] });

    const { match, possible } = await findSupplierByDistinctiveWord(db, { printedName: MASEK });

    expect(match).toMatchObject({ workdayId: 'wid-masek', supplierId: 'S-030001', supplierName: 'MASEK GOLF CARS ALBUQUERQUE', sources: ['printed'] });
    expect(match?.evidence[0]).toContain('"MASEK"');
    expect(possible.map((item) => item.workdayId)).toEqual(['wid-masek']);
    expect(findByWord).toHaveBeenCalledTimes(1);
    expect(findByWord).toHaveBeenCalledWith(db, 'masek', DISTINCTIVE_WORD_SUPPLIER_LIMIT);
  });

  it.each(['Rocky Mountain Golf', 'Rocky Mountain Golf Cars', 'Golf Club'])('never searches or picks on the common words of "%s"', async (name) => {
    const result = await findSupplierByDistinctiveWord(db, { printedName: name });

    expect(result).toEqual({ possible: [] });
    expect(findByWord).not.toHaveBeenCalled();
  });

  it('does not pick a supplier that only shares common words even if the cache has one match', async () => {
    wordIndex({ rocky: [supplierRow('wid-gcsa', 'ROCKY MOUNTAIN GOLF COURSE SUPERINTENDENTS ASSOCIATION', 'S-020312')] });

    const result = await findSupplierByDistinctiveWord(db, { printedName: 'Rocky Mountain Golf Cars' });

    expect(result.match).toBeUndefined();
    expect(result.possible).toEqual([]);
  });

  it('never guesses when two suppliers share the distinctive word, and lists both', async () => {
    const other = supplierRow('wid-masek-2', 'MASEK ELECTRIC', 'S-030002');
    wordIndex({ masek: [masek, other] });

    const { match, possible } = await findSupplierByDistinctiveWord(db, { printedName: MASEK });

    expect(match).toBeUndefined();
    expect(possible.map((item) => item.supplierId)).toEqual(['S-030001', 'S-030002']);
    expect(possible[0]?.reason).toContain('"MASEK"');
  });

  it('never guesses when two distinctive words each point to a different supplier', async () => {
    const brightwater = supplierRow('wid-bright', 'BRIGHTWATER SUPPLY', 'S-030003');
    wordIndex({ masek: [masek], brightwater: [brightwater] });

    const { match, possible } = await findSupplierByDistinctiveWord(db, { printedName: 'Masek Brightwater Carts' });

    expect(match).toBeUndefined();
    expect(possible.map((item) => item.workdayId).sort()).toEqual(['wid-bright', 'wid-masek']);
  });

  it('does not pick when a word shared by other suppliers ties the unique one', async () => {
    const twinA = supplierRow('wid-twin-a', 'BRIGHTWATER ONE', 'S-030004');
    const twinB = supplierRow('wid-twin-b', 'BRIGHTWATER TWO', 'S-030005');
    wordIndex({ masek: [masek], brightwater: [twinA, twinB] });

    expect((await findSupplierByDistinctiveWord(db, { printedName: 'Masek Brightwater Carts' })).match).toBeUndefined();
  });

  it('picks the supplier that matches more printed words than any other', async () => {
    const both = supplierRow('wid-both', 'MASEK BRIGHTWATER', 'S-030006');
    const lone = supplierRow('wid-lone', 'BRIGHTWATER OTHER', 'S-030007');
    wordIndex({ masek: [both], brightwater: [both, lone] });

    expect((await findSupplierByDistinctiveWord(db, { printedName: 'Masek Brightwater Carts' })).match?.workdayId).toBe('wid-both');
  });

  it('treats a word on a full page of suppliers as common', async () => {
    findByWord.mockResolvedValue(Array.from({ length: DISTINCTIVE_WORD_SUPPLIER_LIMIT }, (_, index) => supplierRow(`wid-${index}`, `MASEK ${index}`, `S-${index}`)));

    expect(await findSupplierByDistinctiveWord(db, { printedName: MASEK })).toEqual({ possible: [] });
  });

  it('does not list a word that is on too many suppliers to narrow the field', async () => {
    wordIndex({ masek: Array.from({ length: 6 }, (_, index) => supplierRow(`wid-${index}`, `MASEK ${index}`, `S-${index}`)) });

    expect(await findSupplierByDistinctiveWord(db, { printedName: MASEK })).toEqual({ possible: [] });
  });

  it('skips the default supplier', async () => {
    wordIndex({ masek: [masek] });

    expect(await findSupplierByDistinctiveWord(db, { printedName: MASEK, excludeWorkdayIds: ['wid-masek'] })).toEqual({ possible: [] });
  });

  it('matches the word in an alternate name', async () => {
    wordIndex({ masek: [supplierRow('wid-parent', 'ROCKY MOUNTAIN CART GROUP', 'S-030008', ['MASEK GOLF CARS'])] });

    expect((await findSupplierByDistinctiveWord(db, { printedName: MASEK })).match?.workdayId).toBe('wid-parent');
  });

  it('does not apply a cached supplier to a new supplier that only shares a city word', async () => {
    wordIndex({ albuquerque: [masek] });

    const { match, possible } = await findSupplierByDistinctiveWord(db, { printedName: 'Albuquerque Turf Supply' });

    expect(match).toBeUndefined();
    expect(possible.map((item) => item.workdayId)).toEqual(['wid-masek']);
  });

  it.each([
    ['trade word', 'Aeration Plus Solutions', 'aeration', supplierRow('wid-acme', 'ACME AERATION', 'S-030009')],
    ['surname', 'Brightwater Irrigation', 'brightwater', supplierRow('wid-smith', 'JOHN BRIGHTWATER', 'S-030010')],
  ])('does not apply a supplier whose only shared %s does not lead both names', async (_label, printed, word, record) => {
    wordIndex({ [word]: [record] });

    const { match } = await findSupplierByDistinctiveWord(db, { printedName: printed });

    expect(match).toBeUndefined();
  });

  it('does not apply a supplier when the shared word leads the record but not the printed name', async () => {
    wordIndex({ masek: [masek] });

    expect((await findSupplierByDistinctiveWord(db, { printedName: 'Rocky Mountain Masek Golf Cars' })).match).toBeUndefined();
  });

  it('applies a supplier on a unique word when the printed phone is on the record', async () => {
    const withPhone = { ...masek, metadata: { ...masek.metadata, phones: ['+1 (505) 452-2222'] } };
    wordIndex({ albuquerque: [withPhone] });

    const { match } = await findSupplierByDistinctiveWord(db, { printedName: 'Albuquerque Turf Supply', phone: '505-452-2222' });

    expect(match?.workdayId).toBe('wid-masek');
    expect(match?.evidence[0]).toContain('printed phone');
  });

  it('does not treat a different phone as a signal', async () => {
    const withPhone = { ...masek, metadata: { ...masek.metadata, phones: ['+1 (505) 111-0000'] } };
    wordIndex({ albuquerque: [withPhone] });

    expect((await findSupplierByDistinctiveWord(db, { printedName: 'Albuquerque Turf Supply', phone: '505-452-2222' })).match).toBeUndefined();
  });

  it('searches only the first distinctive words of a long printed name', async () => {
    await findSupplierByDistinctiveWord(db, { printedName: 'Alpha Bravo Charlie Delta Foxtrot Hotel Juliet' });

    expect(findByWord).toHaveBeenCalledTimes(MAX_DISTINCTIVE_WORDS);
    expect(findByWord.mock.calls.map(([, word]) => word)).toEqual(['alpha', 'bravo', 'charlie', 'delta']);
  });
});
