const mockSend = jest.fn().mockResolvedValue({});

jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: {
      from: jest.fn(() => ({ send: mockSend })),
    },
  };
});

import { clearInvoiceValidationFailure } from '../lib/invoice_validation_failures.js';

describe('clearInvoiceValidationFailure', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockResolvedValue({});
  });

  it('does nothing when config is undefined', async () => {
    await clearInvoiceValidationFailure(undefined, 'invoice-wid-123');

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('does nothing when invoiceWorkdayID is empty', async () => {
    await clearInvoiceValidationFailure({ tableName: 'test-table' }, '');

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('deletes the validation failure record by invoiceWorkdayID', async () => {
    await clearInvoiceValidationFailure(
      { tableName: 'finance-agent-invoice-validation-failures' },
      'invoice-wid-123',
    );

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].input).toEqual({
      TableName: 'finance-agent-invoice-validation-failures',
      Key: { invoiceWorkdayID: 'invoice-wid-123' },
      ConditionExpression: 'attribute_exists(invoiceWorkdayID)',
    });
  });

  it('ignores missing records without affecting other table items', async () => {
    const conditionalCheckFailed = new Error('The conditional request failed');
    conditionalCheckFailed.name = 'ConditionalCheckFailedException';
    mockSend.mockRejectedValueOnce(conditionalCheckFailed);

    await expect(clearInvoiceValidationFailure(
      { tableName: 'finance-agent-invoice-validation-failures' },
      'invoice-wid-123',
    )).resolves.toBeUndefined();

    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});
