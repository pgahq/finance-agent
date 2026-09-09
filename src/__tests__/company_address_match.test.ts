import {
  addressesShareStreet,
  rankCompaniesByAddress,
  streetFingerprint,
} from '../lib/company_address_match.js';

const BILL_TO = '100 Avenue of the Champions, Palm Beach Gardens, FL 33418-3653';

describe('streetFingerprint', () => {
  it('takes house number and Champions, not city or ZIP', () => {
    const fingerprint = streetFingerprint(BILL_TO);
    expect(fingerprint.house).toBe('100');
    expect(fingerprint.tokens.has('champions')).toBe(true);
    expect(fingerprint.tokens.has('palm')).toBe(false);
    expect(fingerprint.tokens.has('gardens')).toBe(false);
  });

  it('does not treat Avenue of the Stars as the same street', () => {
    expect(addressesShareStreet(
      BILL_TO,
      '100 Avenue of the Stars, Palm Beach Gardens, FL 33418'
    )).toBe(false);
  });
});

describe('rankCompaniesByAddress', () => {
  const wisconsin = {
    workday_id: 'wisconsin-wid',
    metadata: {
      companyName: 'Wisconsin Section of the PGA of America, Inc.',
      addressPrimary: '11370 N. Cedarburg Road, Mequon, WI 53092',
    },
  };
  const national = {
    workday_id: 'pga-wid',
    metadata: {
      companyName: 'The Professional Golfers Association of America',
      addressPrimary: '100 Avenue of the Champions, Palm Beach Gardens, FL 33418',
    },
  };

  it('moves PGA of America ahead of a section whose name contains that phrase', () => {
    const ranked = rankCompaniesByAddress([wisconsin, national], BILL_TO);
    expect(ranked.addressMatch).toBe('unique');
    expect(ranked.results.map((result) => result.workday_id)).toEqual(['pga-wid', 'wisconsin-wid']);
    expect(ranked.results[0].addressMatch).toBe('unique');
    expect(ranked.results[1].addressMatch).toBe('none');
  });

  it('does not reorder when several candidates share headquarters', () => {
    const juniorLeague = {
      workday_id: 'jr-wid',
      metadata: {
        companyName: 'PGA JR. LEAGUE',
        addressPrimary: '100 Avenue of the Champions, Palm Beach Gardens, FL 33418',
      },
    };
    const ranked = rankCompaniesByAddress([wisconsin, juniorLeague, national], BILL_TO);
    expect(ranked.addressMatch).toBe('shared');
    expect(ranked.results.map((result) => result.workday_id)).toEqual([
      'wisconsin-wid',
      'jr-wid',
      'pga-wid',
    ]);
    expect(ranked.results.map((result) => result.addressMatch)).toEqual(['none', 'shared', 'shared']);
  });

  it('does not treat matching ZIP alone as a unique street', () => {
    const ranked = rankCompaniesByAddress(
      [wisconsin, national],
      'Palm Beach Gardens, FL 33418'
    );
    expect(ranked.addressMatch).toBe('none');
    expect(ranked.results[0].workday_id).toBe('wisconsin-wid');
  });
});
