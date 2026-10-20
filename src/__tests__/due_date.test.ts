import { dayMonthYearReading, dueDateIsPlausible, MAX_DUE_DATE_DAYS_AFTER_INVOICE } from '../lib/due_date.js';

describe('dueDateIsPlausible', () => {
  it.each([
    ['2026-10-10', '2026-10-10', true],
    ['2026-10-10', '2026-11-11', true],
    ['2026-10-10', '2026-10-09', false],
    ['2026-10-10', '2027-04-08', true],
    ['2026-10-10', '2027-04-09', false],
    ['2026-10-10', '2062-11-11', false],
  ])('invoice %s, due %s -> %s', (invoice, due, expected) => {
    expect(dueDateIsPlausible(invoice, due)).toBe(expected);
    expect(MAX_DUE_DATE_DAYS_AFTER_INVOICE).toBe(180);
  });
});

describe('dayMonthYearReading', () => {
  it('finds a day/month/year invoice: 05/10/2026 due 04/11/2026 read month/day/year puts the due date before the invoice', () => {
    expect(dayMonthYearReading('2026-05-10', '2026-04-11')).toEqual({ invoiceDate: '2026-10-05', dueDate: '2026-11-04' });
  });

  it('finds one whose month/day/year reading is too far out: the due date lands more than 180 days after', () => {
    expect(dayMonthYearReading('2026-01-02', '2026-11-03')).toEqual({ invoiceDate: '2026-02-01', dueDate: '2026-03-11' });
  });

  it('keeps an invoice date that cannot be swapped because its day is over 12', () => {
    expect(dayMonthYearReading('2026-10-25', '2026-04-11')).toEqual({ invoiceDate: '2026-10-25', dueDate: '2026-11-04' });
    expect(dayMonthYearReading('2026-03-25', '2026-04-11')).toBeUndefined();
  });

  it('says nothing when month/day/year is plausible, even if the flipped reading is too', () => {
    expect(dayMonthYearReading('2026-10-10', '2026-11-11')).toBeUndefined();
    expect(dayMonthYearReading('2026-01-12', '2026-02-11')).toBeUndefined();
  });

  it('says nothing when the flipped reading is no better, or a date cannot be swapped or is missing', () => {
    expect(dayMonthYearReading('2026-10-10', '2026-10-09')).toBeUndefined();
    expect(dayMonthYearReading('2026-05-10', '2026-04-25')).toBeUndefined();
    expect(dayMonthYearReading(undefined, '2026-04-11')).toBeUndefined();
    expect(dayMonthYearReading('2026-05-10', null)).toBeUndefined();
    expect(dayMonthYearReading('not a date', '2026-04-11')).toBeUndefined();
  });
});
