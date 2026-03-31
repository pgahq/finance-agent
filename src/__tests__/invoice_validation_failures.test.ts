import { isWorkdayValidationError, summarizeValidationError } from '../lib/invoice_validation_failures.js';

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

  it('reads standard SOAP fault strings', () => {
    const error = {
      faultstring: 'Validation error occurred while submitting supplier invoice'
    };

    expect(summarizeValidationError(error)).toBe('Validation error occurred while submitting supplier invoice');
    expect(isWorkdayValidationError(error)).toBe(true);
  });
});
