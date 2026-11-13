jest.mock('@pga/logger', () => ({ debug: jest.fn() }));
jest.mock('ai', () => ({ experimental_decide: jest.fn() }));

import { experimental_decide as decide } from 'ai';
import { DEFAULT_JEV_BUDGET_MS, DEFAULT_JEV_MODEL, jevBudgetFromEnv, jevDecide, jevMinConfidence, jevMode, jevModelName, resetJevBreaker, startJevBudget, type JevQuestion } from '../lib/jev.js';

const mockDecide = decide as unknown as jest.Mock;

const questions: Record<string, JevQuestion> = {
  who: { type: 'choice', instructions: 'Who?', criteria: { agent: 'a', business: 'b' } },
  flag: { type: 'boolean', instructions: 'Is it?' },
};

beforeEach(() => {
  mockDecide.mockReset();
  resetJevBreaker();
});

describe('jevMode and settings', () => {
  it('is off unless shadow or on is asked for, so a blank or a typo sends nothing', () => {
    expect(jevMode({})).toBe('off');
    expect(jevMode({ JEV_AUDIT_MODE: ' ON ' })).toBe('on');
    expect(jevMode({ JEV_AUDIT_MODE: 'Shadow' })).toBe('shadow');
    expect(jevMode({ JEV_AUDIT_MODE: 'off' })).toBe('off');
    expect(jevMode({ JEV_AUDIT_MODE: '' })).toBe('off');
    expect(jevMode({ JEV_AUDIT_MODE: 'of' })).toBe('off');
  });

  it('reads the model and the confidence threshold with safe defaults', () => {
    expect(jevModelName({})).toBe(DEFAULT_JEV_MODEL);
    expect(jevModelName({ JEV_MODEL: 'typesafe-ai/jev' })).toBe('typesafe-ai/jev');
    expect(jevMinConfidence({})).toBe(0.8);
    expect(jevMinConfidence({ JEV_MIN_CONFIDENCE: '0.9' })).toBe(0.9);
    expect(jevMinConfidence({ JEV_MIN_CONFIDENCE: '4' })).toBe(0.8);
  });
});

