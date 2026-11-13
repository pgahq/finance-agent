import { experimental_decide as decide } from 'ai';
import { Experimental_DecisionMockModelV4 as DecisionMockModelV4 } from 'ai/test';

// jevDecide trusts the distribution experimental_decide returns, so the SDK must keep rejecting malformed answers.
// This runs the real SDK against the SDK's mock decision model; a failure here after an `ai` upgrade means jevDecide
// and its callers need their own validation before the upgrade ships.
const questions = { field: { type: 'choice', instructions: 'Which one?', criteria: { a: 'A', b: 'B', unknown: 'U' } } } as const;

function modelAnswering(answer: unknown) {
  return new DecisionMockModelV4({
    supportedQuestionTypes: ['choice'],
    doDecide: () => Promise.resolve({ answers: { field: answer } as never, warnings: [], usage: { inputTokens: 1, outputTokens: 0 } }),
  });
}

describe('experimental_decide answer validation', () => {
  it('accepts a well-formed distribution', async () => {
    const result = await decide({ model: modelAnswering({ type: 'choice', choice: 'a', probabilities: { a: 0.9, b: 0.05, unknown: 0.05 } }), state: 'x', questions, maxRetries: 0 });

    expect(result.answers.field.choice).toBe('a');
  });

  it.each([
    ['a choice outside the criteria', { type: 'choice', choice: 'zzz', probabilities: { a: 0.9, b: 0.05, unknown: 0.05 } }],
    ['an inherited object key as the choice', { type: 'choice', choice: 'toString', probabilities: { toString: 0.9, b: 0.05, unknown: 0.05 } }],
    ['an option the question did not offer', { type: 'choice', choice: 'a', probabilities: { a: 0.9, b: 0.05, unknown: 0.03, extra: 0.02 } }],
    ['a missing option', { type: 'choice', choice: 'a', probabilities: { a: 0.9, b: 0.1 } }],
    ['probabilities that do not sum to one', { type: 'choice', choice: 'a', probabilities: { a: 0.9, b: 0.5, unknown: 0.5 } }],
    ['a non-finite probability', { type: 'choice', choice: 'a', probabilities: { a: Number.NaN, b: 0.5, unknown: 0.5 } }],
    ['a probability outside 0 to 1', { type: 'choice', choice: 'a', probabilities: { a: 1.2, b: -0.1, unknown: -0.1 } }],
    ['a selected option that is not the most likely', { type: 'choice', choice: 'b', probabilities: { a: 0.9, b: 0.05, unknown: 0.05 } }],
  ])('rejects %s', async (_name, answer) => {
    await expect(decide({ model: modelAnswering(answer), state: 'x', questions, maxRetries: 0 })).rejects.toThrow();
  });
});
