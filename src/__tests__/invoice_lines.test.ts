import {
  alignSupplierInvoiceLineAmounts,
  applyAmountOnlyLineRetry,
  applyDefaultCompanyLineWorktags,
  applyMissingQuantityColumnLines,
  applyRelatedLobWorktags,
  buildFinalInvoiceLines,
  chargeReconciliationMessages,
  constrainEmailLobToRelatedWorktags,
  extractedChargeCheck,
  formatChargeReconciliationNotes,
  FREIGHT_HEADER_FALLBACK_MESSAGE,
  mergeAmountCheckMessages,
  isFreightOrHandlingLine,
  overlayPoLineOfBusiness,
  overlayPoWorktagsFromPurchaseOrder,
  overlaySharedPoWorktagsOnUnmatchedLines,
  prepareInvoiceCharges,
  reconcileSubmittedCharges,
  resolveInvoiceLineQuantityDisplayed,
  splitFreightLines,
  statesServicePeriod,
  type FinalInvoiceLine,
} from '../lib/invoice_lines.js';
import { getAiResponse } from '../lib/ai.js';
import { mergeInvoiceLinesPromptFor } from '../prompts/merge_invoice_lines_prompt.js';
import { extractLineOfBusinessId } from '../lib/related_worktags.js';
import type { PurchaseOrderLine } from '../lib/workday.js';

jest.mock('@pga/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn()
}));

jest.mock('../lib/ai.js', () => ({
  getAiResponse: jest.fn()
}));

const mockGetAiResponse = getAiResponse as jest.MockedFunction<typeof getAiResponse>;

const makeWorktag = (type: string, value: string) => ({
  ID: [
    { $attributes: { type: 'WID' }, $value: `wid-${value}` },
    { $attributes: { type }, $value: value }
  ]
});

const poLine = (overrides: Partial<PurchaseOrderLine> = {}): PurchaseOrderLine => ({
  lineOrder: 1,
  purchaseOrderLineId: 'POL-001',
  purchaseOrderDocumentNumber: 'PO-123456',
  description: 'Building services',
  worktagsReference: [
    makeWorktag('Fund_ID', 'FUND-General_Fund_Unrestricted'),
    makeWorktag('Cost_Center_Reference_ID', 'CC-Building Services-PBG'),
    makeWorktag('Organization_Reference_ID', 'LOB-Facilities'),
  ],
  ...overrides,
});

describe('extractLineOfBusinessId', () => {
  it('returns Organization_Reference_ID values that start with LOB-', () => {
    expect(extractLineOfBusinessId([
      makeWorktag('Fund_ID', 'FUND-General_Fund_Unrestricted'),
      makeWorktag('Organization_Reference_ID', 'LOB-Facilities'),
      makeWorktag('Organization_Reference_ID', '2026-PGA_Championship'),
    ])).toBe('LOB-Facilities');
  });

  it('returns Custom_Organization_Reference_ID values that start with LOB-', () => {
    expect(extractLineOfBusinessId([
      makeWorktag('Custom_Organization_Reference_ID', 'LOB-Technology_Services'),
    ])).toBe('LOB-Technology_Services');
  });

  it('returns Default_Line_Of_Business', () => {
    expect(extractLineOfBusinessId([
      makeWorktag('Organization_Reference_ID', 'Default_Line_Of_Business'),
    ])).toBe('Default_Line_Of_Business');
  });

  it('returns null when no LOB worktag is present', () => {
    expect(extractLineOfBusinessId([
      makeWorktag('Cost_Center_Reference_ID', 'CC-Building Services-PBG'),
      makeWorktag('Organization_Reference_ID', '2026-PGA_Championship'),
    ])).toBeNull();
  });
});

describe('applyDefaultCompanyLineWorktags', () => {
  it('overwrites line worktags with Default OCR fallbacks and clears PO/event/ship-to', () => {
    const lines = applyDefaultCompanyLineWorktags(
      [{
        lineOrder: 1,
        description: 'Widgets',
        quantity: 2,
        unitCost: 50,
        costCenterId: '72200',
        fundId: 'fund-id',
        spendCategoryId: 'spend-id',
        lineOfBusinessId: 'lob-id',
        eventId: 'event-id',
        eventWid: 'event-wid',
        shipToAddressId: 'ADDR-1',
        purchaseOrderLineId: 'POL-B',
      }],
      {
        costCenterId: 'Default_OCR_Cost_Center',
        fundId: 'Default_OCR_Fund',
        spendCategoryId: 'Default_OCR_Spend_Category',
        lineOfBusinessId: 'Default_Line_Of_Business',
      }
    );

    expect(lines).toEqual([{
      lineOrder: 1,
      description: 'Widgets',
      quantity: 2,
      unitCost: 50,
      costCenterId: 'Default_OCR_Cost_Center',
      fundId: 'Default_OCR_Fund',
      spendCategoryId: 'Default_OCR_Spend_Category',
      lineOfBusinessId: 'Default_Line_Of_Business',
      eventId: null,
      eventWid: null,
      shipToAddressId: null,
      purchaseOrderLineId: null,
    }]);
  });
});

describe('overlayPoLineOfBusiness', () => {
  const baseLine = (overrides: Partial<FinalInvoiceLine> = {}): FinalInvoiceLine => ({
    lineOrder: 1,
    description: 'Service',
    ...overrides,
  });

  it('copies LOB from the matching PO line when merge left it null', () => {
    const lines = overlayPoLineOfBusiness(
      [baseLine({ purchaseOrderLineId: 'POL-001' })],
      [{
        lineOrder: 1,
        purchaseOrderLineId: 'POL-001',
        lineOfBusinessId: 'LOB-Facilities',
        costCenterId: 'CC-Building Services-PBG',
        fundId: null,
        spendCategoryId: null,
        worktagsReference: [],
        description: 'Service',
        memo: null,
        shipToAddressId: null,
        splitLineData: [],
      }]
    );

    expect(lines[0].lineOfBusinessId).toBe('LOB-Facilities');
  });

  it('does not overwrite an existing lineOfBusinessId', () => {
    const lines = overlayPoLineOfBusiness(
      [baseLine({ purchaseOrderLineId: 'POL-001', lineOfBusinessId: 'LOB-From-Email' })],
      [{
        lineOrder: 1,
        purchaseOrderLineId: 'POL-001',
        lineOfBusinessId: 'LOB-Facilities',
        costCenterId: null,
        fundId: null,
        spendCategoryId: null,
        worktagsReference: [],
        description: null,
        memo: null,
        shipToAddressId: null,
        splitLineData: [],
      }]
    );

    expect(lines[0].lineOfBusinessId).toBe('LOB-From-Email');
  });
});

describe('overlayPoWorktagsFromPurchaseOrder', () => {
  it('copies passthrough worktags and split rows from the matched PO line', () => {
    const program = makeWorktag('Custom_Worktag_01_ID', 'PROGRAM-A');
    const lines = overlayPoWorktagsFromPurchaseOrder(
      [{ lineOrder: 1, description: 'Service', purchaseOrderLineId: 'POL-001' }],
      [{
        lineOrder: 1,
        purchaseOrderLineId: 'POL-001',
        lineOfBusinessId: null,
        costCenterId: 'CC-100',
        fundId: null,
        spendCategoryId: null,
        worktagsReference: [program],
        description: null,
        memo: null,
        shipToAddressId: null,
        splitLineData: [{ extendedAmount: 50, worktagReference: [program] }],
      }]
    );

    expect(lines[0].poPassthroughWorktagsReference).toEqual([program]);
    expect(lines[0].supplierInvoiceSplitLineData).toHaveLength(1);
  });

  it('copies shared PO worktags to unmatched lines without splits', () => {
    const venue = makeWorktag('Organization_Reference_ID', 'VENU-Contestant_Indirect');
    const fundA = makeWorktag('Fund_ID', 'FUND-A');
    const fundB = makeWorktag('Fund_ID', 'FUND-B');
    const lines = overlayPoWorktagsFromPurchaseOrder(
      [{ lineOrder: 1, description: 'Service', purchaseOrderLineId: null }],
      [
        {
          lineOrder: 1,
          purchaseOrderLineId: 'POL-001',
          lineOfBusinessId: null,
          costCenterId: null,
          fundId: 'FUND-A',
          spendCategoryId: null,
          worktagsReference: [venue, fundA],
          lineLevelWorktagsReference: [venue, fundA],
          description: null,
          memo: null,
          shipToAddressId: null,
          splitLineData: [],
        },
        {
          lineOrder: 2,
          purchaseOrderLineId: 'POL-002',
          lineOfBusinessId: null,
          costCenterId: null,
          fundId: 'FUND-B',
          spendCategoryId: null,
          worktagsReference: [venue, fundB],
          lineLevelWorktagsReference: [venue, fundB],
          description: null,
          memo: null,
          shipToAddressId: null,
          splitLineData: [],
        },
      ]
    );

    expect(lines[0].poPassthroughWorktagsReference).toEqual([venue]);
    expect(lines[0].supplierInvoiceSplitLineData).toBeUndefined();
  });
});

describe('overlaySharedPoWorktagsOnUnmatchedLines', () => {
  it('clears PO line id and splits then copies only shared additional worktags', () => {
    const venue = makeWorktag('Organization_Reference_ID', 'VENU-Contestant_Indirect');
    const fundA = makeWorktag('Fund_ID', 'FUND-A');
    const fundB = makeWorktag('Fund_ID', 'FUND-B');
    const lines = overlaySharedPoWorktagsOnUnmatchedLines(
      [{
        lineOrder: 1,
        description: 'Invoice',
        purchaseOrderLineId: 'POL-001',
        poPassthroughWorktagsReference: [fundA],
        supplierInvoiceSplitLineData: [{ extendedAmount: 100, worktagReference: [fundA] }],
      }],
      [
        poLine({
          purchaseOrderLineId: 'POL-001',
          worktagsReference: [venue, fundA],
          lineLevelWorktagsReference: [venue, fundA],
          splitLineData: [{ extendedAmount: 100, worktagReference: [fundA] }],
        }),
        poLine({
          lineOrder: 2,
          purchaseOrderLineId: 'POL-002',
          worktagsReference: [venue, fundB],
          lineLevelWorktagsReference: [venue, fundB],
          splitLineData: [],
        }),
      ]
    );

    expect(lines[0].purchaseOrderLineId).toBeNull();
    expect(lines[0].supplierInvoiceSplitLineData).toBeUndefined();
    expect(lines[0].poPassthroughWorktagsReference).toEqual([venue]);
  });
});

