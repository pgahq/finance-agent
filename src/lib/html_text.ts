/** Tag names Intercom bodies use; anything else in angle brackets (`<PO-413672>`, `<a@b.com>`, `a < b > c`) is text. */
export const HTML_TAG_NAMES = 'a|article|b|blockquote|body|br|center|code|div|em|figcaption|figure|font|footer|h[1-6]|head|header|hr|html|i|img|li|link|meta|nav|ol|p|pre|script|section|small|span|strong|style|sub|sup|table|tbody|td|tfoot|th|thead|title|tr|u|ul|wbr';
/** Tags that start or end a rendered block, so text on either side never runs together. */
export const HTML_BLOCK_NAMES = 'br|p|div|li|tr|h[1-6]|blockquote|pre|table|ul|ol|section|article|header|footer';

const tagPattern = (names: string) => new RegExp(`<\\/?(?:${names})(?:[\\s/][^<>]{0,200})?>`, 'gi');
const HTML_BLOCK_TAG = tagPattern(HTML_BLOCK_NAMES);
const HTML_TAG = tagPattern(HTML_TAG_NAMES);

/** Plain text from an Intercom HTML body: block tags become newlines, other tags drop, common entities decode. */
export function htmlToText(value: string): string {
  return value
    .replace(HTML_BLOCK_TAG, '\n')
    .replace(HTML_TAG, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}
