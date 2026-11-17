const DISCOUNT_PERCENT = /\d+(?:\.\d+)?\s*%/;
const PAYMENT_TERMS_CONTENT_PREFIX = /^\s*payment terms:\s*/i;

/** A number followed by a percent sign: the printed or Workday text states a discount rate. */
export function hasDiscountPercent(text: string | null | undefined): boolean {
  return Boolean(text && DISCOUNT_PERCENT.test(text));
}

/**
 * Lowercase words and numbers, sorted, so "30 NET", "Net 30", and "NET30" compare equal while
 * "2% 10 Net 30" does not.
 */
export function paymentTermsKey(text: string): string {
  const tokens = text.toLowerCase().match(/[a-z]+|\d+(?:\.\d+)?/g) ?? [];
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

export function paymentTermsNameOf(result: Pick<PaymentTermsRankable, 'content' | 'metadata'>): string {
  const fromMetadata = result.metadata?.name;
  if (typeof fromMetadata === 'string' && fromMetadata.trim()) return fromMetadata.trim();
  return (result.content ?? '').replace(PAYMENT_TERMS_CONTENT_PREFIX, '').trim();
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
}

/**
 * Enforces AP's rule in code: with no discount percentage printed, a discount term is never used. A refused
 * term leaves the invoice without a payment-terms match, the same as a lookup that found nothing.
 * `lookupName` failing or returning nothing leaves the match as the model made it.
 */
export async function applyPaymentTermsDiscountRule<T extends PaymentTermsResolution>(
  terms: T,
  lookupName: (workdayId: string) => Promise<string | undefined>
): Promise<T> {
  if (!terms.workdayId) return terms;
  let resolvedName: string | undefined;
  try {
    resolvedName = (await lookupName(terms.workdayId))?.trim() || undefined;
  } catch {
    return terms;
  }
  if (!resolvedName) return terms;
  if (!hasDiscountPercent(terms.name) && hasDiscountPercent(resolvedName)) {
    return { ...terms, workdayId: null, resolvedName: null, rejectedDiscountTerm: resolvedName };
  }
  return { ...terms, resolvedName };
}

/** Slack and note text for the term as the invoice shows it, with the Workday term when it reads differently. */
export function describePaymentTerms(terms: Pick<PaymentTermsResolution, 'name' | 'resolvedName' | 'rejectedDiscountTerm'>): string {
  if (terms.rejectedDiscountTerm) {
    return `${terms.name} (no Workday match; "${terms.rejectedDiscountTerm}" was not used because the invoice shows no discount)`;
  }
  if (terms.resolvedName && !isExactPaymentTermsMatch(terms.name, terms.resolvedName)) {
    return `${terms.name} (Workday: ${terms.resolvedName})`;
  }
  return terms.name;
}