describe('applyRelatedLobWorktags', () => {
  it('fills default related LOB when the line has a cost center and no LOB', () => {
    const related = new Map([
      ['CC-Building Services-PBG', {
        requiredOnTransaction: true,
        defaultReferenceId: 'LOB-Facilities',
        allowedReferenceIds: ['LOB-Facilities'],
      }]
    ]);

    const lines = applyRelatedLobWorktags(
      [{ lineOrder: 1, description: 'Service', costCenterId: 'CC-Building Services-PBG' }],
      related,
      'CC0000'
    );

    expect(lines[0].lineOfBusinessId).toBe('LOB-Facilities');
  });

  it('uses the unique allowed LOB when there is no default', () => {
    const related = new Map([
      ['CC-001', {
        requiredOnTransaction: true,
        defaultReferenceId: null,
        allowedReferenceIds: ['LOB-Only'],
      }]
    ]);

    const lines = applyRelatedLobWorktags(
      [{ lineOrder: 1, description: 'Service', costCenterId: 'CC-001' }],
      related
    );

    expect(lines[0].lineOfBusinessId).toBe('LOB-Only');
  });

  it('does not fill an allowed LOB when multiple values exist and there is no default', () => {
    const related = new Map([
      ['CC-001', {
        requiredOnTransaction: true,
        defaultReferenceId: null,
        allowedReferenceIds: ['LOB-A', 'LOB-B'],
      }]
    ]);

    const lines = applyRelatedLobWorktags(
      [{ lineOrder: 1, description: 'Service', costCenterId: 'CC-001' }],
      related
    );

    expect(lines[0].lineOfBusinessId).toBeUndefined();
  });

  it('can fill any allowed LOB when replacing a fallback id', () => {
    const related = new Map([
      ['CC-001', {
        requiredOnTransaction: true,
        defaultReferenceId: null,
        allowedReferenceIds: ['LOB-A', 'LOB-B'],
      }]
    ]);

    const lines = applyRelatedLobWorktags(
      [{ lineOrder: 1, description: 'Service', costCenterId: 'CC-001', lineOfBusinessId: 'Default_Line_Of_Business' }],
      related,
      undefined,
      { replaceIds: ['Default_Line_Of_Business'], anyAllowed: true }
    );

    expect(lines[0].lineOfBusinessId).toBe('LOB-A');
  });

  it('replaces a disallowed LOB with the related default', () => {
    const related = new Map([
      ['CC-Other Broadcasting', {
        requiredOnTransaction: true,
        defaultReferenceId: 'LOB-Other_Broadcasting',
        allowedReferenceIds: ['LOB-Other_Broadcasting', 'LOB-TV'],
      }]
    ]);

    const lines = applyRelatedLobWorktags(
      [{ lineOrder: 1, description: 'Overtime', costCenterId: 'CC-Other Broadcasting', lineOfBusinessId: 'Event Broadcasting' }],
      related,
      undefined,
      { anyAllowed: true, replaceDisallowed: true }
    );

    expect(lines[0].lineOfBusinessId).toBe('LOB-Other_Broadcasting');
  });

  it('replaces a disallowed LOB with the first allowed value when there is no default', () => {
    const related = new Map([
      ['CC-Other Broadcasting', {
        requiredOnTransaction: true,
        defaultReferenceId: null,
        allowedReferenceIds: ['LOB-TV', 'LOB-Radio'],
      }]
    ]);

    const lines = applyRelatedLobWorktags(
      [{ lineOrder: 1, description: 'Overtime', costCenterId: 'CC-Other Broadcasting', lineOfBusinessId: 'Event Broadcasting' }],
      related,
      undefined,
      { anyAllowed: true, replaceDisallowed: true }
    );

    expect(lines[0].lineOfBusinessId).toBe('LOB-TV');
  });

  it('keeps a line already on the related default while replacing a disallowed LOB', () => {
    const related = new Map([
      ['CC-Other Broadcasting', {
        requiredOnTransaction: true,
        defaultReferenceId: 'LOB-Other_Broadcasting',
        allowedReferenceIds: ['LOB-Other_Broadcasting', 'LOB-TV'],
      }]
    ]);

    const lines = applyRelatedLobWorktags(
      [
        { lineOrder: 1, description: 'Overtime', costCenterId: 'CC-Other Broadcasting', lineOfBusinessId: 'Event Broadcasting' },
        { lineOrder: 2, description: 'Studio', costCenterId: 'CC-Other Broadcasting', lineOfBusinessId: 'LOB-Other_Broadcasting' },
      ],
      related,
      undefined,
      { anyAllowed: true, replaceDisallowed: true }
    );

    expect(lines[0].lineOfBusinessId).toBe('LOB-Other_Broadcasting');
    expect(lines[1].lineOfBusinessId).toBe('LOB-Other_Broadcasting');
  });

  it('replaces a rejected in-list LOB with the related default', () => {
    const related = new Map([
      ['CC-Other Broadcasting', {
        requiredOnTransaction: true,
        defaultReferenceId: 'LOB-Other_Broadcasting',
        allowedReferenceIds: ['LOB-Other_Broadcasting', 'Event Broadcasting'],
      }]
    ]);

    const lines = applyRelatedLobWorktags(
      [{ lineOrder: 1, description: 'Overtime', costCenterId: 'CC-Other Broadcasting', lineOfBusinessId: 'Event Broadcasting' }],
      related,
      undefined,
      { anyAllowed: true, replaceDisallowed: true }
    );

    expect(lines[0].lineOfBusinessId).toBe('LOB-Other_Broadcasting');
  });

  it('rewrites a rejected LOB- alias to the related catalog id', () => {
    const related = new Map([
      ['CC-Building Services-PBG', {
        requiredOnTransaction: true,
        defaultReferenceId: null,
        allowedReferenceIds: ['Building Services'],
      }]
    ]);

    const lines = applyRelatedLobWorktags(
      [{ lineOrder: 1, description: 'Janitorial', costCenterId: 'CC-Building Services-PBG', lineOfBusinessId: 'LOB-Building_Services' }],
      related,
      undefined,
      { anyAllowed: true, replaceDisallowed: true }
    );

    expect(lines[0].lineOfBusinessId).toBe('Building Services');
  });

  it('replaces Default_Line_Of_Business with a related allowed LOB', () => {
    const related = new Map([
      ['CC-001', {
        requiredOnTransaction: true,
        defaultReferenceId: null,
        allowedReferenceIds: ['LOB-Enterprise'],
      }]
    ]);

    const lines = applyRelatedLobWorktags(
      [{ lineOrder: 1, description: 'Service', costCenterId: 'CC-001', lineOfBusinessId: 'Default_Line_Of_Business' }],
      related,
      undefined,
      { replaceIds: ['Default_Line_Of_Business'] }
    );

    expect(lines[0].lineOfBusinessId).toBe('LOB-Enterprise');
  });

  it('skips the fallback cost center', () => {
    const related = new Map([
      ['CC0000', {
        requiredOnTransaction: true,
        defaultReferenceId: 'LOB-Should-Not-Apply',
        allowedReferenceIds: ['LOB-Should-Not-Apply'],
      }]
    ]);

    const lines = applyRelatedLobWorktags(
      [{ lineOrder: 1, description: 'Service', costCenterId: 'CC0000' }],
      related,
      'CC0000'
    );

    expect(lines[0].lineOfBusinessId).toBeUndefined();
  });
});

describe('constrainEmailLobToRelatedWorktags', () => {
  const related = new Map([
    ['CC-Other Broadcasting', {
      requiredOnTransaction: true,
      defaultReferenceId: 'LOB-Other_Broadcasting',
      allowedReferenceIds: ['LOB-Other_Broadcasting', 'LOB-TV'],
    }]
  ]);

  it('does not change lines when email has an LOB but no cost center', () => {
    const lines = constrainEmailLobToRelatedWorktags(
      [{ lineOrder: 1, description: 'Overtime', costCenterId: 'CC-Other Broadcasting', lineOfBusinessId: 'Event Broadcasting' }],
      related,
      { lobReferenceId: 'Event Broadcasting' }
    );

    expect(lines[0].lineOfBusinessId).toBe('Event Broadcasting');
  });

  it('replaces a catalog LOB with the related default when email has both cost center and LOB', () => {
    const lines = constrainEmailLobToRelatedWorktags(
      [{ lineOrder: 1, description: 'Overtime', costCenterId: 'CC-Other Broadcasting', lineOfBusinessId: 'Event Broadcasting' }],
      related,
      { costCenterId: 'CC-Other Broadcasting', lobReferenceId: 'Event Broadcasting' }
    );

    expect(lines[0].lineOfBusinessId).toBe('LOB-Other_Broadcasting');
  });

  it('keeps an email LOB that matches related allowed ids only by LOB- prefix', () => {
    const lines = constrainEmailLobToRelatedWorktags(
      [{ lineOrder: 1, description: 'Janitorial', costCenterId: 'CC-Building Services-PBG', lineOfBusinessId: 'LOB-Building_Services' }],
      new Map([
        ['CC-Building Services-PBG', {
          requiredOnTransaction: true,
          defaultReferenceId: null,
          allowedReferenceIds: ['Building Services'],
        }]
      ]),
      { costCenterId: 'CC-Building Services-PBG', lobReferenceId: 'LOB-Building_Services' }
    );

    expect(lines[0].lineOfBusinessId).toBe('LOB-Building_Services');
  });

  it('uses the unique allowed LOB when email has a catalog value and there is no default', () => {
    const lines = constrainEmailLobToRelatedWorktags(
      [{ lineOrder: 1, description: 'Overtime', costCenterId: 'CC-Other Broadcasting', lineOfBusinessId: 'Event Broadcasting' }],
      new Map([
        ['CC-Other Broadcasting', {
          requiredOnTransaction: true,
          defaultReferenceId: null,
          allowedReferenceIds: ['LOB-TV'],
        }]
      ]),
      { costCenterId: 'CC-Other Broadcasting', lobReferenceId: 'Event Broadcasting' }
    );

    expect(lines[0].lineOfBusinessId).toBe('LOB-TV');
  });

  it('keeps the email LOB when several allowed values exist and there is no default', () => {
    const lines = constrainEmailLobToRelatedWorktags(
      [{ lineOrder: 1, description: 'Overtime', costCenterId: 'CC-Other Broadcasting', lineOfBusinessId: 'Event Broadcasting' }],
      new Map([
        ['CC-Other Broadcasting', {
          requiredOnTransaction: true,
          defaultReferenceId: null,
          allowedReferenceIds: ['LOB-TV', 'LOB-Radio'],
        }]
      ]),
      { costCenterId: 'CC-Other Broadcasting', lobReferenceId: 'Event Broadcasting' }
    );

    expect(lines[0].lineOfBusinessId).toBe('Event Broadcasting');
  });
});

