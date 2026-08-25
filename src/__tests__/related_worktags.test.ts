import {
  EMPTY_RELATED_LOB,
  parseRelatedLob,
  parseRelatedWorktagsResponse,
  relatedLobSoapReference,
  relatedWorktagsTotalPages,
  resolveRelatedLobId,
  worktagsIncludeLineOfBusiness,
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
      defaultIds: [{ type: 'Organization_Reference_ID', value: 'LOB-Facilities' }],
      allowedIds: [{ type: 'Organization_Reference_ID', value: 'LOB-Facilities' }],
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
      defaultIds: [],
      allowedIds: [{ type: 'Custom_Organization_Reference_ID', value: 'LOB-Only' }],
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

  it('keeps Line of Business organization ids even when they do not use a LOB- prefix', () => {
    const parsed = parseRelatedWorktagsResponse({
      Response_Data: {
        Related_Worktags: {
          Related_Worktag_Reference: { ID: [id('Cost_Center_Reference_ID', 'CC-Enterprise Technology')] },
          Related_Worktags_Data: {
            Related_Worktags_by_Type_Data: {
              Worktag_Type_Reference: {
                ID: [id('Worktag_Type_ID', 'LINE_OF_BUSINESS')]
              },
              Required_On_Transaction: true,
              Allowed_Worktag_Data: {
                Allowed_Worktag_Reference: {
                  ID: [id('Organization_Reference_ID', 'Enterprise_Technology')]
                }
              }
            }
          }
        }
      }
    });

    expect(parsed.get('CC-Enterprise Technology')).toEqual({
      requiredOnTransaction: true,
      defaultReferenceId: null,
      allowedReferenceIds: ['Enterprise_Technology'],
      defaultIds: [],
      allowedIds: [{ type: 'Organization_Reference_ID', value: 'Enterprise_Technology' }],
    });
  });

  it('treats custom organization related worktags as Line of Business', () => {
    const parsed = parseRelatedWorktagsResponse({
      Response_Data: {
        Related_Worktags: {
          Related_Worktag_Reference: {
            ID: [
              id('WID', '737c7895dd701001f0f9c396f27b0000'),
              id('Cost_Center_Reference_ID', 'CC-Building_Services-PBG'),
            ]
          },
          Related_Worktags_Data: {
            Related_Worktags_by_Type_Data: [
              {
                Worktag_Type_Reference: { ID: [id('Worktag_Type_ID', 'FUND')] },
                Default_Worktag_Data: {
                  Default_Worktag_Reference: { ID: [id('Fund_ID', 'FUND-General_Fund_Unrestricted')] }
                }
              },
              {
                Worktag_Type_Reference: { ID: [id('Worktag_Type_ID', 'CUSTOM_ORGANIZATION_01')] },
                Required_On_Transaction: true,
                Allowed_Worktag_Data: {
                  Allowed_Worktag_Reference: {
                    ID: [
                      id('WID', '737c7895dd701001ec3537bb73570000'),
                      id('Organization_Reference_ID', 'LOB-Building_Services'),
                      id('Custom_Organization_Reference_ID', 'LOB-Building_Services'),
                    ]
                  }
                }
              }
            ]
          }
        }
      }
    });

    expect(parsed.get('737c7895dd701001f0f9c396f27b0000')).toEqual({
      requiredOnTransaction: true,
      defaultReferenceId: null,
      allowedReferenceIds: [
        'LOB-Building_Services',
        '737c7895dd701001ec3537bb73570000',
      ],
      defaultIds: [],
      allowedIds: [
        { type: 'Custom_Organization_Reference_ID', value: 'LOB-Building_Services' },
        { type: 'Organization_Reference_ID', value: 'LOB-Building_Services' },
        { type: 'WID', value: '737c7895dd701001ec3537bb73570000' },
      ],
    });
    expect(parsed.get('CC-Building_Services-PBG')).toEqual(
      parsed.get('737c7895dd701001f0f9c396f27b0000')
    );
  });

  it('does not treat CUSTOM_ORGANIZATION_02 as Line of Business', () => {
    const parsed = parseRelatedWorktagsResponse({
      Response_Data: {
        Related_Worktags: {
          Related_Worktag_Reference: { ID: [id('WID', 'cc-wid-region')] },
          Related_Worktags_Data: {
            Related_Worktags_by_Type_Data: {
              Worktag_Type_Reference: { ID: [id('Worktag_Type_ID', 'CUSTOM_ORGANIZATION_02')] },
              Required_On_Transaction: true,
              Allowed_Worktag_Data: {
                Allowed_Worktag_Reference: {
                  ID: [id('Organization_Reference_ID', 'Region_South')]
                }
              }
            }
          }
        }
      }
    });

    expect(parsed.get('cc-wid-region')).toEqual(EMPTY_RELATED_LOB);
  });

  it('reads Related_Worktags_Data arrays returned by strong-soap', () => {
    const parsed = parseRelatedWorktagsResponse({
      Response_Data: {
        Related_Worktags: {
          Related_Worktag_Reference: {
            ID: [
              id('WID', '737c7895dd701001f0f9c396f27b0000'),
              id('Cost_Center_Reference_ID', 'CC-Building_Services-PBG'),
            ]
          },
          Related_Worktags_Data: [{
            Related_Worktags_by_Type_Data: [
              {
                Worktag_Type_Reference: { ID: [id('Worktag_Type_ID', 'FUND')] },
                Default_Worktag_Data: {
                  Default_Worktag_Reference: { ID: [id('Fund_ID', 'FUND-General_Fund_Unrestricted')] }
                }
              },
              {
                Worktag_Type_Reference: { ID: [id('Worktag_Type_ID', 'CUSTOM_ORGANIZATION_01')] },
                Required_On_Transaction: true,
                Allowed_Worktag_Data: {
                  Allowed_Worktag_Reference: {
                    ID: [
                      id('WID', '737c7895dd701001ec3537bb73570000'),
                      id('Organization_Reference_ID', 'LOB-Building_Services'),
                      id('Custom_Organization_Reference_ID', 'LOB-Building_Services'),
                    ]
                  }
                }
              }
            ]
          }]
        }
      }
    });

    expect(parsed.get('737c7895dd701001f0f9c396f27b0000')).toEqual({
      requiredOnTransaction: true,
      defaultReferenceId: null,
      allowedReferenceIds: [
        'LOB-Building_Services',
        '737c7895dd701001ec3537bb73570000',
      ],
      defaultIds: [],
      allowedIds: [
        { type: 'Custom_Organization_Reference_ID', value: 'LOB-Building_Services' },
        { type: 'Organization_Reference_ID', value: 'LOB-Building_Services' },
        { type: 'WID', value: '737c7895dd701001ec3537bb73570000' },
      ],
    });
  });

  it('detects Line of Business from the worktag type descriptor when the type id is a WID', () => {
    const parsed = parseRelatedWorktagsResponse({
      Response_Data: {
        Related_Worktags: {
          Related_Worktag_Reference: { ID: [id('WID', 'cc-wid-4')] },
          Related_Worktags_Data: {
            Related_Worktags_by_Type_Data: {
              Worktag_Type_Reference: {
                $attributes: { Descriptor: 'Line of Business' },
                ID: [id('WID', 'lob-type-wid')]
              },
              Required_On_Transaction: true,
              Allowed_Worktag_Data: {
                Allowed_Worktag_Reference: {
                  ID: [id('Custom_Organization_Reference_ID', 'Building_Services')]
                }
              }
            }
          }
        }
      }
    });

    expect(parsed.get('cc-wid-4')).toEqual({
      requiredOnTransaction: true,
      defaultReferenceId: null,
      allowedReferenceIds: ['Building_Services'],
      defaultIds: [],
      allowedIds: [{ type: 'Custom_Organization_Reference_ID', value: 'Building_Services' }],
    });
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

  it('does not pick an allowed LOB when multiple values exist and there is no default', () => {
    expect(resolveRelatedLobId({
      requiredOnTransaction: true,
      defaultReferenceId: null,
      allowedReferenceIds: ['LOB-A', 'LOB-B'],
    }, 'CC-001')).toBeNull();
  });

  it('can use any allowed LOB on the validation retry path', () => {
    expect(resolveRelatedLobId({
      requiredOnTransaction: true,
      defaultReferenceId: null,
      allowedReferenceIds: ['LOB-A', 'LOB-B'],
    }, 'CC-001', undefined, undefined, { anyAllowed: true })).toBe('LOB-A');
  });

  it('treats org and WID ids for the same LOB as one allowed value', () => {
    expect(resolveRelatedLobId({
      requiredOnTransaction: true,
      defaultReferenceId: null,
      allowedReferenceIds: ['LOB-Building_Services', '737c7895dd701001ec3537bb73570000'],
    }, 'CC-001')).toBe('LOB-Building_Services');
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

describe('parseRelatedLob', () => {
  it('keeps typed WID and organization ids from cache', () => {
    expect(parseRelatedLob({
      requiredOnTransaction: true,
      defaultReferenceId: null,
      allowedReferenceIds: ['LOB-Building_Services', '737c7895dd701001ec3537bb73570000'],
      defaultIds: [],
      allowedIds: [
        { type: 'Custom_Organization_Reference_ID', value: 'LOB-Building_Services' },
        { type: 'Organization_Reference_ID', value: 'LOB-Building_Services' },
        { type: 'WID', value: '737c7895dd701001ec3537bb73570000' },
      ],
    })).toEqual({
      requiredOnTransaction: true,
      defaultReferenceId: null,
      allowedReferenceIds: ['LOB-Building_Services', '737c7895dd701001ec3537bb73570000'],
      defaultIds: [],
      allowedIds: [
        { type: 'Custom_Organization_Reference_ID', value: 'LOB-Building_Services' },
        { type: 'Organization_Reference_ID', value: 'LOB-Building_Services' },
        { type: 'WID', value: '737c7895dd701001ec3537bb73570000' },
      ],
    });
  });

  it('synthesizes typed ids from legacy cache rows', () => {
    expect(parseRelatedLob({
      requiredOnTransaction: true,
      defaultReferenceId: 'LOB-Facilities',
      allowedReferenceIds: ['LOB-Facilities', '737c7895dd701001ec3537bb73570000'],
    })).toEqual({
      requiredOnTransaction: true,
      defaultReferenceId: 'LOB-Facilities',
      allowedReferenceIds: ['LOB-Facilities', '737c7895dd701001ec3537bb73570000'],
      defaultIds: [{ type: 'Organization_Reference_ID', value: 'LOB-Facilities' }],
      allowedIds: [
        { type: 'Organization_Reference_ID', value: 'LOB-Facilities' },
        { type: 'WID', value: '737c7895dd701001ec3537bb73570000' },
      ],
    });
  });
});

describe('relatedLobSoapReference', () => {
  it('prefers Organization_Reference_ID over Custom_Organization_Reference_ID for the same value', () => {
    expect(relatedLobSoapReference({
      requiredOnTransaction: true,
      defaultReferenceId: null,
      allowedReferenceIds: ['LOB-Building_Services'],
      allowedIds: [
        { type: 'Custom_Organization_Reference_ID', value: 'LOB-Building_Services' },
        { type: 'Organization_Reference_ID', value: 'LOB-Building_Services' },
        { type: 'WID', value: '737c7895dd701001ec3537bb73570000' },
      ],
    }, 'LOB-Building_Services')).toEqual({
      type: 'Organization_Reference_ID',
      value: 'LOB-Building_Services',
    });
  });

  it('uses WID when submitting the stored Workday id', () => {
    expect(relatedLobSoapReference({
      requiredOnTransaction: true,
      defaultReferenceId: null,
      allowedReferenceIds: ['737c7895dd701001ec3537bb73570000'],
      allowedIds: [{ type: 'WID', value: '737c7895dd701001ec3537bb73570000' }],
    }, '737c7895dd701001ec3537bb73570000')).toEqual({
      type: 'WID',
      value: '737c7895dd701001ec3537bb73570000',
    });
  });
});

describe('worktagsIncludeLineOfBusiness', () => {
  const related = {
    requiredOnTransaction: true,
    defaultReferenceId: null,
    allowedReferenceIds: ['Building Services', '737c7895dd701001ec3537bb73570000'],
    defaultIds: [],
    allowedIds: [
      { type: 'Custom_Organization_Reference_ID' as const, value: 'Building Services' },
      { type: 'Organization_Reference_ID' as const, value: 'Building Services' },
      { type: 'WID' as const, value: '737c7895dd701001ec3537bb73570000' },
    ],
  };

  it('matches a related LOB organization id that does not use a LOB- prefix', () => {
    expect(worktagsIncludeLineOfBusiness([
      { ID: [{ $attributes: { type: 'Cost_Center_Reference_ID' }, $value: 'CC-Building Services-PBG' }] },
      { ID: [{ $attributes: { type: 'Organization_Reference_ID' }, $value: 'Building Services' }] },
    ], related)).toBe(true);
  });

  it('does not treat an Event organization reference as Line of Business', () => {
    expect(worktagsIncludeLineOfBusiness([
      { ID: [{ $attributes: { type: 'Organization_Reference_ID' }, $value: '2026-PGA_Championship' }] },
    ], related)).toBe(false);
  });
});
