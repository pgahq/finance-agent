import {
  dedupeWorktagReferences,
  firstNonEmptyPoLineArray,
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

  it('mapPoSplitsToSupplierInvoiceSplitLineData omits amounts when split sum mismatches invoice line', () => {
    const cc = makeWorktag('Cost_Center_Reference_ID', 'CC-A');
    const mapped = mapPoSplitsToSupplierInvoiceSplitLineData(
      [{ extendedAmount: 60, worktagReference: [cc] }, { extendedAmount: 40, worktagReference: [cc] }],
      99
    );
    expect(mapped).toEqual([
      { Worktag_Reference: [cc] },
      { Worktag_Reference: [cc] },
    ]);
  });

  it('passthroughWorktagsForSplitInvoiceLine drops fund and cost center on split lines', () => {
    const fund = makeWorktag('Fund_ID', 'FUND-A');
    const cc = makeWorktag('Cost_Center_Reference_ID', 'CC-A');
    const venue = makeWorktag('Custom_Worktag_01_ID', 'VENUE-A');
    const filtered = passthroughWorktagsForSplitInvoiceLine([fund, cc, venue], true);
    expect(filtered).toEqual([venue]);
  });

  it('firstNonEmptyPoLineArray prefers first non-empty source', () => {
    expect(firstNonEmptyPoLineArray([], [{ id: 1 }], [{ id: 2 }])).toEqual([{ id: 1 }]);
    expect(firstNonEmptyPoLineArray(undefined, [], [{ id: 2 }])).toEqual([{ id: 2 }]);
  });
});