describe('buildFinalInvoiceLines', () => {
  const extracted = [{ description: 'Janitorial', quantity: 1, unitCost: '100', totalPrice: '100', hasDiscount: null }];

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.FALLBACK_COST_CENTER_ID;
  });

  it('pins the extracted description when merge returns a shortened category', async () => {
    mockGetAiResponse.mockResolvedValue({
      lines: [{
        lineOrder: 1,
        description: 'Services',
        memo: 'Project management services for Ryan Poland',
        quantity: 32,
        unitCost: 155,
        extendedAmount: 4960,
        costCenterId: null,
        fundId: null,
        spendCategoryId: null,
        lineOfBusinessId: null,
        eventId: null,
        shipToAddressId: null,
        purchaseOrderLineId: null,
        hasDiscount: null,
      }]
    } as any);

    const result = await buildFinalInvoiceLines(
      [{ description: 'Ryan Poland - Project Management', quantity: 32, unitCost: '155.00', totalPrice: '4,960.00', hasDiscount: null }],
      undefined,
      undefined,
      {}
    );

    expect(result.lines[0].description).toBe('Ryan Poland - Project Management');
    expect(result.lines[0].memo).toBe('Project management services for Ryan Poland');
  });

  it('overlays PO LOB when the merge model omits lineOfBusinessId', async () => {
    mockGetAiResponse.mockResolvedValue({
      lines: [{
        lineOrder: 1,
        description: 'Janitorial',
        memo: 'Janitorial services',
        quantity: 1,
        unitCost: 100,
        extendedAmount: 100,
        costCenterId: 'CC-Building Services-PBG',
        fundId: 'FUND-General_Fund_Unrestricted',
        spendCategoryId: null,
        lineOfBusinessId: null,
        eventId: null,
        shipToAddressId: null,
        purchaseOrderLineId: 'POL-001',
        hasDiscount: null,
      }]
    } as any);

    const result = await buildFinalInvoiceLines(
      extracted,
      [poLine()],
      undefined,
      {}
    );

    expect(result.lines[0].lineOfBusinessId).toBe('LOB-Facilities');
  });

  it('lets email LOB override the PO LOB', async () => {
    mockGetAiResponse.mockResolvedValue({
      lines: [{
        lineOrder: 1,
        description: 'Janitorial',
        memo: null,
        quantity: 1,
        unitCost: 100,
        extendedAmount: 100,
        costCenterId: 'CC-Building Services-PBG',
        fundId: null,
        spendCategoryId: null,
        lineOfBusinessId: 'LOB-Facilities',
        eventId: null,
        shipToAddressId: null,
        purchaseOrderLineId: 'POL-001',
        hasDiscount: null,
      }]
    } as any);

    const result = await buildFinalInvoiceLines(
      extracted,
      [poLine()],
      undefined,
      {},
      { lobReferenceId: 'LOB-From-Email' }
    );

    expect(result.lines[0].lineOfBusinessId).toBe('LOB-From-Email');
  });

  it('replaces an email LOB that is not allowed for the email cost center with the related default', async () => {
    mockGetAiResponse.mockResolvedValue({
      lines: [{
        lineOrder: 1,
        description: 'Janitorial',
        memo: null,
        quantity: 1,
        unitCost: 100,
        extendedAmount: 100,
        costCenterId: null,
        fundId: null,
        spendCategoryId: null,
        lineOfBusinessId: null,
        eventId: null,
        shipToAddressId: null,
        purchaseOrderLineId: null,
        hasDiscount: null,
      }]
    } as any);

    const lookup = jest.fn().mockResolvedValue(new Map([
      ['CC-Other Broadcasting', {
        requiredOnTransaction: true,
        defaultReferenceId: 'LOB-Other_Broadcasting',
        allowedReferenceIds: ['LOB-Other_Broadcasting', 'LOB-TV'],
      }]
    ]));

    const result = await buildFinalInvoiceLines(
      extracted,
      undefined,
      undefined,
      {},
      { costCenterId: 'CC-Other Broadcasting', lobReferenceId: 'Event Broadcasting' },
      lookup
    );

    expect(result.lines[0].lineOfBusinessId).toBe('LOB-Other_Broadcasting');
    expect(result.lines[0].costCenterId).toBe('CC-Other Broadcasting');
  });

  it('keeps an email LOB that is already allowed for the email cost center', async () => {
    mockGetAiResponse.mockResolvedValue({
      lines: [{
        lineOrder: 1,
        description: 'Janitorial',
        memo: null,
        quantity: 1,
        unitCost: 100,
        extendedAmount: 100,
        costCenterId: null,
        fundId: null,
        spendCategoryId: null,
        lineOfBusinessId: null,
        eventId: null,
        shipToAddressId: null,
        purchaseOrderLineId: null,
        hasDiscount: null,
      }]
    } as any);

    const lookup = jest.fn().mockResolvedValue(new Map([
      ['CC-Other Broadcasting', {
        requiredOnTransaction: true,
        defaultReferenceId: 'LOB-Other_Broadcasting',
        allowedReferenceIds: ['LOB-Other_Broadcasting', 'Event Broadcasting'],
      }]
    ]));

    const result = await buildFinalInvoiceLines(
      extracted,
      undefined,
      undefined,
      {},
      { costCenterId: 'CC-Other Broadcasting', lobReferenceId: 'Event Broadcasting' },
      lookup
    );

    expect(result.lines[0].lineOfBusinessId).toBe('Event Broadcasting');
  });

  it('fills related LOB from cache when there is no PO LOB', async () => {
    mockGetAiResponse.mockResolvedValue({
      lines: [{
        lineOrder: 1,
        description: 'Janitorial',
        memo: null,
        quantity: 1,
        unitCost: 100,
        extendedAmount: 100,
        costCenterId: 'CC-Building Services-PBG',
        fundId: null,
        spendCategoryId: null,
        lineOfBusinessId: null,
        eventId: null,
        shipToAddressId: null,
        purchaseOrderLineId: null,
        hasDiscount: null,
      }]
    } as any);

    const lookup = jest.fn().mockResolvedValue(new Map([
      ['CC-Building Services-PBG', {
        requiredOnTransaction: true,
        defaultReferenceId: 'LOB-Facilities',
        allowedReferenceIds: ['LOB-Facilities'],
      }]
    ]));

    const result = await buildFinalInvoiceLines(
      extracted,
      undefined,
      undefined,
      {},
      undefined,
      lookup
    );

    expect(lookup).toHaveBeenCalledWith(['CC-Building Services-PBG']);
    expect(result.lines[0].lineOfBusinessId).toBe('LOB-Facilities');
    expect(result.appliedFallbacks.lineOfBusiness).toBe(false);
  });

  it('uses Default_Line_Of_Business when no PO, email, or related LOB is available', async () => {
    mockGetAiResponse.mockResolvedValue({
      lines: [{
        lineOrder: 1,
        description: 'Janitorial',
        memo: null,
        quantity: 1,
        unitCost: 100,
        extendedAmount: 100,
        costCenterId: 'CC-Building Services-PBG',
        fundId: null,
        spendCategoryId: null,
        lineOfBusinessId: null,
        eventId: null,
        shipToAddressId: null,
        purchaseOrderLineId: null,
        hasDiscount: null,
      }]
    } as any);

    const lookup = jest.fn().mockResolvedValue(new Map());

    const result = await buildFinalInvoiceLines(
      extracted,
      undefined,
      undefined,
      { lineOfBusinessId: 'Default_Line_Of_Business' },
      undefined,
      lookup
    );

    expect(result.lines[0].lineOfBusinessId).toBe('Default_Line_Of_Business');
    expect(result.appliedFallbacks.lineOfBusiness).toBe(true);
  });

  it('does not apply the LOB fallback when a unique related allowed LOB was filled', async () => {
    mockGetAiResponse.mockResolvedValue({
      lines: [{
        lineOrder: 1,
        description: 'Janitorial',
        memo: null,
        quantity: 1,
        unitCost: 100,
        extendedAmount: 100,
        costCenterId: 'CC-Building Services-PBG',
        fundId: null,
        spendCategoryId: null,
        lineOfBusinessId: null,
        eventId: null,
        shipToAddressId: null,
        purchaseOrderLineId: null,
        hasDiscount: null,
      }]
    } as any);

    const lookup = jest.fn().mockResolvedValue(new Map([
      ['CC-Building Services-PBG', {
        requiredOnTransaction: true,
        defaultReferenceId: null,
        allowedReferenceIds: ['LOB-Facilities'],
      }]
    ]));

    const result = await buildFinalInvoiceLines(
      extracted,
      undefined,
      undefined,
      { lineOfBusinessId: 'Default_Line_Of_Business' },
      undefined,
      lookup
    );

    expect(result.lines[0].lineOfBusinessId).toBe('LOB-Facilities');
    expect(result.appliedFallbacks.lineOfBusiness).toBe(false);
    expect(result.relatedLobByCostCenter.get('CC-Building Services-PBG')?.allowedReferenceIds).toEqual([
      'LOB-Facilities',
    ]);
  });

  it('uses Default_Line_Of_Business when multiple related allowed LOBs exist and there is no default', async () => {
    mockGetAiResponse.mockResolvedValue({
      lines: [{
        lineOrder: 1,
        description: 'Janitorial',
        memo: null,
        quantity: 1,
        unitCost: 100,
        extendedAmount: 100,
        costCenterId: 'CC-Building Services-PBG',
        fundId: null,
        spendCategoryId: null,
        lineOfBusinessId: null,
        eventId: null,
        shipToAddressId: null,
        purchaseOrderLineId: null,
        hasDiscount: null,
      }]
    } as any);

    const lookup = jest.fn().mockResolvedValue(new Map([
      ['CC-Building Services-PBG', {
        requiredOnTransaction: true,
        defaultReferenceId: null,
        allowedReferenceIds: ['LOB-Facilities', 'LOB-Events'],
      }]
    ]));

    const result = await buildFinalInvoiceLines(
      extracted,
      undefined,
      undefined,
      { lineOfBusinessId: 'Default_Line_Of_Business' },
      undefined,
      lookup
    );

    expect(result.lines[0].lineOfBusinessId).toBe('Default_Line_Of_Business');
    expect(result.appliedFallbacks.lineOfBusiness).toBe(true);
  });

  it('does not apply the LOB fallback when a related default was filled', async () => {
    mockGetAiResponse.mockResolvedValue({
      lines: [{
        lineOrder: 1,
        description: 'Janitorial',
        memo: null,
        quantity: 1,
        unitCost: 100,
        extendedAmount: 100,
        costCenterId: 'CC-Building Services-PBG',
        fundId: null,
        spendCategoryId: null,
        lineOfBusinessId: null,
        eventId: null,
        shipToAddressId: null,
        purchaseOrderLineId: null,
        hasDiscount: null,
      }]
    } as any);

    const lookup = jest.fn().mockResolvedValue(new Map([
      ['CC-Building Services-PBG', {
        requiredOnTransaction: true,
        defaultReferenceId: 'LOB-Facilities',
        allowedReferenceIds: ['LOB-Facilities'],
      }]
    ]));

    const result = await buildFinalInvoiceLines(
      extracted,
      undefined,
      undefined,
      { lineOfBusinessId: 'Default_Line_Of_Business' },
      undefined,
      lookup
    );

    expect(result.lines[0].lineOfBusinessId).toBe('LOB-Facilities');
    expect(result.appliedFallbacks.lineOfBusiness).toBe(false);
  });
});

