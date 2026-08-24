import { findDocumentsByReferenceId, type DatabaseConnection, type DocumentType } from '../lib/database.js';
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
  getDatabaseConnection: jest.fn(),
}));

const mockFindDocumentsByReferenceId = findDocumentsByReferenceId as jest.MockedFunction<typeof findDocumentsByReferenceId>;

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
});

describe('resolveCompanyFromEmail', () => {
  const db = { query: jest.fn(), close: jest.fn() } as unknown as DatabaseConnection;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the unique company among mixed object types', async () => {
    mockFindDocumentsByReferenceId.mockImplementation((_db, code) => {
      if (code === '912') return Promise.resolve([companyDoc()]);
      if (code === '72200') return Promise.resolve([costCenterDoc()]);
      return Promise.resolve([]);
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
    mockFindDocumentsByReferenceId.mockImplementation((_db, code) => {
      if (code === '912') return Promise.resolve([companyDoc()]);
      if (code === '800') {
        return Promise.resolve([companyDoc({
          workday_id: 'company-wid-800',
          metadata: { companyReferenceId: '800', companyName: 'Other Company' },
        })]);
      }
      return Promise.resolve([]);
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
    expect(mockFindDocumentsByReferenceId).not.toHaveBeenCalled();
  });

  it('looks up a WID when only a company referenceId is present', async () => {
    mockFindDocumentsByReferenceId.mockResolvedValue([companyDoc()]);

    await expect(resolveCompanyFromEmail({
      db,
      emailCompany: { extracted: '912', workdayId: null, referenceId: '912', name: 'PGA Company' },
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
