import type { WorkdayValidationFieldDecision } from '../../src/lib/workday_validation_field_agent.js';

export interface ValidationFieldCase {
  id: string;
  input: {
    validation: {
      message?: string;
      detailMessage?: string;
      xpath?: string;
    };
    allowedRetryFields: Array<'supplier' | 'invoiceDate' | 'paymentTerms' | 'worktags'>;
  };
  expected: {
    retryField: WorkdayValidationFieldDecision['retryField'];
  };
}

export function scoreValidationFieldCase(
  testCase: ValidationFieldCase,
  actual: WorkdayValidationFieldDecision
): { passed: boolean; details?: string } {
  if (actual.retryField === testCase.expected.retryField) {
    return { passed: true };
  }

  return {
    passed: false,
    details: `expected retryField=${testCase.expected.retryField}, got ${actual.retryField}`,
  };
}
