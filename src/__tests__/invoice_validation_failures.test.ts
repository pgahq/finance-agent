import {
  collectWorkdayValidationErrorText,
  getInvoiceValidationFailuresConfig,
  humanWorkdayValidationMessage,
  isDisallowedLineOfBusinessWorktagError,
  isLineOfBusinessRelatedWorktagError,
  isRequiredLineOfBusinessWorktagError,
  isWorkdayTaskNotAuthorizedError,
  isWorkdayValidationError,
  summarizeValidationError,
} from '../lib/invoice_validation_failures.js';

describe('invoice_validation_failures', () => {
  it('detects related-worktag faults that require Line of Business', () => {
    expect(isRequiredLineOfBusinessWorktagError(
      'When "Cost Center: CC-Enterprise Technology" is entered then these worktag types must also have a value: Line of Business'
    )).toBe(true);
    expect(isRequiredLineOfBusinessWorktagError('Spend Category is required')).toBe(false);
    expect(isDisallowedLineOfBusinessWorktagError(
      'The Cost Center "CC-Enterprise Technology" does not allow worktag values: "Line of Business: Default Line Of Business"'
    )).toBe(true);
    expect(isLineOfBusinessRelatedWorktagError(
      'The Cost Center "CC-Enterprise Technology" does not allow worktag values: "Line of Business: Default Line Of Business"'
    )).toBe(true);
  });

  it('detects a required Line of Business rule in a multi-error SOAP fault', () => {
    const error = {
      faultstring: 'Validation error occurred.',
      detail: {
        Validation_Fault: {
          Validation_Error: [
            {
              Message: 'When "Cost Center: CC-Enterprise Technology" is entered then these worktag types must also have a value: Line of Business.',
              Xpath: '/wd:Submit_Supplier_Invoice_Request[1]/wd:Supplier_Invoice_Data[1]/wd:Invoice_Line_Replacement_Data[9]/wd:Worktags_Reference'
            },
            {
              Message: 'The Cost Center is/are not available for use with the company/s: CC-Enterprise Technology',
              Xpath: '/wd:Submit_Supplier_Invoice_Request[1]/wd:Supplier_Invoice_Data[1]/wd:Invoice_Line_Replacement_Data[9]/wd:Worktags_Reference'
            }
          ]
        }
      }
    };

    expect(isRequiredLineOfBusinessWorktagError(error)).toBe(true);
    expect(isLineOfBusinessRelatedWorktagError(error)).toBe(true);
    expect(collectWorkdayValidationErrorText(error)).toContain('must also have a value: Line of Business');
    expect(collectWorkdayValidationErrorText(error)).toContain('not available for use with the company');
  });

  it('detects a Workday processing fault that is not authorized', () => {
    expect(isWorkdayTaskNotAuthorizedError(
      'Processing error occurred. The task submitted is not authorized.'
    )).toBe(true);
    expect(isWorkdayTaskNotAuthorizedError({
      body: '<?xml version="1.0" encoding="utf-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"><SOAP-ENV:Body><SOAP-ENV:Fault><faultcode>SOAP-ENV:Server.processingError</faultcode><faultstring>Processing error occurred. The task submitted is not authorized.</faultstring></SOAP-ENV:Fault></SOAP-ENV:Body></SOAP-ENV:Envelope>'
    })).toBe(true);
    expect(isWorkdayTaskNotAuthorizedError('Spend Category is required')).toBe(false);
  });

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

  it('reads a human Workday Message from a SOAP fault string with embedded JSON', () => {
    const soapMessage = 'faultcode: SOAP-ENV:Client.validationError faultstring: Validation error occurred. You can\'t select this supplier to invoice this purchase order. detail: {"Validation_Fault":{"Validation_Error":{"Message":"You can\'t select this supplier to invoice this purchase order.","Detail_Message":"Parm Supplier Invoice Line Replacement Data Restricted by Supplier Invoice Line Replacement Data-You can\'t select this supplier to invoice this purchase order.{+1}- on Supplier Invoice Line Replacement Data","Xpath":"/wd:Submit_Supplier_Invoice_Request[1]/wd:Supplier_Invoice_Data[1]/wd:Invoice_Line_Replacement_Data[1]"}}}';

    expect(humanWorkdayValidationMessage(new Error(soapMessage))).toBe(
      "You can't select this supplier to invoice this purchase order."
    );
  });

  it('reads faultstring from a SOAP XML envelope', () => {
    expect(humanWorkdayValidationMessage(new Error(
      '<?xml version="1.0" encoding="utf-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"><SOAP-ENV:Body><SOAP-ENV:Fault><faultcode>SOAP-ENV:Server.processingError</faultcode><faultstring>Processing error occurred. The task submitted is not authorized.</faultstring></SOAP-ENV:Fault></SOAP-ENV:Body></SOAP-ENV:Envelope>'
    ))).toBe('Processing error occurred. The task submitted is not authorized.');
  });

  it('prefers Detail_Message when Message is a generic restriction notice', () => {
    expect(humanWorkdayValidationMessage({
      Validation_Fault: {
        Validation_Error: {
          Message: 'The entered information does not meet the restrictions defined for this field.',
          Detail_Message: 'The invoice date must be the first day of the month.',
        },
      },
    })).toBe('The invoice date must be the first day of the month.');
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
