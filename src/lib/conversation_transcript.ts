import PDFDocument from 'pdfkit';

const CENTRAL_TIME_ZONE = 'America/Chicago';
const TRANSCRIPT_FILE_PREFIX = 'pga_corp_accounts_payable';
const INCLUDED_PART_TYPES = new Set(['comment', 'note']);

export interface ConversationTranscriptMessage {
  kind: 'source' | 'comment' | 'note';
  meta: string;
  body: string;
}

export interface ConversationTranscript {
  fileName: string;
  title: string;
  startedOn?: string;
  messages: ConversationTranscriptMessage[];
}

export interface ConversationTranscriptInput {
  id?: string;
  created_at?: number;
  title?: string | null;
  custom_attributes?: { Brand?: string | null } | null;
  source?: {
    subject?: string | null;
    body?: string | null;
    author?: { name?: string | null; email?: string | null } | null;
  } | null;
  conversation_parts?: {
    conversation_parts?: Array<{
      part_type?: string;
      body?: string | null;
      created_at?: number;
      author?: { name?: string | null; email?: string | null } | null;
    }>;
  } | null;
}

interface CentralDateTimeParts {
  year: string;
  month: string;
  day: string;
  monthName: string;
  dayOfMonth: string;
  hour: string;
  minute: string;
  dayPeriod: string;
}

function toDate(createdAt: number | undefined): Date | undefined {
  if (createdAt == null || !Number.isFinite(createdAt)) {
    return undefined;
  }
  const ms = createdAt > 1e12 ? createdAt : createdAt * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function centralDateTimeParts(date: Date): CentralDateTimeParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CENTRAL_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h12',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  const monthName = new Intl.DateTimeFormat('en-US', {
    timeZone: CENTRAL_TIME_ZONE,
    month: 'long',
  }).format(date);
  const dayOfMonth = new Intl.DateTimeFormat('en-US', {
    timeZone: CENTRAL_TIME_ZONE,
    day: 'numeric',
  }).format(date);

  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    monthName,
    dayOfMonth,
    hour: value('hour').padStart(2, '0'),
    minute: value('minute').padStart(2, '0'),
    dayPeriod: value('dayPeriod').toUpperCase(),
  };
}

function clockTime(parts: CentralDateTimeParts): string {
  return `${parts.hour}:${parts.minute} ${parts.dayPeriod}`;
}