describe('isFreightOrHandlingLine', () => {
  it.each([
    'Shipping',
    'Freight',
    'Shipping & Handling',
    'Shipping and Handling',
    'Delivery',
    'Postage',
    'S&H',
    'S/H',
    'Handling',
    'Freight Charge',
    'Shipping Charges',
    'Delivery Fee',
    'Inbound Freight',
    'Ground Shipping',
    'UPS Freight',
    'FedEx Shipping',
    'USPS Postage',
    'Overnight Shipping',
    'DHL Express Freight',
    'Standard Shipping',
    '2-Day Shipping',
    'Freight In',
    'Freight Out',
    'FedEx Ground',
    'UPS Ground',
    'Priority Shipping',
    'Next Day Shipping',
    'Free Shipping',
    'Air Freight',
    'Ocean Freight',
    'Freight Surcharge',
    'FedEx Home Delivery',
    'Parcel Shipping',
    'Rush Shipping',
    'Local Delivery',
    'Deliveries',
    'FRN52118A - Freight Charge - 42,000.00 Pounds',
    'B12345 Freight 1,200 lbs',
  ])('treats %s as a freight/handling charge', (description) => {
    expect(isFreightOrHandlingLine(description)).toBe(true);
  });

  it.each([
    'Shipping Container',
    'Overnight shipping boxes',
    'Freightliner parts',
    'Shipping Supplies',
    'Handling equipment',
    'Delivery truck rental',
    'Consulting Services',
    'Widgets',
    'SKU123 Shipping Supplies',
    'SKU123 Freight Charge',
    'SKU123 Freight Charge 42 lbs',
    'ITEM2024 Shipping Fee',
    'A100 Freightliner parts',
    'PRO 52118 - Linehaul - 42,000 lbs',
  ])('does not treat %s as a freight/handling charge', (description) => {
    expect(isFreightOrHandlingLine(description)).toBe(false);
  });

  it('returns false for empty descriptions', () => {
    expect(isFreightOrHandlingLine(undefined)).toBe(false);
    expect(isFreightOrHandlingLine(null)).toBe(false);
    expect(isFreightOrHandlingLine('')).toBe(false);
    expect(isFreightOrHandlingLine('   ')).toBe(false);
  });
});

describe('splitFreightLines', () => {
  it('separates freight lines from merchandise and sums freight amounts', () => {
    const split = splitFreightLines([
      { description: 'Consulting Services', totalPrice: '$100.00' },
      { description: 'Shipping & Handling', totalPrice: '$15.00' },
      { description: 'Widgets', unitCost: '50.00' },
    ]);

    expect(split.merchandiseLines.map(l => l.description)).toEqual([
      'Consulting Services',
      'Widgets',
    ]);
    expect(split.freightLines.map(l => l.description)).toEqual(['Shipping & Handling']);
    expect(split.freightAmountFromLines).toBe(15);
  });

  it('reads SOAP OCR description and extended amount fields', () => {
    const split = splitFreightLines([
      { Item_Description: 'Item 1', Extended_Amount: 100 },
      { Item_Description: 'Freight', Extended_Amount: '12.50' },
    ]);

    expect(split.merchandiseLines).toHaveLength(1);
    expect(split.freightLines).toHaveLength(1);
    expect(split.freightAmountFromLines).toBe(12.5);
  });

  it('returns no freight amount when no freight lines are present', () => {
    const split = splitFreightLines([
      { description: 'Widgets', extendedAmount: 100 },
    ]);

    expect(split.merchandiseLines).toHaveLength(1);
    expect(split.freightLines).toHaveLength(0);
    expect(split.freightAmountFromLines).toBeUndefined();
  });

  it('recovers freight from unitCost times quantity when totalPrice is missing', () => {
    const split = splitFreightLines([
      { description: 'Freight', quantity: 2, unitCost: 15 },
    ]);

    expect(split.freightLines).toHaveLength(1);
    expect(split.freightAmountFromLines).toBe(30);
  });

  it('recovers freight from SOAP Unit_Cost times Quantity when Extended_Amount is missing', () => {
    const split = splitFreightLines([
      { Item_Description: 'Freight', Quantity: '2', Unit_Cost: '15' },
    ]);

    expect(split.freightLines).toHaveLength(1);
    expect(split.freightAmountFromLines).toBe(30);
  });

  it('strips the MyFreightWorld carrier row (SUPIN-465729) so it is not also a merchandise line', () => {
    const split = splitFreightLines([
      { description: 'FRN52118A - Freight Charge - 42,000.00 Pounds', quantity: 0, unitCost: null, totalPrice: '$4595.00' },
    ]);

    expect(split.merchandiseLines).toEqual([]);
    expect(split.freightAmountFromLines).toBe(4595);
  });
});

