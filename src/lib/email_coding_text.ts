import { htmlToText } from './html_text.js';

/** Phrases that mean "code the invoice to"; a bare "code" is too common (zip code, promo code, customer code). */
export const CODING_LINE_KEYWORD = /\b(?:coding|coded\s+to|code\s+(?:to|this|these)|(?:please|kindly)\s+code|(?:company|entity)\s+code|charge(?:\s+(?:this|it|these|all))?\s+to|allocat(?:e|ed|ion)\s+to|worktags?|gl\s+string)\b/i;
const COMPANY_LABEL_LINE = /^\s*(?:company|entity)\b\s*[:#=-]/i;

export interface EmailBodies {
  plainTextBody?: string;
  conversationParts?: string;
  adminConversationParts?: string;
}

/**
 * The source email body: `plainTextBody` without the conversation parts appended after it. Unset when the
 * boundary cannot be found, so note text never passes as the supplier's own text.
 */
export function sourceEmailBody(emailContext: EmailBodies | undefined): string | undefined {
  const plainTextBody = emailContext?.plainTextBody;
  const parts = emailContext?.conversationParts;
  if (!plainTextBody) return undefined;
  if (!parts) return emailContext?.adminConversationParts ? undefined : plainTextBody;
  const suffix = `\n\n${parts}`;
  return plainTextBody.endsWith(suffix) ? plainTextBody.slice(0, -suffix.length) : undefined;
}

/**
 * Text where a company may be named without a code: AP's internal notes, and only the coding or company-label
 * lines of the supplier's email. A supplier naming its customer ("624065 PGA OF AMERICA", "PGA Hotline Fee")
 * is the bill-to, not coding, and the inbox's automatic reply is excluded too.
 */
export function emailCodingText(emailContext: EmailBodies | undefined): string {
  const sourceLines = htmlToText(sourceEmailBody(emailContext) ?? '')
    .split('\n')
    .filter((line) => CODING_LINE_KEYWORD.test(line) || COMPANY_LABEL_LINE.test(line));
  const apNotes = emailContext?.adminConversationParts ? htmlToText(emailContext.adminConversationParts) : '';
  return [...sourceLines, apNotes].filter((part) => part.trim()).join('\n');
}
