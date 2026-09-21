import {
  dedupeWorktagReferences,
  enrichSplitWorktagsWithLineLevel,
  firstNonEmptyPoLineArray,
  isLobWorktag,
  mapPoSplitsToSupplierInvoiceSplitLineData,
  mergePassthroughWorktagReferences,
  mergePurchaseOrderLineWorktags,
  passthroughWorktagsForSplitInvoiceLine,
} from '../lib/po_worktags.js';

const makeWorktag = (type: string, value: string) => ({
  ID: [
    { $attributes: { type: 'WID' }, $value: `wid-${value}` },
    { $attributes: { type }, $value: value },
  ],
});

const makeOrgWorktag = (value: string, wid?: string) => ({
  ID: [
    { $attributes: { type: 'WID' }, $value: wid ?? `wid-${value}` },
    { $attributes: { type: 'Organization_Reference_ID' }, $value: value },
    { $attributes: { type: 'Custom_Organization_Reference_ID' }, $value: value },
  ],
});

describe('po_worktags', () => {
  it('dedupeWorktagReferences keeps one entry per non-WID id', () => {
    const tag = makeWorktag('Fund_ID', 'FUND-A');
    expect(dedupeWorktagReferences([tag, tag])).toEqual([tag]);
  });

  it('mergePurchaseOrderLineWorktags combines line, additional, and split worktags', () => {
    const program = makeWorktag('Custom_Worktag_01_ID', 'PROGRAM-A');
    const fund = makeWorktag('Fund_ID', 'FUND-A');
    const cc = makeWorktag('Cost_Center_Reference_ID', 'CC-A');
    const { worktagsReference, splitLineData } = mergePurchaseOrderLineWorktags(
      {
        Worktags_Reference: [fund],
        Purchase_Order_Line_Worktags_Data: [{ Worktag_Reference: [program] }],
        Service_Purchase_Order_Line_Split_Data: [
          { Worktag_Reference: [cc], Extended_Amount: 60 },
          { Worktag_Reference: [cc], Extended_Amount: 40 },
        ],
      },
      'Service_Purchase_Order_Line_Split_Data'
    );

    expect(worktagsReference).toEqual([fund, program, cc]);
    expect(splitLineData).toHaveLength(2);
    expect(splitLineData[0].extendedAmount).toBe(60);
  });

  it('mergePassthroughWorktagReferences appends non-duplicate passthrough worktags', () => {
    const fund = makeWorktag('Fund_ID', 'FUND-A');
    const program = makeWorktag('Custom_Worktag_01_ID', 'PROGRAM-A');
    const merged = mergePassthroughWorktagReferences([fund], [fund, program]);
    expect(merged).toEqual([fund, program]);
  });

  it('mergePassthroughWorktagReferences skips passthrough when scalar already has that worktag type', () => {
    const emailFund = makeWorktag('Fund_ID', 'FUND-EMAIL');
    const poFund = makeWorktag('Fund_ID', 'FUND-PO');
    const merged = mergePassthroughWorktagReferences([emailFund], [poFund]);
    expect(merged).toEqual([emailFund]);
  });

  it('mapPoSplitsToSupplierInvoiceSplitLineData includes amounts when split sum matches invoice line', () => {
    const cc = makeWorktag('Cost_Center_Reference_ID', 'CC-A');
    const mapped = mapPoSplitsToSupplierInvoiceSplitLineData(
      [{ extendedAmount: 60, worktagReference: [cc] }, { extendedAmount: 40, worktagReference: [cc] }],
      100
    );
    expect(mapped).toEqual([
      { Extended_Amount: 60, Worktag_Reference: [cc] },
      { Extended_Amount: 40, Worktag_Reference: [cc] },
    ]);
  });

  it('mapPoSplitsToSupplierInvoiceSplitLineData scales amounts when split sum mismatches invoice line', () => {
    const cc = makeWorktag('Cost_Center_Reference_ID', 'CC-A');
    const mapped = mapPoSplitsToSupplierInvoiceSplitLineData(
      [{ extendedAmount: 60, worktagReference: [cc] }, { extendedAmount: 40, worktagReference: [cc] }],
      50
    );
    expect(mapped).toEqual([
      { Extended_Amount: 30, Worktag_Reference: [cc] },
      { Extended_Amount: 20, Worktag_Reference: [cc] },
    ]);
  });

  it('passthroughWorktagsForSplitInvoiceLine drops fund and cost center on split lines', () => {
    const fund = makeWorktag('Fund_ID', 'FUND-A');
    const cc = makeWorktag('Cost_Center_Reference_ID', 'CC-A');
    const venue = makeWorktag('Custom_Worktag_01_ID', 'VENUE-A');
    const filtered = passthroughWorktagsForSplitInvoiceLine([fund, cc, venue], true);
    expect(filtered).toEqual([venue]);
  });

  it('passthroughWorktagsForSplitInvoiceLine keeps org venue/event but strips LOB on splits', () => {
    const fund = makeWorktag('Fund_ID', 'FUND-A');
    const venue = makeOrgWorktag('VENU-Contestant_Indirect');
    const event = makeOrgWorktag('2026-PGA_Championship');
    const lob = makeOrgWorktag('LOB-Technology_Services');
    const filtered = passthroughWorktagsForSplitInvoiceLine(
      [fund, venue, event, lob],
      true,
      { lineOfBusinessId: 'LOB-Technology_Services' }
    );
    expect(filtered).toEqual([venue, event]);
  });

  it('isLobWorktag distinguishes LOB from venue via related cache', () => {
    const related = {
      requiredOnTransaction: false,
      defaultReferenceId: 'Building Services',
      allowedReferenceIds: ['Building Services'],
      defaultIds: [{ type: 'Organization_Reference_ID', value: 'Building Services' }],
      allowedIds: [{ type: 'Organization_Reference_ID', value: 'Building Services' }],
    };
    expect(isLobWorktag(makeOrgWorktag('Building Services'), related)).toBe(true);
    expect(isLobWorktag(makeOrgWorktag('VENU-Contestant_Indirect'), related)).toBe(false);
    expect(isLobWorktag(makeOrgWorktag('2026-PGA_Championship'), related)).toBe(false);
  });

  it('mergePassthroughWorktagReferences allows org venue alongside org LOB', () => {
    const lobScalar = makeWorktag('Organization_Reference_ID', 'LOB-Technology_Services');
    const venue = makeOrgWorktag('VENU-Contestant_Indirect');
    const merged = mergePassthroughWorktagReferences(
      [lobScalar],
      [venue],
      { lineOfBusinessId: 'LOB-Technology_Services' }
    );
    expect(merged).toEqual([lobScalar, venue]);
  });

  it('mergePassthroughWorktagReferences skips duplicate LOB org but keeps venue', () => {
    const lobScalar = makeWorktag('Organization_Reference_ID', 'LOB-Technology_Services');
    const lobPo = makeOrgWorktag('LOB-Technology_Services');
    const venue = makeOrgWorktag('VENU-Contestant_Indirect');
    const merged = mergePassthroughWorktagReferences(
      [lobScalar],
      [lobPo, venue],
      { lineOfBusinessId: 'LOB-Technology_Services' }
    );
    expect(merged).toEqual([lobScalar, venue]);
  });

  it('mergePassthroughWorktagReferences skips org passthrough sharing a WID with base', () => {
    const base = [{ ID: [{ $attributes: { type: 'WID' }, $value: 'event-wid-1' }] }];
    const sameEvent = makeOrgWorktag('2026-PGA_Championship', 'event-wid-1');
    const merged = mergePassthroughWorktagReferences(base, [sameEvent]);
    expect(merged).toEqual(base);
  });

  it('mergePassthroughWorktagReferences lets PO fund replace fallback fund', () => {
    const prev = process.env.FALLBACK_FUND_ID;
    process.env.FALLBACK_FUND_ID = 'FUND-FALLBACK';
    try {
      const fallback = makeWorktag('Fund_ID', 'FUND-FALLBACK');
      const poFund = makeWorktag('Fund_ID', 'FUND-PO');
      expect(mergePassthroughWorktagReferences([fallback], [poFund])).toEqual([poFund]);

      const real = makeWorktag('Fund_ID', 'FUND-EMAIL');
      expect(mergePassthroughWorktagReferences([real], [poFund])).toEqual([real]);
    } finally {
      if (prev === undefined) delete process.env.FALLBACK_FUND_ID;
      else process.env.FALLBACK_FUND_ID = prev;
    }
  });

  it('mergePassthroughWorktagReferences lets PO LOB replace fallback LOB', () => {
    const prev = process.env.FALLBACK_LOB_ID;
    process.env.FALLBACK_LOB_ID = 'LOB-Fallback';
    try {
      const fallback = makeWorktag('Organization_Reference_ID', 'LOB-Fallback');
      const poLob = makeOrgWorktag('LOB-Technology_Services');
      const venue = makeOrgWorktag('VENU-Contestant_Indirect');
      const merged = mergePassthroughWorktagReferences([fallback], [poLob, venue], {
        lineOfBusinessId: 'LOB-Fallback',
      });
      expect(merged).toEqual([poLob, venue]);
    } finally {
      if (prev === undefined) delete process.env.FALLBACK_LOB_ID;
      else process.env.FALLBACK_LOB_ID = prev;
    }
  });

  it('passthroughWorktagsForSplitInvoiceLine keeps shared fund when splits lack it', () => {
    const fund = makeWorktag('Fund_ID', 'FUND-PO');
    const venue = makeOrgWorktag('VENU-Contestant_Indirect');
    const cc = makeWorktag('Cost_Center_Reference_ID', 'CC-A');
    const splitsWithoutFund = [
      { extendedAmount: 60, worktagReference: [cc] },
      { extendedAmount: 40, worktagReference: [cc] },
    ];
    expect(passthroughWorktagsForSplitInvoiceLine([fund, venue], splitsWithoutFund)).toEqual([
      fund,
      venue,
    ]);

    const splitsWithFund = [
      { extendedAmount: 60, worktagReference: [fund, cc] },
      { extendedAmount: 40, worktagReference: [fund, cc] },
    ];
    expect(passthroughWorktagsForSplitInvoiceLine([fund, venue], splitsWithFund)).toEqual([venue]);
  });

  it('enrichSplitWorktagsWithLineLevel copies venue/custom to splits lacking them', () => {
    const venue = makeOrgWorktag('VENU-Contestant_Indirect');
    const custom = makeWorktag('Custom_Worktag_01_ID', 'PROGRAM-A');
    const fund = makeWorktag('Fund_ID', 'FUND-PO');
    const lob = makeOrgWorktag('LOB-Technology_Services');
    const cc = makeWorktag('Cost_Center_Reference_ID', 'CC-A');

    expect(enrichSplitWorktagsWithLineLevel([cc], [venue, custom, fund, lob])).toEqual([
      cc,
      venue,
      custom,
    ]);
    expect(enrichSplitWorktagsWithLineLevel([cc, venue], [venue])).toEqual([cc, venue]);
    expect(
      enrichSplitWorktagsWithLineLevel([makeWorktag('Custom_Worktag_01_ID', 'PROGRAM-B')], [custom])
    ).toEqual([makeWorktag('Custom_Worktag_01_ID', 'PROGRAM-B')]);
  });

  it('mapPoSplitsToSupplierInvoiceSplitLineData inherits line venue on splits', () => {
    const cc = makeWorktag('Cost_Center_Reference_ID', 'CC-A');
    const venue = makeOrgWorktag('VENU-Contestant_Indirect');
    const mapped = mapPoSplitsToSupplierInvoiceSplitLineData(
      [{ extendedAmount: 60, worktagReference: [cc] }],
      60,
      [venue]
    );
    expect(mapped?.[0].Worktag_Reference).toEqual([cc, venue]);
  });

  it('firstNonEmptyPoLineArray prefers first non-empty source', () => {
    expect(firstNonEmptyPoLineArray([], [{ id: 1 }], [{ id: 2 }])).toEqual([{ id: 1 }]);
    expect(firstNonEmptyPoLineArray(undefined, [], [{ id: 2 }])).toEqual([{ id: 2 }]);
  });
});
