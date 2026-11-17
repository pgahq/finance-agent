import { debug } from '@pga/logger';
import { ToolLoopAgent, stepCountIs, tool, type LanguageModel } from 'ai';
import { z } from 'zod';
import { jevDecide, parseJevMode, type JevChoiceQuestion } from './jev.js';
import { createLanguageModel } from './models.js';
import { isDuplicateSuppliersInvoiceNumberError, type WorkdayValidationDetails } from './invoice_validation_failures.js';

export type WorkdayValidationRetryField = 'supplier' | 'invoiceDate' | 'paymentTerms' | 'worktag:fund' | 'worktag:costCenter' | 'worktag:spendCategory' | 'worktag:event' | 'worktag:lob' | 'unknown';

const inspectValidationErrorSchema = z.object({});

const workdayValidationFieldDecisionSchema = z.object({
  retryField: z.enum(['supplier', 'invoiceDate', 'paymentTerms', 'worktag:fund', 'worktag:costCenter', 'worktag:spendCategory', 'worktag:event', 'worktag:lob', 'unknown'])
    .describe('The configured retry field this validation error points to, or unknown when no configured retry field is clearly implicated.'),
  workdayField: z.string().min(1).optional()
    .describe('The exact Workday field name or XPath segment that appears to have failed validation, if identifiable.'),
  reason: z.string().min(1).describe('Brief explanation grounded in the message, detail message, and XPath.'),
});

export type WorkdayValidationFieldDecision = z.infer<typeof workdayValidationFieldDecisionSchema>;

export interface WorkdayValidationFieldInput {
  validation: Omit<WorkdayValidationDetails, 'field'>;
  allowedRetryFields: WorkdayValidationRetryField[];
}

function getValidationFieldModel(): LanguageModel {
  return createLanguageModel(process.env.WORKDAY_VALIDATION_FIELD_MODEL
    || process.env.WORKDAY_SUBMIT_REPAIR_MODEL
    || 'openai/gpt-5.4-mini');
}

export const JEV_VALIDATION_FIELD_MODE_ENV = 'JEV_VALIDATION_FIELD_MODE';

// An answer below this probability goes to the language model. A wrong specific field drops the wrong fallback value
// on the retry, while a wrong `unknown` is today's no-retry outcome, so the bar is strict. Probabilities sum to one,
// so a runner-up is already at most 0.2 here and a margin bar would never reject anything.
export const JEV_VALIDATION_FIELD_MIN_PROBABILITY = 0.8;
const JEV_VALIDATION_FIELD_TIMEOUT_MS = 5_000;

const RETRY_FIELD_CRITERIA: Record<Exclude<WorkdayValidationRetryField, 'unknown'>, string> = {
  supplier: 'Supplier references or supplier identity fields. A duplicate Supplier\'s Invoice Number ("already in use", XPath Suppliers_Invoice_Number) is unknown, never supplier.',
  invoiceDate: 'Invoice date fields or date restrictions.',
  paymentTerms: 'Payment terms fields.',
  'worktag:fund': 'Fund worktag errors: the message or XPath references Fund or Fund_ID.',
  'worktag:costCenter': 'Invalid or restricted cost center values (for example "The Cost Center is/are not available for use with the company"). Not related-worktag rules that name Cost Center only as the field that requires another type.',
  'worktag:spendCategory': 'Spend category errors: the message or XPath references Spend Category or Spend_Category_Reference.',
  'worktag:event': 'Event worktag errors: the message or XPath references Event.',
  'worktag:lob': 'Line of business worktag errors, including "when Cost Center is entered then these worktag types must also have a value: Line of Business" and "does not allow worktag values: Line of Business". When several Validation_Error entries exist, a required or disallowed Line of Business rule is this field even if another message says the Cost Center is not available for the company.',
};

const UNKNOWN_CRITERIA = 'No allowed retry field is clearly implicated: the failing field is not one of the allowed fields, the evidence is ambiguous, the specific worktag type cannot be identified, fixing it would require inventing data, or the fault is a duplicate Supplier\'s Invoice Number (changing the supplier does not fix an invoice number that is already in use).';

