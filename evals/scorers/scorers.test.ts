import { aggregateFieldAccuracy, scoreInvoiceLineMergeCase } from '../scorers/invoice-line-merge.js';
import { scoreSupplierRagCase, aggregateHitRate } from '../scorers/supplier-rag.js';
import { scoreValidationFieldCase } from '../scorers/validation-field.js';

describe('eval scorers', () => {
  it('scores validation field matches', () => {
    const result = scoreValidationFieldCase(
      {
        id: 'test',
        input: {
          validation: { message: 'bad date' },
          allowedRetryFields: ['invoiceDate'],
        },
        expected: { retryField: 'invoiceDate' },
      },
      { retryField: 'invoiceDate', reason: 'invoice date fault' }
    );

    expect(result.passed).toBe(true);
  });

  it('scores invoice line merge fields', () => {
    const result = scoreInvoiceLineMergeCase(
      {
        id: 'test',
        input: { extractedInvoiceLines: [{ description: 'test' }] },
        expected: {
          lines: [{ lineOrder: 1, costCenterId: '72200' }],
        },
      },
      [{
        lineOrder: 1,
        description: 'test',
        costCenterId: '72200',
        fundId: null,
        spendCategoryId: null,
        lineOfBusinessId: null,
        eventId: null,
        shipToAddressId: null,
        purchaseOrderLineId: null,
      }]
    );

    expect(result.passed).toBe(true);
    expect(aggregateFieldAccuracy(result.fieldScores)).toBe(1);
  });

  it('scores supplier rag hit rates', () => {
    const score = scoreSupplierRagCase(
      {
        id: 'test',
        query: 'Acme',
        expectedWorkdayId: 'wid-1',
        matchRank: 3,
      },
      [
        { workday_id: 'wid-2' },
        { workday_id: 'wid-1' },
      ]
    );

    expect(score.hitAt1).toBe(false);
    expect(score.hitAt3).toBe(true);
    expect(aggregateHitRate([score], 3)).toBe(1);
  });
});
