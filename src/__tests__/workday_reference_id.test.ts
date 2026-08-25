import { extractCompanyReferenceId, isWorkdayWid } from '../lib/workday_reference_id.js';

const WID = 'cab0b1d2505a016b332c2e17822708ea';

describe('isWorkdayWid', () => {
  it('matches 32-character hex Workday IDs', () => {
    expect(isWorkdayWid(WID)).toBe(true);
    expect(isWorkdayWid('912')).toBe(false);
  });
});

describe('extractCompanyReferenceId', () => {
  it('prefers referenceID1 over referenceID when it is the company code', () => {
    expect(extractCompanyReferenceId(
      ['912', WID],
      { workdayId: WID, companyName: 'Alabama-Northwest Florida Golf Foundation' }
    )).toBe('912');
  });

  it('uses a descriptor such as 912 and ignores instance .id WIDs', () => {
    expect(extractCompanyReferenceId(
      [{ id: WID, descriptor: '912' }],
      { workdayId: WID }
    )).toBe('912');
  });

  it('does not treat companyID / company.id as Company_Reference_ID', () => {
    expect(extractCompanyReferenceId(
      [WID, { id: WID, descriptor: WID }],
      { workdayId: WID, companyName: 'Alabama-Northwest Florida Golf Foundation' }
    )).toBeUndefined();
  });

  it('skips a descriptor that is the company name', () => {
    expect(extractCompanyReferenceId(
      [{ id: WID, descriptor: 'Alabama-Northwest Florida Golf Foundation' }, '912'],
      { workdayId: WID, companyName: 'Alabama-Northwest Florida Golf Foundation' }
    )).toBe('912');
  });

  it('falls back to referenceID when it is a non-WID code', () => {
    expect(extractCompanyReferenceId(
      [undefined, '912'],
      { workdayId: WID }
    )).toBe('912');
  });
});
