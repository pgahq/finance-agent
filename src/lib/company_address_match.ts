export type CompanyAddressMatch = 'unique' | 'shared' | 'none';

const STREET_TYPE =
  '(?:Avenue|Ave\\.?|Boulevard|Blvd\\.?|Street|St\\.?|Road|Rd\\.?|Drive|Dr\\.?|Lane|Ln\\.?|Way|Parkway|Pkwy\\.?|Highway|Hwy\\.?|Circle|Cir\\.?|Court|Ct\\.?|Place|Pl\\.?|Trail|Trl\\.?|Terrace|Ter\\.?|Plaza|Square|Sq\\.?)';

const STREET_LINE = new RegExp(
  String.raw`\b(\d{1,6}(?:-\d{1,6})?)\s+((?:[NSEW]\.?\s+)?(?:[A-Za-z0-9.'#-]+\s+){0,8}${STREET_TYPE}\b(?:\s+of(?:\s+the)?(?:\s+[A-Za-z][A-Za-z.'-]*){1,3})?)`,
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
  for (const token of left.tokens) {
    if (right.tokens.has(token)) return true;
  }
  return false;
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

export function rankCompaniesByAddress<T extends { metadata?: Record<string, unknown> | null }>(
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

  const tagged = results.map((result, index) => ({
    ...result,
    addressMatch: matchedIndexes.includes(index) ? addressMatch : 'none',
  }));

  if (addressMatch !== 'unique') {
    return { results: tagged, addressMatch };
  }

  const winner = tagged[matchedIndexes[0]];
  const rest = tagged.filter((_, index) => index !== matchedIndexes[0]);
  return { results: [winner, ...rest], addressMatch };
}