describe('reconcileSubmittedCharges', () => {
  it('drops a freight line that repeats header freight', () => {
    const lines = [
      { description: 'Widgets', totalPrice: '$100.00' },
      { description: 'Freight Charge', totalPrice: '$15.00' },
    ];
    const result = reconcileSubmittedCharges(lines, { amountDue: '$115.00', freight: '$15.00' });

    expect(result.lines).toEqual([lines[0]]);
    expect(result.duplicateFreightLines).toEqual([lines[1]]);
    expect(result.unreconciled).toBeUndefined();
    expect(formatChargeReconciliationNotes(result)).toBe(
      '\n\nAmount check: Removed invoice line "Freight Charge" ($15.00): that amount is already on the header Freight_Amount.'
    );
  });

  it('drops the only line of an all-freight invoice only when the single-line rule is allowed', () => {
    const line = { description: 'PRO 52118 - Linehaul - 42,000 lbs', quantity: 0, unitCost: null, totalPrice: '$4595.00' };
    const charges = { amountDue: '$4,595.00', freight: '$4,595.00', tax: null };

    const allowed = reconcileSubmittedCharges([line], charges, { allowSingleLineFreight: true });
    expect(allowed.lines).toEqual([]);
    expect(allowed.duplicateFreightLines).toEqual([line]);

    const byDefault = reconcileSubmittedCharges([line], charges);
    expect(byDefault.lines).toEqual([line]);
    expect(byDefault.unreconciled).toEqual({ lineTotal: 4595, freight: 4595, tax: 0, amountDue: 4595 });
  });

  it.each(['Shipping Supplies', 'DHL Shipping Supplies', 'Shipping Container', 'FedEx branded boxes', 'Freight for order 88'])(
    'never removes %s, which the freight matcher rejects, as duplicate freight',
    (description) => {
      const lines = [{ description: 'Widgets', totalPrice: '$100.00' }, { description, totalPrice: '$15.00' }];
      const result = reconcileSubmittedCharges(lines, { amountDue: '$115.00', freight: '$15.00' });

      expect(result.lines).toBe(lines);
      expect(result.unreconciled).toBeDefined();
    }
  );

  it('reconciles a credit memo whose amount due and lines are printed negative', () => {
    const lines = [{ description: 'Returned widgets', totalPrice: '-$100.00' }];
    const result = reconcileSubmittedCharges(lines, { amountDue: '($100.00)' });

    expect(result.lines).toBe(lines);
    expect(result.unreconciled).toBeUndefined();
  });

  it('lists at most five removed lines in the amount-check note', () => {
    const taxLines = Array.from({ length: 7 }, () => ({ description: 'Sales Tax', totalPrice: '$1.00' }));
    const result = reconcileSubmittedCharges(
      [{ description: 'Widgets', totalPrice: '$100.00' }, ...taxLines],
      { amountDue: '$107.00', tax: '$7.00' }
    );

    expect(result.duplicateTaxLines).toHaveLength(7);
    expect(chargeReconciliationMessages(result)).toEqual([
      'Removed invoice line "Sales Tax" ($1.00), "Sales Tax" ($1.00), "Sales Tax" ($1.00), "Sales Tax" ($1.00), "Sales Tax" ($1.00) and 2 more: that amount is already on the header Tax_Amount.',
    ]);
  });

  it('counts a row printed as "Included" as zero instead of skipping the check', () => {
    const lines = [
      { description: 'Widgets', totalPrice: '$100.00' },
      { description: 'Setup', totalPrice: 'Included' },
      { description: 'Freight Charge', totalPrice: '$15.00' },
    ];
    const result = reconcileSubmittedCharges(lines, { amountDue: '$115.00', freight: '$15.00' });

    expect(result.lines).toEqual([lines[0], lines[1]]);
    expect(result.duplicateFreightLines).toEqual([lines[2]]);
  });

  it('flags header charges that do not match the amount due when no lines remain, if asked to', () => {
    expect(reconcileSubmittedCharges([], { amountDue: '$500.00', freight: '$50.00' }).unreconciled).toBeUndefined();
    expect(reconcileSubmittedCharges([], { amountDue: '$500.00', freight: '$50.00' }, { checkWithoutLines: true }).unreconciled)
      .toEqual({ lineTotal: 0, freight: 50, tax: 0, amountDue: 500 });
  });

  it.each(['10.00-', '\u2212$10.00'])('reads %s as a credit', (printed) => {
    const lines = [{ description: 'Widgets', totalPrice: '$100.00' }, { description: 'Credit', totalPrice: printed }];
    expect(reconcileSubmittedCharges(lines, { amountDue: '$90.00' }).unreconciled).toBeUndefined();
  });

  it('reads the credit sign from a unit cost when no line total is printed', () => {
    const lines = [
      { description: 'Widgets', totalPrice: '$100.00' },
      { description: 'Credit', quantity: 1, unitCost: '-$10.00' },
    ];
    const result = reconcileSubmittedCharges(lines, { amountDue: '$90.00' });

    expect(result.unreconciled).toBeUndefined();
  });

  it('keeps header-only freight when lines + freight + tax already equal the amount due', () => {
    const lines = [{ description: 'Widgets', totalPrice: '$100.00' }];
    const result = reconcileSubmittedCharges(lines, { amountDue: '$121.00', freight: '$15.00', tax: '$6.00' });

    expect(result.lines).toBe(lines);
    expect(result.duplicateFreightLines).toEqual([]);
    expect(result.unreconciled).toBeUndefined();
    expect(chargeReconciliationMessages(result)).toEqual([]);
  });

  it('reports totals and keeps every line when the extra amount cannot be tied to a charge line', () => {
    const lines = [
      { description: 'Widgets', totalPrice: '$4,595.00' },
      { description: 'Gadgets', totalPrice: '$100.00' },
    ];
    const result = reconcileSubmittedCharges(lines, { amountDue: '$4,695.00', freight: '$4,595.00' });

    expect(result.lines).toBe(lines);
    expect(result.unreconciled).toEqual({ lineTotal: 4695, freight: 4595, tax: 0, amountDue: 4695 });
    expect(chargeReconciliationMessages(result)).toEqual([
      'Lines $4,695.00 + freight $4,595.00 + tax $0.00 = $9,290.00, but the amount due is $4,695.00. Review lines and header charges.',
    ]);
  });

  it('does not collapse a single goods line into tax', () => {
    const lines = [{ description: 'Widgets', totalPrice: '$6.00' }];
    const result = reconcileSubmittedCharges(lines, { amountDue: '$6.00', tax: '$6.00' });

    expect(result.lines).toBe(lines);
    expect(result.unreconciled).toEqual({ lineTotal: 6, freight: 0, tax: 6, amountDue: 6 });
  });

  it.each(['Sales Tax 6%', 'VAT 20.00%', 'Tax 0.0825'])('drops the rate-printed tax row %s that repeats header tax', (description) => {
    const lines = [{ description: 'Widgets', totalPrice: '$100.00' }, { description, totalPrice: '$6.00' }];
    const result = reconcileSubmittedCharges(lines, { amountDue: '$106.00', tax: '$6.00' });

    expect(result.duplicateTaxLines).toEqual([lines[1]]);
  });

  it('drops a sales tax line that repeats header tax', () => {
    const lines = [
      { description: 'Widgets', totalPrice: '$100.00' },
      { description: 'Sales Tax', totalPrice: '$6.00' },
    ];
    const result = reconcileSubmittedCharges(lines, { amountDue: '$106.00', tax: '$6.00' });

    expect(result.lines).toEqual([lines[0]]);
    expect(result.duplicateTaxLines).toEqual([lines[1]]);
  });

  it('drops both freight and tax lines when both repeat header charges', () => {
    const lines = [
      { description: 'Widgets', totalPrice: '$100.00' },
      { description: 'Freight Charge', totalPrice: '$15.00' },
      { description: 'State Sales Tax', totalPrice: '$6.00' },
    ];
    const result = reconcileSubmittedCharges(lines, { amountDue: '$121.00', freight: '$15.00', tax: '$6.00' });

    expect(result.lines).toEqual([lines[0]]);
    expect(result.duplicateFreightLines).toEqual([lines[1]]);
    expect(result.duplicateTaxLines).toEqual([lines[2]]);
  });

  it('counts printed credits as negative', () => {
    const lines = [
      { description: 'Widgets', totalPrice: '$100.00' },
      { description: 'Credit', totalPrice: '-$10.00' },
      { description: 'Return', totalPrice: '($5.00)' },
    ];
    const result = reconcileSubmittedCharges(lines, { amountDue: '$100.00', freight: '$15.00' });

    expect(result.lines).toBe(lines);
    expect(result.unreconciled).toBeUndefined();
  });

  it('reads SOAP-shaped final lines and numeric header amounts', () => {
    const lines = [
      { description: 'Consulting', extendedAmount: 100 },
      { description: 'Shipping Charge', extendedAmount: 15 },
    ];
    const result = reconcileSubmittedCharges(lines, { amountDue: 115, freight: 15, tax: 0 });

    expect(result.lines).toEqual([lines[0]]);
  });

  it.each([
    ['no amount due', [{ description: 'Widgets', totalPrice: '$100.00' }], { freight: '$15.00' }],
    ['no lines', [], { amountDue: '$15.00', freight: '$15.00' }],
    ['a line without an amount', [{ description: 'Widgets' }], { amountDue: '$15.00', freight: '$15.00' }],
  ])('skips the check with %s', (_label, lines, charges) => {
    const result = reconcileSubmittedCharges(lines as Array<{ description: string; totalPrice?: string }>, charges);

    expect(result.lines).toBe(lines);
    expect(result.unreconciled).toBeUndefined();
  });
});

describe('mergeAmountCheckMessages', () => {
  it('drops the freight-as-line sentence when submit fell back to header freight', () => {
    const extraction = [
      'All-freight invoice: freight $15.00 submitted as an invoice line so it carries the line coding; header Freight_Amount is not set.',
      'Removed invoice line "Sales Tax" ($1.00): that amount is already on the header Tax_Amount.',
    ];
    expect(mergeAmountCheckMessages(extraction, [FREIGHT_HEADER_FALLBACK_MESSAGE])).toEqual([
      extraction[1],
      FREIGHT_HEADER_FALLBACK_MESSAGE,
    ]);
    expect(mergeAmountCheckMessages(extraction, [])).toEqual(extraction);
  });
});

