/** Tag names Intercom bodies use. */
export const HTML_TAG_NAMES = 'a|article|b|blockquote|body|br|center|code|div|em|figcaption|figure|font|footer|h[1-6]|head|header|hr|html|i|img|li|link|meta|nav|ol|p|pre|script|section|small|span|strong|style|sub|sup|table|tbody|td|tfoot|th|thead|title|tr|u|ul|wbr';
/** Tags that start or end a rendered block, so text on either side never runs together. */
export const HTML_BLOCK_NAMES = 'br|p|div|li|tr|h[1-6]|blockquote|pre|table|ul|ol|section|article|header|footer';

// Attributes may quote ">"; each alternative consumes distinct characters, so matching stays linear.
const TAG_ATTRIBUTES = String.raw`(?:[\s/](?:"[^"]*"|'[^']*'|[^'"<>])*)?`;
const HTML_BLOCK_TAG = new RegExp(String.raw`<\/?(?:${HTML_BLOCK_NAMES})${TAG_ATTRIBUTES}>`, 'gi');
// Unknown names (`o:p`, `v:shape`, `x-mail`) count as tags only with no attributes or real `name=` ones, so
// bracketed text such as `<PO 413672>`, `<PO-413672>`, `<Arrow Exterminators>`, or `<a@b.com>` stays.
const UNKNOWN_TAG_ATTRIBUTES = String.raw`(?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s'"<>]+))?)*\s*\/?`;
const HTML_TAG = new RegExp(
  String.raw`<\/?(?:(?:${HTML_TAG_NAMES})(?![\w:-])${TAG_ATTRIBUTES}|[a-z]+(?:[:-][a-z]+)*(?=[\s/>])(?:\s*\/?|(?=\s+[\w:-]+\s*=)${UNKNOWN_TAG_ATTRIBUTES}))>`,
  'gi'
);
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
