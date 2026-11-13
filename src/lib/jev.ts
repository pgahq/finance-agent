import { experimental_decide as decide } from 'ai';
import { debug } from '@pga/logger';

/**
 * Jev (TypeSafe's decision model) through Vercel AI Gateway. Every use of `experimental_decide` lives here, so
 * a rename or shape change in the experimental API is a one-file fix. Nothing here throws: a failed or slow call
 * resolves to `undefined` and callers fall back to the rule they already have.
 */

type DecisionState = Parameters<typeof decide>[0]['state'];

export type JevMode = 'off' | 'shadow' | 'on';

export const DEFAULT_JEV_MODEL = 'typesafe-ai/jev-1.14.0';
export const DEFAULT_JEV_MIN_CONFIDENCE = 0.8;
export const DEFAULT_JEV_TIMEOUT_MS = 15_000;
/** Invoice data goes only to the model's own vendor, as with the other gateway models. */
const JEV_PROVIDER = 'typesafe-ai';

/** `shadow` (the default) scores with the rules and stores Jev's verdicts; `on` scores with Jev; `off` never calls it. */
export function jevMode(env: NodeJS.ProcessEnv = process.env): JevMode {
  const value = env.JEV_AUDIT_MODE?.trim().toLowerCase();
  return value === 'off' || value === 'on' || value === 'shadow' ? value : 'shadow';
}

export function jevMinConfidence(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.JEV_MIN_CONFIDENCE);
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : DEFAULT_JEV_MIN_CONFIDENCE;
}

export function jevModelName(env: NodeJS.ProcessEnv = process.env): string {
  return env.JEV_MODEL?.trim() || DEFAULT_JEV_MODEL;
}

function jevTimeoutMs(env: NodeJS.ProcessEnv): number {
  const value = Number(env.JEV_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_JEV_TIMEOUT_MS;
}

export interface JevChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

export interface JevBooleanQuestion {
  type: 'boolean';
  instructions: string;
}

export type JevQuestion = JevChoiceQuestion | JevBooleanQuestion;

export interface JevChoiceAnswer {
  choice: string;
  probabilities: Record<string, number>;
  /** Jev's own confidence for the question when the gateway returns it, else the winning probability. */
  confidence: number;
}

export interface JevAnswers {
  choices: Record<string, JevChoiceAnswer>;
  booleans: Record<string, number>;
}

interface RawAnswer {
  type?: string;
  choice?: string;
  probability?: number;
  probabilities?: Record<string, number>;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Winning probability: used as confidence when the response carries none. */
function topProbability(probabilities: Record<string, number>, choice: string): number {
  return finiteNumber(probabilities[choice]) ?? Math.max(0, ...Object.values(probabilities).filter((value) => Number.isFinite(value)));
}

const BREAKER_FAILURES = 3;
const BREAKER_OPEN_MS = 5 * 60 * 1000;
let consecutiveFailures = 0;
let breakerOpenUntil = 0;

/** Test hook: forget earlier failures so one test's outage does not skip Jev in the next. */
export function resetJevBreaker(): void {
  consecutiveFailures = 0;
  breakerOpenUntil = 0;
}

function recordJevFailure(): void {
  consecutiveFailures += 1;
  if (consecutiveFailures >= BREAKER_FAILURES) breakerOpenUntil = Date.now() + BREAKER_OPEN_MS;
}

/**
 * Asks every question against one shared state in a single request. Returns `undefined` on any failure (timeout,
 * gateway error, an answer of an unexpected shape), so a caller never has to handle Jev being down. After
 * three failures in a row it skips Jev for five minutes, so an outage costs a scoring batch seconds, not its timeout.
 */
export async function jevDecide(
  state: Record<string, unknown>,
  questions: Record<string, JevQuestion>,
  env: NodeJS.ProcessEnv = process.env
): Promise<JevAnswers | undefined> {
  if (!Object.keys(questions).length) return { choices: {}, booleans: {} };
  if (Date.now() < breakerOpenUntil) return undefined;
  const model = jevModelName(env);
  try {
    const result = await decide({
      model,
      state: state as DecisionState,
      questions,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(jevTimeoutMs(env)),
      providerOptions: { gateway: { only: [JEV_PROVIDER], zeroDataRetention: true } },
    });
    const answers = result.answers as unknown as Record<string, RawAnswer>;
    const providerConfidence = (result.providerMetadata as { typesafe?: { confidence?: Record<string, unknown> } } | undefined)
      ?.typesafe?.confidence;
    const out: JevAnswers = { choices: {}, booleans: {} };
    for (const [id, question] of Object.entries(questions)) {
      const answer = answers[id];
      if (question.type === 'boolean') {
        const probability = finiteNumber(answer?.probability);
        if (answer?.type !== 'boolean' || probability === undefined) throw new Error(`Jev answered ${id} with an unexpected shape`);
        out.booleans[id] = probability;
      } else {
        const probabilities = answer?.probabilities;
        const choice = answer?.choice;
        if (answer?.type !== 'choice' || typeof choice !== 'string' || !probabilities || !(choice in question.criteria)) {
          throw new Error(`Jev answered ${id} with an unexpected shape`);
        }
        out.choices[id] = {
          choice,
          probabilities,
          confidence: finiteNumber(providerConfidence?.[id]) ?? topProbability(probabilities, choice),
        };
      }
    }
    consecutiveFailures = 0;
    return out;
  } catch (error) {
    recordJevFailure();
    debug('Jev decision failed; falling back to the rule', { model, error: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}
