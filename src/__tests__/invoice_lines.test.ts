import {
  alignSupplierInvoiceLineAmounts,
  applyAmountOnlyLineRetry,
  applyDefaultCompanyLineWorktags,
  applyMissingQuantityColumnLines,
  applyRelatedLobWorktags,
  buildFinalInvoiceLines,
  constrainEmailLobToRelatedWorktags,
  isFreightOrHandlingLine,
  lineTotalMismatchNote,
  normalizeExtractedFreightAndTax,
  overlayPoLineOfBusiness,
  overlayPoWorktagsFromPurchaseOrder,
  overlaySharedPoWorktagsOnUnmatchedLines,
  parseExtractedAmount,
  parseExtractedLineAmount,
  parseExtractedUnitCost,
  resolveHeaderChargeAmounts,
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

  it('keeps sub-cent unit cost precision when the merge fails and extracted lines are used', async () => {
    mockGetAiResponse.mockRejectedValue(new Error('merge unavailable'));

    const result = await buildFinalInvoiceLines(
      [{ description: 'PSO-RISK-ADVISORY - Consultant', quantity: 24.45, unitCost: '$224.9488753', totalPrice: '$5,500.00', hasDiscount: null }],
      undefined,
      undefined,
      {}
    );
    const [line] = alignSupplierInvoiceLineAmounts(result.lines);

    expect(line).toMatchObject({ quantity: 24.45, unitCost: 224.948875, extendedAmount: 5500 });
  });

  it('keeps a printed discount row negative when the merge fails and extracted lines are used', async () => {
    mockGetAiResponse.mockRejectedValue(new Error('merge unavailable'));

    const result = await buildFinalInvoiceLines(
      [
        { description: 'Consulting', quantity: 10, unitCost: '$125.00', totalPrice: '$1,250.00', hasDiscount: null },
        { description: 'Loyalty discount', quantity: null, unitCost: null, totalPrice: '($250.00)', hasDiscount: true },
      ],
      undefined,
      undefined,
      {}
    );
    const lines = alignSupplierInvoiceLineAmounts(result.lines);

    expect(lines[1]).toMatchObject({ hasDiscount: true, extendedAmount: -250 });
    expect(lineTotalMismatchNote(lines, { amountDue: '$1,000.00' })).toBeUndefined();
  });

  it('rethrows AI errors when the deadline signal has aborted', async () => {
    const abortController = new AbortController();
    abortController.abort(new Error('Processor deadline reached'));
    mockGetAiResponse.mockRejectedValue(new Error('Processor deadline reached'));

    await expect(buildFinalInvoiceLines(
      extracted,
      [poLine()],
      undefined,
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      abortController.signal
    )).rejects.toThrow('Processor deadline reached');
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

  it('rounds a back-computed unit cost to six decimals and keeps quantity and the line total', () => {
    const lines = [{ lineOrder: 1, description: 'PSO-RISK-ADVISORY - Consultant', quantity: 24.45, unitCost: 224.9488753, extendedAmount: 5500, purchaseOrderLineId: 'POL-001' }];
    const result = alignSupplierInvoiceLineAmounts(lines);
    expect(result[0]).toMatchObject({ quantity: 24.45, unitCost: 224.948875, extendedAmount: 5500, purchaseOrderLineId: 'POL-001' });
  });

  it('rounds quantity to two decimals and submits amount-only when the rounded product misses the total', () => {
    const lines = [{ lineOrder: 1, description: 'Consulting hours', quantity: 1.125, unitCost: 200, extendedAmount: 225 }];
    const result = alignSupplierInvoiceLineAmounts(lines);
    expect(result[0]).toMatchObject({ quantity: 0, unitCost: 0, extendedAmount: 225 });
  });

  it('submits amount-only when six-decimal rounding no longer reproduces the total on a very large quantity', () => {
    const lines = [{ lineOrder: 1, description: 'Envelopes', quantity: 2000000, unitCost: 0.0123456789, extendedAmount: 24691.36 }];
    const result = alignSupplierInvoiceLineAmounts(lines);
    expect(result[0]).toMatchObject({ quantity: 0, unitCost: 0, extendedAmount: 24691.36 });
  });

  it('rounds unit cost on lines without an extended amount and records the unrounded total', () => {
    const lines = [{ lineOrder: 1, description: 'Consulting', quantity: 2, unitCost: 10.12345678, extendedAmount: null }];
    expect(alignSupplierInvoiceLineAmounts(lines)[0]).toMatchObject({ quantity: 2, unitCost: 10.123457, extendedAmount: 20.25 });
  });

  it('records the quantity total on a credit with no discount marker and no extended amount', () => {
    const lines = [
      { lineOrder: 1, description: 'Credit for returned units', hasDiscount: null, quantity: 2, unitCost: -10, extendedAmount: null },
      { lineOrder: 2, description: 'Discount', hasDiscount: true, quantity: null, unitCost: -50, extendedAmount: null },
    ];
    const result = alignSupplierInvoiceLineAmounts(lines);
    expect(result[0]).toMatchObject({ quantity: 2, unitCost: -10, extendedAmount: -20 });
    expect(result[1].extendedAmount).toBeNull();
  });

  it('keeps the total of a line with no extended amount when rounding the quantity would move it', () => {
    const lines = [{ lineOrder: 1, description: 'Consulting', quantity: 2.555, unitCost: 1000, extendedAmount: null }];
    expect(alignSupplierInvoiceLineAmounts(lines)[0]).toMatchObject({ quantity: 0, unitCost: 0, extendedAmount: 2555 });
  });

  it('leaves a line with no extended amount untouched when nothing needs rounding', () => {
    const lines = [{ lineOrder: 1, description: 'Consulting', quantity: 3, unitCost: 12.5, extendedAmount: null }];
    expect(alignSupplierInvoiceLineAmounts(lines)[0]).toEqual(lines[0]);
  });

  it('keeps a three-decimal extended amount as printed', () => {
    const lines = [{ lineOrder: 1, description: 'Fuel', quantity: 0, unitCost: 0, extendedAmount: 10.005 }];
    expect(alignSupplierInvoiceLineAmounts(lines)[0].extendedAmount).toBe(10.005);
  });

  it('rounds half-cent boundaries on the decimal value in both signs', () => {
    const lines = [
      { lineOrder: 1, description: 'Item', quantity: 1, unitCost: 1.0049999, extendedAmount: 1.0045 },
      { lineOrder: 2, description: 'Item', quantity: 1, unitCost: 1.0000005, extendedAmount: null },
      { lineOrder: 3, description: 'Credit', quantity: 1, unitCost: -12.3455, extendedAmount: -12.3455 },
    ];
    const [first, second, third] = alignSupplierInvoiceLineAmounts(lines);
    expect(first).toMatchObject({ quantity: 0, unitCost: 0, extendedAmount: 1 });
    expect(second).toMatchObject({ quantity: 1, unitCost: 1.000001, extendedAmount: 1 });
    expect(third).toMatchObject({ quantity: 1, unitCost: -12.3455, extendedAmount: -12.35 });
    expect(lineTotalMismatchNote(
      [{ lineOrder: 1, description: 'Item', quantity: 0, unitCost: 0, extendedAmount: 1.005 }],
      { amountDue: '$1.01' }
    )).toBeUndefined();
  });

  it('rounds an extended amount past three decimals to cents so its cent total holds', () => {
    const lines = [{ lineOrder: 1, description: 'Item', quantity: 0, unitCost: 0, extendedAmount: 1.0049 }];
    expect(alignSupplierInvoiceLineAmounts(lines)[0].extendedAmount).toBe(1);
  });

  it('rounds the extended amount on amount-only lines derived from a long unit cost to cents', () => {
    const lines = applyMissingQuantityColumnLines(
      [{ lineOrder: 1, description: 'Retainer', quantity: null, unitCost: 224.9488753, extendedAmount: null }],
      false
    );
    expect(alignSupplierInvoiceLineAmounts(lines)[0]).toMatchObject({ quantity: 0, unitCost: 0, extendedAmount: 224.95 });
  });
});

describe('lineTotalMismatchNote', () => {
  const consultant = { lineOrder: 1, description: 'PSO-RISK-ADVISORY - Consultant', quantity: 24.45, unitCost: 224.948875, extendedAmount: 5500 };
  const monthly = { lineOrder: 2, description: "PSO-RISK-ADVISORY - Sep'26 - 5,500 per month", quantity: 1, unitCost: 5500, extendedAmount: 5500 };

  it('flags lines that total twice the amount due', () => {
    expect(lineTotalMismatchNote([consultant, monthly], { amountDue: '$5,500.00', taxAmount: '$0.00' })).toBe(
      'Invoice lines total $11,000.00, but the amount due $5,500.00 less freight $0.00 and tax $0.00 is $5,500.00. Check for a duplicated or summary line, or a payment, credit, or discount applied outside the lines, before approving.'
    );
  });

  it('accepts lines that match the amount due', () => {
    expect(lineTotalMismatchNote([consultant], { amountDue: '$5,500.00', taxAmount: '$0.00' })).toBeUndefined();
  });

  it('subtracts freight and tax from the amount due', () => {
    const line = { lineOrder: 1, description: 'Widgets', quantity: 2, unitCost: 50, extendedAmount: 100 };
    expect(lineTotalMismatchNote([line], { amountDue: '$118.25', freightAmount: '$10.00', taxAmount: '$8.25' })).toBeUndefined();
    expect(lineTotalMismatchNote([line], { amountDue: '$118.25', freightAmount: '$10.00' })).toContain('is $108.25');
  });

  it('nets discount lines and amount-only lines', () => {
    const lines = [
      { lineOrder: 1, description: 'Consulting', quantity: 0, unitCost: 0, extendedAmount: 1250 },
      { lineOrder: 2, description: 'Discount', hasDiscount: true, quantity: null, unitCost: null, extendedAmount: -250 },
    ];
    expect(lineTotalMismatchNote(lines, { amountDue: '1,000.00' })).toBeUndefined();
  });

  it('uses quantity times unit cost when a line has no extended amount', () => {
    const line = { lineOrder: 1, description: 'Widgets', quantity: 3, unitCost: 33.34, extendedAmount: null };
    expect(lineTotalMismatchNote([line], { amountDue: '$100.02' })).toBeUndefined();
    expect(lineTotalMismatchNote([line], { amountDue: '$100.00' })).toContain('Invoice lines total $100.02');
  });

  it('skips the check without an amount due, lines, or a line amount', () => {
    expect(lineTotalMismatchNote([consultant, monthly], {})).toBeUndefined();
    expect(lineTotalMismatchNote([], { amountDue: '$5,500.00' })).toBeUndefined();
    expect(lineTotalMismatchNote(
      [{ lineOrder: 1, description: 'Retainer', quantity: 1, unitCost: null, extendedAmount: null }],
      { amountDue: '$5,500.00' }
    )).toBeUndefined();
  });

  it('asks about a missing line or charge when the lines fall short', () => {
    expect(lineTotalMismatchNote([consultant], { amountDue: '$6,000.00' })).toBe(
      'Invoice lines total $5,500.00, but the amount due $6,000.00 less freight $0.00 and tax $0.00 is $6,000.00. Check for a missing line or charge before approving.'
    );
  });

  it.each([
    ['a negative amount due', { amountDue: '-$50.00' }],
    ['a parenthesized credit', { amountDue: '$(1,000.00)' }],
    ['a malformed amount due', { amountDue: '1.234,56' }],
    ['an unreadable freight amount', { amountDue: '$5,600.00', freightAmount: 'N/A' }],
    ['an unreadable freight amount over a Workday freight', { amountDue: '$5,515.00', freightAmount: 'N/A', currentFreightAmount: '15.00' }],
    ['an unreadable tax amount', { amountDue: '$5,600.00', taxAmount: '12.3.4' }],
    ['an unreadable Workday tax amount', { amountDue: '$5,600.00', currentTaxAmount: { value: 100 } }],
  ])('skips the check for %s', (_label, charges) => {
    expect(lineTotalMismatchNote([consultant], charges)).toBeUndefined();
  });

  it('uses the Workday invoice freight and tax when none was extracted, as the builder does', () => {
    const charges = { amountDue: '$5,620.00', currentFreightAmount: '15.00', currentTaxAmount: 105 };
    expect(lineTotalMismatchNote([consultant], charges)).toBeUndefined();
    expect(lineTotalMismatchNote([consultant], { ...charges, freightAmount: '$20.00' })).toContain('less freight $20.00 and tax $105.00');
    expect(lineTotalMismatchNote([consultant], { ...charges, taxCleared: true })).toContain('less freight $15.00 and tax $0.00');
  });

  it('moves freight-described lines to freight when no header freight is set', () => {
    const shipping = { lineOrder: 2, description: 'Shipping', quantity: 1, unitCost: 10, extendedAmount: 10 };
    expect(lineTotalMismatchNote([consultant, shipping], { amountDue: '$5,510.00' })).toBeUndefined();
    expect(lineTotalMismatchNote([consultant, shipping], { amountDue: '$5,510.00', freightAmount: '$10.00' })).toBeUndefined();
  });

  it('counts a discount line once at its unit cost, as the builder submits it', () => {
    const discount = { lineOrder: 2, description: 'Discount', hasDiscount: true, quantity: 2, unitCost: -5, extendedAmount: null };
    expect(lineTotalMismatchNote([consultant, discount], { amountDue: '$5,495.00' })).toBeUndefined();
  });
});

describe('extracted amount parsing', () => {
  it.each([
    ['$5,500.00', 5500],
    ['5,500.00', 5500],
    ['USD 1,234.567', 1234.57],
  ])('parses amount %s to cents', (raw, expected) => {
    expect(parseExtractedAmount(raw)).toBe(expected);
  });

  it.each([
    ['$224.9488753', 224.948875],
    ['$1,224.12', 1224.12],
    ['0.0123456789', 0.012346],
  ])('parses unit cost %s to six decimals', (raw, expected) => {
    expect(parseExtractedUnitCost(raw)).toBe(expected);
  });

  it('returns undefined for text without a number', () => {
    expect(parseExtractedAmount('N/A')).toBeUndefined();
    expect(parseExtractedUnitCost('N/A')).toBeUndefined();
    expect(parseExtractedLineAmount('N/A')).toBeUndefined();
  });

  it.each([
    ['-$250.00', -250],
    ['$-250.00', -250],
    ['($1,000.50)', -1000.5],
    ['\u2212$12.345', -12.345],
    ['$10.0049', 10.005],
    ['$250.00', 250],
  ])('keeps the sign of line amount %s', (raw, expected) => {
    expect(parseExtractedLineAmount(raw)).toBe(expected);
  });

  it('keeps the sign of a printed negative unit cost and leaves header amounts unsigned', () => {
    expect(parseExtractedUnitCost('-$12.3456789')).toBe(-12.345679);
    expect(parseExtractedAmount('-$250.00')).toBe(250);
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

describe('normalizeExtractedFreightAndTax', () => {
  it('moves a sales-tax amount out of freight into tax', () => {
    const result = normalizeExtractedFreightAndTax({
      extractedFreightAmount: '510.86',
      extractedFreightLabel: 'Sales Tax',
      extractedTaxAmount: '0',
      extractedTaxLabel: 'Tax',
    });
    expect(result.extractedFreightAmount).toBeUndefined();
    expect(result.extractedTaxAmount).toBe('510.86');
    expect(result.freightCleared).toBe(true);
    expect(result.taxCleared).toBe(false);
  });

  it('keeps a real freight amount and a real tax amount separate', () => {
    const result = normalizeExtractedFreightAndTax({
      extractedFreightAmount: '15.00',
      extractedFreightLabel: 'Shipping',
      extractedTaxAmount: '5.00',
      extractedTaxLabel: 'Sales Tax',
    });
    expect(result.extractedFreightAmount).toBe('15.00');
    expect(result.extractedTaxAmount).toBe('5.00');
    expect(result.freightCleared).toBe(false);
    expect(result.taxCleared).toBe(false);
  });

  it('moves a freight-labeled tax amount into freight', () => {
    const result = normalizeExtractedFreightAndTax({
      extractedFreightAmount: null,
      extractedFreightLabel: null,
      extractedTaxAmount: '25.00',
      extractedTaxLabel: 'Shipping & Handling',
    });
    expect(result.extractedFreightAmount).toBe('25.00');
    expect(result.extractedTaxAmount).toBeUndefined();
    expect(result.freightCleared).toBe(false);
    expect(result.taxCleared).toBe(true);
  });

  it('swaps freight and tax when both are mislabeled', () => {
    const result = normalizeExtractedFreightAndTax({
      extractedFreightAmount: '8.00',
      extractedFreightLabel: 'Sales Tax',
      extractedTaxAmount: '10.00',
      extractedTaxLabel: 'Freight',
    });
    expect(result.extractedFreightAmount).toBe('10.00');
    expect(result.extractedTaxAmount).toBe('8.00');
  });

  it('treats labeled zero amounts as explicit clears', () => {
    const result = normalizeExtractedFreightAndTax({
      extractedFreightAmount: '0.00',
      extractedFreightLabel: 'Freight',
      extractedTaxAmount: '0',
      extractedTaxLabel: 'Sales Tax',
    });
    expect(result.extractedFreightAmount).toBeUndefined();
    expect(result.extractedTaxAmount).toBeUndefined();
    expect(result.freightCleared).toBe(true);
    expect(result.taxCleared).toBe(true);
  });

  it.each([
    'Sales Tax Amount',
    'Total Tax Amount',
    'Sales Tax - Estimated',
    'Sales Tax (approx.)',
  ])('moves a freight amount labeled %s to tax', (label) => {
    const result = normalizeExtractedFreightAndTax({
      extractedFreightAmount: '$510.86',
      extractedFreightLabel: label,
    });
    expect(result.extractedFreightAmount).toBeUndefined();
    expect(result.extractedTaxAmount).toBe('$510.86');
    expect(result.freightCleared).toBe(true);
  });

  it.each(['Freight Amount', 'Shipping & Handling Amount', 'Shipping Total'])('moves a tax amount labeled %s to freight', (label) => {
    const result = normalizeExtractedFreightAndTax({
      extractedTaxAmount: '25.00',
      extractedTaxLabel: label,
    });
    expect(result.extractedFreightAmount).toBe('25.00');
    expect(result.extractedTaxAmount).toBeUndefined();
    expect(result.taxCleared).toBe(true);
  });

  it.each(['1,2,3', '12,34', '1,23.45', '510.86.1'])('withholds malformed amount %s under a crossed label and asks for review', (amount) => {
    expect(normalizeExtractedFreightAndTax({
      extractedFreightAmount: amount,
      extractedFreightLabel: 'Sales Tax',
    })).toEqual({
      extractedFreightAmount: undefined,
      extractedTaxAmount: undefined,
      freightCleared: false,
      taxCleared: false,
      reviewNote: `Could not safely apply freight amount "${amount}" labeled "Sales Tax", so it was not submitted; any value already on the Workday invoice was left as is. Verify freight and tax against the document.`,
      chargeWithheld: true,
    });
  });

  it('marks only withheld charges, not conflicting charges that are both submitted', () => {
    expect(resolveHeaderChargeAmounts({ extractedFreightAmount: 'N/A' }).chargeWithheld).toBe(true);
    const conflicting = resolveHeaderChargeAmounts({
      extractedFreightAmount: '$12.00',
      extractedFreightLabel: 'Sales Tax',
      extractedTaxAmount: '$30.00',
      extractedTaxLabel: 'Sales Tax',
    });
    expect(conflicting).toMatchObject({ extractedFreightAmount: '$12.00', extractedTaxAmount: '$30.00' });
    expect(conflicting.reviewNote).toContain('both were kept as read');
    expect(conflicting.chargeWithheld).toBeUndefined();
  });

  it('withholds a crossed amount when the other amount is unreadable instead of submitting it under the wrong field', () => {
    const result = normalizeExtractedFreightAndTax({
      extractedFreightAmount: '510.86',
      extractedFreightLabel: 'Sales Tax',
      extractedTaxAmount: '1.234,56',
      extractedTaxLabel: 'Sales Tax',
    });
    expect(result.extractedFreightAmount).toBeUndefined();
    expect(result.extractedTaxAmount).toBeUndefined();
    expect(result.freightCleared).toBe(false);
    expect(result.taxCleared).toBe(false);
    expect(result.reviewNote).toBe('Could not safely apply freight amount "510.86" labeled "Sales Tax" and tax amount "1.234,56" labeled "Sales Tax", so they were not submitted; any value already on the Workday invoice was left as is. Verify freight and tax against the document.');
  });

  it('withholds only the unreadable amount when labels match and keeps the readable one', () => {
    const result = normalizeExtractedFreightAndTax({
      extractedFreightAmount: '12.00',
      extractedFreightLabel: 'Shipping',
      extractedTaxAmount: '-4.00',
      extractedTaxLabel: 'Sales Tax',
    });
    expect(result.extractedFreightAmount).toBe('12.00');
    expect(result.extractedTaxAmount).toBeUndefined();
    expect(result.reviewNote).toContain('tax amount "-4.00" labeled "Sales Tax"');
  });

  it.each(['510.86 $', '$ 510.86*', '510.86 USD*', '$510.86†'])('accepts correctly labeled amount %s with a trailing symbol or footnote mark', (amount) => {
    expect(normalizeExtractedFreightAndTax({
      extractedFreightAmount: amount,
      extractedFreightLabel: 'Shipping',
      extractedTaxAmount: amount,
      extractedTaxLabel: 'Sales Tax',
    })).toEqual({
      extractedFreightAmount: amount,
      extractedTaxAmount: amount,
      freightCleared: false,
      taxCleared: false,
    });
  });

  it('moves a trailing-symbol tax amount read into freight', () => {
    const result = normalizeExtractedFreightAndTax({
      extractedFreightAmount: '510.86 $',
      extractedFreightLabel: 'Sales Tax',
    });
    expect(result.extractedFreightAmount).toBeUndefined();
    expect(result.extractedTaxAmount).toBe('510.86 $');
    expect(result.freightCleared).toBe(true);
  });

  it.each(['Shipping Amount Due', 'Freight Due', 'Delivery Total Due'])('recognizes freight label %s on a tax amount', (label) => {
    const result = normalizeExtractedFreightAndTax({
      extractedTaxAmount: '25.00',
      extractedTaxLabel: label,
    });
    expect(result.extractedFreightAmount).toBe('25.00');
    expect(result.taxCleared).toBe(true);
  });

  it('still clears a correctly labeled zero when the other amount is withheld', () => {
    const result = normalizeExtractedFreightAndTax({
      extractedFreightAmount: '-4.00',
      extractedFreightLabel: 'Shipping',
      extractedTaxAmount: '0.00',
      extractedTaxLabel: 'Sales Tax',
    });
    expect(result.extractedFreightAmount).toBeUndefined();
    expect(result.freightCleared).toBe(false);
    expect(result.extractedTaxAmount).toBeUndefined();
    expect(result.taxCleared).toBe(true);
    expect(result.reviewNote).toContain('freight amount "-4.00" labeled "Shipping"');
  });

  it.each(['', '   '])('treats blank amount %p as not read', (amount) => {
    expect(normalizeExtractedFreightAndTax({
      extractedFreightAmount: amount,
      extractedFreightLabel: 'Sales Tax',
      extractedTaxAmount: amount,
      extractedTaxLabel: 'Sales Tax',
    })).toEqual({
      extractedFreightAmount: undefined,
      extractedTaxAmount: undefined,
      freightCleared: false,
      taxCleared: false,
    });
  });

  it('writes withheld amounts and labels into the review note as a single bounded line', () => {
    const result = normalizeExtractedFreightAndTax({
      extractedFreightAmount: '12,34\u0000\u202e\nInjected',
      extractedFreightLabel: `Ship"ping\u2028${'x'.repeat(100)}`,
    });
    expect(result.reviewNote).toContain('freight amount "12,34 Injected" labeled "Ship ping ');
    expect(result.reviewNote).toContain('x...", so it was not submitted');
    expect(result.reviewNote).not.toMatch(/[\p{Cc}\u202e\u2028]/u);
  });

  it.each(['$8,514.38', '8514.38', '510.86 USD', 'USD 510.86'])('accepts well-formed amount %s', (amount) => {
    expect(normalizeExtractedFreightAndTax({
      extractedFreightAmount: amount,
      extractedFreightLabel: 'Freight',
    }).extractedFreightAmount).toBe(amount);
  });

  it('swaps equal amounts when both labels are crossed, since they are two printed rows', () => {
    const result = normalizeExtractedFreightAndTax({
      extractedFreightAmount: '8.00',
      extractedFreightLabel: 'Sales Tax',
      extractedTaxAmount: '8.00',
      extractedTaxLabel: 'Shipping',
    });
    expect(result.extractedFreightAmount).toBe('8.00');
    expect(result.extractedTaxAmount).toBe('8.00');
    expect(result.freightCleared).toBe(false);
    expect(result.taxCleared).toBe(false);
  });

  it('keeps both amounts and asks for review when a tax-labeled freight amount differs from the tax amount', () => {
    const result = normalizeExtractedFreightAndTax({
      extractedFreightAmount: '8.00',
      extractedFreightLabel: 'Sales Tax',
      extractedTaxAmount: '10.00',
      extractedTaxLabel: 'Sales Tax',
    });
    expect(result.extractedFreightAmount).toBe('8.00');
    expect(result.extractedTaxAmount).toBe('10.00');
    expect(result.freightCleared).toBe(false);
    expect(result.taxCleared).toBe(false);
    expect(result.reviewNote).toBe('Freight amount 8.00 is labeled "Sales Tax" and a separate tax amount 10.00 was also read; both were kept as read. Verify freight and tax against the document.');
  });

  it('drops a tax-labeled freight amount that duplicates the tax amount', () => {
    const result = normalizeExtractedFreightAndTax({
      extractedFreightAmount: '$510.86',
      extractedFreightLabel: 'Sales Tax',
      extractedTaxAmount: '510.86',
      extractedTaxLabel: 'Sales Tax',
    });
    expect(result.extractedFreightAmount).toBeUndefined();
    expect(result.extractedTaxAmount).toBe('510.86');
    expect(result.freightCleared).toBe(true);
    expect(result.reviewNote).toBeUndefined();
  });

  it('keeps both amounts and asks for review when a freight-labeled tax amount differs from the freight amount', () => {
    const result = normalizeExtractedFreightAndTax({
      extractedFreightAmount: '15.00',
      extractedFreightLabel: 'Shipping',
      extractedTaxAmount: '8.00',
      extractedTaxLabel: 'Freight',
    });
    expect(result.extractedFreightAmount).toBe('15.00');
    expect(result.extractedTaxAmount).toBe('8.00');
    expect(result.freightCleared).toBe(false);
    expect(result.taxCleared).toBe(false);
    expect(result.reviewNote).toContain('Tax amount 8.00 is labeled "Freight"');
  });

  it.each([
    ['-15.00', 'Shipping', 'Freight'],
    ['N/A', 'Sales Tax', 'Tax'],
    ['1.234,56', 'Sales Tax', 'Tax'],
  ])('withholds unparseable amount %s under matching label %s and asks for review', (amount, label, field) => {
    const result = normalizeExtractedFreightAndTax(field === 'Freight'
      ? { extractedFreightAmount: amount, extractedFreightLabel: label }
      : { extractedTaxAmount: amount, extractedTaxLabel: label });
    expect(result.extractedFreightAmount).toBeUndefined();
    expect(result.extractedTaxAmount).toBeUndefined();
    expect(result.freightCleared).toBe(false);
    expect(result.taxCleared).toBe(false);
    expect(result.reviewNote).toContain(`${field.toLowerCase()} amount "${amount}" labeled "${label}"`);
  });
});

describe('resolveHeaderChargeAmounts', () => {
  it('moves the BearCom tax-labeled freight to tax and clears freight when no freight lines exist', () => {
    expect(resolveHeaderChargeAmounts({
      extractedFreightAmount: '510.86',
      extractedFreightLabel: 'Sales Tax',
      extractedTaxAmount: null,
      extractedTaxLabel: null,
    })).toEqual({
      extractedFreightAmount: undefined,
      extractedTaxAmount: '510.86',
      freightCleared: true,
      taxCleared: false,
    });
  });

  it.each([
    ['moved', { extractedFreightAmount: '$510.86', extractedFreightLabel: 'Sales Tax' }],
    ['a duplicate tax read', { extractedFreightAmount: '510.86', extractedFreightLabel: 'Sales Tax', extractedTaxAmount: '510.86', extractedTaxLabel: 'Sales Tax' }],
    ['a zero tax row', { extractedFreightAmount: '0.00', extractedFreightLabel: 'Sales Tax', extractedTaxAmount: '510.86', extractedTaxLabel: 'Sales Tax' }],
  ])('fills freight from shipping lines when the freight header amount was %s out to tax', (_case, extracted) => {
    const result = resolveHeaderChargeAmounts({ ...extracted, freightAmountFromLines: 15 });
    expect(result.extractedFreightAmount).toBe('15');
    expect(result.freightCleared).toBe(false);
    expect(parseFloat(result.extractedTaxAmount!.replace('$', ''))).toBe(510.86);
  });

  it('keeps freight cleared when a tax-field row labeled Shipping printed zero, even with shipping lines', () => {
    const result = resolveHeaderChargeAmounts({
      extractedFreightAmount: '510.86',
      extractedFreightLabel: 'Sales Tax',
      extractedTaxAmount: '0.00',
      extractedTaxLabel: 'Shipping',
      freightAmountFromLines: 15,
    });
    expect(result.extractedFreightAmount).toBeUndefined();
    expect(result.freightCleared).toBe(true);
    expect(result.extractedTaxAmount).toBe('510.86');
  });

  it('fills freight from lines only when the document showed no freight header', () => {
    expect(resolveHeaderChargeAmounts({ freightAmountFromLines: 25 }).extractedFreightAmount).toBe('25');
    expect(resolveHeaderChargeAmounts({
      extractedFreightAmount: '12.00',
      extractedFreightLabel: 'Shipping',
      freightAmountFromLines: 25,
    }).extractedFreightAmount).toBe('12.00');
  });

  it.each(['', '   '])('fills freight from lines when the freight header amount is blank (%p)', (amount) => {
    const result = resolveHeaderChargeAmounts({
      extractedFreightAmount: amount,
      extractedFreightLabel: 'Shipping',
      freightAmountFromLines: 25,
    });
    expect(result.extractedFreightAmount).toBe('25');
    expect(result.reviewNote).toBeUndefined();
  });

  it('keeps the existing freight instead of line freight when the header amount is withheld', () => {
    const result = resolveHeaderChargeAmounts({
      extractedFreightAmount: '12,34',
      extractedFreightLabel: 'Shipping',
      freightAmountFromLines: 25,
    });
    expect(result.extractedFreightAmount).toBeUndefined();
    expect(result.freightCleared).toBe(false);
    expect(result.reviewNote).toContain('freight amount "12,34"');
  });

  it('does not refill a cleared freight header from lines and drops a cleared tax amount', () => {
    expect(resolveHeaderChargeAmounts({
      extractedFreightAmount: '0.00',
      extractedFreightLabel: 'Shipping',
      extractedTaxAmount: '0.00',
      extractedTaxLabel: 'Sales Tax',
      freightAmountFromLines: 25,
    })).toEqual({
      extractedFreightAmount: undefined,
      extractedTaxAmount: undefined,
      freightCleared: true,
      taxCleared: true,
    });
  });
});

