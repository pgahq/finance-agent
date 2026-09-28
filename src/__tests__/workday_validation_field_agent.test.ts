import { classifyWorkdayValidationField } from '../lib/workday_validation_field_agent.js';

describe('classifyWorkdayValidationField', () => {
  it('returns unknown for a duplicate supplier invoice number without calling the model', async () => {
    const decision = await classifyWorkdayValidationField({
      validation: {
        message: "Enter a Supplier's Invoice Number that isn't already in use on another supplier invoice",
        detailMessage: "The supplier's invoice number entered is already in use.",
        xpath: '/wd:Submit_Supplier_Invoice_Request[1]/wd:Supplier_Invoice_Data[1]/wd:Suppliers_Invoice_Number[1]',
      },
      allowedRetryFields: ['supplier', 'invoiceDate', 'paymentTerms', 'unknown'],
    });

    expect(decision).toEqual({
      retryField: 'unknown',
      workdayField: 'Suppliers_Invoice_Number',
      reason: "Supplier's Invoice Number is already in use. Changing the supplier does not fix that fault.",
    });
  });
});
