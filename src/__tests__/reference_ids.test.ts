import { findDocumentsByReferenceId, findDocumentsByReferenceIds, searchDocumentsByTypes, type DatabaseConnection, type DocumentType } from '../lib/database.js';
import { createEmbedding } from '../lib/rag.js';
import {
  extractReferenceCodeCandidates,
  findCachedReferenceMatches,
  resolveCompanyFromEmail,
  resolveReferenceCodesFromText,
  selectCompanyForCreateInvoice,
  costCenterCodeExcludingCompany,
  formatReferenceDirectory,
  pickTopReferenceMatch,
  MAX_INEXACT_REFERENCE_LOOKUPS,
} from '../lib/reference_ids.js';

jest.mock('@pga/logger', () => ({
  debug: jest.fn(),
}));

jest.mock('../lib/database.js', () => ({
  findDocumentsByReferenceId: jest.fn(),
  findDocumentsByReferenceIds: jest.fn(),
  searchDocumentsByTypes: jest.fn(),
  getDatabaseConnection: jest.fn(),
}));

jest.mock('../lib/rag.js', () => ({
  createEmbedding: jest.fn(),
}));

const mockFindDocumentsByReferenceId = findDocumentsByReferenceId as jest.MockedFunction<typeof findDocumentsByReferenceId>;
const mockFindDocumentsByReferenceIds = findDocumentsByReferenceIds as jest.MockedFunction<typeof findDocumentsByReferenceIds>;
const mockSearchDocumentsByTypes = searchDocumentsByTypes as jest.MockedFunction<typeof searchDocumentsByTypes>;
const mockCreateEmbedding = createEmbedding as jest.MockedFunction<typeof createEmbedding>;

function mockReferenceLookup(byCode: Record<string, CachedDoc[]>) {
  mockFindDocumentsByReferenceIds.mockImplementation((_db, codes) => {
    const grouped = new Map<string, CachedDoc[]>();
    for (const code of codes) {
      grouped.set(code, byCode[code] ?? []);
    }
    return Promise.resolve(grouped);
  });
}

type CachedDoc = {
  workday_id: string;
  type: DocumentType;
  content: string;
  metadata: Record<string, unknown>;
};

function companyDoc(overrides: Partial<CachedDoc> = {}): CachedDoc {
  return {
    workday_id: 'company-wid-912',
    type: 'company',
    content: 'PGA Company',
    metadata: { companyReferenceId: '912', companyName: 'PGA Company' },
    ...overrides,
  };
}

function costCenterDoc(overrides: Partial<CachedDoc> = {}): CachedDoc {
  return {
    workday_id: 'cc-wid-72200',
    type: 'cost_center',
    content: 'Technology',
    metadata: { code: '72200', name: 'Technology' },
    ...overrides,
  };
}

describe('extractReferenceCodeCandidates', () => {
  it('extracts short numeric codes such as 912', () => {
    expect(extractReferenceCodeCandidates('Please code to 912 and 72200')).toEqual(
      expect.arrayContaining(['912', '72200'])
    );
  });

  it('extracts prefixed reference IDs', () => {
    expect(extractReferenceCodeCandidates('Use LOB-Golf and FD-001')).toEqual(
      expect.arrayContaining(['LOB-Golf', 'FD-001'])
    );
  });

  it('ignores single-digit numbers', () => {
    expect(extractReferenceCodeCandidates('line 1 of 2')).not.toContain('1');
  });

  it('ignores lowercase English hyphenations such as follow-up', () => {
    expect(extractReferenceCodeCandidates('Please follow-up and re-submit')).not.toEqual(
      expect.arrayContaining(['follow-up', 're-submit'])
    );
  });

  it('ignores 4-digit calendar years so invoice dates do not trigger lookups', () => {
    expect(extractReferenceCodeCandidates('Invoice dated 2024 for company 912')).toEqual(
      expect.arrayContaining(['912'])
    );
    expect(extractReferenceCodeCandidates('Invoice dated 2024 for company 912')).not.toContain('2024');
  });

  it('ignores currency digit groups so invoice amounts are not treated as codes', () => {
    expect(extractReferenceCodeCandidates('Amount due $1,912.00 please code 72200')).toEqual(['72200']);
    expect(extractReferenceCodeCandidates('Total $800.00')).toEqual([]);
    expect(extractReferenceCodeCandidates('Please code to 912, then 72200')).toEqual(
      expect.arrayContaining(['912', '72200'])
    );
  });

  it('ignores zip+4 and phone-number fragments', () => {
    expect(extractReferenceCodeCandidates('Ship to 30328-1234 and code 912')).toEqual(['912']);
    expect(extractReferenceCodeCandidates('Call 555-123-4567 then code 72200')).toEqual(['72200']);
  });
});

