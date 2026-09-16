export type CompanyAddressMatch = 'unique' | 'shared' | 'none';

const STREET_TYPE =
  '(?:Avenue|Ave\\.?|Boulevard|Blvd\\.?|Street|St\\.?|Road|Rd\\.?|Drive|Dr\\.?|Lane|Ln\\.?|Way|Parkway|Pkwy\\.?|Highway|Hwy\\.?|Circle|Cir\\.?|Court|Ct\\.?|Place|Pl\\.?|Trail|Trl\\.?|Terrace|Ter\\.?|Plaza|Square|Sq\\.?)';

const STREET_LINE = new RegExp(
  String.raw`\b(\d{1,6}(?:-\d{1,6})?)\s+((?:[NSEW]\.?\s+)?(?:[A-Za-z0-9.'#-]+\s+){0,8}${STREET_TYPE}\b(?:\s+of(?:\s+the)?(?:\s+[A-Za-z][A-Za-z.'-]*))?)`,
  'i'
);

const PO_BOX = /\bP\.?\s*O\.?\s*Box\s+(\d+)\b/i;
const STREET_TYPE_TOKEN = new RegExp(`^${STREET_TYPE}$`, 'i');
const STOP = /^(?:of|the|and|n|s|e|w|ne|nw|se|sw|north|south|east|west|suite|ste|unit|apt|apartment|#)$/i;

export interface StreetFingerprint {
  house?: string;
  poBox?: string;
  tokens: Set<string>;
}

function distinctiveTokens(streetLine: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of streetLine.split(/[\s,]+/)) {
    const token = raw.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
    if (token.length < 3) continue;
    if (STREET_TYPE_TOKEN.test(token) || STOP.test(token)) continue;
    tokens.add(token);
  }
  return tokens;
}

export function streetFingerprint(address: string): StreetFingerprint {
  const poBox = address.match(PO_BOX)?.[1];
  const street = address.match(STREET_LINE);
  return {
    house: street?.[1],
    poBox,
    tokens: street ? distinctiveTokens(street[2]) : new Set(),
  };
}

export function addressesShareStreet(billTo: string, candidate: string): boolean {
  const left = streetFingerprint(billTo);
  const right = streetFingerprint(candidate);
  if (left.poBox && right.poBox && left.poBox === right.poBox) return true;
  if (!left.house || left.house !== right.house) return false;
  if (left.tokens.size === 0 || left.tokens.size !== right.tokens.size) return false;
  for (const token of left.tokens) {
    if (!right.tokens.has(token)) return false;
  }
  return true;
}

export function cachedCompanyAddresses(metadata: Record<string, unknown> | null | undefined): string[] {
  const addresses: string[] = [];
  if (typeof metadata?.addressPrimary === 'string' && metadata.addressPrimary.trim()) {
    addresses.push(metadata.addressPrimary);
  }
  if (Array.isArray(metadata?.publicAddresses)) {
    for (const value of metadata.publicAddresses) {
      if (typeof value === 'string' && value.trim()) addresses.push(value);
    }
  }
  return addresses;
}

function resultMatchesBillToAddress<T extends { metadata?: Record<string, unknown> | null }>(
  result: T,
  billToAddress: string
): boolean {
  return cachedCompanyAddresses(result.metadata).some((address) => addressesShareStreet(billToAddress, address));
}

export function tagCompaniesByAddress<T extends { metadata?: Record<string, unknown> | null }>(
  results: T[],
  billToAddress: string | undefined
): { results: Array<T & { addressMatch: CompanyAddressMatch }>; addressMatch: CompanyAddressMatch } {
  if (!billToAddress?.trim() || results.length === 0) {
    return {
      addressMatch: 'none',
      results: results.map((result) => ({ ...result, addressMatch: 'none' as const })),
    };
  }

  const matchedIndexes = results
    .map((result, index) => (resultMatchesBillToAddress(result, billToAddress) ? index : -1))
    .filter((index) => index >= 0);

  const addressMatch: CompanyAddressMatch = matchedIndexes.length === 0
    ? 'none'
    : matchedIndexes.length === 1
      ? 'unique'
      : 'shared';

  return {
    addressMatch,
    results: results.map((result, index) => ({
      ...result,
      addressMatch: matchedIndexes.includes(index) ? addressMatch : 'none' as const,
    })),
  };
}

export function includeCompaniesMatchingBillToAddress<
  T extends { workday_id: string; metadata?: Record<string, unknown> | null },
  C extends { workday_id: string; metadata?: Record<string, unknown> | null }
>(
  nameResults: T[],
  cachedCompanies: C[] | undefined,
  billToAddress: string | undefined,
  limit?: number
): { results: Array<(T | C) & { addressMatch: CompanyAddressMatch }>; addressMatch: CompanyAddressMatch } {
  if (!billToAddress?.trim() || !cachedCompanies?.length) {
    return tagCompaniesByAddress(nameResults, billToAddress);
  }

  const fromCache = tagCompaniesByAddress(cachedCompanies, billToAddress);
  if (fromCache.addressMatch === 'none') {
    return tagCompaniesByAddress(nameResults, billToAddress);
  }

  const hitIds = new Set(
    fromCache.results.filter((row) => row.addressMatch !== 'none').map((row) => row.workday_id)
  );
  const nameIds = new Set(nameResults.map((row) => row.workday_id));
  const taggedName = nameResults.map((row) => ({
    ...row,
    addressMatch: hitIds.has(row.workday_id) ? fromCache.addressMatch : 'none' as const,
  }));
  const extras = fromCache.results.filter((row) => row.addressMatch !== 'none' && !nameIds.has(row.workday_id));
  const remaining = typeof limit === 'number' ? Math.max(0, limit - taggedName.length) : extras.length;

  return {
    addressMatch: fromCache.addressMatch,
    results: [...taggedName, ...extras.slice(0, remaining)],
  };
}
