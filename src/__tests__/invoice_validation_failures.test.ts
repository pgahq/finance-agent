import {
  getInvoiceValidationFailuresConfig,
  isWorkdayValidationError,
  summarizeValidationError,
} from '../lib/invoice_validation_failures.js';

describe('invoice_validation_failures', () => {
  it('returns the plain validation message from an Error', () => {
    const error = new Error('Validation_Fault: Spend Category is required');

    expect(summarizeValidationError(error)).toBe('Validation_Fault: Spend Category is required');
    expect(isWorkdayValidationError(error)).toBe(true);
  });

  it('prefers a Workday validation message nested in detail', () => {
    const error = {
      detail: {
        Validation_Fault: {
          Validation_Message: 'Tax Code is required when there is a tax amount.'
        }
      }
    };

    expect(summarizeValidationError(error)).toBe('Tax Code is required when there is a tax amount.');
    expect(isWorkdayValidationError(error)).toBe(true);
  });

  it('reads Workday Validation_Error message and xpath details', () => {
    const error = {
      Validation_Fault: {
        Validation_Error: {
          Message: 'The entered information does not meet the restrictions defined for this field.',
          Detail_Message: 'Please verify the referenced ship-to contact before submitting.',
          Xpath: '/wd:Submit_Supplier_Invoice_Request[1]/wd:Supplier_Invoice_Data[1]/wd:Invoice_Line_Replacement_Data[1]/wd:Ship_To_Contact_Reference'
        }
      }
    };

    expect(summarizeValidationError(error)).toBe(
      'The entered information does not meet the restrictions defined for this field. Detail: Please verify the referenced ship-to contact before submitting. Xpath: /wd:Submit_Supplier_Invoice_Request[1]/wd:Supplier_Invoice_Data[1]/wd:Invoice_Line_Replacement_Data[1]/wd:Ship_To_Contact_Reference'
    );
    expect(isWorkdayValidationError(error)).toBe(true);
  });

  it('does not classify an empty validation fault shape as a usable validation error', () => {
    const error = {
      Validation_Fault: {
        Validation_Error: {}
      }
    };

    expect(summarizeValidationError(error)).toBe('');
    expect(isWorkdayValidationError(error)).toBe(false);
  });

  it('reads standard SOAP fault strings', () => {
    const error = {
      faultstring: 'Validation error occurred while submitting supplier invoice'
    };

    expect(summarizeValidationError(error)).toBe('Validation error occurred while submitting supplier invoice');
    expect(isWorkdayValidationError(error)).toBe(true);
  });

  it('does not classify AI or Zod schema validation failures as Workday validation errors', () => {
    expect(isWorkdayValidationError(new Error('Type validation failed: Value must be object'))).toBe(false);
    expect(isWorkdayValidationError(new Error('Schema validation failed'))).toBe(false);
  });

  it('does not classify RAG or infrastructure errors mentioning validation as Workday validation errors', () => {
    expect(isWorkdayValidationError(new Error('Failed to fetch validation rules: ECONNREFUSED'))).toBe(false);
    expect(isWorkdayValidationError(new Error('connection terminated unexpectedly'))).toBe(false);
  });

  describe('getInvoiceValidationFailuresConfig', () => {
    it('returns undefined when table name env var is missing', () => {
      expect(getInvoiceValidationFailuresConfig({})).toBeUndefined();
    });

    it('returns config when table name env var is set', () => {
      expect(getInvoiceValidationFailuresConfig({
        INVOICE_VALIDATION_FAILURES_TABLE_NAME: 'finance-agent-invoice-validation-failures',
      })).toEqual({
        tableName: 'finance-agent-invoice-validation-failures',
      });
    });
  });
});
