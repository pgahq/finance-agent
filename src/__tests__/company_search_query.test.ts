import { companyNameSearchQuery } from '../lib/company_search_query.js';

describe('companyNameSearchQuery', () => {
  it('keeps a billed company name that has no address', () => {
    expect(companyNameSearchQuery('PGA JR. LEAGUE')).toBe('PGA JR. LEAGUE');
  });

  it('drops a concatenated street, city, state, and ZIP', () => {
    expect(companyNameSearchQuery(
      'PGA JR. LEAGUE 100 Avenue of the Stars Palm Beach Gardens FL 33418'
    )).toBe('PGA JR. LEAGUE');
  });

  it('keeps names that include St without a house number', () => {
    expect(companyNameSearchQuery('PGA St Lucie Inc')).toBe('PGA St Lucie Inc');
  });

  it('keeps a Company_Reference_ID', () => {
    expect(companyNameSearchQuery('912')).toBe('912');
  });

  it('returns empty when the query is only an address', () => {
    expect(companyNameSearchQuery(
      '100 Avenue of the Stars Palm Beach Gardens FL 33418'
    )).toBe('');
  });

  it('drops a trailing city, state, and ZIP without a street type', () => {
    expect(companyNameSearchQuery(
      'PGA JR. LEAGUE Palm Beach Gardens FL 33418'
    )).toBe('PGA JR. LEAGUE');
  });

  it('drops a PO Box suffix', () => {
    expect(companyNameSearchQuery('Acme Corp P.O. Box 74007056')).toBe('Acme Corp');
  });

  it('keeps a legal suffix when only a state and ZIP follow', () => {
    expect(companyNameSearchQuery('Acme Corporation NY 10001')).toBe('Acme Corporation');
  });
});
