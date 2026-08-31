import {
  applyDefaultCompanyLineWorktags,
  applyRelatedLobWorktags,
  buildFinalInvoiceLines,
  isFreightOrHandlingLine,
  overlayPoLineOfBusiness,
  splitFreightLines,
  type FinalInvoiceLine,
} from '../lib/invoice_lines.js';
import { getAiResponse } from '../lib/ai.js';
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
      }]
    );

    expect(lines[0].lineOfBusinessId).toBe('LOB-From-Email');
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

describe('buildFinalInvoiceLines', () => {
  const extracted = [{ description: 'Janitorial', quantity: 1, unitCost: '100', totalPrice: '100', hasDiscount: null }];

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.FALLBACK_COST_CENTER_ID;
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