describe('jevDecide', () => {
  it('asks all questions in one request, pinned to TypeSafe with zero data retention', async () => {
    mockDecide.mockResolvedValue({
      answers: {
        who: { type: 'choice', choice: 'agent', probabilities: { agent: 0.9, business: 0.1 } },
        flag: { type: 'boolean', probability: 0.3 },
      },
      providerMetadata: { typesafe: { confidence: { who: 0.95 } } },
    });
    const answers = await jevDecide({ x: 1 }, questions, {});
    expect(answers).toEqual({
      choices: { who: { choice: 'agent', probabilities: { agent: 0.9, business: 0.1 }, confidence: 0.95 } },
      booleans: { flag: 0.3 },
    });
    expect(mockDecide).toHaveBeenCalledTimes(1);
    expect(mockDecide).toHaveBeenCalledWith(expect.objectContaining({
      model: DEFAULT_JEV_MODEL,
      state: { x: 1 },
      questions,
      providerOptions: { gateway: { only: ['typesafe-ai'], zeroDataRetention: true } },
    }));
  });

  it('uses the winning probability when the response carries no confidence', async () => {
    mockDecide.mockResolvedValue({
      answers: {
        who: { type: 'choice', choice: 'business', probabilities: { agent: 0.2, business: 0.8 } },
        flag: { type: 'boolean', probability: 0.5 },
      },
    });
    const answers = await jevDecide({}, questions, {});
    expect(answers?.choices.who.confidence).toBe(0.8);
  });

  it('makes no request when there is nothing to ask', async () => {
    await expect(jevDecide({}, {}, {})).resolves.toEqual({ choices: {}, booleans: {} });
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it('resolves to undefined on a gateway error or timeout instead of throwing', async () => {
    mockDecide.mockRejectedValue(new Error('gateway down'));
    await expect(jevDecide({}, questions, {})).resolves.toBeUndefined();
    mockDecide.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    await expect(jevDecide({}, questions, {})).resolves.toBeUndefined();
  });

  it('rejects an answer of the wrong shape or a choice that was not offered', async () => {
    mockDecide.mockResolvedValue({ answers: { who: { type: 'boolean', probability: 1 }, flag: { type: 'boolean', probability: 1 } } });
    await expect(jevDecide({}, questions, {})).resolves.toBeUndefined();
    mockDecide.mockResolvedValue({
      answers: { who: { type: 'choice', choice: 'nobody', probabilities: {} }, flag: { type: 'boolean', probability: 1 } },
    });
    await expect(jevDecide({}, questions, {})).resolves.toBeUndefined();
    mockDecide.mockResolvedValue({
      answers: { who: { type: 'choice', choice: 'agent', probabilities: { agent: 1 } }, flag: { type: 'boolean' } },
    });
    await expect(jevDecide({}, questions, {})).resolves.toBeUndefined();
  });

  it('skips Jev for a while after three failures in a row, then recovers once reset', async () => {
    mockDecide.mockRejectedValue(new Error('gateway down'));
    for (let i = 0; i < 3; i++) await jevDecide({}, questions, {});
    expect(mockDecide).toHaveBeenCalledTimes(3);
    await expect(jevDecide({}, questions, {})).resolves.toBeUndefined();
    expect(mockDecide).toHaveBeenCalledTimes(3);

    resetJevBreaker();
    mockDecide.mockResolvedValue({
      answers: { who: { type: 'choice', choice: 'agent', probabilities: { agent: 1 } }, flag: { type: 'boolean', probability: 0 } },
    });
    await expect(jevDecide({}, questions, {})).resolves.toBeDefined();
  });

  it('does not open the breaker when a success breaks the run of failures', async () => {
    const ok = {
      answers: { who: { type: 'choice', choice: 'agent', probabilities: { agent: 1 } }, flag: { type: 'boolean', probability: 0 } },
    };
    mockDecide.mockRejectedValueOnce(new Error('x')).mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(ok)
      .mockRejectedValueOnce(new Error('x')).mockResolvedValue(ok);
    for (let i = 0; i < 4; i++) await jevDecide({}, questions, {});
    await expect(jevDecide({}, questions, {})).resolves.toBeDefined();
  });
});

describe('Jev time budget', () => {
  const ok = {
    answers: { who: { type: 'choice', choice: 'agent', probabilities: { agent: 1 } }, flag: { type: 'boolean', probability: 0 } },
  };

  it('reads the budget from the environment with a safe default', () => {
    expect(jevBudgetFromEnv({})).toBe(DEFAULT_JEV_BUDGET_MS);
    expect(jevBudgetFromEnv({ JEV_BUDGET_MS: '1000' })).toBe(1000);
    expect(jevBudgetFromEnv({ JEV_BUDGET_MS: '-1' })).toBe(DEFAULT_JEV_BUDGET_MS);
  });

  it('skips Jev once slow-but-successful answers have used the budget, until a new one is started', async () => {
    let clock = 0;
    const now = jest.spyOn(Date, 'now').mockImplementation(() => clock);
    mockDecide.mockImplementation(async () => {
      clock += 14_000;
      return ok;
    });
    startJevBudget(30_000);
    await expect(jevDecide({}, questions, {})).resolves.toBeDefined();
    await expect(jevDecide({}, questions, {})).resolves.toBeDefined();
    await expect(jevDecide({}, questions, {})).resolves.toBeDefined();
    expect(mockDecide).toHaveBeenCalledTimes(3);
    await expect(jevDecide({}, questions, {})).resolves.toBeUndefined();
    expect(mockDecide).toHaveBeenCalledTimes(3);

    startJevBudget(30_000);
    await expect(jevDecide({}, questions, {})).resolves.toBeDefined();
    now.mockRestore();
  });

  it('counts time spent on failed calls too, and is unlimited until a budget is started', async () => {
    let clock = 0;
    const now = jest.spyOn(Date, 'now').mockImplementation(() => clock);
    mockDecide.mockImplementation(async () => {
      clock += 40_000;
      throw new Error('timed out');
    });
    await jevDecide({}, questions, {});
    mockDecide.mockImplementation(async () => ok);
    await expect(jevDecide({}, questions, {})).resolves.toBeDefined();
    startJevBudget(30_000);
    mockDecide.mockImplementation(async () => {
      clock += 40_000;
      throw new Error('timed out');
    });
    await jevDecide({}, questions, {});
    await expect(jevDecide({}, questions, {})).resolves.toBeUndefined();
    now.mockRestore();
  });
});