describe('prepareInvoiceCharges', () => {
  const ON = { allowFreightAsLines: true, removeDuplicates: true };
  const prepare = (
    lines: Parameters<typeof prepareInvoiceCharges>[0],
    charges: Parameters<typeof prepareInvoiceCharges>[1],
    options: Parameters<typeof prepareInvoiceCharges>[2] = ON
  ) => prepareInvoiceCharges(lines, charges, options);

  it('keeps a single goods line equal to a misread header freight and says so plainly', () => {
    const golfBalls = { description: 'Golf balls', totalPrice: '100.00' };
    const prepared = prepare([golfBalls], { amountDue: '100.00', freight: '100.00' });

    expect(prepared.freightAsLines).toBe(true);
    expect(prepared.lines).toEqual([golfBalls]);
    expect(chargeReconciliationMessages(prepared.reconciliation)).toEqual([
      'Header freight equals the only line ($100.00), so header Freight_Amount is not set. Check the extracted freight.',
    ]);
  });

  it('keeps freight on the header and every line when both behaviors are off (annotate-only enrichment)', () => {
    const lines = [{ description: 'Widgets', totalPrice: '$100.00' }, { description: 'Sales Tax', totalPrice: '$6.00' }];
    const prepared = prepare(lines, { amountDue: '$106.00', tax: '$6.00' }, { allowFreightAsLines: false, removeDuplicates: false });

    expect(prepared.lines).toEqual(lines);
    expect(prepared.reconciliation.duplicateTaxLines).toEqual([]);

    const freightOnly = prepare([{ description: 'Shipping', totalPrice: '$15.00' }], { amountDue: '$15.00', freight: '$15.00' }, { allowFreightAsLines: false, removeDuplicates: false });
    expect(freightOnly.freightAsLines).toBe(false);
    expect(freightOnly.freightAmount).toBe('$15.00');
  });

  const allFreightNote = (amount: string) =>
    `All-freight invoice: freight ${amount} submitted as an invoice line so it carries the line coding; header Freight_Amount is not set.`;

  it('submits the MyFreightWorld carrier row (SUPIN-465729) as the line with no header freight', () => {
    const carrier = { description: 'FRN52118A - Freight Charge - 42,000.00 Pounds', quantity: 0, unitCost: null, totalPrice: '$4595.00', hasDiscount: null };
    const prepared = prepare([carrier], { amountDue: '$4,595.00', freight: '$4,595.00' });

    expect(prepared.freightAsLines).toBe(true);
    expect(prepared.lines).toEqual([carrier]);
    expect(prepared.freightAmount).toBe('$4,595.00');
    expect(chargeReconciliationMessages(prepared.reconciliation)).toEqual([allFreightNote('$4,595.00')]);
  });

  it('keeps an unrecognized single carrier line as the freight line instead of removing it', () => {
    const linehaul = { description: 'PRO 52118 - Linehaul - 42,000 lbs', totalPrice: '$4595.00' };
    const prepared = prepare([linehaul], { amountDue: '$4,595.00', freight: '$4,595.00' });

    expect(prepared.freightAsLines).toBe(true);
    expect(prepared.lines).toEqual([linehaul]);
    expect(prepared.reconciliation.duplicateFreightLines).toEqual([]);
  });

  it('synthesizes one freight line when freight was only extracted as the header amount', () => {
    const prepared = prepare([], { amountDue: '$4,595.00', freight: '$4,595.00' });

    expect(prepared.freightAsLines).toBe(true);
    expect(prepared.lines).toEqual([
      { description: 'Freight', quantity: null, unitCost: null, totalPrice: '4595', hasDiscount: null },
    ]);
  });

  it('uses the header freight amount when the freight rows do not add up to it', () => {
    const prepared = prepare(
      [{ description: 'Shipping', totalPrice: '$10.00' }, { description: 'Handling', totalPrice: '$3.00' }],
      { amountDue: '$15.00', freight: '$15.00' }
    );

    expect(prepared.lines).toEqual([
      { description: 'Shipping', quantity: null, unitCost: null, totalPrice: '15', hasDiscount: null },
    ]);
  });

  it('ignores an unparseable extracted freight and keeps the freight row as the line', () => {
    const shipping = { description: 'Shipping', totalPrice: '$15.00' };
    const prepared = prepare([shipping], { amountDue: '$15.00', freight: 'n/a' });

    expect(prepared.freightAsLines).toBe(true);
    expect(prepared.lines).toEqual([shipping]);
    expect(prepared.freightAmount).toBe('15');
  });

  it('does not let a zero extracted freight discard a freight row that has an amount', () => {
    const shipping = { description: 'Shipping', totalPrice: '$15.00' };
    const prepared = prepare([shipping], { amountDue: '$15.00', freight: '$0.00' });

    expect(prepared.freightAsLines).toBe(true);
    expect(prepared.lines).toEqual([shipping]);
    expect(prepared.freightAmount).toBe('15');
  });

  it('treats a blank extracted freight as missing and uses the freight rows', () => {
    const shipping = { description: 'Shipping', totalPrice: '$15.00' };
    const prepared = prepare([shipping], { amountDue: '$15.00', freight: ' ' });

    expect(prepared.freightAsLines).toBe(true);
    expect(prepared.lines).toEqual([shipping]);
    expect(prepared.freightAmount).toBe('15');
  });

  it('treats freight plus tax as the whole invoice', () => {
    const shipping = { description: 'Shipping', totalPrice: '$15.00' };
    const prepared = prepare([shipping], { amountDue: '$16.00', freight: '$15.00', tax: '$1.00' });

    expect(prepared.freightAsLines).toBe(true);
    expect(prepared.lines).toEqual([shipping]);
  });

  it('keeps header freight on a mixed invoice', () => {
    const widgets = { description: 'Widgets', totalPrice: '$100.00' };
    const prepared = prepare(
      [widgets, { description: 'Shipping', totalPrice: '$15.00' }],
      { amountDue: '$115.00' }
    );

    expect(prepared.freightAsLines).toBe(false);
    expect(prepared.lines).toEqual([widgets]);
    expect(prepared.freightAmount).toBe('15');
  });

  it('keeps header freight when the amount due also covers goods that were not extracted', () => {
    const prepared = prepare(
      [{ description: 'Shipping', totalPrice: '$15.00' }],
      { amountDue: '$115.00', freight: '$15.00' }
    );

    expect(prepared.freightAsLines).toBe(false);
    expect(prepared.lines).toEqual([]);
    expect(prepared.freightAmount).toBe('$15.00');
  });

  it('flags header freight that disagrees with the amount due when no lines were extracted', () => {
    expect(extractedChargeCheck([], { amountDue: '$500.00', freight: '$50.00' })).toEqual([
      'Lines $0.00 + freight $50.00 + tax $0.00 = $50.00, but the amount due is $500.00. Review lines and header charges.',
    ]);
    expect(extractedChargeCheck([], { amountDue: '$500.00' })).toEqual([]);
  });

  it('does not flag a credit memo whose freight row is also a credit', () => {
    expect(extractedChargeCheck(
      [{ description: 'Widget', totalPrice: '-$100.00' }, { description: 'Freight', totalPrice: '-$10.00' }],
      { amountDue: '-$110.00' }
    )).toEqual([]);
  });

  it('does not turn a credit into a freight line', () => {
    const prepared = prepare([], { amountDue: '-$15.00', freight: '-$15.00' });

    expect(prepared.freightAsLines).toBe(false);
    expect(prepared.freightAmount).toBe('-$15.00');
  });

  it.each([
    ['freight as lines is not allowed', { amountDue: '$15.00', freight: '$15.00' }, { allowFreightAsLines: false, removeDuplicates: false }],
    ['the amount due is missing', { freight: '$15.00' }, undefined],
  ])('keeps header freight when %s', (_label, charges, options) => {
    const prepared = prepare([{ description: 'Shipping', totalPrice: '$15.00' }], charges, options);

    expect(prepared.freightAsLines).toBe(false);
    expect(prepared.freightAmount).toBe('$15.00');
  });
});

describe('resolveInvoiceLineQuantityDisplayed', () => {
  it('returns explicit true or false from the model when lines lack quantity', () => {
    expect(resolveInvoiceLineQuantityDisplayed(true, [])).toBe(true);
    expect(resolveInvoiceLineQuantityDisplayed(false, [{ description: 'A', quantity: null, totalPrice: '10' }])).toBe(false);
  });

  it('treats the document as quantity-displayed when any extracted line has quantity', () => {
    const lines = [{ description: 'Widgets', quantity: 2, totalPrice: '100.00' }];
    expect(resolveInvoiceLineQuantityDisplayed(false, lines)).toBe(true);
    expect(resolveInvoiceLineQuantityDisplayed(undefined, lines)).toBe(true);
  });

  it('keeps explicit true when every line lacks quantity but has amounts', () => {
    const lines = [
      { description: 'Service A', quantity: null, totalPrice: '100.00' },
      { description: 'Service B', quantity: null, unitCost: '50.00' },
    ];
    expect(resolveInvoiceLineQuantityDisplayed(true, lines)).toBe(true);
  });

  it('infers false when every line lacks quantity but has amounts', () => {
    const lines = [
      { description: 'Service A', quantity: null, totalPrice: '100.00' },
      { description: 'Service B', quantity: null, unitCost: '50.00' },
    ];
    expect(resolveInvoiceLineQuantityDisplayed(undefined, lines)).toBe(false);
  });

  it('defaults to true when the model omits the flag and any line has quantity', () => {
    const lines = [{ description: 'Widgets', quantity: 2, totalPrice: '100.00' }];
    expect(resolveInvoiceLineQuantityDisplayed(undefined, lines)).toBe(true);
  });

});

describe('applyMissingQuantityColumnLines', () => {
  it('sets quantity and unit cost to zero and keeps extended amount', () => {
    const lines = [{ lineOrder: 1, description: 'Consulting', quantity: null, unitCost: 50, extendedAmount: 250 }];
    const result = applyMissingQuantityColumnLines(lines, false);
    expect(result[0]).toMatchObject({ quantity: 0, unitCost: 0, extendedAmount: 250 });
  });

  it('does not change lines when quantity is displayed on the document', () => {
    const lines = [{ lineOrder: 1, description: 'Widgets', quantity: 2, unitCost: 50, extendedAmount: 100 }];
    const result = applyMissingQuantityColumnLines(lines, true);
    expect(result).toEqual(lines);
  });

  it('leaves discount lines unchanged', () => {
    const lines = [{ lineOrder: 1, description: 'Discount', hasDiscount: true, quantity: null, unitCost: null, extendedAmount: -25 }];
    const result = applyMissingQuantityColumnLines(lines, false);
    expect(result[0]).toMatchObject({ hasDiscount: true, quantity: null, unitCost: null, extendedAmount: -25 });
  });

  it('treats a positive line flagged hasDiscount as merchandise', () => {
    const lines = [{ lineOrder: 1, description: 'Discounted widgets', hasDiscount: true, quantity: null, unitCost: null, extendedAmount: 90 }];
    const result = applyMissingQuantityColumnLines(lines, false);
    expect(result[0]).toMatchObject({ quantity: 0, unitCost: 0, extendedAmount: 90 });
  });

  it('copies unit cost onto extended amount when extended amount is missing', () => {
    const lines = [{ lineOrder: 1, description: 'Consulting', quantity: null, unitCost: 250, extendedAmount: null }];
    const result = applyMissingQuantityColumnLines(lines, false);
    expect(result[0]).toMatchObject({ quantity: 0, unitCost: 0, extendedAmount: 250 });
  });
});

describe('alignSupplierInvoiceLineAmounts', () => {
  it('keeps matching quantity, unit cost, and extended amount', () => {
    const lines = [{ lineOrder: 1, description: 'Widgets', quantity: 2, unitCost: 50, extendedAmount: 100 }];
    expect(alignSupplierInvoiceLineAmounts(lines)).toEqual(lines);
  });

  it('does not invent extended amount when unit cost is present and extended is missing', () => {
    const lines = [{ lineOrder: 1, description: 'Widgets', quantity: 2, unitCost: 50, extendedAmount: null }];
    expect(alignSupplierInvoiceLineAmounts(lines)).toEqual(lines);
  });

  it('submits amount-only when unit cost is missing and extended amount is present', () => {
    const lines = [{ lineOrder: 1, description: 'Sintra Signs', quantity: 37, unitCost: null, extendedAmount: 1105.49 }];
    const result = alignSupplierInvoiceLineAmounts(lines);
    expect(result[0]).toMatchObject({ quantity: 0, unitCost: 0, extendedAmount: 1105.49 });
  });

  it('submits amount-only when quantity times unit cost does not equal extended amount', () => {
    const lines = [{ lineOrder: 1, description: 'Sintra Signs', quantity: 37, unitCost: 29.88, extendedAmount: 1105.49 }];
    const result = alignSupplierInvoiceLineAmounts(lines);
    expect(result[0]).toMatchObject({ quantity: 0, unitCost: 0, extendedAmount: 1105.49 });
  });

  it('uses SOAP quantity 1 when quantity is null and product does not match extended amount', () => {
    const lines = [{ lineOrder: 1, description: 'Service', quantity: null, unitCost: 50, extendedAmount: 250 }];
    const result = alignSupplierInvoiceLineAmounts(lines);
    expect(result[0]).toMatchObject({ quantity: 0, unitCost: 0, extendedAmount: 250 });
  });

  it('leaves discount lines unchanged', () => {
    const lines = [{ lineOrder: 1, description: 'Discount', hasDiscount: true, quantity: null, unitCost: null, extendedAmount: -25 }];
    expect(alignSupplierInvoiceLineAmounts(lines)).toEqual(lines);
  });

  it('submits the net unit cost and keeps quantity on a PO-linked line priced before a discount', () => {
    const lines = [{ lineOrder: 1, description: 'Titl Pro V1 Cstm', hasDiscount: true, quantity: 45, unitCost: 46.5, extendedAmount: 1966.95, purchaseOrderLineId: 'POL-001' }];
    const result = alignSupplierInvoiceLineAmounts(lines);
    expect(result[0]).toMatchObject({ quantity: 45, unitCost: 43.71, extendedAmount: 1966.95, purchaseOrderLineId: 'POL-001' });
  });

  it('uses four decimal precision for PO-linked discount lines that do not divide to cents', () => {
    const lines = [{ lineOrder: 1, description: 'Sintra Signs', hasDiscount: true, quantity: 7, unitCost: 29.88, extendedAmount: 188.24, purchaseOrderLineId: 'POL-001' }];
    const result = alignSupplierInvoiceLineAmounts(lines);
    expect(result[0]).toMatchObject({ quantity: 7, unitCost: 26.8914, extendedAmount: 188.24, purchaseOrderLineId: 'POL-001' });
  });

  it('submits amount-only for the same line when it is not linked to a PO line', () => {
    const lines = [{ lineOrder: 1, description: 'Titl Pro V1 Cstm', hasDiscount: true, quantity: 45, unitCost: 46.5, extendedAmount: 1966.95 }];
    const result = alignSupplierInvoiceLineAmounts(lines);
    expect(result[0]).toMatchObject({ quantity: 0, unitCost: 0, extendedAmount: 1966.95 });
  });

  it('submits amount-only on a non-discount PO-linked line whose qty times unit does not match the total', () => {
    const lines = [{ lineOrder: 1, description: 'Widgets', quantity: 10, unitCost: 5, extendedAmount: 100, purchaseOrderLineId: 'POL-001' }];
    const result = alignSupplierInvoiceLineAmounts(lines);
    expect(result[0]).toMatchObject({ quantity: 0, unitCost: 0, extendedAmount: 100 });
  });

  it('submits amount-only on a PO-linked discount line when the net price is not lower', () => {
    const lines = [{ lineOrder: 1, description: 'Widgets', hasDiscount: true, quantity: 10, unitCost: 5, extendedAmount: 100, purchaseOrderLineId: 'POL-001' }];
    const result = alignSupplierInvoiceLineAmounts(lines);
    expect(result[0]).toMatchObject({ quantity: 0, unitCost: 0, extendedAmount: 100 });
  });

  it('leaves already amount-only lines unchanged', () => {
    const lines = [{ lineOrder: 1, description: 'Consulting', quantity: 0, unitCost: 0, extendedAmount: 1250 }];
    expect(alignSupplierInvoiceLineAmounts(lines)).toEqual(lines);
  });
});

