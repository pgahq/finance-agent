/* eslint-disable @typescript-eslint/require-await -- stubs implement async interfaces */
import { extractScoredFields, diffScoredFields } from '../lib/invoice_snapshots.js';
import { invoiceDataFromScoredFields, scoredFieldsFromSubmitRequest, type ReferenceResolver } from '../eval/replay_payload.js';

jest.mock('@pga/logger', () => ({ debug: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() }));

const ref = (...ids: Array<[string, string]>) => ({ ID: ids.map(([type, value]) => ({ $attributes: { type }, $value: value })) });

const request = {
  Submit_Supplier_Invoice_Request: {
    Supplier_Invoice_Data: {
      Submit: false,
      Company_Reference: ref(['WID', 'company-wid']),
      Invoice_Date: '2026-10-01',
      Due_Date_Override: '2026-10-31',
      Supplier_Reference: ref(['WID', 'supplier-wid']),
      Suppliers_Invoice_Number: 'INV-1',
      Control_Amount_Total: 125.5,
      Memo: 'Header memo',
      Invoice_Line_Replacement_Data: [
        {
          Line_Order: 1,
          Item_Description: 'Venue rental',
          Quantity: 2,
          Unit_Cost: 50,
          Worktags_Reference: [
            ref(['Cost_Center_Reference_ID', 'CC200']),
            ref(['Fund_ID', 'FUND-General']),
            ref(['Organization_Reference_ID', 'LOB-Golf']),
            ref(['Organization_Reference_ID', 'VENU-Frisco']),
          ],
          Spend_Category_Reference: ref(['Spend_Category_ID', 'SC-1']),
          Purchase_Order_Line_Reference: ref(['Purchase_Order_Line_ID', 'PO-123456-1']),
          Memo: 'Line memo',
        },
        { Line_Order: 2, Item_Description: 'Freight', Extended_Amount: 25.5, Quantity: 0, Unit_Cost: 0 },
      ],
    },
  },
};

const resolver: ReferenceResolver = {
  supplierKey: async (wid) => (wid === 'supplier-wid' ? 'Supplier_ID=S-000123' : undefined),
  companyKey: async (wid) => (wid === 'company-wid' ? 'Company_Reference_ID=912' : undefined),
};

describe('scoredFieldsFromSubmitRequest', () => {
  it('reads the request in the scored shape and maps WID references to reference IDs', async () => {
    const { fields, warnings } = await scoredFieldsFromSubmitRequest(request, resolver);
    expect(warnings).toEqual([]);
    expect(fields).toEqual({
      supplier: 'Supplier_ID=S-000123',
      company: 'Company_Reference_ID=912',
      suppliersInvoiceNumber: 'INV-1',
      invoiceDate: '2026-10-01',
      dueDate: '2026-10-31',
      controlTotal: 125.5,
      memo: 'Header memo',
      lines: [
        {
          lineOrder: 1,
          amount: 100,
          purchaseOrderLine: 'Purchase_Order_Line_ID=PO-123456-1',
          spendCategory: 'Spend_Category_ID=SC-1',
          costCenter: 'Cost_Center_Reference_ID=CC200',
          fund: 'Fund_ID=FUND-General',
          lineOfBusiness: 'Organization_Reference_ID=LOB-Golf',
          otherWorktags: ['Organization_Reference_ID=VENU-Frisco'],
          memo: 'Line memo',
          itemDescription: 'Venue rental',
        },
        { lineOrder: 2, amount: 25.5, otherWorktags: [], itemDescription: 'Freight' },
      ],
    });
  });

  it('fills the extended amount Workday computes when the request leaves it out', async () => {
    const { fields } = await scoredFieldsFromSubmitRequest(request, resolver);
    expect(fields.lines[0].amount).toBe(100);
  });

  it('warns, and leaves the WID, when a header reference cannot be mapped', async () => {
    const { fields, warnings } = await scoredFieldsFromSubmitRequest(request);
    expect(fields.supplier).toBe('WID=supplier-wid');
    expect(warnings.join(' ')).toContain('supplier is a WID (supplier-wid)');
    expect(warnings.join(' ')).toContain('company is a WID (company-wid)');
  });

  it('warns about PO split rows, which a read-back scores at line level only', async () => {
    const withSplits = {
      Submit_Supplier_Invoice_Request: {
        Supplier_Invoice_Data: {
          Invoice_Line_Replacement_Data: [{ Line_Order: 1, Extended_Amount: 10, Supplier_Invoice_Split_Line_Data: [{ Extended_Amount: 10 }] }],
        },
      },
    };
    const { warnings } = await scoredFieldsFromSubmitRequest(withSplits);
    expect(warnings.join(' ')).toContain('1 line(s) carry PO split rows');
  });

  it('handles an empty request', async () => {
    expect((await scoredFieldsFromSubmitRequest({})).fields).toEqual({ lines: [] });
  });
});

describe('invoiceDataFromScoredFields', () => {
  it('round-trips through the production extractor', async () => {
    const { fields } = await scoredFieldsFromSubmitRequest(request, resolver);
    const rebuilt = extractScoredFields(invoiceDataFromScoredFields(fields, 'SUPIN-1'));
    expect(diffScoredFields(fields, rebuilt)).toEqual([]);
    expect(invoiceDataFromScoredFields(fields, 'SUPIN-1').Invoice_Number).toBe('SUPIN-1');
  });

  it('writes a reference with no type as a WID', () => {
    const data = invoiceDataFromScoredFields({ supplier: 'abc123', lines: [] });
    expect(data.Supplier_Reference).toEqual({ ID: [{ $attributes: { type: 'WID' }, $value: 'abc123' }] });
  });
});