describe('resolveCompanyFromEmail', () => {
  const db = { query: jest.fn(), close: jest.fn() } as unknown as DatabaseConnection;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchDocumentsByTypes.mockResolvedValue([]);
    mockCreateEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
  });

  it('returns the unique company among mixed object types', async () => {
    mockReferenceLookup({
      '912': [companyDoc()],
      '72200': [costCenterDoc()],
    });

    await expect(resolveCompanyFromEmail({
      db,
      emailBody: 'Coding: 912 / 72200',
    })).resolves.toEqual({
      workdayId: 'company-wid-912',
      referenceId: '912',
      name: 'PGA Company',
    });
  });

  it('returns undefined when two companies match', async () => {
    mockReferenceLookup({
      '912': [companyDoc()],
      '800': [companyDoc({
        workday_id: 'company-wid-800',
        metadata: { companyReferenceId: '800', companyName: 'Other Company' },
      })],
    });

    await expect(resolveCompanyFromEmail({
      db,
      emailBody: 'Companies 912 and 800',
    })).resolves.toBeUndefined();
  });

  it('returns an already-resolved workdayId without looking up when no codes are present', async () => {
    await expect(resolveCompanyFromEmail({
      db,
      emailCompany: {
        extracted: null,
        workdayId: 'email-company-wid',
        referenceId: null,
        name: 'PGA Company',
      },
    })).resolves.toEqual({
      workdayId: 'email-company-wid',
      referenceId: undefined,
      name: 'PGA Company',
    });
    expect(mockFindDocumentsByReferenceIds).not.toHaveBeenCalled();
  });

  it('keeps a claimed company WID that matches an exact cache hit', async () => {
    mockReferenceLookup({ '912': [companyDoc()] });

    await expect(resolveCompanyFromEmail({
      db,
      emailCompany: {
        extracted: '912',
        workdayId: 'company-wid-912',
        referenceId: '912',
        name: 'PGA Company',
      },
    })).resolves.toEqual({
      workdayId: 'company-wid-912',
      referenceId: '912',
      name: 'PGA Company',
    });
    expect(mockFindDocumentsByReferenceIds).toHaveBeenCalled();
  });

  it('ignores a claimed company WID that is not an exact cache hit when codes are present', async () => {
    mockReferenceLookup({ '912': [companyDoc()] });

    await expect(resolveCompanyFromEmail({
      db,
      emailCompany: {
        extracted: '912',
        workdayId: 'similar-neighbor-wid',
        referenceId: '912',
        name: 'PGA Company',
      },
    })).resolves.toEqual({
      workdayId: 'company-wid-912',
      referenceId: '912',
      name: 'PGA Company',
    });
  });

  it('does not apply a claimed company WID when codes are present and there is no exact cache hit', async () => {
    mockReferenceLookup({});

    await expect(resolveCompanyFromEmail({
      db,
      emailBody: 'Coding: 912',
      emailCompany: {
        extracted: '912',
        workdayId: 'similar-neighbor-wid',
        referenceId: '912',
        name: 'Similar Company',
      },
    })).resolves.toBeUndefined();
  });

  it('prefers a unique exact email company over a claimed findCompanies company that is not in the email', async () => {
    mockReferenceLookup({
      '912': [companyDoc()],
      '72200': [costCenterDoc()],
      '800': [companyDoc({
        workday_id: 'company-wid-800',
        metadata: { companyReferenceId: '800', companyName: 'Other Company' },
      })],
    });

    await expect(resolveCompanyFromEmail({
      db,
      emailBody: 'Coding: 912 / 72200',
      emailCompany: {
        extracted: null,
        workdayId: 'company-wid-800',
        referenceId: '800',
        name: 'Other Company',
      },
    })).resolves.toEqual({
      workdayId: 'company-wid-912',
      referenceId: '912',
      name: 'PGA Company',
    });
    expect(mockFindDocumentsByReferenceIds).toHaveBeenCalledWith(
      db,
      expect.arrayContaining(['912', '72200']),
      expect.any(Array)
    );
    expect(mockFindDocumentsByReferenceIds.mock.calls[0][1]).not.toContain('800');
  });

  it('looks up a WID when only a company referenceId is present', async () => {
    mockReferenceLookup({ '912': [companyDoc()] });

    await expect(resolveCompanyFromEmail({
      db,
      emailCompany: { extracted: '912', workdayId: null, referenceId: '912', name: 'PGA Company' },
    })).resolves.toEqual({
      workdayId: 'company-wid-912',
      referenceId: '912',
      name: 'PGA Company',
    });
  });

  it('does not treat a non-company AI referenceId as the company', async () => {
    mockReferenceLookup({
      '72200': [costCenterDoc()],
      '912': [companyDoc()],
    });

    await expect(resolveCompanyFromEmail({
      db,
      emailBody: 'Coding: 912 / 72200',
      emailCompany: { extracted: '72200', workdayId: null, referenceId: '72200', name: null },
    })).resolves.toEqual({
      workdayId: 'company-wid-912',
      referenceId: '912',
      name: 'PGA Company',
    });
  });

  it('does not select a similar company when there is no exact metadata hit', async () => {
    mockReferenceLookup({});
    mockSearchDocumentsByTypes.mockResolvedValue([
      {
        workday_id: 'company-wid-912',
        type: 'company',
        content: 'PGA Company\nCompany Reference ID: 912',
        metadata: { companyReferenceId: '912', companyName: 'PGA Company' },
        similarity: 0.91,
      },
      {
        workday_id: 'cc-wid-72200',
        type: 'cost_center',
        content: 'Technology',
        metadata: { code: '72200', name: 'Technology' },
        similarity: 0.41,
      },
    ]);

    await expect(resolveCompanyFromEmail({
      db,
      emailBody: 'Coding: 912 / 72200',
    })).resolves.toBeUndefined();
    expect(mockCreateEmbedding).not.toHaveBeenCalled();
  });

  it('does not treat a similar cost center as the company when it outranks company matches', async () => {
    mockReferenceLookup({});
    mockSearchDocumentsByTypes.mockResolvedValue([
      {
        workday_id: 'cc-wid-72200',
        type: 'cost_center',
        content: 'Technology 72200',
        metadata: { code: '72200', name: 'Technology' },
        similarity: 0.94,
      },
      {
        workday_id: 'company-wid-912',
        type: 'company',
        content: 'PGA Company',
        metadata: { companyReferenceId: '912', companyName: 'PGA Company' },
        similarity: 0.4,
      },
    ]);

    await expect(resolveCompanyFromEmail({
      db,
      emailBody: 'Please code 72200',
    })).resolves.toBeUndefined();
  });
});

