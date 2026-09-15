import {
  dedupeWorktagReferences,
  mapPoSplitsToSupplierInvoiceSplitLineData,
  mergePassthroughWorktagReferences,
  mergePurchaseOrderLineWorktags,
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

  it('mapPoSplitsToSupplierInvoiceSplitLineData maps split rows for submit', () => {
    const cc = makeWorktag('Cost_Center_Reference_ID', 'CC-A');
    const mapped = mapPoSplitsToSupplierInvoiceSplitLineData([
      { extendedAmount: 100, worktagReference: [cc] },
    ]);
    expect(mapped).toEqual([{ Extended_Amount: 100, Worktag_Reference: [cc] }]);
  });
});
