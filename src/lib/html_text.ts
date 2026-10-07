/** Plain text from an Intercom HTML body: block ends become newlines, tags drop, common entities decode. */
export function htmlToText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li)>/gi, '\n')
    .replace(/<[^>]{1,200}>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}
