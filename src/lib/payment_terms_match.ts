const DISCOUNT_PERCENT = /\d+(?:\.\d+)?\s*(?:%|percent\b)/i;
const PAYMENT_TERMS_CONTENT_PREFIX = /^\s*payment terms:\s*/i;
/** Cached and printed payment-terms names are a short single line, e.g. "2% 10 Net 30". Anything longer or
 * multiline is not a usable name and is treated the same as a lookup that found nothing. */
const MAX_PAYMENT_TERMS_NAME_LENGTH = 100;

/** A number followed by "%" or the word "percent": the printed or Workday text states a discount rate. */
export function hasDiscountPercent(text: string | null | undefined): boolean {
  return Boolean(text && DISCOUNT_PERCENT.test(text));
}

/** A usable single-line payment-terms name; rejects empty, multiline, or implausibly long cache content. */
export function validatedPaymentTermsName(name: string | null | undefined): string | undefined {
  const trimmed = name?.trim();
  if (!trimmed || trimmed.length > MAX_PAYMENT_TERMS_NAME_LENGTH || /[\r\n]/.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Lowercase words and numbers, sorted, so "30 NET", "Net 30", and "NET30" compare equal while
 * "2% 10 Net 30" does not. The word "percent" is dropped before tokenizing, the same way the "%"
 * character is already invisible to the token regex below, so "2% 10 Net 30" and "2 percent 10 Net 30"
 * key the same discount term instead of looking like two different ones.
 */
export function paymentTermsKey(text: string): string {
  const tokens = text.toLowerCase().replace(/\bpercent\b/g, '').match(/[a-z]+|\d+(?:\.\d+)?/g) ?? [];
  return [...tokens].sort().join(' ');
}

export function isExactPaymentTermsMatch(printed: string, workdayName: string): boolean {
  const key = paymentTermsKey(printed);
  return key.length > 0 && key === paymentTermsKey(workdayName);
}

export interface PaymentTermsRankable {
  workday_id: string;
  similarity: number;
  content?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * createPaymentTermsContent and createMetadata both write from the same Workday name on every sync, so a
 * well-formed row's two representations always agree. Metadata is the primary source; a row is trusted
 * only when metadata is either absent (fall back to content) or present, valid, and in agreement with a
 * parseable content value. Metadata present but invalid, or metadata that disagrees with content, makes
 * the whole row untrusted (returns '') rather than silently preferring or falling back to one side.
 */
export function paymentTermsNameOf(result: Pick<PaymentTermsRankable, 'content' | 'metadata'>): string {
  const metadata = result.metadata;
  const hasMetadataName = Boolean(metadata) && Object.prototype.hasOwnProperty.call(metadata, 'name');
  const content = result.content ?? '';
  const hasContentPrefix = PAYMENT_TERMS_CONTENT_PREFIX.test(content);
  const contentName = hasContentPrefix ? validatedPaymentTermsName(content.replace(PAYMENT_TERMS_CONTENT_PREFIX, '')) : undefined;

  if (hasMetadataName) {
    const fromMetadata = metadata!.name;
    // A present name key that is not a usable string (null, a number, or an invalid string) makes the row
    // untrusted immediately; it is not treated the same as metadata.name being absent.
    const metadataName = typeof fromMetadata === 'string' ? validatedPaymentTermsName(fromMetadata) : undefined;
    if (!metadataName) return '';
    if (hasContentPrefix && (!contentName || paymentTermsKey(metadataName) !== paymentTermsKey(contentName))) return '';
    return metadataName;
  }

  // Only trust content that actually looks like the "Payment Terms: <name>" format; with no metadata.name
  // key at all, arbitrary cache content (wrong field, wrong document) is not a name.
  return contentName ?? '';
}

/**
 * Orders payment-terms candidates for a printed term. An exact match comes first. When the printed text shows
 * no discount percentage, every term that carries one is placed after every plain term, because AP does not
 * want a discount term on an invoice that prints none. Ties fall back to similarity, then the Workday ID, so
 * the order never depends on the order the database returned equal scores in.
 */
export function rankPaymentTermsSearchResults<T extends PaymentTermsRankable>(results: T[], query: string): T[] {
  const printedHasDiscount = hasDiscountPercent(query);
  const tierOf = (result: T): number => {
    const name = paymentTermsNameOf(result);
    if (isExactPaymentTermsMatch(query, name)) return 0;
    if (!printedHasDiscount && hasDiscountPercent(name)) return 2;
    return 1;
  };

  return results
    .map((result) => ({ result, tier: tierOf(result) }))
    .sort((left, right) => {
      if (left.tier !== right.tier) return left.tier - right.tier;
      if (right.result.similarity !== left.result.similarity) return right.result.similarity - left.result.similarity;
      return left.result.workday_id < right.result.workday_id ? -1 : left.result.workday_id > right.result.workday_id ? 1 : 0;
    })
    .map(({ result }) => result);
}

export interface PaymentTermsResolution {
  name: string;
  workdayId: string | null;
  /** The Workday name of the term that was chosen, or the discount term that was refused. */
  resolvedName?: string | null;
  /** Set when a discount term was refused because the invoice prints no discount percentage. */
  rejectedDiscountTerm?: string | null;
  /** Set when the invoice prints no discount and the matched term's Workday name could not be confirmed safe. */
  unverified?: boolean;
  /** The Workday ID that was refused or could not be verified, kept only so the note can point AP at it directly; never submitted (workdayId stays null). */
  candidateWorkdayId?: string | null;
}

/**
 * Enforces AP's rule in code: with no discount percentage printed, a discount term is never used. A refused
 * or unverifiable term leaves the invoice without a payment-terms match, the same as a lookup that found
 * nothing — when the invoice prints no discount, an unconfirmed match could be a discount term, so it is not
 * submitted unseen. `lookupName` failing or returning nothing only short-circuits the match when the invoice
 * does print a discount, since this rule has nothing to enforce in that case.
 */
export async function applyPaymentTermsDiscountRule<T extends PaymentTermsResolution>(
  terms: T,
  lookupName: (workdayId: string) => Promise<string | undefined>
): Promise<T> {
  if (!terms.workdayId) return terms;
  const printedHasDiscount = hasDiscountPercent(terms.name);
  let resolvedName: string | undefined;
  try {
    resolvedName = validatedPaymentTermsName(await lookupName(terms.workdayId));
  } catch {
    resolvedName = undefined;
  }
  if (!resolvedName) {
    if (printedHasDiscount) return terms;
    return { ...terms, workdayId: null, resolvedName: null, unverified: true, candidateWorkdayId: terms.workdayId };
  }
  if (!printedHasDiscount && hasDiscountPercent(resolvedName)) {
    return { ...terms, workdayId: null, resolvedName: null, rejectedDiscountTerm: resolvedName, candidateWorkdayId: terms.workdayId };
  }
  return { ...terms, resolvedName };
}

/** Slack and note text for the term as the invoice shows it, with the Workday term when it reads differently. */
export function describePaymentTerms(terms: Pick<PaymentTermsResolution, 'name' | 'resolvedName' | 'rejectedDiscountTerm' | 'unverified'>): string {
  if (terms.rejectedDiscountTerm) {
    return `${terms.name} (no Workday match; "${terms.rejectedDiscountTerm}" was not used because the invoice shows no discount)`;
  }
  if (terms.unverified) {
    return `${terms.name} (no Workday match; the matched term's name could not be confirmed safe)`;
  }
  if (terms.resolvedName && !isExactPaymentTermsMatch(terms.name, terms.resolvedName)) {
    return `${terms.name} (Workday: ${terms.resolvedName})`;
  }
  return terms.name;
}
