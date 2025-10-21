import { handler } from '../actions/enrich_invoice_company.js';

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
    company1: null,
    supplier: { id: 'supplier-1', name: 'Test Supplier' }
  }]),
  getAttachmentContent: jest.fn().mockResolvedValue([])
}));

jest.mock('../lib/openai.js', () => ({
  callOpenAIWithSchema: jest.fn().mockResolvedValue({
    companyId: 'company-1',
    companyName: 'Test Company',
    confidence: 0.9,
    reasoning: 'High confidence match'
  })
}));

describe('enrich_invoice_company', () => {
  it('should process company enrichment event', async () => {
    const mockEvent = {
      detail: {
        action: 'enrich_invoice_company',
        data: {
          id: 'test-invoice-id',
          invoiceNumber: 'INV-001',
          company1: null
        },
        timestamp: '2024-01-01T00:00:00Z',
        requestId: 'test-request-id'
      }
    };

    await expect(handler(mockEvent as any)).resolves.not.toThrow();
  });
});
