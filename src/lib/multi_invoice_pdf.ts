import { sanitizeSuppliersInvoiceNumber } from './invoice_memo.js';

const MAX_NUMBERS_LISTED = 10;
const MAX_NUMBER_LENGTH = 40;

export interface MultiInvoiceReview {
  fileName: string;
  /** Distinct invoice numbers the reader saw, the one that was entered first. */
  invoiceNumbers: string[];
  /** Null when the reader printed no number for the invoice it entered. */
  enteredInvoiceNumber: string | null;
  /** The sentence shown to AP in the Workday note and the Slack post. */
  message: string;
}

function cleanNumber(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_NUMBER_LENGTH ? `${collapsed.slice(0, MAX_NUMBER_LENGTH - 1)}…` : collapsed;
}

// The agent reads one invoice from a file, so a file that prints several separate invoices needs a person to
// enter the rest. The reader lists every invoice number it sees; this turns two or more distinct numbers into a
// review note. The entered number leads the list, whatever order the reader returned.
export function multiInvoiceReview(input: {
  fileName: string;
  enteredInvoiceNumber?: string | null;
  invoiceNumbersInDocument?: string[] | null;
}): MultiInvoiceReview | undefined {
  const entered = input.enteredInvoiceNumber?.trim() ? cleanNumber(input.enteredInvoiceNumber) : null;
  const seen = new Set<string>();
  const numbers: string[] = [];
  const add = (value: string) => {
    const key = sanitizeSuppliersInvoiceNumber(value)?.toUpperCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    numbers.push(cleanNumber(value));
  };
  if (entered) add(entered);
  for (const value of input.invoiceNumbersInDocument ?? []) add(value);
  if (numbers.length < 2) return undefined;

  const listed = numbers.slice(0, MAX_NUMBERS_LISTED).join(', ');
  const more = numbers.length > MAX_NUMBERS_LISTED ? `, and ${numbers.length - MAX_NUMBERS_LISTED} more` : '';
  const enteredText = entered ? `only ${entered} was entered` : 'only the first invoice was entered';
  return {
    fileName: input.fileName,
    invoiceNumbers: numbers,
    enteredInvoiceNumber: entered,
    message: `${input.fileName} appears to contain ${numbers.length} invoices (${listed}${more}); ${enteredText}. Enter the rest manually.`,
  };
}

export function formatMultiInvoiceNotes(review: MultiInvoiceReview | undefined): string {
  return review ? `Multiple invoices in one PDF: ${review.message}\n\n` : '';
}
