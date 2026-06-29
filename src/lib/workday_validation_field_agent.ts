import { debug } from '@pga/logger';
import { openai } from '@ai-sdk/openai';
import { ToolLoopAgent, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { getEvalLanguageModel, resolveEvalLanguageModel } from './eval_model.js';
import type { WorkdayValidationDetails } from './invoice_validation_failures.js';

export type WorkdayValidationRetryField = 'supplier' | 'invoiceDate' | 'paymentTerms' | 'worktags';

const inspectValidationErrorSchema = z.object({});

const workdayValidationFieldDecisionSchema = z.object({
  retryField: z.enum(['supplier', 'invoiceDate', 'paymentTerms', 'worktags', 'unknown'])
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

function getValidationFieldModel(): string {
  if (process.env.RUN_EVALS === '1') {
    return getEvalLanguageModel();
  }

  return process.env.WORKDAY_VALIDATION_FIELD_MODEL
    || process.env.WORKDAY_SUBMIT_REPAIR_MODEL
    || 'gpt-5.4-mini';
}

function getValidationFieldLanguageModel() {
  if (process.env.RUN_EVALS === '1') {
    return resolveEvalLanguageModel(getValidationFieldModel());
  }

  return openai(getValidationFieldModel());
}

export async function classifyWorkdayValidationField(
  input: WorkdayValidationFieldInput
): Promise<WorkdayValidationFieldDecision> {
  const agent = new ToolLoopAgent({
    model: getValidationFieldLanguageModel(),
    instructions: `You classify Workday Supplier Invoice validation faults.

Use only the validation message, detail message, and XPath returned by inspectValidationError.
Map the failing Workday field to one of the configured retry fields only when the evidence is clear:
- supplier: supplier references or supplier identity fields
- invoiceDate: invoice date fields or date restrictions
- paymentTerms: payment terms fields
- worktags: fund, cost center, spend category, worktag, accounting worktag fields, or any error whose XPath includes Worktags_Reference — classify as worktags even when the specific missing worktag type (e.g. Line of Business) is not one of the configured fallback types, since applying fallback worktags may still resolve the conflict

Return unknown when the failing field is not one of the allowed retry fields, when the evidence is ambiguous, or when changing the field would require inventing new invoice line/contact/company data.
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