describe('applyAmountOnlyLineRetry', () => {
  it('zeros quantity and unit cost when both are present with extended amount', () => {
    const lines = [{ lineOrder: 1, description: 'Sintra Signs', quantity: 37, unitCost: 29.88, extendedAmount: 1105.49 }];
    const result = applyAmountOnlyLineRetry(lines);
    expect(result[0]).toMatchObject({ quantity: 0, unitCost: 0, extendedAmount: 1105.49 });
  });

  it('zeros quantity when unit cost is missing and extended amount is present', () => {
    const lines = [{ lineOrder: 1, description: 'Sintra Signs', quantity: 37, unitCost: null, extendedAmount: 1105.49 }];
    const result = applyAmountOnlyLineRetry(lines);
    expect(result[0]).toMatchObject({ quantity: 0, unitCost: 0, extendedAmount: 1105.49 });
  });

  it('zeros unit cost when quantity is missing and extended amount is present', () => {
    const lines = [{ lineOrder: 1, description: 'Service', quantity: null, unitCost: 50, extendedAmount: 250 }];
    const result = applyAmountOnlyLineRetry(lines);
    expect(result[0]).toMatchObject({ quantity: 0, unitCost: 0, extendedAmount: 250 });
  });

  it('leaves lines without extended amount unchanged', () => {
    const lines = [{ lineOrder: 1, description: 'Widgets', quantity: 2, unitCost: 50, extendedAmount: null }];
    expect(applyAmountOnlyLineRetry(lines)).toEqual(lines);
  });

  it('leaves discount lines unchanged', () => {
    const lines = [{ lineOrder: 1, description: 'Discount', hasDiscount: true, quantity: 1, unitCost: 10, extendedAmount: -5 }];
    expect(applyAmountOnlyLineRetry(lines)).toEqual(lines);
  });
});

describe('statesServicePeriod', () => {
  it.each([
    'September 2026',
    'Sept retainer',
    'Q3 2026',
    'third quarter 2026',
    'quarter 3 2026',
    '3rd qtr',
    '09/2026',
    '2026-09',
    '2026/09',
    '9/1 - 9/30',
    '2026-09-01 to 2026-09-30',
    '09.01.2026 - 09.30.2026',
    'AUG2026 retainer',
    'Retainer Sep26',
    'Retainer 2026.08',
    'H2 2026',
  ])('recognizes "%s" as a stated period', (text) => {
    expect(statesServicePeriod(text)).toBe(true);
  });

  it.each(['Monthly retainer', 'Annual services', 'Consulting retainer', 'Version 2.5 license', 'Mayfield maintenance', 'Consulting 1.5 hours', '', null])(
    'does not treat "%s" as a stated period',
    (text) => {
      expect(statesServicePeriod(text)).toBe(false);
    }
  );
});

