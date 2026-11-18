import {
  detectInvoiceCurrency,
  formatCurrencyNotes,
  formatMoney,
  normalizeCurrencyCode,
  resolveInvoiceCurrency,
  type ResolveInvoiceCurrencyInput,
  type SupplierCurrencies,
} from '../lib/invoice_currency.js';

describe('normalizeCurrencyCode', () => {
  it.each([
    ['EUR', 'EUR'],
    [' gbp ', 'GBP'],
    ['€', 'EUR'],
    ['£', 'GBP'],
    ['Euro', 'EUR'],
    ['euros', 'EUR'],
    ['Pounds Sterling', 'GBP'],
    ['Canadian Dollars', 'CAD'],
    ['CA$', 'CAD'],
    ['C$', 'CAD'],
    ['A$', 'AUD'],
    ['US$', 'USD'],
    ['US Dollars', 'USD'],
    ['Swiss Francs', 'CHF'],
    ['Dollars', 'USD'],
    ['USD$', 'USD'],
  ])('reads %p as %p', (printed, code) => {
    expect(normalizeCurrencyCode(printed)).toBe(code);
  });

  it.each(['', '   ', null, undefined, '$', '¥', 'N/A', 'EURO ZONE', 'TBD', 'NET', 'NaN', 'XYZ'])('names no currency for %p', (printed) => {
    expect(normalizeCurrencyCode(printed)).toBeNull();
  });
});

describe('detectInvoiceCurrency', () => {
  const detect = (extractedCurrency: string | null, ...amountTexts: Array<string | null>) =>
    detectInvoiceCurrency({ extractedCurrency, amountTexts });

  it('reads the model code', () => {
    expect(detect('EUR', '€8,573.40')).toEqual({ status: 'detected', code: 'EUR' });
  });

  it('reads an unambiguous symbol or code from the printed amount when the model returned nothing', () => {
    expect(detect(null, '€8,573.40')).toEqual({ status: 'detected', code: 'EUR' });
    expect(detect('', 'GBP 120.00')).toEqual({ status: 'detected', code: 'GBP' });
    expect(detect('', '1.200,00 EUR')).toEqual({ status: 'detected', code: 'EUR' });
    expect(detect('', 'CA$450.00')).toEqual({ status: 'detected', code: 'CAD' });
  });

  it('treats a bare dollar sign as no signal, never as a currency', () => {
    expect(detect(null, '$8,573.40', '$12.00')).toEqual({ status: 'none', code: null });
    expect(detect('$', '$8,573.40')).toEqual({ status: 'none', code: null });
    expect(detect(null, null, null)).toEqual({ status: 'none', code: null });
  });

  it('accepts an explicit dollar currency beside a dollar sign', () => {
    expect(detect('CAD', '$450.00')).toEqual({ status: 'detected', code: 'CAD' });
    expect(detect('USD', '$450.00')).toEqual({ status: 'detected', code: 'USD' });
  });

  it('is a conflict when a non-dollar currency is printed beside a dollar sign', () => {
    expect(detect('EUR', '$8,573.40')).toMatchObject({ status: 'conflict', code: null });
  });

  it('is a conflict when two signals name different currencies', () => {
    expect(detect('EUR', '£8,573.40')).toMatchObject({ status: 'conflict', code: null, conflicting: ['EUR', 'GBP'] });
    expect(detect('', '€10.00', '£4.00')).toMatchObject({ status: 'conflict', code: null });
  });

  it('is ambiguous for a symbol or answer that names several currencies', () => {
    expect(detect(null, '¥8,573')).toEqual({ status: 'ambiguous', code: null });
    expect(detect('Rubles', '8,573.40')).toEqual({ status: 'ambiguous', code: null });
  });

  it.each(['TBD', 'NaN', 'N/A', 'none', 'null'])('treats the placeholder answer %p as no currency, not as an unreadable one', (answer) => {
    expect(detect(answer, '$8,573.40')).toEqual({ status: 'none', code: null });
  });

  it.each(['NET', 'XYZ', 'EURO ZONE'])('treats the unknown answer %p as ambiguous, never as a code', (answer) => {
    expect(detect(answer, '$8,573.40')).toEqual({ status: 'ambiguous', code: null });
  });

  it('reads Dollars and USD$ as USD on a plain dollar invoice', () => {
    expect(detect('Dollars', '$8,573.40')).toEqual({ status: 'detected', code: 'USD' });
    expect(detect('USD$', '$8,573.40')).toEqual({ status: 'detected', code: 'USD' });
  });

  it('does not read a code out of an ordinary word', () => {
    expect(detect(null, 'EURO 5.00 AUDIT')).toEqual({ status: 'none', code: null });
  });
});

