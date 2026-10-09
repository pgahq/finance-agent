import { htmlToText } from './html_text.js';

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
 * Text where a company may be named: the supplier's source email and AP's internal notes. The automatic
 * acknowledgement the AP inbox sends back ("...at The PGA of America headquarters office") is excluded so
 * it never reads as coding.
 */
export function emailCodingText(emailContext: EmailBodies | undefined): string {
  return [sourceEmailBody(emailContext), emailContext?.adminConversationParts]
    .filter((part): part is string => Boolean(part?.trim()))
    .map((part) => htmlToText(part))
    .join('\n\n');
}
