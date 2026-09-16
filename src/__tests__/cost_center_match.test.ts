import {
  adjustCostCenterSimilarity,
  COST_CENTER_DNU_MATCH_PENALTY,
  isDoNotUseCostCenter,
  rankCostCenterSearchResults,
  shouldSkipDoNotUsePenalty,
  shouldSkipDoNotUseTieBreak,
} from '../lib/cost_center_match.js';

describe('isDoNotUseCostCenter', () => {
  it('detects zDNU prefix on code or name', () => {
    expect(isDoNotUseCostCenter({ code: 'zDNU-CC6015', name: 'Legal Dept' })).toBe(true);
    expect(isDoNotUseCostCenter({ code: 'CC-Legal Dept', name: 'DNU Legal' })).toBe(true);
    expect(isDoNotUseCostCenter({ code: 'CC-Legal Dept', name: 'CC-Legal Dept' })).toBe(false);
  });
});

describe('shouldSkipDoNotUsePenalty', () => {
  it('skips when query equals cost center code', () => {
    expect(shouldSkipDoNotUsePenalty('zDNU-CC6015', { code: 'zDNU-CC6015', name: 'Legal Dept' })).toBe(true);
  });

  it('skips when query starts with zDNU or DNU', () => {
    expect(shouldSkipDoNotUsePenalty('zDNU-CC6015 Legal', { code: 'x', name: 'y' })).toBe(true);
    expect(shouldSkipDoNotUsePenalty('DNU Legal', { code: 'x', name: 'y' })).toBe(true);
  });

  it('does not skip for a normal name query', () => {
    expect(shouldSkipDoNotUsePenalty('Legal', { code: 'zDNU-CC6015', name: 'Legal Dept' })).toBe(false);
  });

  it('skips tie-break for DNU-prefixed queries', () => {
    expect(shouldSkipDoNotUseTieBreak('DNU Legal')).toBe(true);
    expect(shouldSkipDoNotUseTieBreak('zDNU-CC6015')).toBe(true);
    expect(shouldSkipDoNotUseTieBreak('Legal')).toBe(false);
  });
});

describe('adjustCostCenterSimilarity', () => {
  it('applies penalty to zDNU cost centers for fuzzy queries', () => {
    const metadata = { code: 'zDNU-CC6015', name: 'zDNU-CC6015 Legal Dept' };
    expect(adjustCostCenterSimilarity(1, metadata, 'Legal')).toBe(1 - COST_CENTER_DNU_MATCH_PENALTY);
  });

  it('does not penalize when query is the explicit DNU code', () => {
    const metadata = { code: 'zDNU-CC6015', name: 'zDNU-CC6015 Legal Dept' };
    expect(adjustCostCenterSimilarity(1, metadata, 'zDNU-CC6015')).toBe(1);
  });

  it('leaves non-DNU centers unchanged', () => {
    const metadata = { code: 'CC-Legal Dept', name: 'CC-Legal Dept' };
    expect(adjustCostCenterSimilarity(1, metadata, 'Legal')).toBe(1);
  });
});

describe('rankCostCenterSearchResults', () => {
  it('ranks CC-Legal Dept above zDNU when both raw scores tie at 1.0', () => {
    const results = rankCostCenterSearchResults(
      [
        {
          workday_id: 'dnu-wid',
          similarity: 1,
          metadata: { code: 'zDNU-CC6015', name: 'zDNU-CC6015 Legal Dept' },
        },
        {
          workday_id: 'active-wid',
          similarity: 1,
          metadata: { code: 'CC-Legal Dept', name: 'CC-Legal Dept' },
        },
      ],
      'Legal'
    );

    expect(results[0]?.metadata?.code).toBe('CC-Legal Dept');
    expect(results[1]?.similarity).toBe(1 - COST_CENTER_DNU_MATCH_PENALTY);
  });

  it('can rank active center higher when raw vector score is lower', () => {
    const results = rankCostCenterSearchResults(
      [
        {
          workday_id: 'dnu-wid',
          similarity: 1,
          metadata: { code: 'zDNU-CC6015', name: 'zDNU-CC6015 Legal Dept' },
        },
        {
          workday_id: 'active-wid',
          similarity: 0.88,
          metadata: { code: 'CC-Legal Dept', name: 'CC-Legal Dept' },
        },
      ],
      'Legal'
    );

    expect(results[0]?.metadata?.code).toBe('CC-Legal Dept');
  });

  it('does not rerank on DNU tie-break when query starts with DNU', () => {
    const results = rankCostCenterSearchResults(
      [
        {
          workday_id: 'dnu-wid',
          similarity: 1,
          metadata: { code: 'zDNU-CC6015', name: 'zDNU-CC6015 Legal Dept' },
        },
        {
          workday_id: 'active-wid',
          similarity: 1,
          metadata: { code: 'CC-Legal Dept', name: 'CC-Legal Dept' },
        },
      ],
      'DNU Legal'
    );

    expect(results[0]?.workday_id).toBe('dnu-wid');
    expect(results[1]?.workday_id).toBe('active-wid');
  });
});
