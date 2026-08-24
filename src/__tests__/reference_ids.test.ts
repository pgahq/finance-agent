import { findDocumentsByReferenceIds, type DatabaseConnection, type DocumentType } from '../lib/database.js';
import {
  extractReferenceCodeCandidates,
  resolveCompanyFromEmail,
  selectCompanyForCreateInvoice,
  costCenterCodeExcludingCompany,
  formatReferenceDirectory,
} from '../lib/reference_ids.js';

jest.mock('@pga/logger', () => ({
  debug: jest.fn(),
}));

jest.mock('../lib/database.js', () => ({
  findDocumentsByReferenceId: jest.fn(),
  findDocumentsByReferenceIds: jest.fn(),
  getDatabaseConnection: jest.fn(),
}));

const mockFindDocumentsByReferenceIds = findDocumentsByReferenceIds as jest.MockedFunction<typeof findDocumentsByReferenceIds>;

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
});

describe('resolveCompanyFromEmail', () => {
  const db = { query: jest.fn(), close: jest.fn() } as unknown as DatabaseConnection;

  beforeEach(() => {
    jest.clearAllMocks();
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

  it('returns an already-resolved workdayId without looking up', async () => {
    await expect(resolveCompanyFromEmail({
      db,
      emailCompany: {
        extracted: '912',
        workdayId: 'email-company-wid',
        referenceId: '912',
        name: 'PGA Company',
      },
    })).resolves.toEqual({
      workdayId: 'email-company-wid',
      referenceId: '912',
      name: 'PGA Company',
    });
    expect(mockFindDocumentsByReferenceIds).not.toHaveBeenCalled();
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
        }],
      },
    ]);
    expect(directory).toContain('912');
    expect(directory).toContain('company');
    expect(directory).toContain('company-wid-912');
  });
});
