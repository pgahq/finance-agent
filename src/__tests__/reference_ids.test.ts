import { findDocumentsByReferenceId, findDocumentsByReferenceIds, searchDocumentsByTypes, type DatabaseConnection, type DocumentType } from '../lib/database.js';
import { createEmbedding } from '../lib/rag.js';
import { emailCodingText } from '../lib/email_coding_text.js';
import { describeEmailCompanyReview } from '../lib/invoice_enrichment.js';
import {
  explicitCodingCodes,
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

const KMRD_EMAIL = [
  'Hello,',
  'Attached is an invoice for our October 2026 monthly HRO Support services and monthly PGA Hotline Fee.',
  'Thank you,',
  'Terri',
  'Theresa Quinn, CISR',
  'Account Manager',
  'O +1 267.482.8292',
  'tquinn@kmrdpartners.com',
  '2600 KELLY ROAD, SUITE 120 , WARRINGTON, PA 18976 USA',
].join('\n');

describe('extractReferenceCodeCandidates address and noise filters', () => {
  it('returns no codes for the KMRD Partners signature', () => {
    expect(extractReferenceCodeCandidates(KMRD_EMAIL)).toEqual([]);
  });

  it('skips street numbers, suites, zips, and phone extensions (Dynamic Brands)', () => {
    const text = [
      '624065 PGA OF AMERICA',
      'contact us at 804-262-3000 ext. 2200 or credit@dynamicbrands.com',
      '2701 Emerywood Pkwy, Suite 200',
      'Richmond, VA 23294',
      'for purchase order PO-414064',
    ].join('\n');
    const codes = extractReferenceCodeCandidates(text);
    expect(codes).not.toContain('2200');
    expect(codes).not.toContain('2701');
    expect(codes).not.toContain('200');
    expect(codes).not.toContain('23294');
    expect(codes).not.toContain('414064');
  });

  it('skips a street number and an SMTP status code (Makse Group, United Rentals)', () => {
    expect(extractReferenceCodeCandidates('550 Reserve Street, STE 190, Southlake, TX 76092')).toEqual([]);
    expect(extractReferenceCodeCandidates('smtp;550 5.7.129 RESOLVER.RST.RestrictedToRecipientsPermission')).toEqual([]);
    expect(extractReferenceCodeCandidates('800-UR-RENTS (800-877-3687)')).not.toContain('800');
  });

  it('still extracts coding codes', () => {
    expect(extractReferenceCodeCandidates('Coding: 912 / 72200')).toEqual(['912', '72200']);
  });
});

describe('explicitCodingCodes', () => {
  it('accepts a code after a company label, on a coding line, or on a codes-only line', () => {
    expect(explicitCodingCodes('Company: 912')).toEqual(['912']);
    expect(explicitCodingCodes('Company code 912, cost center 72200')).toEqual(expect.arrayContaining(['912']));
    expect(explicitCodingCodes('Please code to 912 and 72200')).toEqual(['912', '72200']);
    expect(explicitCodingCodes('Thanks\n912 / 72200\nBye')).toEqual(['912', '72200']);
  });

  it('does not treat a bare "code" as coding (zip, promo, customer codes, "coded")', () => {
    expect(explicitCodingCodes('Use promo code 2600 at checkout')).toEqual([]);
    expect(explicitCodingCodes('Your customer code is 2600')).toEqual([]);
    expect(explicitCodingCodes('Zip code: 18976')).toEqual([]);
    expect(explicitCodingCodes('Order 12345 has been coded and shipped')).toEqual([]);
  });

  it('does not treat card receipt text as coding', () => {
    expect(explicitCodingCodes('This amount was charged to your card ending in 2600')).toEqual([]);
    expect(explicitCodingCodes('Payment of $1,250.00 charged to Visa ending 2600')).toEqual([]);
    expect(explicitCodingCodes('Amount charged to account 2600')).toEqual([]);
    expect(explicitCodingCodes('Please charge to card ending in 2600')).toEqual([]);
    expect(explicitCodingCodes('Charge to 912')).toEqual(['912']);
  });

  it('accepts coding phrases', () => {
    expect(explicitCodingCodes('Please code 912')).toEqual(['912']);
    expect(explicitCodingCodes('Coded to 912')).toEqual(['912']);
    expect(explicitCodingCodes('Charge to 912')).toEqual(['912']);
    expect(explicitCodingCodes('Company code 912')).toEqual(['912']);
  });

  it('rejects account numbers and other bare numbers in prose', () => {
    expect(explicitCodingCodes('624065 PGA OF AMERICA')).toEqual([]);
    expect(explicitCodingCodes('Your reference is 2600 for this order')).toEqual([]);
    expect(explicitCodingCodes('Call +1 267.482.8292 today')).toEqual([]);
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
      origin: 'code',
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

  it('applies a claimed company WID when the email itself names that company', async () => {
    await expect(resolveCompanyFromEmail({
      db,
      emailBody: 'Please bill this to PGA Company.',
      codingText: 'Please bill this to PGA Company.',
      emailCompany: {
        extracted: 'PGA Company',
        workdayId: 'email-company-wid',
        referenceId: null,
        name: 'PGA Company',
      },
    })).resolves.toEqual({
      workdayId: 'email-company-wid',
      referenceId: undefined,
      name: 'PGA Company',
      origin: 'name',
    });
    expect(mockFindDocumentsByReferenceIds).not.toHaveBeenCalled();
  });

  it('ignores a claimed company the email never names, such as the invoice bill-to', async () => {
    await expect(resolveCompanyFromEmail({
      db,
      emailBody: 'Attached is our October invoice.',
      codingText: 'Attached is our October invoice.',
      emailCompany: {
        extracted: 'PGA of America',
        workdayId: 'email-company-wid',
        referenceId: '310',
        name: 'The Professional Golfers Association of America',
      },
    })).resolves.toBeUndefined();
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
      origin: 'code',
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
      origin: 'code',
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
      origin: 'code',
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

  it('does not scan an LLM extracted company code that is absent from the email body', async () => {
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
        extracted: '800',
        workdayId: 'company-wid-800',
        referenceId: '800',
        name: 'Other Company',
      },
    })).resolves.toEqual({
      origin: 'code',
      workdayId: 'company-wid-912',
      referenceId: '912',
      name: 'PGA Company',
    });
    expect(mockFindDocumentsByReferenceIds.mock.calls[0][1]).not.toContain('800');
  });

  it('looks up a WID when only a company referenceId is present', async () => {
    mockReferenceLookup({ '912': [companyDoc()] });

    await expect(resolveCompanyFromEmail({
      db,
      emailCompany: { extracted: '912', workdayId: null, referenceId: '912', name: 'PGA Company' },
    })).resolves.toEqual({
      origin: 'code',
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
      origin: 'code',
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

describe('resolveCompanyFromEmail KMRD Partners regression (SUPIN-466170)', () => {
  const db = { query: jest.fn(), close: jest.fn() } as unknown as DatabaseConnection;
  const kentucky = companyDoc({
    workday_id: 'cab0b1d2505a012c97d7da178227ceea',
    metadata: { companyReferenceId: '2600', companyName: 'Kentucky Section PGA of America' },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchDocumentsByTypes.mockResolvedValue([]);
    mockReferenceLookup({ '2600': [kentucky] });
  });

  it('does not turn the supplier address 2600 Kelly Road into the Kentucky Section company', async () => {
    await expect(resolveCompanyFromEmail({
      db,
      emailBody: KMRD_EMAIL,
      codingText: KMRD_EMAIL,
      emailCompany: {
        extracted: 'PGA of America',
        name: 'The Professional Golfers Association of America',
        workdayId: 'cab0b1d2505a01338fcd651982277bec',
        referenceId: '310',
      },
    })).resolves.toBeUndefined();
    expect(mockFindDocumentsByReferenceIds).not.toHaveBeenCalled();
  });

  it('still honors 2600 when the email actually codes it', async () => {
    await expect(resolveCompanyFromEmail({
      db,
      emailBody: `${KMRD_EMAIL}\n\nCompany: 2600`,
      codingText: `${KMRD_EMAIL}\n\nCompany: 2600`,
    })).resolves.toEqual({
      workdayId: 'cab0b1d2505a012c97d7da178227ceea',
      referenceId: '2600',
      name: 'Kentucky Section PGA of America',
      origin: 'code',
    });
  });

  it('counts a code in an AP note as coding, e.g. "Please use 912 for this one"', async () => {
    mockReferenceLookup({ '912': [companyDoc()] });
    await expect(resolveCompanyFromEmail({
      db,
      emailBody: `${KMRD_EMAIL}\n\nPlease use 912 for this one`,
      apNotes: '<p>Please use 912 for this one</p>',
    })).resolves.toEqual({
      workdayId: 'company-wid-912',
      referenceId: '912',
      name: 'PGA Company',
      origin: 'code',
    });
  });

  it('does not count the customer name in a supplier account line or "PGA Hotline Fee" as a company name', () => {
    const text = emailCodingText({
      plainTextBody: '624065 PGA OF AMERICA\nMonthly PGA Hotline Fee\nCompany: PGA Tournament Corp',
    });
    expect(text).toContain('PGA Tournament Corp');
    expect(text).not.toContain('624065');
    expect(text).not.toContain('Hotline');
  });

  it('includes AP notes in the text where a company may be named', () => {
    const text = emailCodingText({
      plainTextBody: 'hello\n\n<p>Bill to PGA Tournament Corp</p>',
      conversationParts: '<p>Bill to PGA Tournament Corp</p>',
      adminConversationParts: '<p>Bill to PGA Tournament Corp</p>',
    });
    expect(text).toContain('Bill to PGA Tournament Corp');
  });

  it('does not read the PGA of America name from the inbox auto-reply as email coding', async () => {
    const autoReply = 'Thank you for contacting the Corporate Accounts Payable Team at The PGA of America headquarters office.';
    await expect(resolveCompanyFromEmail({
      db,
      emailBody: `${KMRD_EMAIL}\n\n${autoReply}`,
      codingText: KMRD_EMAIL,
      emailCompany: {
        extracted: 'PGA of America',
        name: 'The Professional Golfers Association of America',
        workdayId: 'cab0b1d2505a01338fcd651982277bec',
        referenceId: '310',
      },
    })).resolves.toBeUndefined();
  });
});

describe('selectCompanyForCreateInvoice', () => {
  it('prefers email company WID over email reference ID, PO, recommended WID, and the default', () => {
    expect(selectCompanyForCreateInvoice({
      emailCompany: { workdayId: 'email-wid', referenceId: '912' },
      recommendedCompanyWID: 'pdf-wid',
      poCompanyWID: 'po-wid',
      defaultCompany: { companyId: 'Default_OCR_Company', companyReferenceType: 'Company_Reference_ID' },
    })).toEqual({
      companyId: 'email-wid',
      companyReferenceType: 'WID',
      source: 'email',
      conflict: { with: 'po', workdayId: 'po-wid' },
    });
  });

  it('uses the email company reference ID when no WID is available', () => {
    expect(selectCompanyForCreateInvoice({
      emailCompany: { referenceId: '912' },
      recommendedCompanyWID: 'pdf-wid',
      defaultCompany: { companyId: 'Default_OCR_Company', companyReferenceType: 'Company_Reference_ID' },
    })).toEqual({ companyId: '912', companyReferenceType: 'Company_Reference_ID', source: 'email' });
  });

  it('selects the verified bill-to company when the email supplies no company (KMRD)', () => {
    expect(selectCompanyForCreateInvoice({
      emailCompany: undefined,
      recommendedCompanyWID: 'cab0b1d2505a01338fcd651982277bec',
      defaultCompany: { companyId: 'Default_OCR_Company', companyReferenceType: 'Company_Reference_ID' },
    })).toEqual({
      companyId: 'cab0b1d2505a01338fcd651982277bec',
      companyReferenceType: 'WID',
      source: 'recommended',
    });
  });

  it('flags an explicit email company that conflicts with the bill-to company and keeps its origin', () => {
    expect(selectCompanyForCreateInvoice({
      emailCompany: { workdayId: 'email-wid', referenceId: '2600', origin: 'code' },
      recommendedCompanyWID: 'bill-to-wid',
    })).toEqual({
      companyId: 'email-wid',
      companyReferenceType: 'WID',
      source: 'email',
      emailOrigin: 'code',
      conflict: { with: 'bill_to', workdayId: 'bill-to-wid' },
    });
  });

  it('does not flag an email company that agrees with the PO company', () => {
    expect(selectCompanyForCreateInvoice({
      emailCompany: { workdayId: 'same-wid', origin: 'code' },
      poCompanyWID: 'same-wid',
    })).toEqual({
      companyId: 'same-wid',
      companyReferenceType: 'WID',
      source: 'email',
      emailOrigin: 'code',
    });
  });

  it('uses the PO company WID over a PDF recommendation', () => {
    expect(selectCompanyForCreateInvoice({
      recommendedCompanyWID: 'pdf-wid',
      poCompanyWID: 'po-wid',
      defaultCompany: { companyId: 'Default_OCR_Company', companyReferenceType: 'Company_Reference_ID' },
    })).toEqual({ companyId: 'po-wid', companyReferenceType: 'WID', source: 'po' });
  });

  it('uses the recommended PDF company WID when email and PO are absent', () => {
    expect(selectCompanyForCreateInvoice({
      recommendedCompanyWID: 'pdf-wid',
      defaultCompany: { companyId: 'Default_OCR_Company', companyReferenceType: 'Company_Reference_ID' },
    })).toEqual({ companyId: 'pdf-wid', companyReferenceType: 'WID', source: 'recommended' });
  });

  it('falls back to Default OCR Company as Company_Reference_ID', () => {
    expect(selectCompanyForCreateInvoice({
      defaultCompany: { companyId: 'Default_OCR_Company', companyReferenceType: 'Company_Reference_ID' },
    })).toEqual({
      companyId: 'Default_OCR_Company',
      companyReferenceType: 'Company_Reference_ID',
      source: 'default',
    });
  });

  it('returns an empty company id when no default is available', () => {
    expect(selectCompanyForCreateInvoice({})).toEqual({
      companyId: '',
      companyReferenceType: 'Company_Reference_ID',
      source: 'default',
    });
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

  it('formats codes with no cached match so the model does not invent a type', () => {
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
      { code: '99999', matches: [] },
    ]);
    expect(directory).toContain('912');
    expect(directory).toContain('99999');
    expect(directory).toContain('no cached company, cost center, fund, LOB, or spend category');
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

  it('prefers non-DNU cost center when same-type confidence ties', () => {
    expect(pickTopReferenceMatch([
      {
        type: 'cost_center',
        workdayId: 'dnu-wid',
        referenceId: 'zDNU-CC6015',
        name: 'zDNU-CC6015 Legal Dept',
        confidence: 0.88,
      },
      {
        type: 'cost_center',
        workdayId: 'active-wid',
        referenceId: 'CC-Legal Dept',
        name: 'CC-Legal Dept',
        confidence: 0.88,
      },
    ])).toEqual(expect.objectContaining({ workdayId: 'active-wid' }));
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

  it('deprioritizes zDNU cost centers on inexact lookup for Legal', async () => {
    mockFindDocumentsByReferenceId.mockResolvedValue([]);
    mockSearchDocumentsByTypes.mockResolvedValue([
      {
        workday_id: 'dnu-wid',
        type: 'cost_center',
        content: 'zDNU-CC6015 Legal Dept',
        metadata: { code: 'zDNU-CC6015', name: 'zDNU-CC6015 Legal Dept' },
        similarity: 1,
      },
      {
        workday_id: 'active-wid',
        type: 'cost_center',
        content: 'CC-Legal Dept',
        metadata: { code: 'CC-Legal Dept', name: 'CC-Legal Dept' },
        similarity: 1,
      },
    ]);

    const matches = await findCachedReferenceMatches(db, 'Legal');

    expect(matches[0]).toEqual(expect.objectContaining({
      type: 'cost_center',
      workdayId: 'active-wid',
      referenceId: 'CC-Legal Dept',
      confidence: 1,
    }));
    expect(matches[1]?.confidence).toBe(0.88);
  });

  it('prefers active cost center on confidence tie after DNU penalty', async () => {
    mockFindDocumentsByReferenceId.mockResolvedValue([]);
    mockSearchDocumentsByTypes.mockResolvedValue([
      {
        workday_id: 'dnu-wid',
        type: 'cost_center',
        content: 'zDNU-CC6015 Legal Dept',
        metadata: { code: 'zDNU-CC6015', name: 'zDNU-CC6015 Legal Dept' },
        similarity: 1,
      },
      {
        workday_id: 'active-wid',
        type: 'cost_center',
        content: 'CC-Legal Dept',
        metadata: { code: 'CC-Legal Dept', name: 'CC-Legal Dept' },
        similarity: 0.88,
      },
    ]);

    const matches = await findCachedReferenceMatches(db, 'Legal');

    expect(matches[0]?.workdayId).toBe('active-wid');
    expect(matches[0]?.confidence).toBe(0.88);
    expect(matches[1]?.confidence).toBe(0.88);
    expect(pickTopReferenceMatch(matches)).toEqual(expect.objectContaining({ workdayId: 'active-wid' }));
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

  it('keeps exact metadata hits when an inexact embedding lookup fails', async () => {
    mockReferenceLookup({
      '912': [companyDoc()],
    });
    mockCreateEmbedding.mockRejectedValue(new Error('embedding down'));

    const resolved = await resolveReferenceCodesFromText(db, 'Coding: 912 / 333');

    expect(resolved).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: '912',
        matches: [expect.objectContaining({ type: 'company', workdayId: 'company-wid-912', confidence: 1 })],
      }),
      expect.objectContaining({ code: '333', matches: [] }),
    ]));
  });
});

describe('describeEmailCompanyReview', () => {
  it('says "named in the email" in both the note and the Slack review for a name-origin company', () => {
    const { note, review } = describeEmailCompanyReview({
      appliedName: 'PGA REACH',
      origin: 'name',
      conflictWith: 'bill_to',
      conflictName: 'PGA Foundation',
    });
    expect(note).toContain('the company named in the email');
    expect(review).toContain('PGA REACH was named in the email but differs from the invoice bill-to company (PGA Foundation)');
    expect(review).not.toContain('email coding');
  });

  it('names the code for a code-origin company and has no review when nothing conflicts', () => {
    expect(describeEmailCompanyReview({ appliedName: 'Kentucky', referenceId: '2600', origin: 'code' }).review).toBeUndefined();
    expect(describeEmailCompanyReview({ appliedName: 'Kentucky', referenceId: '2600', origin: 'code', conflictWith: 'po', conflictName: 'PGA' }).review)
      .toContain('came from email coding 2600 but differs from the purchase order company (PGA)');
  });
});
