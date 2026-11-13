import { htmlToText } from './html_text.js';
import { jevDecide, jevMinConfidence, type JevBooleanQuestion, type JevChoiceQuestion } from './jev.js';
import {
  FACT_CANCEL_BASES,
  categoryOf,
  scoreChanges,
  type CancelAttribution,
  type CancelAttributionResult,
  type CancelEvidence,
  type ScoredChange,
  type SupplierThreadMessage,
  supplierMessagesAfter,
} from './invoice_score.js';
import { diffScoredFieldsWithJev, type ScoredFieldName, type ScoredFields } from './invoice_snapshots.js';

const MAX_SUPPLIER_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 1500;
const CHANGES_PER_REQUEST = 40;
const MAX_VALUE_CHARS = 300;

export interface JevCancelDecision {
  result: CancelAttributionResult;
  /** Jev's confidence in its choice; absent when the cancel rested on a fact and Jev was not asked. */
  confidence?: number;
}

/**
 * Cancels the rules settled from a Workday fact or AP's label keep that result. For the rest (wrong document, extra
 * PDF, supplier message, early cancel, no signal) Jev picks `agent`, `business`, or `unattributed` from the evidence;
 * below the confidence threshold the cancel stays `unattributed` so AP's labeling flow is unchanged.
 */
export async function jevAttributeCancel(
  evidence: CancelEvidence,
  rule: CancelAttributionResult,
  env: NodeJS.ProcessEnv = process.env
): Promise<JevCancelDecision | undefined> {
  if (FACT_CANCEL_BASES.has(rule.basis)) return { result: rule };
  const facts: Partial<CancelEvidence> = { ...evidence };
  delete facts.replacement;
  delete facts.duplicate;
  delete facts.apLabel;
  const question: JevChoiceQuestion = {
    type: 'choice',
    instructions: 'A supplier invoice the finance automation created in Workday was canceled. Who is responsible for the cancel?',
    criteria: {
      agent: 'The automation caused it: it created an invoice from a supporting or unrelated document, made an extra invoice from one invoice\'s pages, or coded the invoice wrong.',
      business: 'A reason outside the automation: the supplier voided, withdrew, or credited the invoice, the order was canceled, or the payment method changed.',
      unattributed: 'The evidence does not show which.',
    },
  };
  const answers = await jevDecide({ evidence: facts }, { cancel: question }, env);
  const answer = answers?.choices.cancel;
  if (!answer) return undefined;
  const choice = answer.choice as CancelAttribution;
  if (choice !== 'unattributed' && answer.confidence >= jevMinConfidence(env)) {
    return { result: { attribution: choice, basis: 'jev' }, confidence: answer.confidence };
  }
  return {
    result: rule.attribution === 'unattributed' ? rule : { attribution: 'unattributed', basis: 'no_signal' },
    confidence: answer.confidence,
  };
}

function messageText(message: SupplierThreadMessage): string {
  return htmlToText(message.body ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE_CHARS);
}

/**
 * Asks Jev whether any supplier message after the agent's write says the invoice was voided, credited, canceled, or
 * withdrawn. Same message filter as the pattern it replaces; the newest messages are asked about, at most
 * `MAX_SUPPLIER_MESSAGES`.
 */
export async function jevSupplierVoidOrCredit(
  messages: SupplierThreadMessage[],
  afterUnixSeconds: number | undefined,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ voided: boolean; probability: number } | undefined> {
  const eligible = supplierMessagesAfter(messages, afterUnixSeconds)
    .map((message) => ({ message, text: messageText(message) }))
    .filter(({ text }) => text.length > 0)
    .slice(-MAX_SUPPLIER_MESSAGES);
  if (!eligible.length) return { voided: false, probability: 0 };
  const questions: Record<string, JevBooleanQuestion> = {};
  const state: Record<string, string> = {};
  eligible.forEach(({ text }, index) => {
    state[`message${index}`] = text;
    questions[`message${index}`] = {
      type: 'boolean',
      instructions: `In message${index}, the supplier says the invoice is voided, credited, canceled, withdrawn, or should be disregarded.`,
    };
  });
  const answers = await jevDecide({ supplierMessages: state }, questions, env);
  if (!answers) return undefined;
  const probability = Math.max(0, ...Object.values(answers.booleans));
  return { voided: probability >= jevMinConfidence(env), probability };
}

function clip(value: unknown): unknown {
  if (typeof value === 'string') return value.slice(0, MAX_VALUE_CHARS);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, inner]) => [key, clip(inner)]));
  }
  return value;
}

/**
 * Decides, for every change on a field the agent owned, whether AP corrected an agent error (`material`) or applied a
 * house convention or preference (`convention`). A change at or above the confidence threshold is material. Changes the
 * agent did not own keep their static category. Returns `undefined` when Jev could not answer every request, so the
 * static categories stand for the whole invoice.
 */
export async function jevClassifyChanges(
  changes: ScoredChange[],
  context: { supplier?: string },
  env: NodeJS.ProcessEnv = process.env
): Promise<ScoredChange[] | undefined> {
  const indexed = changes.map((change, index) => ({ change, index })).filter(({ change }) => change.agentOwned !== false);
  if (!indexed.length) return changes;
  const minConfidence = jevMinConfidence(env);
  const probabilities = new Map<number, number>();
  for (let start = 0; start < indexed.length; start += CHANGES_PER_REQUEST) {
    const chunk = indexed.slice(start, start + CHANGES_PER_REQUEST);
    const state: Record<string, unknown> = {
      supplier: context.supplier ?? null,
      changes: chunk.map(({ change, index }) => ({
        id: `change${index}`,
        field: change.field,
        line: change.line ?? null,
        before: clip(change.before) ?? null,
        after: clip(change.after) ?? null,
      })),
    };
    const questions: Record<string, JevBooleanQuestion> = {};
    for (const { index } of chunk) {
      questions[`change${index}`] = {
        type: 'boolean',
        instructions: `AP changed the invoice as described by change${index}. The change corrects a mistake the automation made in extracting or coding the invoice, as opposed to AP's formatting, wording, or house-convention preference.`,
      };
    }
    const answers = await jevDecide(state, questions, env);
    if (!answers) return undefined;
    for (const { index } of chunk) {
      const probability = answers.booleans[`change${index}`];
      if (probability === undefined) return undefined;
      probabilities.set(index, probability);
    }
  }
  return changes.map((change, index) => {
    const probability = probabilities.get(index);
    if (probability === undefined) return change;
    return {
      ...change,
      category: probability >= minConfidence ? 'material' : 'convention',
      jev: { probability, staticCategory: categoryOf(change.field) },
    };
  });
}

/**
 * The invoice's changes as Jev sees them: lines paired by Jev, then each change classified by Jev. Lines Jev cannot
 * place fall back to the rule pairing. `undefined` when Jev could not classify the changes, so a stored verdict never
 * claims Jev ran when it did not.
 */
export async function jevScoredChanges(
  before: ScoredFields,
  after: ScoredFields,
  options: { agentChangedFields?: Iterable<ScoredFieldName>; supplier?: string },
  env: NodeJS.ProcessEnv = process.env
): Promise<ScoredChange[] | undefined> {
  const diff = await diffScoredFieldsWithJev(before, after, env);
  const changes = scoreChanges(diff, options.agentChangedFields);
  return jevClassifyChanges(changes, { supplier: options.supplier ?? after.supplier ?? before.supplier }, env);
}
