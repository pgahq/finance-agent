/** A printed due date further out than this is more likely a misread year than real terms, so it is not sent. */
export const MAX_DUE_DATE_DAYS_AFTER_INVOICE = 180;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function daysBetween(fromIsoDate: string, toIsoDate: string): number {
  return Math.round((Date.parse(`${toIsoDate}T00:00:00Z`) - Date.parse(`${fromIsoDate}T00:00:00Z`)) / 86_400_000);
}

/** True when the due date is on or after the invoice date and within MAX_DUE_DATE_DAYS_AFTER_INVOICE days of it. */
export function dueDateIsPlausible(invoiceDate: string, dueDate: string): boolean {
  const days = daysBetween(invoiceDate, dueDate);
  return days >= 0 && days <= MAX_DUE_DATE_DAYS_AFTER_INVOICE;
}

/** The same calendar date with month and day exchanged, or undefined when the day is over 12 or the date is invalid. */
function swapMonthAndDay(isoDate: string): string | undefined {
  const match = isoDate.match(ISO_DATE);
  if (!match) return undefined;
  const [year, month, day] = match.slice(1).map(Number);
  if (day > 12 || month < 1 || month > 12) return undefined;
  const swapped = new Date(Date.UTC(year, day - 1, month));
  if (swapped.getUTCFullYear() !== year || swapped.getUTCMonth() !== day - 1 || swapped.getUTCDate() !== month) return undefined;
  return `${match[1]}-${String(day).padStart(2, '0')}-${String(month).padStart(2, '0')}`;
}

/**
 * Both dates are read month/day/year. When that reading is not plausible (due date before the invoice date, or
 * too far after it) but exchanging month and day on both makes it plausible, the invoice probably prints
 * day/month/year dates. A pair that is plausible either way cannot be told apart, so it returns undefined.
 */
export function dayMonthYearReading(
  invoiceDate: string | null | undefined,
  dueDate: string | null | undefined
): { invoiceDate: string; dueDate: string } | undefined {
  if (!invoiceDate || !dueDate || dueDateIsPlausible(invoiceDate, dueDate)) return undefined;
  const swappedDue = swapMonthAndDay(dueDate);
  if (!swappedDue) return undefined;
  const swappedInvoice = swapMonthAndDay(invoiceDate) ?? invoiceDate;
  return dueDateIsPlausible(swappedInvoice, swappedDue) ? { invoiceDate: swappedInvoice, dueDate: swappedDue } : undefined;
}
