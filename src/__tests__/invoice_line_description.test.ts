import {
  composeInvoiceLineDescription,
  pinExtractedLineDescriptions,
  withComposedLineDescriptions,
} from '../lib/invoice_lines.js';
import { formatInvoiceLinesNotes } from '../lib/invoice_enrichment.js';
import { invoiceEnrichmentPrompt } from '../prompts/enrich_invoice_prompt.js';
import { mergeInvoiceLinesPrompt } from '../prompts/merge_invoice_lines_prompt.js';

const hashrocketAmounts = { quantity: 32, unitCost: '155.00', totalPrice: '4,960.00' };

describe('composeInvoiceLineDescription', () => {
  it('concatenates Hashrocket Activity and Description and drops qty/rate/amount cells', () => {
    expect(composeInvoiceLineDescription(
      ['', 'Ryan Poland', 'Project Management', '32', '155.00', '4,960.00'],
      'Project Management',
      hashrocketAmounts
    )).toBe('Ryan Poland - Project Management');
  });

  it('does not let a longer model summary win over descriptionCells', () => {
    expect(composeInvoiceLineDescription(
      ['Ryan Poland', 'Project Management'],
      'Project management services for Ryan Poland',
      hashrocketAmounts
    )).toBe('Ryan Poland - Project Management');
  });

  it('joins SKU and item name when neither cell contains the other as a token', () => {
    expect(composeInvoiceLineDescription(['ABC-123', 'Sintra Signs'])).toBe('ABC-123 - Sintra Signs');
  });

  it('keeps a short SKU that is only a substring of another cell', () => {
    expect(composeInvoiceLineDescription(['IN', 'Installation'])).toBe('IN - Installation');
  });

  it('keeps the longer cell when one identifying value already contains the other as a token', () => {
    expect(composeInvoiceLineDescription(
      ['ABC-123', 'Widget', 'ABC-123 Widget'],
      'Widget'
    )).toBe('ABC-123 Widget');
  });

  it('keeps a numeric item number that is not the line quantity or amount', () => {
    expect(composeInvoiceLineDescription(
      ['1001', 'Widgets'],
      'Widgets',
      { quantity: 2, unitCost: '50.00', totalPrice: '100.00' }
    )).toBe('1001 - Widgets');
  });

  it('returns the existing description when there are no extra cells', () => {
    expect(composeInvoiceLineDescription(null, 'Janitorial')).toBe('Janitorial');
    expect(composeInvoiceLineDescription(undefined, 'Janitorial')).toBe('Janitorial');
  });

  it('skips currency amount cells', () => {
    expect(composeInvoiceLineDescription(['Consulting', '$1,250.00'], 'Consulting')).toBe('Consulting');
  });
});

describe('withComposedLineDescriptions', () => {
  it('upgrades a terse DESCRIPTION-column value using sibling row cells', () => {
    const lines = withComposedLineDescriptions([{
      description: 'Project Management',
      descriptionCells: ['Ryan Poland', 'Project Management'],
      quantity: 32,
      unitCost: '155.00',
      totalPrice: '4,960.00',
      hasDiscount: false,
    }]);

    expect(lines[0].description).toBe('Ryan Poland - Project Management');
  });

  it('leaves a single-column description unchanged', () => {
    const lines = withComposedLineDescriptions([{
      description: 'Widgets',
      quantity: 2,
      unitCost: '50.00',
      totalPrice: '100.00',
      hasDiscount: false,
    }]);

    expect(lines[0].description).toBe('Widgets');
  });
});

describe('pinExtractedLineDescriptions', () => {
  it('restores the composed description when merge shortens it', () => {
    const pinned = pinExtractedLineDescriptions(
      [{
        lineOrder: 1,
        description: 'Project management',
        memo: 'Project management services for Ryan Poland',
        quantity: 32,
        unitCost: 155,
        extendedAmount: 4960,
      }],
      [{ description: 'Ryan Poland - Project Management', quantity: 32, unitCost: '155.00', totalPrice: '4,960.00' }]
    );

    expect(pinned[0].description).toBe('Ryan Poland - Project Management');
    expect(pinned[0].memo).toBe('Project management services for Ryan Poland');
  });
});

describe('formatInvoiceLinesNotes', () => {
  it('shows the composed Hashrocket line description', () => {
    const notes = formatInvoiceLinesNotes({
      extractedInvoiceLines: [{
        description: 'Project Management',
        descriptionCells: ['Ryan Poland', 'Project Management'],
        quantity: 32,
        unitCost: '155.00',
        totalPrice: '4,960.00',
        hasDiscount: false,
      }],
      invoiceLineQuantityDisplayed: true,
    } as any);

    expect(notes).toContain('Ryan Poland - Project Management');
  });
});

describe('invoice line description prompts', () => {
  it('tells enrichment to concatenate identifying row cells before the terse memo', () => {
    expect(invoiceEnrichmentPrompt).toContain('Ryan Poland');
    expect(invoiceEnrichmentPrompt).toContain('Project Management');
    expect(invoiceEnrichmentPrompt).toContain('descriptionCells');
    expect(invoiceEnrichmentPrompt).toContain('The terse 1-sentence summary belongs in memo later');
    expect(invoiceEnrichmentPrompt).toContain('Ryan Poland - Project Management');
  });

  it('tells merge to copy the concatenated description unchanged and write memo after', () => {
    expect(mergeInvoiceLinesPrompt).toContain('Copy `description` from the extracted line **unchanged**');
    expect(mergeInvoiceLinesPrompt).toContain('after** the concatenated description is set');
  });
});
