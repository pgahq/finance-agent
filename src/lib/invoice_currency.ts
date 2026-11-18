import { debug } from '@pga/logger';

export const DEFAULT_INVOICE_CURRENCY = 'USD';

const SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  CNY: 'CN¥',
  CAD: 'CA$',
  AUD: 'A$',
  INR: '₹',
};

// Currencies whose printed amounts can legitimately carry a bare "$".
const DOLLAR_CODES = new Set(['USD', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD', 'MXN']);

const CURRENCY_NAMES: Array<[RegExp, string]> = [
  [/^(?:us|u\.s\.|united states)\s+dollars?$/i, 'USD'],
  [/^euros?$/i, 'EUR'],
  [/^(?:british\s+pounds?|pounds?\s+sterling|sterling)$/i, 'GBP'],
  [/^canadian\s+dollars?$/i, 'CAD'],
  [/^australian\s+dollars?$/i, 'AUD'],
  [/^swiss\s+francs?$/i, 'CHF'],
  [/^(?:japanese\s+)?yen$/i, 'JPY'],
  [/^(?:chinese\s+yuan|yuan|renminbi)$/i, 'CNY'],
  [/^indian\s+rupees?$/i, 'INR'],
];

const PREFIXED_DOLLAR_SYMBOLS: Array<[RegExp, string]> = [
  [/^(?:US|U\.S\.)\$$/i, 'USD'],
  [/^(?:CA|CAD|C)\$$/i, 'CAD'],
  [/^(?:AU|AUD|A)\$$/i, 'AUD'],
];

/**
 * An ISO 4217 code for a printed currency: a three-letter code, a currency name, or a symbol that names one
 * currency (`€`, `£`, `C$`). A bare `$` or `¥` names several currencies, so it is null.
 */
export function normalizeCurrencyCode(value: string | null | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;
  if (/^[A-Za-z]{3}$/.test(text)) return text.toUpperCase();
  if (text === '€') return 'EUR';
  if (text === '£') return 'GBP';
  for (const [pattern, code] of PREFIXED_DOLLAR_SYMBOLS) {
    if (pattern.test(text)) return code;
  }
  for (const [pattern, code] of CURRENCY_NAMES) {
    if (pattern.test(text)) return code;
  }
  return null;
}

interface AmountCurrencySignal {
  codes: string[];
  bareDollar: boolean;
  ambiguousSymbol: boolean;
}

const AMOUNT_CODE_PATTERN = /(?<![A-Za-z])(USD|EUR|GBP|JPY|CAD|AUD|CHF|CNY|INR)(?![A-Za-z])/gi;
const PREFIXED_DOLLAR_IN_AMOUNT = /(?<![A-Za-z])(US|CA|AU|C|A)\$/gi;

function amountSignal(text: string | null | undefined): AmountCurrencySignal {
  const signal: AmountCurrencySignal = { codes: [], bareDollar: false, ambiguousSymbol: false };
  if (!text) return signal;
  const codes = new Set<string>();
  if (text.includes('€')) codes.add('EUR');
  if (text.includes('£')) codes.add('GBP');
  for (const match of text.matchAll(AMOUNT_CODE_PATTERN)) codes.add(match[1].toUpperCase());
  const withoutPrefixed = text.replace(PREFIXED_DOLLAR_IN_AMOUNT, (_all, prefix: string) => {
    const code = normalizeCurrencyCode(`${prefix}$`);
    if (code) codes.add(code);
    return '';
  });
  signal.bareDollar = withoutPrefixed.includes('$');
  signal.ambiguousSymbol = text.includes('¥');
  signal.codes = [...codes];
  return signal;
}

export type InvoiceCurrencyStatus = 'none' | 'detected' | 'ambiguous' | 'conflict';

export interface DetectedInvoiceCurrency {
  status: InvoiceCurrencyStatus;
  /** The currency every signal agrees on; null unless status is `detected`. */
  code: string | null;
  /** Every distinct currency the signals named, for a conflict note. */
  conflicting?: string[];
}

/**
 * Reads the invoice currency from the model's `extractedCurrency` and from the currency printed beside the
 * extracted amounts. A bare `$` is not a signal (it is the USD default); signals that name different currencies,
 * or a `$` printed beside a non-dollar currency, are a conflict and name no currency.
 */
export function detectInvoiceCurrency(input: {
  extractedCurrency: string | null | undefined;
  amountTexts: Array<string | null | undefined>;
}): DetectedInvoiceCurrency {
  const printed = input.extractedCurrency?.trim() ?? '';
  const modelCode = normalizeCurrencyCode(printed);
  const modelUnresolved = Boolean(printed) && !modelCode && printed !== '$';

  const signals = input.amountTexts.map(amountSignal);
  const codes = new Set<string>();
  if (modelCode) codes.add(modelCode);
  for (const signal of signals) signal.codes.forEach(code => codes.add(code));

  const bareDollar = signals.some(signal => signal.bareDollar);
  const nonDollar = [...codes].filter(code => !DOLLAR_CODES.has(code));
  if (codes.size > 1 || (bareDollar && nonDollar.length > 0)) {
    return { status: 'conflict', code: null, conflicting: [...codes] };
  }
  if (codes.size === 1) return { status: 'detected', code: [...codes][0] };
  if (modelUnresolved || signals.some(signal => signal.ambiguousSymbol)) return { status: 'ambiguous', code: null };
  return { status: 'none', code: null };
}

export interface SupplierCurrencies {
  /** Supplier Accepted_Currencies_Reference Currency_ID values. */
  accepted: string[];
  /** The supplier's own default Currency_Reference Currency_ID, when read. */
  default?: string;
}

export interface InvoiceCurrencyDecision {
  /** The document's currency when it was read; display text uses it. Absent means USD. */
  documentCurrency?: string;
  /** Submitted as Currency_Reference: the supplier-verified currency, or USD for an applied fallback. */
  currencyWID?: string;
  /** Why USD is submitted instead of the printed currency, listed under the applied fallbacks. */
  fallbackLabel?: string;
  /**
   * Nothing was changed on an existing invoice, but AP should know the printed currency could not be applied.
   * An update never overwrites the currency Workday already holds without a supplier-verified one.
   */
  reviewNote?: string;
}

export interface ResolveInvoiceCurrencyInput {
  extractedCurrency: string | null | undefined;
  amountTexts: Array<string | null | undefined>;
  supplierWID: string | undefined;
  defaultSupplierWID: string | undefined;
  /** True when the invoice already exists in Workday with its own currency (resend update, enrich). */
  existingInvoice?: boolean;
  lookupSupplierCurrencies: (supplierWID: string) => Promise<SupplierCurrencies>;
}

function fallbackOrNote(existingInvoice: boolean | undefined, reason: string, printed?: string): Pick<InvoiceCurrencyDecision, 'currencyWID' | 'fallbackLabel' | 'reviewNote'> {
  const shown = printed ? ` instead of ${printed}` : '';
  if (existingInvoice) {
    return { reviewNote: `The invoice currency was left as Workday had it${printed ? `, not changed to ${printed}` : ''}: ${reason}. Check the currency before approving.` };
  }
  return {
    currencyWID: DEFAULT_INVOICE_CURRENCY,
    fallbackLabel: `fallback currency ${DEFAULT_INVOICE_CURRENCY}${shown} (${reason})`,
  };
}

/**
 * Picks the Currency_Reference for an invoice. Never throws and never stops invoice creation: any lookup problem
 * falls back to USD (or, on an existing invoice, leaves its currency alone) and says why.
 */
export async function resolveInvoiceCurrency(input: ResolveInvoiceCurrencyInput): Promise<InvoiceCurrencyDecision> {
  const detected = detectInvoiceCurrency(input);

  if (detected.status === 'none') return {};
  if (detected.status === 'conflict') {
    return fallbackOrNote(input.existingInvoice, `the document's currency signals disagree (${(detected.conflicting ?? []).join(', ')})`);
  }
  if (detected.status === 'ambiguous') {
    return fallbackOrNote(input.existingInvoice, "the document's currency could not be determined");
  }

  const code = detected.code as string;
  if (code === DEFAULT_INVOICE_CURRENCY) return { documentCurrency: code };

  const withDocument = (decision: ReturnType<typeof fallbackOrNote>): InvoiceCurrencyDecision => ({ documentCurrency: code, ...decision });
  const supplierWID = input.supplierWID?.trim();
  if (!supplierWID || supplierWID === input.defaultSupplierWID?.trim()) {
    return withDocument(fallbackOrNote(input.existingInvoice, 'no matched supplier, so the default supplier is used and its accepted currencies are not checked', code));
  }

  let currencies: SupplierCurrencies;
  try {
    currencies = await input.lookupSupplierCurrencies(supplierWID);
  } catch (error) {
    debug('Could not read supplier accepted currencies; falling back to USD', error);
    return withDocument(fallbackOrNote(input.existingInvoice, "the supplier's accepted currencies could not be read from Workday", code));
  }

  const allowed = new Set([...currencies.accepted, ...(currencies.default ? [currencies.default] : [])].map(id => id.toUpperCase()));
  if (!allowed.has(code)) {
    const reason = allowed.size
      ? `the supplier does not accept ${code}`
      : 'the supplier has no accepted currencies on record';
    return withDocument(fallbackOrNote(input.existingInvoice, reason, code));
  }
  return { documentCurrency: code, currencyWID: code };
}

export function currencySymbolPrefix(code: string | undefined): string {
  const upper = (code ?? DEFAULT_INVOICE_CURRENCY).toUpperCase();
  return SYMBOLS[upper] ?? `${upper} `;
}

/** An amount as `$1,234.50`, `€1,234.50`, or `CHF 1,234.50`; USD (the default) matches the older dollar formatting. */
export function formatMoney(amount: number, currency?: string): string {
  const sign = amount < 0 ? '-' : '';
  return `${sign}${currencySymbolPrefix(currency)}${Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function currencyAppliedLabel(decision: InvoiceCurrencyDecision | undefined): string | undefined {
  return decision?.currencyWID && decision.currencyWID !== DEFAULT_INVOICE_CURRENCY ? decision.currencyWID : undefined;
}

/**
 * Workday note text for the currency. The claim that a non-USD currency was submitted is dropped when the submit
 * retry fell back to USD (`currencyFellBack`), because the note is built from what Workday accepted.
 */
export function formatCurrencyNotes(decision: InvoiceCurrencyDecision | undefined, currencyFellBack = false): string {
  if (!decision) return '';
  const applied = currencyAppliedLabel(decision);
  if (applied && !currencyFellBack) {
    return `\n\nCurrency: ${applied}, as printed on the document. The supplier accepts it.`;
  }
  if (decision.reviewNote) return `\n\nCurrency review: ${decision.reviewNote}`;
  return '';
}
