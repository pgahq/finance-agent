import { handler } from '../actions/enrich_invoice_supplier.js';

// Mock the dependencies
jest.mock('@pga/lambda-env', () => ({
  __esModule: true,
  default: jest.fn().mockResolvedValue({})
}));

jest.mock('@pga/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn()
}));

jest.mock('../lib/workday.js', () => ({
  getWorkdayConfig: jest.fn().mockReturnValue({
    domain: 'test.workday.com',
    tenant: 'test-tenant',
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    refreshToken: 'test-refresh-token'
  }),
  executeWorkdayQuery: jest.fn().mockResolvedValue([{
    id: 'test-invoice-id',
    invoiceNumber: 'INV-001',
    company1: { id: 'company-1', name: 'Test Company' },
    supplier: null
  }]),
  getAttachmentContent: jest.fn().mockResolvedValue([])
}));

jest.mock('../lib/openai.js', () => ({
  callOpenAIWithSchema: jest.fn().mockResolvedValue({
    supplierId: 'supplier-1',
    supplierName: 'Test Supplier',
    confidence: 0.9,
    reasoning: 'High confidence match'
  })
}));

describe('enrich_invoice_supplier', () => {
  it('should process supplier enrichment event', async () => {
    const mockEvent = {
      detail: {
        action: 'enrich_invoice_supplier',
        data: {
          id: 'test-invoice-id',
          invoiceNumber: 'INV-001',
          supplier: null
        },
        timestamp: '2024-01-01T00:00:00Z',
        requestId: 'test-request-id'
      }
    };

    await expect(handler(mockEvent as any)).resolves.not.toThrow();
  });
});
