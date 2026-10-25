/* eslint-disable @typescript-eslint/require-await -- stubs implement async interfaces */
import { createReplayWorkday, REPLAY_CREATED_WID } from '../eval/replay_workday.js';
import { scoredFieldsFromSubmitRequest } from '../eval/replay_payload.js';
import { getSupplierInvoice, getPurchaseOrder, executeWorkdayQuery, setWorkdayReplayHook, submitNewSupplierInvoice, submitSupplierInvoiceUpdate, getSupplierInvoiceWithAttachments, getWorkdayConfig } from '../lib/workday.js';
import { putBinaryToS3, putJsonToS3, blockS3Writes } from '../lib/s3.js';

jest.mock('@pga/logger', () => ({ debug: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
jest.mock('../lib/workday_validation_field_agent.js', () => ({ classifyWorkdayValidationField: jest.fn() }));
jest.mock('strong-soap', () => ({ soap: { createClient: jest.fn(() => { throw new Error('strong-soap must not be used in a replay'); }), BearerSecurity: jest.fn() } }));

const config = getWorkdayConfig({ WORKDAY_DOMAIN: 'replay.invalid', WORKDAY_TENANT: 'replay' } as NodeJS.ProcessEnv);
const context = { workdayConfig: config };

const line = (overrides: Record<string, unknown> = {}) => ({
  lineOrder: 1,
  description: 'Venue rental',
  quantity: 1,
  unitCost: 100,
  extendedAmount: 100,
  costCenterId: 'CC1',
  fundId: 'F1',
  spendCategoryId: 'SC-1',
  ...overrides,
});

describe('replay Workday', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    setWorkdayReplayHook(undefined);
    global.fetch = originalFetch;
  });

  it('records the real Submit_Supplier_Invoice request for a create and sends nothing', async () => {
    const workday = createReplayWorkday();
    setWorkdayReplayHook(workday.hook);
    const outcome = await submitNewSupplierInvoice(context, {
      supplierWID: 'supplier-wid',
      companyWID: 'Default_OCR_Company',
      companyReferenceType: 'Company_Reference_ID',
      buildNotes: () => 'notes',
      memo: 'Memo',
      invoiceDate: '2026-10-01',
      extractedAmountDue: '$100.00',
      suppliersInvoiceNumber: 'INV-1',
      finalLines: [line()] as never,
      attachments: [],
    });
    expect(outcome.invoiceWID).toBe(REPLAY_CREATED_WID);
    expect(workday.submits).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();

    const request = workday.submits[0].request;
    expect(request.Submit_Supplier_Invoice_Request?.Supplier_Invoice_Reference).toBeUndefined();
    const data = request.Submit_Supplier_Invoice_Request?.Supplier_Invoice_Data as Record<string, unknown>;
    expect(data.Submit).toBe(false);

    const { fields } = await scoredFieldsFromSubmitRequest(request, { supplierKey: async () => 'Supplier_ID=S-1', companyKey: async () => undefined });
    expect(fields).toMatchObject({
      supplier: 'Supplier_ID=S-1',
      company: 'Company_Reference_ID=Default_OCR_Company',
      suppliersInvoiceNumber: 'INV-1',
      invoiceDate: '2026-10-01',
      controlTotal: 100,
      memo: 'Memo',
    });
    expect(fields.lines[0]).toMatchObject({
      lineOrder: 1,
      amount: 100,
      costCenter: 'Cost_Center_Reference_ID=CC1',
      fund: 'Fund_ID=F1',
      spendCategory: 'Spend_Category_ID=SC-1',
      itemDescription: 'Venue rental',
    });
  });

  it('records an update against the OCR invoice the case supplies', async () => {
    const baseline = {
      Invoice_Number: 'SUPIN-9',
      Company_Reference: { ID: [{ $attributes: { type: 'Company_Reference_ID' }, $value: '912' }] },
      Currency_Reference: { ID: [{ $attributes: { type: 'Currency_ID' }, $value: 'USD' }] },
      Invoice_Date: '2026-09-30',
      Control_Amount_Total: 100,
    };
    const workday = createReplayWorkday({ invoices: new Map([['inv-wid', baseline]]) });
    setWorkdayReplayHook(workday.hook);
    await submitSupplierInvoiceUpdate(context, {
      invoiceWorkdayID: 'inv-wid',
      supplierWID: 'supplier-wid',
      buildNotes: () => 'notes',
      invoiceDate: '2026-10-01',
      extractedAmountDue: '$100.00',
      finalLines: [line()] as never,
    });
    expect(workday.submits).toHaveLength(1);
    expect(workday.submits[0].invoiceWorkdayId).toBe('inv-wid');
    const data = workday.submits[0].request.Submit_Supplier_Invoice_Request?.Supplier_Invoice_Data as Record<string, unknown>;
    expect(data.Invoice_Number).toBe('SUPIN-9');
    expect(data.Submit).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serves a PO from the case and returns nothing for one it does not hold', async () => {
    const response = { Response_Data: { Purchase_Order: [{ Purchase_Order_Data: { Document_Number: 'PO-1' } }] } };
    const workday = createReplayWorkday({ purchaseOrders: new Map([['PO-1', response]]) });
    setWorkdayReplayHook(workday.hook);
    expect(await getPurchaseOrder(context, 'PO-1')).toBe(response);
    expect(await getPurchaseOrder(context, 'PO-2')).toEqual({ Response_Data: {} });
  });

  it('serves the invoice read and the attachment load from the case, with no upload', async () => {
    const workday = createReplayWorkday({
      invoices: new Map([['inv-wid', { Invoice_Number: 'SUPIN-9' }]]),
      loadAttachments: async () => [{ id: 'inv-wid-0', fileName: 'a.pdf', contentType: 'application/pdf', presignedUrl: '', expiresAt: new Date(), s3Key: 'attachments/inv-wid/a.pdf', buffer: Buffer.from('x') }],
    });
    setWorkdayReplayHook(workday.hook);
    expect(await getSupplierInvoice(context, 'inv-wid')).toEqual({ Invoice_Number: 'SUPIN-9' });
    await expect(getSupplierInvoice(context, 'other')).rejects.toThrow('No invoice found');
    const loaded = await getSupplierInvoiceWithAttachments({ ...context, s3Config: { bucketName: 'b' } }, 'inv-wid');
    expect(loaded.presignedAttachments.map((attachment) => attachment.fileName)).toEqual(['a.pdf']);
  });

  it('refuses every other Workday call, over REST and SOAP, without touching the network', async () => {
    const workday = createReplayWorkday();
    setWorkdayReplayHook(workday.hook);
    await expect(executeWorkdayQuery(config, 'SELECT 1')).rejects.toThrow('blocked while an eval replay is running');
    const client = workday.hook.client as Record<string, (request: unknown, callback: (error: unknown) => void) => void>;
    const error = await new Promise<unknown>((resolve) => client.Put_Supplier_Invoice({}, resolve));
    expect(String(error)).toContain('Put_Supplier_Invoice is blocked');
    expect(client.lastRequest).toBeUndefined();
    expect(workday.blocked).toEqual(['Put_Supplier_Invoice']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not reach the network once the hook is removed', async () => {
    const workday = createReplayWorkday();
    setWorkdayReplayHook(workday.hook);
    setWorkdayReplayHook(undefined);
    fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: 'x', text: async () => '' });
    await expect(executeWorkdayQuery(config, 'SELECT 1')).rejects.toThrow('Failed to get access token');
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe('S3 write guard', () => {
  it('refuses writes once blocked', async () => {
    blockS3Writes();
    await expect(putBinaryToS3({ bucketName: 'b' }, 'k', Buffer.from('x'), 'text/plain')).rejects.toThrow('S3 writes are blocked');
    await expect(putJsonToS3({ bucketName: 'b' }, 'k', {})).rejects.toThrow('S3 writes are blocked');
  });
});
