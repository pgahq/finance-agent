import type { WorkdayQueryResultDetail } from '../wqlToEvent.js';

describe('WQL to Event', () => {
  describe('WorkdayQueryResultDetail interface', () => {
    it('should have correct structure', () => {
      const mockDetail: WorkdayQueryResultDetail = {
        action: 'enrich_invoice',
        data: { invoiceNumber: 'INV-001' },
        timestamp: '2024-01-01T00:00:00Z',
        requestId: 'req-123',
      };

      expect(mockDetail.action).toBe('enrich_invoice');
      expect(mockDetail.data).toEqual({ invoiceNumber: 'INV-001' });
      expect(mockDetail.timestamp).toBe('2024-01-01T00:00:00Z');
      expect(mockDetail.requestId).toBe('req-123');
    });
  });
});
