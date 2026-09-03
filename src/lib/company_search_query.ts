const STREET_TYPE =
  '(?:Avenue|Ave\\.?|Boulevard|Blvd\\.?|Street|St\\.?|Road|Rd\\.?|Drive|Dr\\.?|Lane|Ln\\.?|Way|Parkway|Pkwy\\.?|Highway|Hwy\\.?|Circle|Cir\\.?|Court|Ct\\.?|Place|Pl\\.?|Trail|Trl\\.?|Terrace|Ter\\.?|Plaza|Square|Sq\\.?)';

const FROM_STREET_ADDRESS = new RegExp(
  String.raw`\b\d{1,6}(?:-\d{1,6})?\s+(?:[NSEW]\.?\s+)?(?:[A-Za-z0-9.'#-]+\s+){0,8}${STREET_TYPE}\b.*$`,
  'i'
);
const FROM_PO_BOX = /\bP\.?\s*O\.?\s*Box\s+\d+\b.*$/i;
const FROM_UNIT = /\b(?:Suite|Ste\.?|Unit|Apt\.?|Apartment|#)\s*[A-Z0-9-]+\b.*$/i;
const COMPANY_SUFFIX = /^(?:Inc|LLC|Ltd|Corp|Corporation|Company|Co|Association|Foundation|Group|Partners|LLP|PLLC|PC)\.?$/i;
const ALL_CAPS_TOKEN = /^[A-Z]{2,}\.?$/;
const MAX_CITY_WORDS = 4;

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/[,\s]+$/g, '').trim();
}

function looksLikeCityWord(token: string): boolean {
  if (COMPANY_SUFFIX.test(token) || ALL_CAPS_TOKEN.test(token)) return false;
  return /^(?:[A-Z][a-z][A-Za-z.'-]*|(?:St|Ft|Mt)\.)$/.test(token);
}

function stripTrailingCityStateZip(text: string): string {
  const tokens = text.split(' ').filter(Boolean);
  if (tokens.length < 2) return text;
  const zip = tokens[tokens.length - 1];
  const state = tokens[tokens.length - 2];
  if (!/^\d{5}(?:-\d{4})?$/.test(zip) || !/^[A-Z]{2}$/.test(state)) return text;

  let end = tokens.length - 2;
  let peeled = 0;
  while (end > 0 && peeled < MAX_CITY_WORDS && looksLikeCityWord(tokens[end - 1])) {
    end -= 1;
    peeled += 1;
  }
  return tokens.slice(0, end).join(' ');
}

export function companyNameSearchQuery(query: string): string {
  let text = collapseWhitespace(query);
  if (!text) return '';

  text = collapseWhitespace(text.replace(FROM_STREET_ADDRESS, ''));
  text = collapseWhitespace(text.replace(FROM_PO_BOX, ''));
  text = collapseWhitespace(text.replace(FROM_UNIT, ''));
  return stripTrailingCityStateZip(text);
}
