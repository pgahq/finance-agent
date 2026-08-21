import {
  EMPTY_RELATED_LOB,
  parseRelatedWorktagsResponse,
  relatedWorktagsTotalPages,
  resolveRelatedLobId,
} from '../lib/related_worktags.js';

const id = (type: string, value: string) => ({
  $attributes: { type },
  $value: value
});

describe('parseRelatedWorktagsResponse', () => {
  it('maps default and allowed LOB ids by cost center WID and code', () => {
    const parsed = parseRelatedWorktagsResponse({
      Response_Data: {
        Related_Worktags: {
          Related_Worktag_Reference: {
            ID: [
              id('WID', 'cc-wid-1'),
              id('Cost_Center_Reference_ID', 'CC-Building Services-PBG'),
            ]
          },
          Related_Worktags_Data: {
            Related_Worktags_by_Type_Data: {
              Required_On_Transaction: true,
              Default_Worktag_Data: {
                Default_Worktag_Reference: { ID: [id('Organization_Reference_ID', 'LOB-Facilities')] }
              },
              Allowed_Worktag_Data: [
                { Allowed_Worktag_Reference: { ID: [id('Organization_Reference_ID', 'LOB-Facilities')] } },
                { Allowed_Worktag_Reference: { ID: [id('Organization_Reference_ID', '2026-PGA_Championship')] } }
              ]
            }
          }
        }
      }
    });

    expect(parsed.get('cc-wid-1')).toEqual({
      requiredOnTransaction: true,
      defaultReferenceId: 'LOB-Facilities',
      allowedReferenceIds: ['LOB-Facilities'],
    });
    expect(parsed.get('CC-Building Services-PBG')).toEqual(parsed.get('cc-wid-1'));
  });

  it('unwraps Response_Data arrays used by strong-soap', () => {
    const parsed = parseRelatedWorktagsResponse({
      Response_Data: [{
        Related_Worktags: [{
          Related_Worktag_Reference: { ID: [id('WID', 'cc-wid-2')] },
          Related_Worktags_Data: {
            Related_Worktags_by_Type_Data: {
              Allowed_Worktag_Data: {
                Allowed_Worktag_Reference: { ID: [id('Custom_Organization_Reference_ID', 'LOB-Only')] }
              }
            }
          }
        }]
      }]
    });

    expect(parsed.get('cc-wid-2')).toEqual({
      requiredOnTransaction: false,
      defaultReferenceId: null,
      allowedReferenceIds: ['LOB-Only'],
    });
  });

  it('stores an empty related LOB when the cost center has no LOB-related worktags', () => {
    const parsed = parseRelatedWorktagsResponse({
      Response_Data: {
        Related_Worktags: {
          Related_Worktag_Reference: { ID: [id('WID', 'cc-wid-3')] },
          Related_Worktags_Data: {
            Related_Worktags_by_Type_Data: {
              Allowed_Worktag_Data: {
                Allowed_Worktag_Reference: { ID: [id('Fund_ID', 'FUND-General_Fund_Unrestricted')] }
              }
            }
          }
        }
      }
    });

    expect(parsed.get('cc-wid-3')).toEqual(EMPTY_RELATED_LOB);
  });
});

describe('relatedWorktagsTotalPages', () => {
  it('reads Total_Pages from Response_Results', () => {
    expect(relatedWorktagsTotalPages({ Response_Results: { Total_Pages: 3 } })).toBe(3);
    expect(relatedWorktagsTotalPages({ Response_Results: [{ Total_Pages: '2' }] })).toBe(2);
    expect(relatedWorktagsTotalPages({})).toBe(1);
  });
});

describe('resolveRelatedLobId', () => {
  it('prefers the default related LOB', () => {
    expect(resolveRelatedLobId({
      requiredOnTransaction: true,
      defaultReferenceId: 'LOB-Default',
      allowedReferenceIds: ['LOB-A', 'LOB-B'],
    }, 'CC-001')).toBe('LOB-Default');
  });

  it('uses the unique allowed LOB when there is no default', () => {
    expect(resolveRelatedLobId({
      requiredOnTransaction: true,
      defaultReferenceId: null,
      allowedReferenceIds: ['LOB-Only'],
    }, 'CC-001')).toBe('LOB-Only');
  });

  it('uses an allowed LOB when multiple values exist and there is no default', () => {
    expect(resolveRelatedLobId({
      requiredOnTransaction: true,
      defaultReferenceId: null,
      allowedReferenceIds: ['LOB-A', 'LOB-B'],
    }, 'CC-001')).toBe('LOB-A');
  });

  it('skips Default_Line_Of_Business when a real related LOB is allowed', () => {
    expect(resolveRelatedLobId({
      requiredOnTransaction: true,
      defaultReferenceId: 'Default_Line_Of_Business',
      allowedReferenceIds: ['Default_Line_Of_Business', 'LOB-Enterprise'],
    }, 'CC-001')).toBe('LOB-Enterprise');
  });

  it('skips excluded LOB ids', () => {
    expect(resolveRelatedLobId({
      requiredOnTransaction: true,
      defaultReferenceId: 'LOB-A',
      allowedReferenceIds: ['LOB-A', 'LOB-B'],
    }, 'CC-001', undefined, ['LOB-A'])).toBe('LOB-B');
  });

  it('returns null for the fallback cost center', () => {
    expect(resolveRelatedLobId({
      requiredOnTransaction: true,
      defaultReferenceId: 'LOB-Default',
      allowedReferenceIds: ['LOB-Default'],
    }, 'CC0000', 'CC0000')).toBeNull();
  });
});
