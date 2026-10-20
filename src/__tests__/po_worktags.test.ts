import {
  allocateSplitQuantities,
  collapseWorktagsToOnePerType,
  dedupeWorktagReferences,
  enrichSplitWorktagsWithLineLevel,
  firstNonEmptyPoLineArray,
  isLobWorktag,
  isQuantityDistributedSplits,
  lineOrdersExceedingQuantityPoLine,
  mapPoSplitsToSupplierInvoiceSplitLineData,
  mergePassthroughWorktagReferences,
  mergePurchaseOrderLineWorktags,
  passthroughWorktagsForSplitInvoiceLine,
  replaceCostCenterWorktagsWithFallback,
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

  it('mergePassthroughWorktagReferences lets PO cost center replace fallback cost center', () => {
    const prev = process.env.FALLBACK_COST_CENTER_ID;
    process.env.FALLBACK_COST_CENTER_ID = 'CC0000';
    try {
      const fallback = makeWorktag('Cost_Center_Reference_ID', 'CC0000');
      const poCc = makeWorktag('Cost_Center_Reference_ID', 'CC-2025 Ryder Cup Nextgengolf Inc');
      expect(mergePassthroughWorktagReferences([fallback], [poCc])).toEqual([poCc]);

      const real = makeWorktag('Cost_Center_Reference_ID', 'CC-EMAIL');
      expect(mergePassthroughWorktagReferences([real], [poCc])).toEqual([real]);
    } finally {
      if (prev === undefined) delete process.env.FALLBACK_COST_CENTER_ID;
      else process.env.FALLBACK_COST_CENTER_ID = prev;
    }
  });

  it('mergePassthroughWorktagReferences keeps fallback cost center when locked', () => {
    const prev = process.env.FALLBACK_COST_CENTER_ID;
    process.env.FALLBACK_COST_CENTER_ID = 'CC0000';
    try {
      const fallback = makeWorktag('Cost_Center_Reference_ID', 'CC0000');
      const poCc = makeWorktag('Cost_Center_Reference_ID', 'CC-2025 Ryder Cup Nextgengolf Inc');
      const venue = makeWorktag('Custom_Worktag_01_ID', 'VENUE-A');
      const merged = mergePassthroughWorktagReferences([fallback], [poCc, venue], {
        lockFallbackCostCenter: true,
      });
      expect(merged).toEqual([fallback, venue]);
    } finally {
      if (prev === undefined) delete process.env.FALLBACK_COST_CENTER_ID;
      else process.env.FALLBACK_COST_CENTER_ID = prev;
    }
  });

  it('replaceCostCenterWorktagsWithFallback leaves a single fallback cost center on the parent', () => {
    const fallback = makeWorktag('Cost_Center_Reference_ID', 'CC0000');
    const original = makeWorktag('Cost_Center_Reference_ID', 'CC-PO');
    const fund = makeWorktag('Fund_ID', 'FUND-A');
    const { worktags, supplierInvoiceSplitLineData } = replaceCostCenterWorktagsWithFallback(
      [fund, original, fallback],
      undefined,
      fallback
    );
    expect(worktags).toEqual([fund, fallback]);
    expect(supplierInvoiceSplitLineData).toBeUndefined();
  });

  it('replaceCostCenterWorktagsWithFallback moves fallback cost center onto splits and strips the parent', () => {
    const fallback = makeWorktag('Cost_Center_Reference_ID', 'CC0000');
    const original = makeWorktag('Cost_Center_Reference_ID', 'CC-PO');
    const venue = makeWorktag('Custom_Worktag_01_ID', 'VENUE-A');
    const { worktags, supplierInvoiceSplitLineData } = replaceCostCenterWorktagsWithFallback(
      [original, venue],
      [
        { Extended_Amount: 60, Worktag_Reference: [original] },
        { Extended_Amount: 40, Worktag_Reference: [original] },
      ],
      fallback
    );
    expect(worktags).toEqual([venue]);
    expect(supplierInvoiceSplitLineData).toEqual([
      { Extended_Amount: 60, Worktag_Reference: [fallback] },
      { Extended_Amount: 40, Worktag_Reference: [fallback] },
    ]);
  });

  it('replaceCostCenterWorktagsWithFallback puts fallback on every split when only some already have a cost center', () => {
    const fallback = makeWorktag('Cost_Center_Reference_ID', 'CC0000');
    const original = makeWorktag('Cost_Center_Reference_ID', 'CC-PO');
    const venue = makeWorktag('Custom_Worktag_01_ID', 'VENUE-A');
    const { worktags, supplierInvoiceSplitLineData } = replaceCostCenterWorktagsWithFallback(
      [original, venue],
      [
        { Extended_Amount: 60, Worktag_Reference: [original] },
        { Extended_Amount: 40, Worktag_Reference: [venue] },
      ],
      fallback
    );
    expect(worktags).toEqual([venue]);
    expect(supplierInvoiceSplitLineData).toEqual([
      { Extended_Amount: 60, Worktag_Reference: [fallback] },
      { Extended_Amount: 40, Worktag_Reference: [venue, fallback] },
    ]);
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

  it('mergePassthroughWorktagReferences lets a cached PO LOB replace fallback LOB', () => {
    const prev = process.env.FALLBACK_LOB_ID;
    process.env.FALLBACK_LOB_ID = 'LOB-Corporate';
    try {
      const fallback = makeWorktag('Organization_Reference_ID', 'LOB-Corporate');
      const poLob = makeOrgWorktag('Corporate_Communications', 'wid-lob-corporate-comms');
      const merged = mergePassthroughWorktagReferences([fallback], [poLob], {
        lineOfBusinessId: 'LOB-Corporate',
        orgKinds: new Map([['wid-lob-corporate-comms', 'lob']]),
      });
      expect(merged).toEqual([poLob]);
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

  describe('collapseWorktagsToOnePerType', () => {
    it('keeps the first worktag of each non-organization SOAP type', () => {
      const fundA = makeWorktag('Fund_ID', 'FUND-A');
      const fundB = makeWorktag('Fund_ID', 'FUND-B');
      const cc = makeWorktag('Cost_Center_Reference_ID', 'CC-A');
      const { worktags, dropped } = collapseWorktagsToOnePerType([fundA, cc, fundB]);
      expect(worktags).toEqual([fundA, cc]);
      expect(dropped).toEqual([fundB]);
    });

    it('drops a PO LOB the cache types as LOB when the line already has an LOB, and keeps venue', () => {
      const scalarLob = { ID: [{ $attributes: { type: 'Organization_Reference_ID' }, $value: 'LOB-Communications' }] };
      const poLob = makeOrgWorktag('Corporate_Communications', 'wid-lob-corporate-comms');
      const venue = makeOrgWorktag('VENU-Corporate', 'wid-venue');
      const { worktags, dropped } = collapseWorktagsToOnePerType([scalarLob, poLob, venue], {
        lineOfBusinessId: 'LOB-Communications',
        orgKinds: new Map([['wid-lob-corporate-comms', 'lob']]),
      });
      expect(worktags).toEqual([scalarLob, venue]);
      expect(dropped).toEqual([poLob]);
    });

    it('keeps one event when two different events are typed by the cache', () => {
      const eventA = makeOrgWorktag('2026-Womens_PGA_Championship', 'wid-event-a');
      const eventB = makeOrgWorktag('2026-KPMG_Womens_PGA', 'wid-event-b');
      const cc = makeWorktag('Cost_Center_Reference_ID', 'CC-A');
      const { worktags } = collapseWorktagsToOnePerType([cc, eventA, eventB], {
        orgKinds: new Map([['wid-event-a', 'event'], ['wid-event-b', 'event']]),
      });
      expect(worktags).toEqual([cc, eventA]);
    });

    it('replaces a kept fallback LOB with a later real LOB', () => {
      const prev = process.env.FALLBACK_LOB_ID;
      process.env.FALLBACK_LOB_ID = 'LOB-Corporate';
      try {
        const fallbackLob = { ID: [{ $attributes: { type: 'Organization_Reference_ID' }, $value: 'LOB-Corporate' }] };
        const poLob = makeOrgWorktag('Corporate_Communications', 'wid-lob-corporate-comms');
        const { worktags, dropped } = collapseWorktagsToOnePerType([fallbackLob, poLob], {
          orgKinds: new Map([['wid-lob-corporate-comms', 'lob']]),
        });
        expect(worktags).toEqual([poLob]);
        expect(dropped).toEqual([fallbackLob]);
      } finally {
        if (prev === undefined) delete process.env.FALLBACK_LOB_ID;
        else process.env.FALLBACK_LOB_ID = prev;
      }
    });

    it('treats LOB- prefixed organization tags as LOB without the cache', () => {
      const lobA = makeOrgWorktag('LOB-Technology_Services');
      const lobB = makeOrgWorktag('LOB-Facilities');
      expect(collapseWorktagsToOnePerType([lobA, lobB]).worktags).toEqual([lobA]);
    });

    it('keeps organization tags it cannot type, dropping only exact repeats', () => {
      const venueA = makeOrgWorktag('VENU-A');
      const venueB = makeOrgWorktag('VENU-B');
      const { worktags, dropped } = collapseWorktagsToOnePerType([venueA, venueB, venueA]);
      expect(worktags).toEqual([venueA, venueB]);
      expect(dropped).toEqual([venueA]);
    });
  });

  describe('Workday cost center and LOB refs (Organization_Reference_ID alongside the specific ID)', () => {
    const makeCostCenter = (value: string) => ({
      ID: [
        { $attributes: { type: 'WID' }, $value: `wid-${value}` },
        { $attributes: { type: 'Organization_Reference_ID' }, $value: value },
        { $attributes: { type: 'Cost_Center_Reference_ID' }, $value: value },
      ],
    });
    const fund = makeWorktag('Fund_ID', 'FUND-General_Fund_Unrestricted');
    const lobExec = makeOrgWorktag('LOB-Executive');
    const lobPd = makeOrgWorktag('LOB-Partnership_Development');
    const ccExec = makeCostCenter('CC-Executive_Dept');
    const ccPd = makeCostCenter('CC-Partnership_Development');
    const poLine = {
      Goods_Purchase_Order_Line_Split_Data: [
        { Quantity: 1, Extended_Amount: 251.5, Worktag_Reference: [lobExec, fund, ccExec] },
        { Quantity: 1, Extended_Amount: 251.5, Worktag_Reference: [lobPd, fund, ccPd] },
      ],
    };
    const ids = (tags: any[] = []) => tags.map(tag => tag.ID.find((id: any) => id.$attributes.type !== 'WID').$value);

    it('keeps each split with its own cost center and LOB (PO-414594)', () => {
      const merged = mergePurchaseOrderLineWorktags(poLine, 'Goods_Purchase_Order_Line_Split_Data');
      const passthrough = passthroughWorktagsForSplitInvoiceLine(merged.worktagsReference, merged.splitLineData, {});
      const splits = mapPoSplitsToSupplierInvoiceSplitLineData(merged.splitLineData, 408, passthrough, {});

      expect(ids(passthrough)).toEqual([]);
      expect(splits!.map(split => ids(collapseWorktagsToOnePerType(split.Worktag_Reference).worktags))).toEqual([
        ['LOB-Executive', 'FUND-General_Fund_Unrestricted', 'CC-Executive_Dept'],
        ['LOB-Partnership_Development', 'FUND-General_Fund_Unrestricted', 'CC-Partnership_Development'],
      ]);
    });

    it('does not copy a sibling split cost center onto a split from line-level worktags', () => {
      const enriched = enrichSplitWorktagsWithLineLevel([lobExec, fund, ccExec], [ccExec, ccPd]);
      expect(ids(enriched)).toEqual(['LOB-Executive', 'FUND-General_Fund_Unrestricted', 'CC-Executive_Dept']);
    });

    it('collapses duplicate real cost centers to one per line', () => {
      const { worktags, dropped } = collapseWorktagsToOnePerType([ccExec, ccPd]);
      expect(ids(worktags)).toEqual(['CC-Executive_Dept']);
      expect(ids(dropped)).toEqual(['CC-Partnership_Development']);
    });

    it('replaceCostCenterWorktagsWithFallback recognizes real cost centers on splits', () => {
      const fallback = makeWorktag('Cost_Center_Reference_ID', 'CC0000');
      const result = replaceCostCenterWorktagsWithFallback(
        [],
        [{ Worktag_Reference: [lobExec, ccExec] }, { Worktag_Reference: [lobPd, ccPd] }],
        fallback
      );
      expect(result.supplierInvoiceSplitLineData!.map(split => ids(split.Worktag_Reference))).toEqual([
        ['LOB-Executive', 'CC0000'],
        ['LOB-Partnership_Development', 'CC0000'],
      ]);
    });
  });

  describe('quantity-distributed PO line splits', () => {
    const cc = (value: string) => makeWorktag('Cost_Center_Reference_ID', value);
    const split = (quantity: number | undefined, extendedAmount: number, value: string) => ({
      ...(quantity !== undefined && { quantity }),
      extendedAmount,
      worktagReference: [cc(value)],
    });
    const poSplits = [split(1, 251.5, 'CC-A'), split(1, 251.5, 'CC-B')];

    it('detects quantity distribution only when every split carries a positive quantity', () => {
      expect(isQuantityDistributedSplits(poSplits)).toBe(true);
      expect(isQuantityDistributedSplits([split(1, 10, 'CC-A'), split(undefined, 10, 'CC-B')])).toBe(false);
      expect(isQuantityDistributedSplits([split(0, 10, 'CC-A'), split(0, 10, 'CC-B')])).toBe(false);
      expect(isQuantityDistributedSplits([])).toBe(false);
      expect(isQuantityDistributedSplits(undefined)).toBe(false);
    });

    it('emits whole split quantities that sum to the invoice line quantity and amounts of quantity x unit cost', () => {
      const result = mapPoSplitsToSupplierInvoiceSplitLineData(poSplits, 408, [], undefined, { quantity: 2, unitCost: 204 });
      expect(result!.map(({ Quantity, Extended_Amount }) => ({ Quantity, Extended_Amount }))).toEqual([
        { Quantity: 1, Extended_Amount: 204 },
        { Quantity: 1, Extended_Amount: 204 },
      ]);
    });

    it('follows the PO split ratio for uneven splits', () => {
      const uneven = [split(3, 300, 'CC-A'), split(1, 100, 'CC-B')];
      const result = mapPoSplitsToSupplierInvoiceSplitLineData(uneven, 800, [], undefined, { quantity: 8, unitCost: 100 });
      expect(result!.map(row => row.Quantity)).toEqual([6, 2]);
      expect(result!.map(row => row.Extended_Amount)).toEqual([600, 200]);
    });

    it('uses largest-remainder whole quantities when the ratio does not divide evenly', () => {
      expect(allocateSplitQuantities(poSplits, 3)).toEqual([2, 1]);
      expect(allocateSplitQuantities([split(1, 1, 'A'), split(1, 1, 'B'), split(1, 1, 'C')], 10)).toEqual([4, 3, 3]);
      const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
      expect(sum(allocateSplitQuantities([split(2, 1, 'A'), split(3, 1, 'B'), split(5, 1, 'C')], 7))).toBe(7);
    });

    it('never gives a split zero units: lopsided PO weights fall back to fractional quantities', () => {
      const lopsided = [split(1, 100, 'CC-A'), split(9, 900, 'CC-B')];
      const quantities = allocateSplitQuantities(lopsided, 2);
      expect(quantities).toEqual([0.2, 1.8]);
      expect(quantities.every(value => value > 0)).toBe(true);
    });

    it('prices splits from the line total when it disagrees with quantity x unit cost', () => {
      const result = mapPoSplitsToSupplierInvoiceSplitLineData(poSplits, 400, [], undefined, { quantity: 2, unitCost: 204 });
      expect(result!.map(row => row.Quantity)).toEqual([1, 1]);
      expect(result!.map(row => row.Extended_Amount)).toEqual([200, 200]);
    });

    it('falls back to fractional quantities when the line quantity cannot give every split a whole unit', () => {
      expect(allocateSplitQuantities(poSplits, 1)).toEqual([0.5, 0.5]);
      expect(allocateSplitQuantities(poSplits, 2.5)).toEqual([1.25, 1.25]);
    });

    it('puts rounding drift in the last split amount so the splits sum to the line amount', () => {
      const three = [split(1, 1, 'A'), split(1, 1, 'B'), split(1, 1, 'C')];
      const result = mapPoSplitsToSupplierInvoiceSplitLineData(three, 100, [], undefined, { quantity: 3, unitCost: 33.33 });
      expect(result!.map(row => row.Quantity)).toEqual([1, 1, 1]);
      expect(result!.reduce((sum, row) => sum + row.Extended_Amount, 0)).toBeCloseTo(100, 2);
    });

    it('derives unit cost from the extended amount when none is given', () => {
      const result = mapPoSplitsToSupplierInvoiceSplitLineData(poSplits, 100, [], undefined, { quantity: 2 });
      expect(result!.map(row => row.Extended_Amount)).toEqual([50, 50]);
    });

    it('keeps amount-only splits (no Quantity) for PO lines split by amount', () => {
      const byAmount = [split(undefined, 100, 'CC-A'), split(undefined, 300, 'CC-B')];
      const result = mapPoSplitsToSupplierInvoiceSplitLineData(byAmount, 400, [], undefined, { quantity: 4, unitCost: 100 });
      expect(result!.every(row => row.Quantity === undefined)).toBe(true);
      expect(result!.map(row => row.Extended_Amount)).toEqual([100, 300]);
    });

    it('omits Quantity when no quantity context is supplied, scaling PO split amounts to the line', () => {
      const result = mapPoSplitsToSupplierInvoiceSplitLineData(poSplits, 95);
      expect(result!.every(row => row.Quantity === undefined)).toBe(true);
      expect(result!.map(row => row.Extended_Amount)).toEqual([47.5, 47.5]);
    });

    it('emits a single split carrying the whole line quantity', () => {
      const result = mapPoSplitsToSupplierInvoiceSplitLineData([split(5, 500, 'CC-A')], 300, [], undefined, { quantity: 3, unitCost: 100 });
      expect(result).toEqual([expect.objectContaining({ Quantity: 3, Extended_Amount: 300 })]);
    });
  });

  describe('splits priced from a line total that differs from quantity x PO unit cost by rounding (Semicolon 26-2177)', () => {
    const split = (quantity: number) => ({ quantity, extendedAmount: 0, worktagReference: [] });
    const amountsOf = (rows: any[] | undefined) => rows?.map(row => [row.Quantity, row.Extended_Amount]);

    it.each([
      ['Sintra signs', [14, 40], 54, 238.679815, 12888.71, [[14, 3341.52], [40, 9547.19]]],
      ['Alumacorr footers', [6, 6], 12, 212.5325, 2550.39, [[6, 1275.2], [6, 1275.19]]],
      ['Cut vinyl', [36, 40], 76, 10.715526, 814.38, [[36, 385.76], [40, 428.62]]],
    ])('splits %s so the amounts add up to the line total', (_name, quantities, quantity, unitCost, total, expected) => {
      const rows = mapPoSplitsToSupplierInvoiceSplitLineData(
        (quantities as number[]).map(split),
        total as number,
        undefined,
        undefined,
        { quantity: quantity as number, unitCost: unitCost as number }
      );
      expect(amountsOf(rows)).toEqual(expected);
      const sum = rows!.reduce((acc: number, row: any) => acc + Math.round(row.Extended_Amount * 100), 0);
      expect(sum).toBe(Math.round((total as number) * 100));
    });
  });

  describe('lineOrdersExceedingQuantityPoLine', () => {
    const splits = [
      { quantity: 1, extendedAmount: 251.5, worktagReference: [] },
      { quantity: 1, extendedAmount: 251.5, worktagReference: [] },
    ];

    it('lets the larger-quantity line keep the PO line and unlinks the extra charge (St. Andrews)', () => {
      const result = lineOrdersExceedingQuantityPoLine([
        { lineOrder: 1, purchaseOrderLineId: 'POL-1', quantity: 2, extendedAmount: 408, splits },
        { lineOrder: 2, purchaseOrderLineId: 'POL-1', quantity: 1, extendedAmount: 95, splits },
      ]);
      expect([...result]).toEqual([2]);
    });

    it('does not depend on line order', () => {
      const result = lineOrdersExceedingQuantityPoLine([
        { lineOrder: 1, purchaseOrderLineId: 'POL-1', quantity: 1, extendedAmount: 95, splits },
        { lineOrder: 2, purchaseOrderLineId: 'POL-1', quantity: 2, extendedAmount: 408, splits },
      ]);
      expect([...result]).toEqual([1]);
    });

    it('keeps every line that fits within the ordered quantity', () => {
      const result = lineOrdersExceedingQuantityPoLine([
        { lineOrder: 1, purchaseOrderLineId: 'POL-1', quantity: 1, extendedAmount: 100, splits },
        { lineOrder: 2, purchaseOrderLineId: 'POL-1', quantity: 1, extendedAmount: 100, splits },
      ]);
      expect(result.size).toBe(0);
    });

    it('ignores a single line, amount-distributed PO lines, and lines on different PO lines', () => {
      const byAmount = [{ extendedAmount: 100, worktagReference: [] }, { extendedAmount: 100, worktagReference: [] }];
      expect(lineOrdersExceedingQuantityPoLine([
        { lineOrder: 1, purchaseOrderLineId: 'POL-1', quantity: 5, splits },
      ]).size).toBe(0);
      expect(lineOrdersExceedingQuantityPoLine([
        { lineOrder: 1, purchaseOrderLineId: 'POL-1', quantity: 2, splits: byAmount },
        { lineOrder: 2, purchaseOrderLineId: 'POL-1', quantity: 2, splits: byAmount },
      ]).size).toBe(0);
      expect(lineOrdersExceedingQuantityPoLine([
        { lineOrder: 1, purchaseOrderLineId: 'POL-1', quantity: 2, splits },
        { lineOrder: 2, purchaseOrderLineId: 'POL-2', quantity: 2, splits },
      ]).size).toBe(0);
    });

    it('unlinks a zero-quantity line sharing a quantity PO line', () => {
      const result = lineOrdersExceedingQuantityPoLine([
        { lineOrder: 1, purchaseOrderLineId: 'POL-1', quantity: 2, extendedAmount: 408, splits },
        { lineOrder: 2, purchaseOrderLineId: 'POL-1', quantity: 0, extendedAmount: 95, splits },
      ]);
      expect([...result]).toEqual([2]);
    });
  });
});