export function buildValidationFieldQuestions(allowedRetryFields: WorkdayValidationRetryField[]): { retryField: JevChoiceQuestion } {
  const allowed = [...new Set(allowedRetryFields)].filter((field): field is Exclude<WorkdayValidationRetryField, 'unknown'> => field !== 'unknown');
  const criteria: Record<string, string> = Object.fromEntries(allowed.map((field) => [field, RETRY_FIELD_CRITERIA[field]]));
  criteria.unknown = UNKNOWN_CRITERIA;
  return {
    retryField: {
      type: 'choice',
      instructions: 'Which configured retry field does this Workday Supplier Invoice validation fault point to? Use only the validation message, detail message, and XPath. Choose a specific field only when the evidence is clear.',
      criteria,
    },
  };
}

function validationFieldState(validation: WorkdayValidationFieldInput['validation']) {
  return Object.fromEntries(
    Object.entries({ message: validation.message, detailMessage: validation.detailMessage, xpath: validation.xpath })
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0)
  );
}

function lastXpathSegment(xpath: string | undefined): string | undefined {
  const segment = xpath?.split('/').filter(Boolean).pop()?.replace(/\[[^\]]*\]/g, '').replace(/^[^:]+:/, '');
  return segment || undefined;
}

interface JevValidationFieldReading {
  choice: WorkdayValidationRetryField;
  probability: number;
  accepted: boolean;
}

// `jevDecide` never throws: a timeout, gateway error, bad model setting, or an answer outside the offered fields reads
// as no answer, and an answer with no distribution cannot be read.
async function readValidationFieldWithJev(input: WorkdayValidationFieldInput): Promise<JevValidationFieldReading | undefined> {
  const answers = await jevDecide(
    validationFieldState(input.validation),
    buildValidationFieldQuestions(input.allowedRetryFields),
    process.env,
    { timeoutMs: JEV_VALIDATION_FIELD_TIMEOUT_MS }
  );
  const answer = answers?.choices.retryField;
  const probability = answer?.probabilities[answer.choice];
  if (!answer || probability === undefined) return undefined;
  return {
    choice: answer.choice as WorkdayValidationRetryField,
    probability,
    accepted: probability >= JEV_VALIDATION_FIELD_MIN_PROBABILITY,
  };
}

function decisionFromJev(input: WorkdayValidationFieldInput, reading: JevValidationFieldReading): WorkdayValidationFieldDecision {
  const workdayField = lastXpathSegment(input.validation.xpath);
  return {
    retryField: reading.choice,
    ...(workdayField ? { workdayField } : {}),
    reason: `Jev chose ${reading.choice} (probability ${reading.probability.toFixed(2)}).`,
  };
}

export async function classifyWorkdayValidationField(
  input: WorkdayValidationFieldInput,
  options: { model?: LanguageModel } = {}
): Promise<WorkdayValidationFieldDecision> {
  if (isDuplicateSuppliersInvoiceNumberError(input.validation)) {
    return {
      retryField: 'unknown',
      workdayField: 'Suppliers_Invoice_Number',
      reason: "Supplier's Invoice Number is already in use. Changing the supplier does not fix that fault.",
    };
  }

  const mode = parseJevMode(process.env[JEV_VALIDATION_FIELD_MODE_ENV]);
  if (mode === 'off') return classifyWithLanguageModel(input, options);

  if (mode === 'shadow') {
    const [current, jev] = await Promise.allSettled([
      classifyWithLanguageModel(input, options),
      readValidationFieldWithJev(input),
    ]);
    const currentField = current.status === 'fulfilled' ? current.value.retryField : undefined;
    const jevResult = jev.status === 'fulfilled' ? jev.value : undefined;
    // Logged before the language model's failure is rethrown, so the record shows when Jev would have covered it.
    debug('Jev shadow validation field', {
      current: currentField,
      currentFailed: current.status === 'rejected',
      jev: jevResult?.choice,
      jevProbability: jevResult?.probability,
      jevAccepted: jevResult?.accepted ?? false,
      agrees: jevResult && currentField ? jevResult.choice === currentField : undefined,
    });
    if (current.status === 'rejected') throw current.reason;
    return current.value;
  }

  const jev = await readValidationFieldWithJev(input);
  if (jev?.accepted) {
    const decision = decisionFromJev(input, jev);
    debug('Workday validation field classified by Jev', decision);
    return decision;
  }
  debug('Jev did not accept the validation field; using the language model', {
    jev: jev?.choice,
    jevProbability: jev?.probability,
  });
  return classifyWithLanguageModel(input, options);
}

