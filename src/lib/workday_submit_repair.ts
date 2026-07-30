import { debug } from '@pga/logger';
import { openai } from '@ai-sdk/openai';
import { ToolLoopAgent, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import type { ParsedValidationRule } from './workday.js';
import { temperatureOption } from './model_generation_options.js';

const inspectPreviousAttemptSchema = z.object({});

const lookupValidationRulesSchema = z.object({
  searchText: z.string().optional().describe('Optional text used to narrow validation rules to relevant descriptions or comments.'),
  maxResults: z.number().int().min(1).max(20).optional().describe('Maximum number of matching rules to return. Defaults to 10.'),
});

const workdaySubmitRepairPlanSchema = z.object({
  decision: z.enum(['retry', 'give_up']).describe('Choose retry only when a safe, concrete payload change is likely to address the validation fault.'),
  reason: z.string().min(1).describe('Why this repair should or should not be retried.'),
  invoiceDate: z.string().min(1).optional().describe('Replacement invoice date in YYYY-MM-DD format when the validation issue points to the invoice date.'),
  memo: z.string().min(1).optional().describe('Replacement memo text when the validation issue points to the memo.'),
  notesAppend: z.string().min(1).optional().describe('Plain text note to append to the existing Workday notes for the retry attempt.'),
  supplierMode: z.enum(['preserve', 'use_default_supplier']).default('preserve').describe('Whether to preserve the current supplier choice or switch to the configured default supplier.'),
});

export type WorkdaySubmitRepairPlan = z.infer<typeof workdaySubmitRepairPlanSchema>;

export interface WorkdaySubmitRepairAttempt {
  attemptNumber: number;
  request: unknown;
  validationError: string;
}

export interface WorkdaySubmitRepairInput {
  operationName: string;
  currentInvoiceSummary: unknown;
  latestAttempt: WorkdaySubmitRepairAttempt;
  previousAttempts: WorkdaySubmitRepairAttempt[];
  hasDefaultSupplier: boolean;
  getValidationRules: () => Promise<ParsedValidationRule[]>;
}

function getRepairModel(): string {
  return process.env.WORKDAY_SUBMIT_REPAIR_MODEL || 'gpt-5.4-mini';
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function filterValidationRules(
  rules: ParsedValidationRule[],
  searchText?: string,
  maxResults: number = 10
): ParsedValidationRule[] {
  if (!searchText) {
    return rules.slice(0, maxResults);
  }

  const tokens = normalizeText(searchText)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  if (tokens.length === 0) {
    return rules.slice(0, maxResults);
  }

  return rules
    .filter(rule => {
      const haystack = normalizeText(`${rule.description} ${rule.comment ?? ''}`);
      return tokens.some(token => haystack.includes(token));
    })
    .slice(0, maxResults);
}

function buildAttemptContext(input: WorkdaySubmitRepairInput) {
  return {
    operationName: input.operationName,
    currentInvoiceSummary: input.currentInvoiceSummary,
    latestAttempt: input.latestAttempt,
    previousAttempts: input.previousAttempts,
    allowedRepairs: {
      invoiceDate: true,
      memo: true,
      notesAppend: true,
      supplierMode: input.hasDefaultSupplier ? ['preserve', 'use_default_supplier'] : ['preserve'],
    },
  };
}

export async function proposeWorkdaySubmitRepair(
  input: WorkdaySubmitRepairInput
): Promise<WorkdaySubmitRepairPlan> {
  let cachedRules: ParsedValidationRule[] | undefined;
  const model = getRepairModel();

  const agent = new ToolLoopAgent({
    model: openai(model),
    instructions: `You repair Workday Supplier Invoice submit validation faults.

Always inspect the latest failed attempt before deciding what to do.
Use lookupValidationRules only when the validation fault suggests a custom rule may explain the failure.
Never invent new supplier IDs, company IDs, invoice numbers, control amounts, currencies, worktags, or invoice line data.
Only use the allowed repair fields returned by inspectPreviousAttempt.
If no safe change is likely to help, choose give_up.
If you choose retry, make the smallest payload change that could plausibly address the validation fault.
When finished, call done exactly once with your final repair plan.`,
    tools: {
      inspectPreviousAttempt: tool({
        description: 'Returns the latest failed submit request, prior validation failures, and the allowed repair surface.',
        inputSchema: inspectPreviousAttemptSchema,
        execute: () => buildAttemptContext(input),
      }),
      lookupValidationRules: tool({
        description: 'Returns cached Supplier Invoice validation rules from Workday to help explain a validation fault.',
        inputSchema: lookupValidationRulesSchema,
        execute: async ({ searchText, maxResults }) => {
          try {
            cachedRules ??= await input.getValidationRules();
            const matchingRules = filterValidationRules(cachedRules, searchText, maxResults);

            return {
              success: true,
              rules: matchingRules.map(rule => ({
                ruleId: rule.ruleId,
                classification: rule.classification,
                conditionRuleId: rule.conditionRuleId,
                description: rule.description,
                comment: rule.comment,
                suppliers: rule.suppliers ?? [],
                spendCategories: rule.spendCategories ?? [],
                costCenters: rule.costCenters ?? [],
              })),
            };
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : 'Unknown validation rule lookup failure',
            };
          }
        },
      }),
      done: tool({
        description: 'Return the final repair decision for the next submit attempt.',
        inputSchema: workdaySubmitRepairPlanSchema,
      }),
    },
    toolChoice: 'required',
    stopWhen: stepCountIs(4),
    ...temperatureOption(model, 0),
    prepareStep: ({ stepNumber }) => {
      if (stepNumber === 0) {
        return {
          activeTools: ['inspectPreviousAttempt'],
          toolChoice: { type: 'tool', toolName: 'inspectPreviousAttempt' },
        };
      }

      return {
        activeTools: ['lookupValidationRules', 'done'],
      };
    },
  });

  const result = await agent.generate({
    prompt: `A Workday Supplier Invoice submit failed during "${input.operationName}".

Validation fault:
${input.latestAttempt.validationError}

Inspect the previous attempt, decide whether a safe retry is possible, and then call done.`,
  });

  const doneCall = (result as { staticToolCalls?: Array<{ toolName: string; input: unknown }> }).staticToolCalls
    ?.find(call => call.toolName === 'done');

  if (!doneCall) {
    throw new Error('Workday submit repair agent did not return a done tool call');
  }

  const repairPlan = workdaySubmitRepairPlanSchema.parse(doneCall.input);
  debug('Workday submit repair plan generated', repairPlan);
  return repairPlan;
}
