import {
  addressesShareStreet,
  includeCompaniesMatchingBillToAddress,
  streetFingerprint,
  tagCompaniesByAddress,
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

describe('tagCompaniesByAddress', () => {
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

  it('tags a unique street without reordering name results', () => {
    const tagged = tagCompaniesByAddress([wisconsin, national], BILL_TO);
    expect(tagged.addressMatch).toBe('unique');
    expect(tagged.results.map((result) => result.workday_id)).toEqual(['wisconsin-wid', 'pga-wid']);
    expect(tagged.results.map((result) => result.addressMatch)).toEqual(['none', 'unique']);
  });

  it('tags shared headquarters without moving them ahead of other name hits', () => {
    const juniorLeague = {
      workday_id: 'jr-wid',
      metadata: {
        companyName: 'PGA JR. LEAGUE',
        addressPrimary: '100 Avenue of the Champions, Palm Beach Gardens, FL 33418',
      },
    };
    const tagged = tagCompaniesByAddress([wisconsin, juniorLeague, national], BILL_TO);
    expect(tagged.addressMatch).toBe('shared');
    expect(tagged.results.map((result) => result.workday_id)).toEqual([
      'wisconsin-wid',
      'jr-wid',
      'pga-wid',
    ]);
    expect(tagged.results.map((result) => result.addressMatch)).toEqual(['none', 'shared', 'shared']);
  });
  it('tags a unique PO Box without reordering', () => {
    const tagged = tagCompaniesByAddress(
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
    expect(tagged.addressMatch).toBe('unique');
    expect(tagged.results.map((result) => result.workday_id)).toEqual(['wisconsin-wid', 'pga-wid']);
    expect(tagged.results[1].addressMatch).toBe('unique');
  });

  it('tags shared PO Box matches without moving them ahead of other name hits', () => {
    const tagged = tagCompaniesByAddress(
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
    expect(tagged.addressMatch).toBe('shared');
    expect(tagged.results.map((result) => result.workday_id)).toEqual([
      'wisconsin-wid',
      'jr-wid',
      'pga-wid',
    ]);
  });

  it('does not treat different PO Box numbers as a match', () => {
    const tagged = tagCompaniesByAddress(
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
    expect(tagged.addressMatch).toBe('none');
  });

  it('tags a unique bill-to on publicAddresses when primary is a different street', () => {
    const tagged = tagCompaniesByAddress(
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
    expect(tagged.addressMatch).toBe('unique');
    expect(tagged.results.map((result) => result.workday_id)).toEqual(['wisconsin-wid', 'pga-wid']);
    expect(tagged.results[1].addressMatch).toBe('unique');
  });

  it('does not treat matching ZIP alone as a unique street', () => {
    const tagged = tagCompaniesByAddress(
      [wisconsin, national],
      'Palm Beach Gardens, FL 33418'
    );
    expect(tagged.addressMatch).toBe('none');
    expect(tagged.results[0].workday_id).toBe('wisconsin-wid');
  });
});

describe('includeCompaniesMatchingBillToAddress', () => {
  const frisco = '1916 PGA Parkway, Frisco, TX 75033';
  const georgia = {
    workday_id: 'georgia-wid',
    metadata: {
      companyName: 'Georgia Section PGA of America, Inc.',
      addressPrimary: '123 Main Street, Atlanta, GA 30301',
    },
    similarity: 1,
  };
  const national = {
    workday_id: 'pga-wid',
    metadata: {
      companyName: 'The Professional Golfers Association of America',
      addressPrimary: frisco,
    },
    similarity: 0.65,
  };

  it('appends a unique cache street match that name search missed', () => {
    const included = includeCompaniesMatchingBillToAddress([georgia], [georgia, national], frisco);
    expect(included.addressMatch).toBe('unique');
    expect(included.results.map((result) => result.workday_id)).toEqual(['georgia-wid', 'pga-wid']);
    expect(included.results.map((result) => result.addressMatch)).toEqual(['none', 'unique']);
  });

  it('reserves limit slots for unique cache street extras', () => {
    const included = includeCompaniesMatchingBillToAddress([georgia], [georgia, national], frisco, 1);
    expect(included.addressMatch).toBe('unique');
    expect(included.results.map((result) => result.workday_id)).toEqual(['pga-wid']);
    expect(included.results.map((result) => result.addressMatch)).toEqual(['unique']);
  });

  it('keeps name order and appends a shared-street company name search missed', () => {
    const juniorLeague = {
      workday_id: 'jr-wid',
      metadata: {
        companyName: 'PGA JR. LEAGUE',
        addressPrimary: frisco,
      },
      similarity: 0.9,
    };
    const included = includeCompaniesMatchingBillToAddress(
      [georgia, juniorLeague],
      [georgia, national, juniorLeague],
      frisco
    );
    expect(included.addressMatch).toBe('shared');
    expect(included.results.map((result) => result.workday_id)).toEqual([
      'georgia-wid',
      'jr-wid',
      'pga-wid',
    ]);
    expect(included.results.map((result) => result.addressMatch)).toEqual(['none', 'shared', 'shared']);
  });

  it('leaves name order unchanged when the cache has no street match', () => {
    const included = includeCompaniesMatchingBillToAddress(
      [georgia, national],
      [georgia, national],
      '100 Avenue of the Champions, Palm Beach Gardens, FL 33418'
    );
    expect(included.addressMatch).toBe('none');
    expect(included.results.map((result) => result.workday_id)).toEqual(['georgia-wid', 'pga-wid']);
  });
});