describe('buildFinalInvoiceLines service-date matching', () => {
  const monthlyLine = (month: number, overrides: Partial<PurchaseOrderLine> = {}): PurchaseOrderLine => {
    const mm = String(month).padStart(2, '0');
    const lastDay = new Date(Date.UTC(2026, month, 0)).getUTCDate();
    return poLine({
      lineOrder: month,
      purchaseOrderLineId: `POL-${mm}`,
      description: 'Monthly retainer',
      startDate: `2026-${mm}-01`,
      endDate: `2026-${mm}-${lastDay}`,
      ...overrides,
    });
  };

  const mergedLine = (purchaseOrderLineId: string | null, lineOrder = 1) => ({
    lineOrder,
    description: 'Monthly retainer',
    memo: 'Monthly retainer',
    quantity: 1,
    unitCost: 5000,
    extendedAmount: 5000,
    costCenterId: 'CC-Building Services-PBG',
    fundId: 'FUND-General_Fund_Unrestricted',
    spendCategoryId: null,
    lineOfBusinessId: 'LOB-Facilities',
    eventId: null,
    shipToAddressId: null,
    purchaseOrderLineId,
    hasDiscount: null,
  });

  const extracted = [{ description: 'Monthly retainer', quantity: 1, unitCost: '5000', totalPrice: '5000', hasDiscount: null }];

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.FALLBACK_COST_CENTER_ID;
    process.env.PO_LINE_SELECTION_ENABLED = 'true';
  });

  afterEach(() => {
    delete process.env.PO_LINE_SELECTION_ENABLED;
  });

  it('uses the legacy merge prompt and input when the caller passes no invoice context (Closed PO)', async () => {
    mockGetAiResponse.mockResolvedValue({ lines: [mergedLine('POL-08')] } as any);

    await buildFinalInvoiceLines(
      extracted,
      [monthlyLine(8), monthlyLine(9)],
      undefined,
      {},
      undefined,
      undefined,
      true
    );

    const call = mockGetAiResponse.mock.calls[0][0] as any;
    const input = JSON.parse(call.messages[0].content);
    expect(call.prompt).toBe(mergeInvoiceLinesPromptFor(false));
    expect(input.purchaseOrderLines[0]).not.toHaveProperty('startDate');
    expect(input).not.toHaveProperty('invoiceDate');
  });

  it('keeps the pre-selection merge input, prompt, and model pick when PO line selection is off', async () => {
    delete process.env.PO_LINE_SELECTION_ENABLED;
    mockGetAiResponse.mockResolvedValue({ lines: [mergedLine('POL-08')] } as any);

    const result = await buildFinalInvoiceLines(
      extracted,
      [monthlyLine(8, { availableForInvoicing: false }), monthlyLine(9)],
      undefined,
      {},
      undefined,
      undefined,
      true,
      { invoiceDate: '2026-09-05', servicePeriod: 'September 2026' }
    );

    const call = mockGetAiResponse.mock.calls[0][0] as any;
    const input = JSON.parse(call.messages[0].content);
    expect(input).not.toHaveProperty('invoiceDate');
    expect(input).not.toHaveProperty('invoiceServicePeriod');
    expect(input.purchaseOrderLines[0]).not.toHaveProperty('startDate');
    expect(input.purchaseOrderLines[0]).not.toHaveProperty('availableForInvoicing');
    expect(call.prompt).toBe(mergeInvoiceLinesPromptFor(false));
    expect(call.prompt).not.toContain('availableForInvoicing');
    expect(result.lines[0].purchaseOrderLineId).toBe('POL-08');
    expect(result.lines[0].omitPurchaseOrderLineReference).toBeUndefined();
  });

  it('sends the invoice date, service period, and PO line service windows to the merge model', async () => {
    mockGetAiResponse.mockResolvedValue({ lines: [mergedLine('POL-09')] } as any);

    await buildFinalInvoiceLines(
      extracted,
      [monthlyLine(8), monthlyLine(9)],
      undefined,
      {},
      undefined,
      undefined,
      true,
      { invoiceDate: '2026-09-05', servicePeriod: 'September 2026' }
    );

    const input = JSON.parse((mockGetAiResponse.mock.calls[0][0] as any).messages[0].content);
    expect(input.invoiceDate).toBe('2026-09-05');
    expect(input.invoiceServicePeriod).toBe('September 2026');
    expect(input.purchaseOrderLines.map((line: any) => [line.purchaseOrderLineId, line.startDate, line.endDate])).toEqual([
      ['POL-08', '2026-08-01', '2026-08-31'],
      ['POL-09', '2026-09-01', '2026-09-30'],
    ]);
  });

  it('relinks to the PO line whose window covers the invoice date when no service period is stated', async () => {
    mockGetAiResponse.mockResolvedValue({ lines: [mergedLine('POL-08')] } as any);

    const result = await buildFinalInvoiceLines(
      extracted,
      [monthlyLine(8), monthlyLine(9), monthlyLine(10)],
      undefined,
      {},
      undefined,
      undefined,
      true,
      { invoiceDate: '2026-09-05' }
    );

    expect(result.lines[0].purchaseOrderLineId).toBe('POL-09');
  });

  it('takes the ship-to address from the relinked PO line, clearing it when that line has none', async () => {
    mockGetAiResponse.mockResolvedValue({ lines: [{ ...mergedLine('POL-08'), shipToAddressId: 'ADDR-AUG' }] } as any);

    const result = await buildFinalInvoiceLines(
      extracted,
      [monthlyLine(8, { shipToAddressId: 'ADDR-AUG' }), monthlyLine(9)],
      undefined,
      {},
      undefined,
      undefined,
      true,
      { invoiceDate: '2026-09-05' }
    );

    expect(result.lines[0].purchaseOrderLineId).toBe('POL-09');
    expect(result.lines[0].shipToAddressId).toBeNull();
  });

  it('keeps the model pick when the invoice states a service period', async () => {
    mockGetAiResponse.mockResolvedValue({ lines: [mergedLine('POL-08')] } as any);

    const result = await buildFinalInvoiceLines(
      extracted,
      [monthlyLine(8), monthlyLine(9)],
      undefined,
      {},
      undefined,
      undefined,
      true,
      { invoiceDate: '2026-09-05', servicePeriod: 'August 2026' }
    );

    expect(result.lines[0].purchaseOrderLineId).toBe('POL-08');
  });

  it('does not move a line onto a PO line another invoice line already uses', async () => {
    mockGetAiResponse.mockResolvedValue({ lines: [mergedLine('POL-08', 1), mergedLine('POL-09', 2)] } as any);

    const result = await buildFinalInvoiceLines(
      [...extracted, ...extracted],
      [monthlyLine(8), monthlyLine(9)],
      undefined,
      {},
      undefined,
      undefined,
      true,
      { invoiceDate: '2026-09-30' }
    );

    expect(result.lines.map((line) => line.purchaseOrderLineId)).toEqual(['POL-08', 'POL-09']);
  });

  it('does not relink to a covering PO line with different coding', async () => {
    mockGetAiResponse.mockResolvedValue({ lines: [mergedLine('POL-08')] } as any);

    const result = await buildFinalInvoiceLines(
      extracted,
      [
        monthlyLine(8),
        monthlyLine(9, { worktagsReference: [makeWorktag('Cost_Center_Reference_ID', 'CC-Other')] }),
      ],
      undefined,
      {},
      undefined,
      undefined,
      true,
      { invoiceDate: '2026-09-05' }
    );

    expect(result.lines[0].purchaseOrderLineId).toBe('POL-08');
  });

  it('keeps the model pick when the PO lines have no service dates', async () => {
    mockGetAiResponse.mockResolvedValue({ lines: [mergedLine('POL-001')] } as any);

    const result = await buildFinalInvoiceLines(
      extracted,
      [poLine(), poLine({ lineOrder: 2, purchaseOrderLineId: 'POL-002' })],
      undefined,
      {},
      undefined,
      undefined,
      true,
      { invoiceDate: '2026-09-05' }
    );

    expect(result.lines[0].purchaseOrderLineId).toBe('POL-001');
  });

  it('treats a missing Start_Date or End_Date as an open side of the window', async () => {
    mockGetAiResponse.mockResolvedValue({ lines: [mergedLine('POL-08')] } as any);

    const result = await buildFinalInvoiceLines(
      extracted,
      [
        monthlyLine(8, { startDate: undefined }),
        monthlyLine(9, { endDate: undefined }),
      ],
      undefined,
      {},
      undefined,
      undefined,
      true,
      { invoiceDate: '2026-09-05' }
    );

    expect(result.lines[0].purchaseOrderLineId).toBe('POL-09');
  });

  it('treats an impossible PO window date as unknown rather than as an open side', async () => {
    mockGetAiResponse.mockResolvedValue({ lines: [mergedLine('POL-08')] } as any);

    const result = await buildFinalInvoiceLines(
      extracted,
      [monthlyLine(8), monthlyLine(9, { startDate: '2026-02-31' })],
      undefined,
      {},
      undefined,
      undefined,
      true,
      { invoiceDate: '2026-09-05' }
    );

    expect(result.lines[0].purchaseOrderLineId).toBe('POL-08');
  });

  it('does not relink from or to a PO line whose window is unparseable or inverted', async () => {
    mockGetAiResponse.mockResolvedValue({ lines: [mergedLine('POL-08')] } as any);

    const result = await buildFinalInvoiceLines(
      extracted,
      [
        monthlyLine(8, { startDate: '2026-08-31', endDate: '2026-08-01' }),
        monthlyLine(9, { endDate: 'not-a-date' }),
      ],
      undefined,
      {},
      undefined,
      undefined,
      true,
      { invoiceDate: '2026-09-05' }
    );

    expect(result.lines[0].purchaseOrderLineId).toBe('POL-08');
  });

  it('keeps the model pick when the line description states its own period', async () => {
    mockGetAiResponse.mockResolvedValue({
      lines: [{ ...mergedLine('POL-08'), description: 'Retainer - August 2026' }],
    } as any);

    const result = await buildFinalInvoiceLines(
      [{ ...extracted[0], description: 'Retainer - August 2026' }],
      [monthlyLine(8), monthlyLine(9)],
      undefined,
      {},
      undefined,
      undefined,
      true,
      { invoiceDate: '2026-09-05' }
    );

    expect(result.lines[0].purchaseOrderLineId).toBe('POL-08');
  });

  it('keeps the model pick when only the extracted description states a period', async () => {
    mockGetAiResponse.mockResolvedValue({ lines: [{ ...mergedLine('POL-08'), description: 'Retainer' }] } as any);

    const result = await buildFinalInvoiceLines(
      [{ ...extracted[0], description: 'Retainer - August 2026' }],
      [monthlyLine(8), monthlyLine(9)],
      undefined,
      {},
      undefined,
      undefined,
      true,
      { invoiceDate: '2026-09-05' }
    );

    expect(result.lines[0].description).toBe('Retainer - August 2026');
    expect(result.lines[0].purchaseOrderLineId).toBe('POL-08');
  });

  it('does not relink to a PO line whose split worktags differ', async () => {
    mockGetAiResponse.mockResolvedValue({ lines: [mergedLine('POL-08')] } as any);
    const split = (costCenter: string) => [{ extendedAmount: 5000, worktagReference: [makeWorktag('Cost_Center_Reference_ID', costCenter)] }];

    const result = await buildFinalInvoiceLines(
      extracted,
      [
        monthlyLine(8, { splitLineData: split('CC-Split-A') }),
        monthlyLine(9, { splitLineData: split('CC-Split-B') }),
      ],
      undefined,
      {},
      undefined,
      undefined,
      true,
      { invoiceDate: '2026-09-05' }
    );

    expect(result.lines[0].purchaseOrderLineId).toBe('POL-08');
  });

  it('keeps a line on its consumed period PO line and flags the reference to be dropped', async () => {
    mockGetAiResponse.mockResolvedValue({
      lines: [{ ...mergedLine('POL-08'), description: 'Retainer - August 2026' }],
    } as any);

    const result = await buildFinalInvoiceLines(
      [{ ...extracted[0], description: 'Retainer - August 2026' }],
      [monthlyLine(8, { availableForInvoicing: false }), monthlyLine(9, { availableForInvoicing: true })],
      undefined,
      {},
      undefined,
      undefined,
      true,
      { invoiceDate: '2026-09-05' }
    );

    const input = JSON.parse((mockGetAiResponse.mock.calls[0][0] as any).messages[0].content);
    expect(input.purchaseOrderLines.map((line: any) => [line.purchaseOrderLineId, line.availableForInvoicing])).toEqual([
      ['POL-08', false],
      ['POL-09', true],
    ]);
    expect(result.lines[0]).toEqual(expect.objectContaining({
      purchaseOrderLineId: 'POL-08',
      omitPurchaseOrderLineReference: true,
      costCenterId: 'CC-Building Services-PBG',
    }));
  });

  it('relinks to a consumed PO line covering the invoice date instead of an open line for another month', async () => {
    mockGetAiResponse.mockResolvedValue({ lines: [mergedLine('POL-09')] } as any);

    const result = await buildFinalInvoiceLines(
      extracted,
      [monthlyLine(8, { availableForInvoicing: false }), monthlyLine(9, { availableForInvoicing: true })],
      undefined,
      {},
      undefined,
      undefined,
      true,
      { invoiceDate: '2026-08-20' }
    );

    expect(result.lines[0].purchaseOrderLineId).toBe('POL-08');
    expect(result.lines[0].omitPurchaseOrderLineReference).toBe(true);
  });

  it('leaves the reference on lines matched to an open PO line', async () => {
    mockGetAiResponse.mockResolvedValue({ lines: [mergedLine('POL-09')] } as any);

    const result = await buildFinalInvoiceLines(
      extracted,
      [monthlyLine(8, { availableForInvoicing: false }), monthlyLine(9, { availableForInvoicing: true })],
      undefined,
      {},
      undefined,
      undefined,
      true,
      { invoiceDate: '2026-09-05' }
    );

    expect(result.lines[0].purchaseOrderLineId).toBe('POL-09');
    expect(result.lines[0].omitPurchaseOrderLineReference).toBeUndefined();
  });

  it('does not relink between PO lines that carry no worktags', async () => {
    mockGetAiResponse.mockResolvedValue({ lines: [mergedLine('POL-08')] } as any);

    const result = await buildFinalInvoiceLines(
      extracted,
      [monthlyLine(8, { worktagsReference: [] }), monthlyLine(9, { worktagsReference: [] })],
      undefined,
      {},
      undefined,
      undefined,
      true,
      { invoiceDate: '2026-09-05' }
    );

    expect(result.lines[0].purchaseOrderLineId).toBe('POL-08');
  });

  it.each([
    ['blank', '   '],
    ['not mappable to dates', 'Annual services'],
  ])('still relinks by invoice date when the service period is %s', async (_label, servicePeriod) => {
    mockGetAiResponse.mockResolvedValue({ lines: [mergedLine('POL-08')] } as any);

    const result = await buildFinalInvoiceLines(
      extracted,
      [monthlyLine(8), monthlyLine(9)],
      undefined,
      {},
      undefined,
      undefined,
      true,
      { invoiceDate: '2026-09-05', servicePeriod }
    );

    expect(result.lines[0].purchaseOrderLineId).toBe('POL-09');
    const input = JSON.parse((mockGetAiResponse.mock.calls[0][0] as any).messages[0].content);
    expect(input.invoiceServicePeriod).toBe(servicePeriod.trim() || null);
  });
});
