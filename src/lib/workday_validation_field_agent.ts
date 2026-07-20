import { debug } from '@pga/logger';
import { openai } from '@ai-sdk/openai';
import { ToolLoopAgent, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import type { WorkdayValidationDetails } from './invoice_validation_failures.js';
import { temperatureOption } from './model_generation_options.js';

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

function getValidationFieldModel(): string {
  return process.env.WORKDAY_VALIDATION_FIELD_MODEL
    || process.env.WORKDAY_SUBMIT_REPAIR_MODEL
    || 'gpt-5.4-mini';
}

export async function classifyWorkdayValidationField(
  input: WorkdayValidationFieldInput
): Promise<WorkdayValidationFieldDecision> {
  const model = getValidationFieldModel();
  const agent = new ToolLoopAgent({
    model: openai(model),
    instructions: `You classify Workday Supplier Invoice validation faults.

Use only the validation message, detail message, and XPath returned by inspectValidationError.
Map the failing Workday field to one of the configured retry fields only when the evidence is clear:
- supplier: supplier references or supplier identity fields
- invoiceDate: invoice date fields or date restrictions
- paymentTerms: payment terms fields
- worktag:fund: fund worktag errors — message or XPath references Fund or Fund_ID
- worktag:costCenter: cost center worktag errors — message or XPath references Cost Center or Cost_Center_Reference_ID
- worktag:spendCategory: spend category errors — message or XPath references Spend Category or Spend_Category_Reference
- worktag:event: event worktag errors — message or XPath references Event
- worktag:lob: line of business worktag errors — message or XPath references Line of Business or LOB

Only classify as a specific worktag type when the evidence clearly identifies that type.
Return unknown when the failing field is not one of the allowed retry fields, when the evidence is ambiguous, when you cannot identify the specific worktag type, or when changing the field would require inventing new data.
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
    ...temperatureOption(model, 0),
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
