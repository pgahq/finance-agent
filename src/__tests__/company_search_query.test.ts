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

  it('keeps of-America names when only a state and ZIP follow', () => {
    expect(companyNameSearchQuery('PGA of America NY 10001')).toBe('PGA of America');
  });

  it('does not treat Jr as a state before a ZIP', () => {
    expect(companyNameSearchQuery('PGA Jr 33418')).toBe('PGA Jr 33418');
  });

  it('does not treat Co as a state before a ZIP', () => {
    expect(companyNameSearchQuery('Acme Co 80202')).toBe('Acme Co 80202');
  });

  it('drops a one-word city when a billed name remains', () => {
    expect(companyNameSearchQuery(
      'PGA JR. LEAGUE Miami FL 33418'
    )).toBe('PGA JR. LEAGUE');
  });

  it('drops a comma-separated city, state, and ZIP', () => {
    expect(companyNameSearchQuery(
      'PGA JR. LEAGUE, Palm Beach Gardens, FL 33418'
    )).toBe('PGA JR. LEAGUE');
  });

  it('drops an ALL CAPS city, state, and ZIP', () => {
    expect(companyNameSearchQuery(
      'PGA JR. LEAGUE PALM BEACH GARDENS FL 33418'
    )).toBe('PGA JR. LEAGUE');
  });

  it('drops a mixed-case state abbreviation', () => {
    expect(companyNameSearchQuery(
      'PGA JR. LEAGUE Palm Beach Gardens Fl 33418'
    )).toBe('PGA JR. LEAGUE');
  });

  it('drops a trailing country token after ZIP', () => {
    expect(companyNameSearchQuery(
      'PGA JR. LEAGUE Palm Beach Gardens FL 33418 USA'
    )).toBe('PGA JR. LEAGUE');
  });

  it('drops a house number left after peeling city and ZIP', () => {
    expect(companyNameSearchQuery(
      'PGA JR. LEAGUE 100 Palm Beach Gardens FL 33418'
    )).toBe('PGA JR. LEAGUE');
  });

  it('returns empty when a house number is the only remainder', () => {
    expect(companyNameSearchQuery(
      '100 Palm Beach Gardens FL 33418'
    )).toBe('');
  });

  it('keeps a two-word billed name before state and ZIP', () => {
    expect(companyNameSearchQuery('Acme Holdings TX 75034')).toBe('Acme Holdings');
  });

  it('keeps an ALL-CAPS two-word billed name before state and ZIP', () => {
    expect(companyNameSearchQuery('SPORTS ENGINE FL 33418')).toBe('SPORTS ENGINE');
  });

  it('keeps PGA TOUR when a Title Case city, state, and ZIP follow', () => {
    expect(companyNameSearchQuery(
      'PGA TOUR, Ponte Vedra, FL 32082'
    )).toBe('PGA TOUR');
  });

  it('keeps PGA TOUR when an ALL-CAPS city, state, and ZIP follow', () => {
    expect(companyNameSearchQuery(
      'PGA TOUR PONTE VEDRA FL 32082'
    )).toBe('PGA TOUR');
  });

  it('keeps an ALL-CAPS two-word name when an ALL-CAPS city follows', () => {
    expect(companyNameSearchQuery(
      'ACME WIDGETS PALM BEACH FL 33418'
    )).toBe('ACME WIDGETS');
  });
});