describe('resolveInvoiceCurrency', () => {
  const accepts = (currencies: SupplierCurrencies) => jest.fn().mockResolvedValue(currencies);
  const resolve = (overrides: Partial<ResolveInvoiceCurrencyInput> = {}) => resolveInvoiceCurrency({
    extractedCurrency: 'EUR',
    amountTexts: ['€8,573.40'],
    supplierWID: 'supplier-wid-001',
    defaultSupplierWID: 'default-supplier-wid',
    lookupSupplierCurrencies: accepts({ accepted: ['EUR', 'USD'] }),
    ...overrides,
  });

  it('submits a non-USD currency the supplier accepts', async () => {
    const lookup = accepts({ accepted: ['USD', 'EUR'] });

    await expect(resolve({ lookupSupplierCurrencies: lookup })).resolves.toEqual({ documentCurrency: 'EUR', currencyWID: 'EUR' });
    expect(lookup).toHaveBeenCalledWith('supplier-wid-001');
  });

  it('accepts the supplier default currency when it is the only one on record', async () => {
    await expect(resolve({ lookupSupplierCurrencies: accepts({ accepted: [], default: 'eur' }) }))
      .resolves.toEqual({ documentCurrency: 'EUR', currencyWID: 'EUR' });
  });

  it('falls back to USD, with a label, when the supplier does not accept the currency', async () => {
    await expect(resolve({ lookupSupplierCurrencies: accepts({ accepted: ['USD'], default: 'USD' }) })).resolves.toEqual({
      documentCurrency: 'EUR',
      currencyWID: 'USD',
      fallbackLabel: 'fallback currency USD instead of EUR (the supplier does not accept EUR)',
    });
  });

  it('falls back to USD when the supplier has no accepted currencies on record', async () => {
    await expect(resolve({ lookupSupplierCurrencies: accepts({ accepted: [] }) })).resolves.toMatchObject({
      currencyWID: 'USD',
      fallbackLabel: 'fallback currency USD instead of EUR (the supplier has no accepted currencies on record)',
    });
  });

  it('never throws when the accepted-currency lookup fails; it falls back to USD', async () => {
    const lookup = jest.fn().mockRejectedValue(new Error('The task submitted is not authorized'));

    await expect(resolve({ lookupSupplierCurrencies: lookup })).resolves.toEqual({
      documentCurrency: 'EUR',
      currencyWID: 'USD',
      fallbackLabel: "fallback currency USD instead of EUR (the supplier's accepted currencies could not be read from Workday)",
    });
  });

  it.each([undefined, 'default-supplier-wid'])('does not check the default supplier (%p) and falls back to USD', async (supplierWID) => {
    const lookup = accepts({ accepted: ['EUR'] });

    const decision = await resolve({ supplierWID, lookupSupplierCurrencies: lookup });

    expect(decision.currencyWID).toBe('USD');
    expect(decision.fallbackLabel).toContain('the default supplier is used');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('adds nothing when no currency is printed, and never looks the supplier up', async () => {
    const lookup = accepts({ accepted: ['EUR'] });

    await expect(resolve({ extractedCurrency: null, amountTexts: ['$8,573.40'], lookupSupplierCurrencies: lookup })).resolves.toEqual({});
    expect(lookup).not.toHaveBeenCalled();
  });

  it('sends nothing for a printed USD currency, which is the default', async () => {
    const lookup = accepts({ accepted: [] });

    await expect(resolve({ extractedCurrency: 'USD', amountTexts: ['$8,573.40'], lookupSupplierCurrencies: lookup }))
      .resolves.toEqual({ documentCurrency: 'USD' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('falls back to USD when the signals conflict', async () => {
    await expect(resolve({ extractedCurrency: 'EUR', amountTexts: ['£10.00'] })).resolves.toEqual({
      currencyWID: 'USD',
      fallbackLabel: "fallback currency USD (the document's currency signals disagree (EUR, GBP))",
    });
  });

  it('falls back to USD when the currency cannot be determined', async () => {
    await expect(resolve({ extractedCurrency: null, amountTexts: ['¥1,200'] })).resolves.toEqual({
      currencyWID: 'USD',
      fallbackLabel: "fallback currency USD (the document's currency could not be determined)",
    });
  });

  describe('comma-decimal amounts', () => {
    it.each(['€8.573,40', 'EUR 8573,40', '8.573,4 EUR'])('does not verify a non-USD currency when %p is printed, because the amount parser misreads it', async (amount) => {
      const lookup = accepts({ accepted: ['EUR'] });
      const decision = await resolve({ amountTexts: [amount], lookupSupplierCurrencies: lookup });

      expect(decision.currencyWID).toBe('USD');
      expect(decision.fallbackLabel).toBe('fallback currency USD instead of EUR (an amount is printed with a comma as the decimal separator, which the amount parser does not read correctly, so check every amount)');
      expect(lookup).not.toHaveBeenCalled();
    });

    it.each(['€8,573.40', '€8,573', 'EUR 1,234,567.89'])('still verifies a euro invoice printed with a dot decimal: %p', async (amount) => {
      await expect(resolve({ amountTexts: [amount] })).resolves.toEqual({ documentCurrency: 'EUR', currencyWID: 'EUR' });
    });

    it('leaves a review note and the Workday currency on an existing invoice', async () => {
      const decision = await resolve({ existingInvoice: true, amountTexts: ['€8.573,40'] });

      expect(decision.currencyWID).toBeUndefined();
      expect(decision.reviewNote).toContain('comma as the decimal separator');
    });
  });

  describe('on an existing invoice', () => {
    it('applies a currency the supplier accepts', async () => {
      await expect(resolve({ existingInvoice: true })).resolves.toEqual({ documentCurrency: 'EUR', currencyWID: 'EUR' });
    });

    it('never overwrites the invoice currency with USD; it leaves a review note instead', async () => {
      const decision = await resolve({ existingInvoice: true, lookupSupplierCurrencies: accepts({ accepted: ['USD'] }) });

      expect(decision.currencyWID).toBeUndefined();
      expect(decision.fallbackLabel).toBeUndefined();
      expect(decision.reviewNote).toBe('The invoice currency was left as Workday had it, not changed to EUR: the supplier does not accept EUR. Check the currency before approving.');
    });

    it('leaves the currency alone and says so when it cannot be determined', async () => {
      const decision = await resolve({ existingInvoice: true, extractedCurrency: null, amountTexts: ['¥1,200'] });

      expect(decision.currencyWID).toBeUndefined();
      expect(decision.reviewNote).toContain("the document's currency could not be determined");
    });
  });
});

describe('formatMoney', () => {
  it('formats USD exactly like the older dollar formatting', () => {
    expect(formatMoney(38255)).toBe('$38,255.00');
    expect(formatMoney(-12.5, 'USD')).toBe('-$12.50');
    expect(formatMoney(0)).toBe('$0.00');
  });

  it('uses the currency symbol, or the code when there is no common symbol', () => {
    expect(formatMoney(38255, 'EUR')).toBe('€38,255.00');
    expect(formatMoney(1234.5, 'GBP')).toBe('£1,234.50');
    expect(formatMoney(450, 'CAD')).toBe('CA$450.00');
    expect(formatMoney(1200, 'CHF')).toBe('CHF 1,200.00');
    expect(formatMoney(-3, 'chf')).toBe('-CHF 3.00');
  });
});

describe('formatCurrencyNotes', () => {
  it('says a non-USD currency was applied', () => {
    expect(formatCurrencyNotes({ documentCurrency: 'EUR', currencyWID: 'EUR' }))
      .toBe('\n\nCurrency: EUR, as printed on the document. The supplier accepts it.');
  });

  it('drops that claim when the submit retry fell back to USD', () => {
    expect(formatCurrencyNotes({ documentCurrency: 'EUR', currencyWID: 'EUR' }, true)).toBe('');
  });

  it('adds nothing for USD, for a create fallback (listed with the applied fallbacks), or with no decision', () => {
    expect(formatCurrencyNotes({ currencyWID: 'USD', fallbackLabel: 'fallback currency USD instead of EUR (x)' })).toBe('');
    expect(formatCurrencyNotes({ documentCurrency: 'USD' })).toBe('');
    expect(formatCurrencyNotes(undefined)).toBe('');
  });

  it('carries the review note of an existing invoice', () => {
    expect(formatCurrencyNotes({ reviewNote: 'The invoice currency was left as Workday had it.' }))
      .toBe('\n\nCurrency review: The invoice currency was left as Workday had it.');
  });
});
