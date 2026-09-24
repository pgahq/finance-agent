import {
  extractSupplierNoteHints,
  formatSupplierNoteHintContext,
  hasSupplierNoteHints,
  resolveSupplierIdHints,
} from '../lib/supplier_note_hints.js';

describe('supplier_note_hints', () => {
  describe('extractSupplierNoteHints', () => {
    it('extracts Workday supplier IDs', () => {
      expect(extractSupplierNoteHints('Please use supplier S-001234 for this invoice')).toEqual({
        supplierIds: ['S-001234'],
        supplierNames: [],
      });
    });

    it('uppercases a lowercase-only ID', () => {
      expect(extractSupplierNoteHints('use s-000999')).toEqual({
        supplierIds: ['S-000999'],
        supplierNames: [],
      });
    });

    it('dedupes repeated IDs', () => {
      expect(extractSupplierNoteHints('S-0032 and s-0032').supplierIds).toEqual(['S-0032']);
    });

    it('ignores S- tokens that are not numeric supplier IDs', () => {
      expect(extractSupplierNoteHints('We are an S-Corp; see the S-Class invoice; ref S-123 and S-1234567')).toEqual({
        supplierIds: [],
        supplierNames: [],
      });
    });

    it('extracts labeled supplier and vendor names', () => {
      expect(extractSupplierNoteHints('Supplier: Acme Corporation\nVendor - Globex Inc.')).toEqual({
        supplierIds: [],
        supplierNames: ['Acme Corporation', 'Globex Inc'],
      });
    });

    it('strips an embedded ID from the labeled name', () => {
      expect(extractSupplierNoteHints('Supplier: Acme Corp (S-0032)')).toEqual({
        supplierIds: ['S-0032'],
        supplierNames: ['Acme Corp'],
      });
    });

    it('ignores hyphenated words and bare names without a supplier label', () => {
      expect(extractSupplierNoteHints('Vendor-managed inventory report attached\nAcme Corp sent this over')).toEqual({
        supplierIds: [],
        supplierNames: [],
      });
    });

    it('does not treat a labeled supplier ID as a name', () => {
      expect(extractSupplierNoteHints('Supplier: S-001234')).toEqual({
        supplierIds: ['S-001234'],
        supplierNames: [],
      });
    });

    it('reads labeled names from HTML note bodies', () => {
      expect(extractSupplierNoteHints('<p>Please fix this one.</p><p>Supplier: O&#39;Brien &amp; Sons</p>')).toEqual({
        supplierIds: [],
        supplierNames: ["O'Brien & Sons"],
      });
    });

    it('skips empty inputs', () => {
      expect(extractSupplierNoteHints(undefined, null, '', 'S-009999').supplierIds).toEqual(['S-009999']);
    });
  });

  describe('resolveSupplierIdHints', () => {
    it('exact-matches cached supplier IDs and skips the query without IDs', async () => {
      const db = {
        query: jest.fn().mockResolvedValue([
          { workday_id: 'wid-acme', metadata: { supplierId: 'S-001234', supplierName: 'Acme Corp' } },
        ]),
        close: jest.fn(),
      };

      await expect(resolveSupplierIdHints(db, ['S-001234', 'S-000404'])).resolves.toEqual([
        { supplierId: 'S-001234', workdayId: 'wid-acme', supplierName: 'Acme Corp' },
      ]);
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining("UPPER(metadata->>'supplierId') = ANY($1::text[])"),
        [['S-001234', 'S-000404']]
      );

      db.query.mockClear();
      await expect(resolveSupplierIdHints(db, [])).resolves.toEqual([]);
      expect(db.query).not.toHaveBeenCalled();
    });
  });

  describe('formatSupplierNoteHintContext', () => {
    const acme = { supplierId: 'S-001234', workdayId: 'wid-acme', supplierName: 'Acme Corp' };

    it('returns an empty string without hints', () => {
      expect(formatSupplierNoteHintContext({ supplierIds: [], supplierNames: [] }, [])).toBe('');
    });

    it('presents a single exact ID match as authoritative', () => {
      const text = formatSupplierNoteHintContext({ supplierIds: ['S-001234'], supplierNames: [] }, [acme]);
      expect(text).toContain('S-001234 (Acme Corp), workdayId wid-acme');
      expect(text).toContain('exact cached Supplier ID match');
    });

    it('reports conflicting exact matches as ambiguous instead of overriding', () => {
      const text = formatSupplierNoteHintContext(
        { supplierIds: ['S-001234', 'S-000999'], supplierNames: [] },
        [acme, { supplierId: 'S-000999', workdayId: 'wid-globex', supplierName: 'Globex' }]
      );
      expect(text).toContain('more than one Workday supplier');
      expect(text).toContain('ambiguous');
      expect(text).not.toContain('exact cached Supplier ID match');
    });

    it('does not treat an ID missing from the cache as a match', () => {
      const text = formatSupplierNoteHintContext({ supplierIds: ['S-000404'], supplierNames: [] }, []);
      expect(text).toContain('not in the supplier cache');
      expect(text).not.toContain('exact cached Supplier ID match');
    });

    it('asks for an exact findSuppliers match when the cache lookup failed', () => {
      const text = formatSupplierNoteHintContext({ supplierIds: ['S-001234'], supplierNames: [] }, undefined);
      expect(text).toContain('could not be verified');
      expect(text).toContain('matches exactly');
    });

    it('lets a single exact ID match take precedence over name hints', () => {
      const text = formatSupplierNoteHintContext(
        { supplierIds: ['S-001234'], supplierNames: ['Globex'] },
        [acme]
      );
      expect(text).toContain('exact cached Supplier ID match');
      expect(text).not.toContain('Globex');
    });

    it('turns a hinted name into the first findSuppliers query', () => {
      const text = formatSupplierNoteHintContext({ supplierIds: [], supplierNames: ['Acme Corp'] }, []);
      expect(text).toContain('"Acme Corp"');
      expect(text).toContain('findSuppliers');
    });

    it('hasSupplierNoteHints reflects extracted hints', () => {
      expect(hasSupplierNoteHints({ supplierIds: [], supplierNames: [] })).toBe(false);
      expect(hasSupplierNoteHints({ supplierIds: ['S-0001'], supplierNames: [] })).toBe(true);
      expect(hasSupplierNoteHints({ supplierIds: [], supplierNames: ['Acme'] })).toBe(true);
    });
  });
});