async function classifyWithLanguageModel(
  input: WorkdayValidationFieldInput,
  options: { model?: LanguageModel }
): Promise<WorkdayValidationFieldDecision> {
  const agent = new ToolLoopAgent({
    model: options.model ?? getValidationFieldModel(),
    instructions: `You classify Workday Supplier Invoice validation faults.

Use only the validation message, detail message, and XPath returned by inspectValidationError.
Map the failing Workday field to one of the configured retry fields only when the evidence is clear:
- supplier: supplier references or supplier identity fields. A duplicate Supplier's Invoice Number ("already in use", XPath Suppliers_Invoice_Number) is unknown — do not map it to supplier
- invoiceDate: invoice date fields or date restrictions
- paymentTerms: payment terms fields
- worktag:fund: fund worktag errors — message or XPath references Fund or Fund_ID
- worktag:costCenter: invalid or restricted cost center *values* (for example "The Cost Center is/are not available for use with the company") — not related-worktag rules that name Cost Center only as the field that requires another type
- worktag:spendCategory: spend category errors — message or XPath references Spend Category or Spend_Category_Reference
- worktag:event: event worktag errors — message or XPath references Event
- worktag:lob: line of business worktag errors, including "when Cost Center is entered then these worktag types must also have a value: Line of Business" and "does not allow worktag values: Line of Business"

When multiple Validation_Error entries exist, a required or disallowed Line of Business related-worktag rule is worktag:lob even if another message says the Cost Center is not available for the company. Do not classify that combination as worktag:costCenter.

Only classify as a specific worktag type when the evidence clearly identifies that type.
Return unknown when the failing field is not one of the allowed retry fields, when the evidence is ambiguous, when you cannot identify the specific worktag type, when changing the field would require inventing new data, or when the fault is a duplicate Supplier's Invoice Number. Changing the supplier does not fix an invoice number that is already in use.
When finished, call done exactly once.`,
    tools: {
      inspectValidationError: tool({
        description: 'Returns the parsed Workday validation message, detail message, XPath, and allowed retry fields.',
        inputSchema: inspectValidationErrorSchema,
        execute: () => input,
      }),
      done: tool({
        description: 'Return the classified validation field.',
        inputSchema: workdayValidationFieldDecisionSchema,
      }),
    },
    toolChoice: 'required',
    stopWhen: stepCountIs(3),
    temperature: 0,
    prepareStep: ({ stepNumber }) => {
      if (stepNumber === 0) {
        return {
          activeTools: ['inspectValidationError'],
          toolChoice: { type: 'tool', toolName: 'inspectValidationError' },
        };
      }

      return {
        activeTools: ['done'],
        toolChoice: { type: 'tool', toolName: 'done' },
      };
    },
  });

  const result = await agent.generate({
    prompt: `Classify the Workday validation fault into one configured retry field, or unknown.

Validation:
${JSON.stringify(input.validation, null, 2)}

Allowed retry fields: ${input.allowedRetryFields.join(', ')}`,
  });

  const doneCall = (result as { staticToolCalls?: Array<{ toolName: string; input: unknown }> }).staticToolCalls
    ?.find(call => call.toolName === 'done');

  if (!doneCall) {
    throw new Error('Workday validation field agent did not return a done tool call');
  }

  const decision = workdayValidationFieldDecisionSchema.parse(doneCall.input);
  debug('Workday validation field classified', decision);
  return decision;
}
