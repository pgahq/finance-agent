import {
  extractSupplierNoteHints,
  formatSupplierNoteHintContext,
  hasSupplierNoteHints,
} from '../lib/supplier_note_hints.js';

describe('supplier_note_hints', () => {
  describe('extractSupplierNoteHints', () => {
    it('extracts Workday supplier IDs', () => {
      expect(extractSupplierNoteHints('Please use supplier S-001234 for this invoice')).toEqual({
        supplierIds: ['S-001234'],
        supplierNames: [],
      });
    });

    it('normalizes lowercase IDs and dedupes repeats', () => {
      expect(extractSupplierNoteHints('s-00ab12 and S-00AB12')).toEqual({
        supplierIds: ['S-00AB12'],
        supplierNames: [],
      });
    });

    it('extracts labeled supplier and vendor names', () => {
      expect(extractSupplierNoteHints('Supplier: Acme Corporation\nVendor - Globex Inc.')).toEqual({
        supplierIds: [],
        supplierNames: ['Acme Corporation', 'Globex Inc'],
      });
    });

    it('extracts both the ID and the name from one note', () => {
      expect(extractSupplierNoteHints('Supplier: Acme Corp (S-0032)')).toEqual({
        supplierIds: ['S-0032'],
        supplierNames: ['Acme Corp (S-0032)'],
      });
    });

    it('ignores bare names without a supplier label', () => {
      expect(extractSupplierNoteHints('Acme Corp sent this over')).toEqual({
        supplierIds: [],
        supplierNames: [],
      });
    });

    it('ignores a labeled value that is only a supplier ID', () => {
      expect(extractSupplierNoteHints('Supplier: S-001234')).toEqual({
        supplierIds: ['S-001234'],
        supplierNames: [],
      });
    });

    it('scans every text argument and skips empty ones', () => {
      expect(extractSupplierNoteHints(undefined, null, '', 'Note: S-009999')).toEqual({
        supplierIds: ['S-009999'],
        supplierNames: [],
      });
    });
  });

  describe('formatSupplierNoteHintContext', () => {
    it('returns an empty string without hints', () => {
      expect(formatSupplierNoteHintContext({ supplierIds: [], supplierNames: [] })).toBe('');
    });

    it('renders IDs and names as an authoritative hint block', () => {
      const text = formatSupplierNoteHintContext({
        supplierIds: ['S-001234'],
        supplierNames: ['Acme Corp'],
      });
      expect(text).toContain('S-001234');
      expect(text).toContain('Acme Corp');
      expect(text).toContain('findSuppliers');
      expect(text).toContain('authoritative');
    });

    it('hasSupplierNoteHints reflects extracted hints', () => {
      expect(hasSupplierNoteHints({ supplierIds: [], supplierNames: [] })).toBe(false);
      expect(hasSupplierNoteHints({ supplierIds: ['S-1'], supplierNames: [] })).toBe(true);
      expect(hasSupplierNoteHints({ supplierIds: [], supplierNames: ['Acme'] })).toBe(true);
    });
  });
});
