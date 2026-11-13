jest.mock('@pga/logger', () => ({ debug: jest.fn() }));
jest.mock('../lib/jev.js', () => ({
  ...jest.requireActual('../lib/jev.js'),
  jevDecide: jest.fn(),
}));

import { jevDecide } from '../lib/jev.js';
import { jevAttributeCancel, jevClassifyChanges, jevScoredChanges, jevSupplierVoidOrCredit } from '../lib/jev_audit.js';
import { scoreChanges, type ScoredChange } from '../lib/invoice_score.js';
import { diffScoredFields, diffScoredFieldsWithJev, type ScoredFields, type ScoredLine } from '../lib/invoice_snapshots.js';

const mockDecide = jevDecide as unknown as jest.Mock;
const env = {} as NodeJS.ProcessEnv;

const choice = (picked: string, confidence: number) => ({ choice: picked, probabilities: { [picked]: confidence }, confidence });

beforeEach(() => mockDecide.mockReset());

describe('jevAttributeCancel', () => {
  it('keeps a cancel the rules settled from a Workday fact without asking Jev', async () => {
    const rule = { attribution: 'business', basis: 'business_reason' } as const;
    await expect(jevAttributeCancel({}, rule, env)).resolves.toEqual({ result: rule });
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it('takes a confident Jev choice and leaves out the fields the rules already settled', async () => {
    mockDecide.mockResolvedValue({ choices: { cancel: choice('agent', 0.93) }, booleans: {} });
    const decision = await jevAttributeCancel(
      { primaryAttachmentKind: 'supporting', replacement: { workdayInvoiceWid: 'w' }, apLabel: undefined },
      { attribution: 'unattributed', basis: 'no_signal' },
      env
    );
    expect(decision).toEqual({ result: { attribution: 'agent', basis: 'jev' }, confidence: 0.93 });
    expect(mockDecide.mock.calls[0][0]).toEqual({ evidence: { primaryAttachmentKind: 'supporting' } });
  });

  it('leaves a low-confidence or unattributed choice unattributed, keeping the rule basis when it was unattributed', async () => {
    mockDecide.mockResolvedValue({ choices: { cancel: choice('business', 0.5) }, booleans: {} });
    await expect(jevAttributeCancel({}, { attribution: 'unattributed', basis: 'early_draft_cancel' }, env)).resolves.toEqual({
      result: { attribution: 'unattributed', basis: 'early_draft_cancel' },
      confidence: 0.5,
    });
    await expect(jevAttributeCancel({}, { attribution: 'agent', basis: 'wrong_document' }, env)).resolves.toEqual({
      result: { attribution: 'unattributed', basis: 'no_signal' },
      confidence: 0.5,
    });
    mockDecide.mockResolvedValue({ choices: { cancel: choice('unattributed', 0.99) }, booleans: {} });
    const decision = await jevAttributeCancel({}, { attribution: 'unattributed', basis: 'no_signal' }, env);
    expect(decision?.result.attribution).toBe('unattributed');
  });

  it('returns undefined when Jev cannot answer', async () => {
    mockDecide.mockResolvedValue(undefined);
    await expect(jevAttributeCancel({}, { attribution: 'unattributed', basis: 'no_signal' }, env)).resolves.toBeUndefined();
  });
});

describe('jevSupplierVoidOrCredit', () => {
  const message = (body: string, extra: Record<string, unknown> = {}) => ({ createdAt: 100, body, authorType: 'user', ...extra });

  it('asks one question per supplier message after the write and skips AP replies and notes', async () => {
    mockDecide.mockResolvedValue({ choices: {}, booleans: { message0: 0.1, message1: 0.95 } });
    const result = await jevSupplierVoidOrCredit(
      [
        message('<p>Thanks</p>'),
        message('Please disregard that one, it was issued in error'),
        message('Voided', { authorType: 'admin' }),
        message('internal', { partType: 'note' }),
        message('old void', { createdAt: 1 }),
      ],
      50,
      env
    );
    expect(result).toEqual({ voided: true, probability: 0.95 });
    expect(Object.keys(mockDecide.mock.calls[0][1])).toEqual(['message0', 'message1']);
    expect(mockDecide.mock.calls[0][0]).toEqual({ supplierMessages: { message0: 'Thanks', message1: 'Please disregard that one, it was issued in error' } });
  });

  it('does not call Jev when no supplier message qualifies', async () => {
    await expect(jevSupplierVoidOrCredit([message('hi', { authorType: 'admin' })], 0, env)).resolves.toEqual({ voided: false, probability: 0 });
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it('is not a void below the threshold, and undefined when Jev fails', async () => {
    mockDecide.mockResolvedValueOnce({ choices: {}, booleans: { message0: 0.4 } });
    await expect(jevSupplierVoidOrCredit([message('I will credit you')], 0, env)).resolves.toEqual({ voided: false, probability: 0.4 });
    mockDecide.mockResolvedValueOnce(undefined);
    await expect(jevSupplierVoidOrCredit([message('I will credit you')], 0, env)).resolves.toBeUndefined();
  });

  it('asks about the newest 20 messages at most and caps their length', async () => {
    mockDecide.mockResolvedValue({ choices: {}, booleans: {} });
    const many = Array.from({ length: 25 }, (_, index) => message(`note ${index} ${'x'.repeat(2000)}`));
    await jevSupplierVoidOrCredit(many, 0, env);
    const state = mockDecide.mock.calls[0][0].supplierMessages as Record<string, string>;
    expect(Object.keys(state)).toHaveLength(20);
    expect(state.message0.startsWith('note 5 ')).toBe(true);
    expect(state.message0.length).toBeLessThanOrEqual(1500);
  });
});

describe('jevClassifyChanges', () => {
  const changes: ScoredChange[] = [
    { field: 'memo', before: 'a', after: 'b', category: 'convention', agentOwned: true },
    { field: 'line.costCenter', line: 0, before: 'CC1', after: 'CC2', category: 'material', agentOwned: true },
    { field: 'supplier', before: 'S1', after: 'S2', category: 'material', agentOwned: false },
  ];

  it('classifies each agent-owned change by probability and records the static category it replaced', async () => {
    mockDecide.mockResolvedValue({ choices: {}, booleans: { change0: 0.9, change1: 0.2 } });
    const result = await jevClassifyChanges(changes, { supplier: 'Acme' }, env);
    expect(result?.map((change) => change.category)).toEqual(['material', 'convention', 'material']);
    expect(result?.[0].jev).toEqual({ probability: 0.9, staticCategory: 'convention' });
    expect(result?.[1].jev).toEqual({ probability: 0.2, staticCategory: 'material' });
    expect(result?.[2].jev).toBeUndefined();
    expect(Object.keys(mockDecide.mock.calls[0][1])).toEqual(['change0', 'change1']);
  });

  it('asks nothing when no change belongs to the agent', async () => {
    const result = await jevClassifyChanges([changes[2]], {}, env);
    expect(result).toEqual([changes[2]]);
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it('chunks large diffs and returns undefined if any request fails or omits an answer', async () => {
    const many = Array.from({ length: 45 }, (_, index): ScoredChange => ({ field: 'memo', before: index, after: 'x', category: 'convention', agentOwned: true }));
    mockDecide.mockImplementation(async (_state: unknown, questions: Record<string, unknown>) => ({
      choices: {},
      booleans: Object.fromEntries(Object.keys(questions).map((id) => [id, 0.1])),
    }));
    const ok = await jevClassifyChanges(many, {}, env);
    expect(mockDecide).toHaveBeenCalledTimes(2);
    expect(ok).toHaveLength(45);

    mockDecide.mockReset();
    mockDecide.mockResolvedValueOnce({ choices: {}, booleans: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`change${i}`, 0.1])) })
      .mockResolvedValueOnce(undefined);
    await expect(jevClassifyChanges(many, {}, env)).resolves.toBeUndefined();

    mockDecide.mockReset();
    mockDecide.mockResolvedValue({ choices: {}, booleans: {} });
    await expect(jevClassifyChanges(changes, {}, env)).resolves.toBeUndefined();
  });
});

const line = (amount: number, extra: Partial<ScoredLine> = {}): ScoredLine => ({ amount, otherWorktags: [], ...extra });
const fields = (...lines: ScoredLine[]): ScoredFields => ({ lines });

describe('diffScoredFieldsWithJev', () => {
  it('does not call Jev when every line pairs exactly or one side has nothing left', async () => {
    await diffScoredFieldsWithJev(fields(line(10), line(20)), fields(line(10), line(20, { costCenter: 'CC2' })), env);
    await diffScoredFieldsWithJev(fields(line(10)), fields(line(10), line(5)), env);
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it('pairs a re-amounted line by Jev where the rules would pair by position', async () => {
    const before = fields(line(10, { costCenter: 'A' }), line(20, { costCenter: 'B' }));
    const after = fields(line(21, { costCenter: 'B' }), line(11, { costCenter: 'A' }));
    mockDecide.mockResolvedValue({
      choices: { line0: choice('line1', 0.95), line1: choice('line0', 0.95) },
      booleans: {},
    });
    const diff = await diffScoredFieldsWithJev(before, after, env);
    expect(diff.filter((change) => change.field === 'line.costCenter')).toEqual([]);
    expect(diff.filter((change) => change.field === 'line.amount').map((change) => [change.before, change.after])).toEqual([[20, 21], [10, 11]]);
    expect(diffScoredFields(before, after).some((change) => change.field === 'line.costCenter')).toBe(true);
  });

  it('records a line Jev says AP deleted, and falls back to rule pairing below the threshold or on failure', async () => {
    const before = fields(line(10), line(20));
    const after = fields(line(11));
    mockDecide.mockResolvedValue({
      choices: { line0: choice('line0', 0.95), line1: choice('removed', 0.95) },
      booleans: {},
    });
    const withJev = await diffScoredFieldsWithJev(before, after, env);
    expect(withJev.map((change) => change.field)).toEqual(expect.arrayContaining(['line.removed']));

    mockDecide.mockResolvedValue({ choices: { line0: choice('line0', 0.2), line1: choice('removed', 0.2) }, booleans: {} });
    await expect(diffScoredFieldsWithJev(before, after, env)).resolves.toEqual(diffScoredFields(before, after));

    mockDecide.mockResolvedValue(undefined);
    await expect(diffScoredFieldsWithJev(before, after, env)).resolves.toEqual(diffScoredFields(before, after));
  });

  it('gives a contested later line to the more confident earlier line', async () => {
    const before = fields(line(10, { costCenter: 'A' }), line(20, { costCenter: 'B' }));
    const after = fields(line(11, { costCenter: 'A' }), line(99, { costCenter: 'Z' }));
    mockDecide.mockResolvedValue({
      choices: { line0: choice('line0', 0.85), line1: choice('line0', 0.99) },
      booleans: {},
    });
    const diff = await diffScoredFieldsWithJev(before, after, env);
    expect(diff.find((change) => change.field === 'line.amount' && change.after === 11)?.before).toBe(20);
  });
});

describe('jevScoredChanges', () => {
  it('pairs by Jev, classifies by Jev, and carries agent ownership', async () => {
    mockDecide.mockResolvedValue({ choices: {}, booleans: { change0: 0.9 } });
    const result = await jevScoredChanges(
      { ...fields(line(10)), memo: 'AC 1. Services' },
      { ...fields(line(10)), memo: 'Services' },
      { agentChangedFields: ['memo'], supplier: 'Acme' },
      env
    );
    expect(result).toEqual([
      { ...scoreChanges([{ field: 'memo', before: 'AC 1. Services', after: 'Services' }], ['memo'])[0], category: 'material', jev: { probability: 0.9, staticCategory: 'convention' } },
    ]);
  });

  it('is undefined when classification fails, so no half-Jev verdict is stored', async () => {
    mockDecide.mockResolvedValue(undefined);
    await expect(jevScoredChanges({ ...fields(line(10)), memo: 'a' }, { ...fields(line(10)), memo: 'b' }, {}, env)).resolves.toBeUndefined();
  });
});