describe('selectCompanyForCreateInvoice', () => {
  it('prefers email company WID over email reference ID, recommended WID, and the default', () => {
    expect(selectCompanyForCreateInvoice({
      emailCompany: { workdayId: 'email-wid', referenceId: '912' },
      recommendedCompanyWID: 'pdf-wid',
      defaultCompanyReferenceId: 'Default_OCR_Company',
    })).toEqual({ companyId: 'email-wid', companyReferenceType: 'WID' });
  });

  it('uses the email company reference ID when no WID is available', () => {
    expect(selectCompanyForCreateInvoice({
      emailCompany: { referenceId: '912' },
      recommendedCompanyWID: 'pdf-wid',
      defaultCompanyReferenceId: 'Default_OCR_Company',
    })).toEqual({ companyId: '912', companyReferenceType: 'Company_Reference_ID' });
  });

  it('uses the recommended PDF company WID when email did not resolve a company', () => {
    expect(selectCompanyForCreateInvoice({
      recommendedCompanyWID: 'pdf-wid',
      defaultCompanyReferenceId: 'Default_OCR_Company',
    })).toEqual({ companyId: 'pdf-wid', companyReferenceType: 'WID' });
  });

  it('falls back to the default company reference ID', () => {
    expect(selectCompanyForCreateInvoice({
      defaultCompanyReferenceId: 'Default_OCR_Company',
    })).toEqual({ companyId: 'Default_OCR_Company', companyReferenceType: 'Company_Reference_ID' });
  });
});

