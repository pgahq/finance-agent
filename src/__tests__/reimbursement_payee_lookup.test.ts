jest.mock('@pga/logger', () => ({ debug: jest.fn() }));
jest.mock('../lib/database.js', () => ({
  findDocumentsContainingWords: jest.fn(),
  findSuppliersByNameWord: jest.fn(),
}));

import { findDocumentsContainingWords } from '../lib/database.js';
import { decideReimbursement, type ReimbursementPacket } from '../lib/reimbursement_packet.js';

// Runs the real payee lookup (supplier_match + po_supplier name rules) against a small fictional supplier cache.
// Only the SQL is replaced: the stand-in below keeps a document when it contains every word, like the real
// `content ILIKE ALL(...)` query, so what the lookup does with the candidates is the real code.
const findDocuments = findDocumentsContainingWords as jest.Mock;

const supplier = (workdayId: string, name: string, supplierId: string, alternateNames: string[] = []) => ({
  workday_id: workdayId,
  content: [`Company Name: ${name}`, `Supplier ID: ${supplierId}`, ...(alternateNames.length ? [`Alternate Names: ${alternateNames.join(', ')}`] : []), 'Status: Active'].join('\n'),
  metadata: { supplierName: name, supplierId, alternateNames },
});

const CACHE = [
  supplier('wid-jordan', 'JORDAN P REYES', 'S-100001'),
  supplier('wid-jordan-llc', 'REYES EVENT PRODUCTIONS LLC', 'S-100002', ['Jordan Reyes Productions']),
  supplier('wid-avery', 'AVERY LINDQVIST', 'S-100003'),
  supplier('wid-avery-hotel', 'LINDQVIST HOTEL GROUP INC', 'S-100004'),
  supplier('wid-sam-1', 'SAM OKAFOR', 'S-100005'),
  supplier('wid-sam-2', 'SAMUEL OKAFOR', 'S-100006'),
  supplier('wid-casey', 'CASEY M BRANDT', 'S-100007'),
  supplier('wid-casey-2', 'CASEY BRANDT PHOTOGRAPHY LLC', 'S-100008'),
  supplier('wid-courtyard', 'COURTYARD BY MARRIOTT NEW YORK', 'S-100009'),
  supplier('wid-default', 'GENERAL VENDOR (DEFAULT)', 'S-100010'),
];

const includesAllWords = (doc: { content: string }, words: string[]) =>
  words.every((word) => doc.content.toLowerCase().includes(word.replace(/[^a-z0-9]/gi, '').toLowerCase()));

const packet = (payeeName: string | null): ReimbursementPacket => ({
  kind: 'reimbursement',
  confidence: 0.95,
  payeeName,
  payeeSupplierId: null,
  formAmountToPay: '$1,000.00',
  formAmountLabel: 'Amount to Pay',
  emailAmount: null,
  emailAmountIsCap: null,
  formDate: '11/02/2026',
  expenseKind: 'hotel',
  purpose: 'Sample Marathon Team',
  evidence: ['Amount to Pay $1,000.00'],
});

const db = { query: jest.fn().mockResolvedValue([]) };

beforeEach(() => {
  jest.clearAllMocks();
  findDocuments.mockImplementation((_db: unknown, _type: string, words: string[]) =>
    Promise.resolve(CACHE.filter((doc) => includesAllWords(doc, words))));
});

const decide = (payeeName: string | null) => decideReimbursement(db as never, packet(payeeName), { defaultSupplierWid: 'wid-default' });

describe('reimbursement payee lookup on a supplier cache', () => {
  it.each([
    ['the same name', 'JORDAN P REYES', 'wid-jordan'],
    ['a name without the middle initial', 'Jordan Reyes', 'wid-jordan'],
    ['a name in another case', 'jordan p. reyes', 'wid-jordan'],
    ['a person who shares a surname with a hotel group', 'Avery Lindqvist', 'wid-avery'],
    ['a person whose name is inside a longer business name', 'Casey Brandt', 'wid-casey'],
    ['a short first name that is the start of a longer one', 'Sam Okafor', 'wid-sam-1'],
    ['the longer first name when both spellings are cached', 'Samuel Okafor', 'wid-sam-2'],
  ])('books %s to that supplier', async (_label, printed, workdayId) => {
    const decision = await decide(printed);
    expect(decision).toMatchObject({ outcome: 'apply', reimbursement: { payee: { workdayId, matchedBy: 'name' } } });
  });

  it.each([
    ['a person the cache does not have', 'Riley Whitcombe'],
    ['a first name only', 'Jordan'],
    ['a nickname the cache does not have', 'Sammy Okafor'],
    ['the default supplier', 'General Vendor'],
  ])('sends %s to manual entry', async (_label, printed) => {
    const decision = await decide(printed);
    expect(decision.outcome).toBe('manual_entry');
  });

  it('sends a name that two cached suppliers carry to manual entry instead of guessing', async () => {
    CACHE.push(supplier('wid-jordan-2', 'JORDAN REYES', 'S-100011'));
    try {
      expect((await decide('Jordan Reyes')).outcome).toBe('manual_entry');
    } finally {
      CACHE.pop();
    }
  });

  it('sends a blank payee to manual entry', async () => {
    expect((await decide(null)).outcome).toBe('manual_entry');
    expect((await decide('  ')).outcome).toBe('manual_entry');
  });

  it('never returns the default supplier, even when its name is the payee name', async () => {
    const decision = await decide('General Vendor (Default)');
    expect(decision.outcome).toBe('manual_entry');
  });
});
