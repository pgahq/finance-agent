const STREET_TYPE =
  '(?:Avenue|Ave\\.?|Boulevard|Blvd\\.?|Street|St\\.?|Road|Rd\\.?|Drive|Dr\\.?|Lane|Ln\\.?|Way|Parkway|Pkwy\\.?|Highway|Hwy\\.?|Circle|Cir\\.?|Court|Ct\\.?|Place|Pl\\.?|Trail|Trl\\.?|Terrace|Ter\\.?|Plaza|Square|Sq\\.?)';

const FROM_STREET_ADDRESS = new RegExp(
  String.raw`\b\d{1,6}(?:-\d{1,6})?\s+(?:[NSEW]\.?\s+)?(?:[A-Za-z0-9.'#-]+[,\s]+){0,8}${STREET_TYPE}\b.*$`,
  'i'
);
const FROM_PO_BOX = /\bP\.?\s*O\.?\s*Box\s+\d+\b.*$/i;
const FROM_UNIT = /\b(?:Suite|Ste\.?|Unit|Apt\.?|Apartment|#)\s*[A-Z0-9-]+\b.*$/i;
const COMPANY_SUFFIX = /^(?:Inc|LLC|Ltd|Corp|Corporation|Company|Co|Association|Foundation|Group|Partners|LLP|PLLC|PC)\.?$/i;
const ORG_STOP = /^(?:PGA|JR\.?|LEAGUE|SECTION|OF|THE|AND|INC|LLC|LTD|CORP|CORPORATION|COMPANY|CO|ASSOCIATION|FOUNDATION|GROUP|PARTNERS|LLP|PLLC|PC)\.?$/i;
const MAX_CITY_WORDS = 4;

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/[,\s]+$/g, '').trim();
}

function tokenize(text: string): string[] {
  return text.split(/[\s,]+/).map((token) => token.replace(/,+$/g, '')).filter(Boolean);
}

function isZip(token: string): boolean {
  return /^\d{5}(?:-\d{4})?$/.test(token);
}

function isState(token: string): boolean {
  return /^[A-Za-z]{2}$/.test(token);
}

function isHouseNumberToken(token: string): boolean {
  return /^\d{1,6}$/.test(token);
}

function remainderIsAddressSkip(tokens: string[], end: number): boolean {
  if (end <= 0) return true;
  return end === 1 && isHouseNumberToken(tokens[0]);
}

function looksLikeCityWord(token: string): boolean {
  if (ORG_STOP.test(token) || COMPANY_SUFFIX.test(token) || isState(token)) return false;
  if (/^[A-Z]{3,}\.?$/.test(token)) return true;
  return /^(?:[A-Z][a-z][A-Za-z.'-]*|(?:St|Ft|Mt)\.)$/.test(token);
}

function stripTrailingCityStateZip(text: string): string {
  const tokens = tokenize(text);
  if (tokens.length < 2) return text;

  let zipIndex = tokens.length - 1;
  if (/^(?:USA|US)$/i.test(tokens[zipIndex])) {
    zipIndex -= 1;
  }
  if (zipIndex < 1) return text;
  if (!isZip(tokens[zipIndex]) || !isState(tokens[zipIndex - 1])) return text;

  let end = zipIndex - 1;
  let peeled = 0;
  const beforeCity = end;
  while (end > 0 && peeled < MAX_CITY_WORDS && looksLikeCityWord(tokens[end - 1])) {
    const nextEnd = end - 1;
    if (nextEnd < 2 && !remainderIsAddressSkip(tokens, nextEnd)) {
      break;
    }
    end = nextEnd;
    peeled += 1;
  }
  if (peeled < 2) {
    if (!(peeled === 1 && end >= 3)) {
      end = beforeCity;
    }
  }

  const name = tokens.slice(0, end);
  if (name.length > 1 && isHouseNumberToken(name[name.length - 1])) {
    name.pop();
  }
  if (name.length === 1 && isHouseNumberToken(name[0])) {
    return '';
  }
  if (name.length === 1 && ORG_STOP.test(name[0])) {
    return '';
  }
  if (name.length === 0) {
    if (isHouseNumberToken(tokens[0])) {
      return '';
    }
    return tokens.slice(0, zipIndex - 1).join(' ');
  }
  return name.join(' ');
}

export function companyNameSearchQuery(query: string): string {
  let text = collapseWhitespace(query);
  if (!text) return '';

  text = collapseWhitespace(text.replace(FROM_STREET_ADDRESS, ''));
  text = collapseWhitespace(text.replace(FROM_PO_BOX, ''));
  text = collapseWhitespace(text.replace(FROM_UNIT, ''));
  return stripTrailingCityStateZip(text);
}