describe('costCenterCodeExcludingCompany', () => {
  it('strips a cost-center code that is actually the company reference ID', () => {
    expect(costCenterCodeExcludingCompany('912', { referenceId: '912' })).toBeNull();
  });

  it('keeps a real cost-center code', () => {
    expect(costCenterCodeExcludingCompany('72200', { referenceId: '912' })).toBe('72200');
  });
});

describe('formatReferenceDirectory', () => {
  it('returns empty string when there are no resolved codes', () => {
    expect(formatReferenceDirectory([])).toBe('');
  });

  it('formats cached matches for codes found in the email', () => {
    const directory = formatReferenceDirectory([
      {
        code: '912',
        matches: [{
          type: 'company',
          workdayId: 'company-wid-912',
          referenceId: '912',
          name: 'PGA Company',
          confidence: 1,
        }],
      },
    ]);
    expect(directory).toContain('912');
    expect(directory).toContain('company');
    expect(directory).toContain('company-wid-912');
    expect(directory).toContain('confidence=1.00');
    expect(directory).toContain('topMatch');
  });
});

describe('pickTopReferenceMatch', () => {
  it('returns the highest-confidence match when it clearly leads', () => {
    expect(pickTopReferenceMatch([
      { type: 'cost_center', workdayId: 'cc-1', referenceId: '72200', confidence: 0.4 },
      { type: 'company', workdayId: 'co-1', referenceId: '912', confidence: 0.91 },
    ])).toEqual(expect.objectContaining({ type: 'company', referenceId: '912' }));
  });

  it('returns undefined when two object types are nearly tied', () => {
    expect(pickTopReferenceMatch([
      { type: 'company', workdayId: 'co-1', referenceId: '912', confidence: 0.72 },
      { type: 'cost_center', workdayId: 'cc-1', referenceId: '912', confidence: 0.7 },
    ])).toBeUndefined();
  });

  it('returns undefined when two companies are tied at the top', () => {
    expect(pickTopReferenceMatch([
      { type: 'company', workdayId: 'co-1', referenceId: '912', confidence: 1 },
      { type: 'company', workdayId: 'co-2', referenceId: '800', confidence: 1 },
    ])).toBeUndefined();
  });

  it('returns undefined when the best score is below the confidence floor', () => {
    expect(pickTopReferenceMatch([
      { type: 'company', workdayId: 'co-1', referenceId: '912', confidence: 0.4 },
    ])).toBeUndefined();
  });

  it('returns undefined when a company and a cost center are both exact matches', () => {
    expect(pickTopReferenceMatch([
      { type: 'company', workdayId: 'co-1', referenceId: '912', confidence: 1 },
      { type: 'cost_center', workdayId: 'cc-1', referenceId: '912', confidence: 1 },
    ])).toBeUndefined();
  });
});

describe('findCachedReferenceMatches', () => {
  const db = { query: jest.fn(), close: jest.fn() } as unknown as DatabaseConnection;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchDocumentsByTypes.mockResolvedValue([]);
    mockCreateEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
  });

  it('propagates similarity lookup failures instead of returning an empty miss', async () => {
    mockFindDocumentsByReferenceId.mockResolvedValue([]);
    mockCreateEmbedding.mockRejectedValue(new Error('embedding down'));

    await expect(findCachedReferenceMatches(db, '912')).rejects.toThrow('embedding down');
  });
});

describe('resolveReferenceCodesFromText', () => {
  const db = { query: jest.fn(), close: jest.fn() } as unknown as DatabaseConnection;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchDocumentsByTypes.mockResolvedValue([]);
    mockCreateEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
  });

  it('caps inexact embedding lookups per email', async () => {
    const unmatched = Array.from({ length: MAX_INEXACT_REFERENCE_LOOKUPS + 3 }, (_, index) => String(300 + index));
    mockReferenceLookup({});

    await resolveReferenceCodesFromText(db, unmatched.join(' '));

    expect(mockCreateEmbedding).toHaveBeenCalledTimes(MAX_INEXACT_REFERENCE_LOOKUPS);
  });

  it('does not embed codes that already have an exact metadata hit', async () => {
    mockReferenceLookup({
      '912': [companyDoc()],
      '72200': [costCenterDoc()],
    });

    await resolveReferenceCodesFromText(db, 'Coding: 912 / 72200');

    expect(mockCreateEmbedding).not.toHaveBeenCalled();
  });
});
