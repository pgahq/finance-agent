/** Tag names Intercom bodies use. */
export const HTML_TAG_NAMES = 'a|article|b|blockquote|body|br|center|code|div|em|figcaption|figure|font|footer|h[1-6]|head|header|hr|html|i|img|li|link|meta|nav|ol|p|pre|script|section|small|span|strong|style|sub|sup|table|tbody|td|tfoot|th|thead|title|tr|u|ul|wbr';
/** Tags that start or end a rendered block, so text on either side never runs together. */
export const HTML_BLOCK_NAMES = 'br|p|div|li|tr|h[1-6]|blockquote|pre|table|ul|ol|section|article|header|footer';

// Attributes may quote ">"; each alternative consumes distinct characters, so matching stays linear.
const TAG_ATTRIBUTES = String.raw`(?:[\s/](?:"[^"]*"|'[^']*'|[^'"<>])*)?`;
const HTML_BLOCK_TAG = new RegExp(String.raw`<\/?(?:${HTML_BLOCK_NAMES})${TAG_ATTRIBUTES}>`, 'gi');
// Any letters-only tag name, including namespaced and custom tags (`o:p`, `x-mail`). A name followed by a
// digit, "-digit", or "@" is text: `<PO-413672>`, `<a@b.com>`; "a < b > c" has no name after "<".
const HTML_TAG = new RegExp(String.raw`<\/?[a-z]+(?:[:-][a-z]+)*${TAG_ATTRIBUTES}>`, 'gi');
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/** Plain text from an Intercom HTML body: block tags become newlines, other tags drop, common entities decode. */
export function htmlToText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(HTML_COMMENT, '')
    .replace(HTML_BLOCK_TAG, '\n')
    .replace(HTML_TAG, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}
