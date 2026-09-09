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

  it('does not treat PGA Tour Blvd and PGA Drive as the same street', () => {
    expect(addressesShareStreet(
      '100 PGA Tour Blvd, Palm Beach Gardens, FL 33418',
      '100 PGA Drive, Palm Beach Gardens, FL 33418'
    )).toBe(false);
  });

  it('matches a concatenated Champions line to the comma-separated cache address', () => {
    expect(addressesShareStreet(
      '100 Avenue of the Champions Palm Beach Gardens FL 33418-3653',
      '100 Avenue of the Champions, Palm Beach Gardens, FL 33418'
    )).toBe(true);
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

  it('lists shared headquarters ahead of a section at a different street', () => {
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
      'jr-wid',
      'pga-wid',
      'wisconsin-wid',
    ]);
    expect(ranked.results.map((result) => result.addressMatch)).toEqual(['shared', 'shared', 'none']);
  });

  it('promotes a unique PO Box match', () => {
    const ranked = rankCompaniesByAddress(
      [
        wisconsin,
        {
          ...national,
          metadata: {
            ...national.metadata,
            addressPrimary: 'PO Box 109601, Palm Beach Gardens, FL 33410',
          },
        },
      ],
      'PO Box 109601, Palm Beach Gardens, FL 33410-9601'
    );
    expect(ranked.addressMatch).toBe('unique');
    expect(ranked.results[0].workday_id).toBe('pga-wid');
  });

  it('lists shared PO Box matches ahead of a different street', () => {
    const ranked = rankCompaniesByAddress(
      [
        wisconsin,
        {
          workday_id: 'jr-wid',
          metadata: {
            companyName: 'PGA JR. LEAGUE',
            addressPrimary: 'PO Box 109601, Palm Beach Gardens, FL 33410',
          },
        },
        {
          ...national,
          metadata: {
            ...national.metadata,
            addressPrimary: 'P.O. Box 109601 Palm Beach Gardens FL',
          },
        },
      ],
      'PO Box 109601, Palm Beach Gardens, FL 33410'
    );
    expect(ranked.addressMatch).toBe('shared');
    expect(ranked.results.map((result) => result.workday_id)).toEqual([
      'jr-wid',
      'pga-wid',
      'wisconsin-wid',
    ]);
  });

  it('does not treat different PO Box numbers as a match', () => {
    const ranked = rankCompaniesByAddress(
      [
        {
          ...national,
          metadata: {
            ...national.metadata,
            addressPrimary: 'PO Box 109601, Palm Beach Gardens, FL 33410',
          },
        },
      ],
      'PO Box 12, Palm Beach Gardens, FL 33410'
    );
    expect(ranked.addressMatch).toBe('none');
  });

  it('matches a unique bill-to on publicAddresses when primary is a different street', () => {
    const ranked = rankCompaniesByAddress(
      [
        wisconsin,
        {
          ...national,
          metadata: {
            ...national.metadata,
            addressPrimary: '11370 N. Cedarburg Road, Mequon, WI 53092',
            publicAddresses: ['100 Avenue of the Champions, Palm Beach Gardens, FL 33418'],
          },
        },
      ],
      BILL_TO
    );
    expect(ranked.addressMatch).toBe('unique');
    expect(ranked.results[0].workday_id).toBe('pga-wid');
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