function calendarKey(parts: CentralDateTimeParts): string {
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function fullDate(parts: CentralDateTimeParts): string {
  return `${parts.monthName} ${parts.dayOfMonth}, ${parts.year}`;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

const HTML_BREAK = /<br\b[^>]*\/?>/gi;
const HTML_BLOCK_END = /<\/(?:p|div|li|tr|h[1-6]|blockquote|pre|table|ul|ol|section|article|header|footer)>/gi;
const HTML_TAG = /<\/?(?:a|article|b|blockquote|body|br|center|code|div|em|figcaption|figure|font|footer|h[1-6]|head|header|hr|html|i|img|li|link|meta|nav|ol|p|pre|script|section|small|span|strong|style|sub|sup|table|tbody|td|tfoot|th|thead|title|tr|u|ul|wbr)\b[^>]*>/gi;

function stripHtml(value: string | null | undefined): string {
  if (!value) {
    return '';
  }
  return decodeEntities(value)
    .replace(HTML_BREAK, '\n')
    .replace(HTML_BLOCK_END, '\n')
    .replace(HTML_TAG, '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const WIN_ANSI_EXTRA = new Set([
  338, 339, 352, 353, 376, 381, 382, 402, 710, 732, 8211, 8212, 8216, 8217, 8218,
  8220, 8221, 8222, 8224, 8225, 8226, 8230, 8240, 8249, 8250, 8364, 8482,
]);

function isWinAnsi(code: number): boolean {
  if (code === 9 || code === 10 || code === 13) {
    return true;
  }
  if (code >= 32 && code <= 126) {
    return true;
  }
  if (code >= 160 && code <= 255) {
    return true;
  }
  return WIN_ANSI_EXTRA.has(code);
}

function pdfText(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    out += isWinAnsi(code) ? char : '?';
  }
  return out;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function safeConversationId(conversationId: string): string {
  const safe = conversationId.trim().replace(/[^A-Za-z0-9_-]/g, '');
  return safe || 'conversation';
}

export function conversationTranscriptFileName(
  conversationId: string,
  createdAt: Date | undefined,
  now: Date,
): string {
  const parts = centralDateTimeParts(createdAt ?? now);
  return `${TRANSCRIPT_FILE_PREFIX}_${parts.year}_${parts.month}_${parts.day}_${safeConversationId(conversationId)}.pdf`;
}

function messageTime(createdAt: number | undefined, startedOn: Date | undefined): string | undefined {
  const date = toDate(createdAt);
  if (!date) {
    return undefined;
  }
  const parts = centralDateTimeParts(date);
  const time = clockTime(parts);
  if (!startedOn) {
    return `${fullDate(parts)} at ${time}`;
  }
  const startParts = centralDateTimeParts(startedOn);
  if (calendarKey(parts) === calendarKey(startParts)) {
    return time;
  }
  return `${fullDate(parts)} at ${time}`;
}

function metaLine(time: string | undefined, author: string): string {
  return time ? `${time} | ${author}` : author;
}

function authorLabel(
  author: { name?: string | null; email?: string | null } | null | undefined,
  preferEmail: boolean,
): string {
  const email = author?.email?.trim();
  const name = author?.name?.trim();
  if (preferEmail) {
    return email || name || 'Unknown';
  }
  return name || email || 'Unknown';
}

export function buildConversationTranscript(
  conversation: ConversationTranscriptInput,
  options: { conversationId: string; now?: Date },
): ConversationTranscript {
  const now = options.now ?? new Date();
  const startedAt = toDate(conversation.created_at);
  const brand = conversation.custom_attributes?.Brand?.trim();
  const title = brand
    ? `Conversation with ${brand}`
    : conversation.title?.trim() || 'Conversation';
  const startedOn = startedAt
    ? `Started on ${fullDate(centralDateTimeParts(startedAt))} at ${clockTime(centralDateTimeParts(startedAt))} Central Time`
    : undefined;

  const messages: ConversationTranscriptMessage[] = [];
  const subject = oneLine(stripHtml(conversation.source?.subject));
  const sourceBody = stripHtml(conversation.source?.body);
  const sourceText = [subject, sourceBody].filter((part) => part.length > 0).join('\n\n');
  if (sourceText) {
    messages.push({
      kind: 'source',
      meta: metaLine(
        messageTime(conversation.created_at, startedAt),
        authorLabel(conversation.source?.author, true),
      ),
      body: sourceText,
    });
  }

  for (const part of conversation.conversation_parts?.conversation_parts ?? []) {
    if (!part.part_type || !INCLUDED_PART_TYPES.has(part.part_type)) {
      continue;
    }
    const body = stripHtml(part.body);
    if (!body) {
      continue;
    }
    const author = authorLabel(part.author, false);
    const kind = part.part_type === 'note' ? 'note' : 'comment';
    const labeledAuthor = kind === 'note' ? `Note | ${author}` : author;
    messages.push({
      kind,
      meta: metaLine(messageTime(part.created_at, startedAt), labeledAuthor),
      body,
    });
  }

  return {
    fileName: conversationTranscriptFileName(options.conversationId, startedAt, now),
    title,
    ...(startedOn ? { startedOn } : {}),
    messages,
  };
}

export function renderConversationTranscriptPdf(
  transcript: ConversationTranscript,
  options?: { compress?: boolean },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: 54,
      compress: options?.compress !== false,
      info: { Title: transcript.title },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#111111').text(pdfText(transcript.title), { width });
    if (transcript.startedOn) {
      doc.moveDown(0.4);
      doc.font('Helvetica').fontSize(10).fillColor('#444444').text(pdfText(transcript.startedOn), { width });
    }
    doc.moveDown(0.6);
    const ruleY = doc.y;
    doc.moveTo(doc.page.margins.left, ruleY)
      .lineTo(doc.page.width - doc.page.margins.right, ruleY)
      .strokeColor('#1a73e8')
      .stroke();
    doc.moveDown(0.8);

    for (const message of transcript.messages) {
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#333333').text(pdfText(message.meta), { width });
      doc.moveDown(0.35);
      doc.font('Helvetica').fontSize(11).fillColor('#111111').text(pdfText(message.body), { width });
      doc.moveDown(1);
    }

    doc.end();
  });
}
