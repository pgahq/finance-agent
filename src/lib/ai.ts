import { debug } from '@pga/logger';
import { generateText, Output, stepCountIs, NoObjectGeneratedError, NoOutputGeneratedError, type LanguageModel, type ModelMessage } from 'ai';
import { z } from 'zod';
import { findSuppliersTool, findCompaniesTool, findCostCentersTool, findPaymentTermsTool, findEventsTool, findLobsTool, findFundsTool, findSpendCategoriesTool } from './rag.js';
import { resolveReferenceCodeTool } from './reference_ids.js';
import { defaultModel } from './models.js';
import { AI_MAX_RETRIES, AI_STAGE_TIMEOUT_MS, type AiStage } from './ai_budgets.js';
import { ProcessorDeadlineError, deadlineErrorFromSignal } from './deadline.js';

function logStageFinished(stage: AiStage | undefined, startedAt: number): void {
  if (stage) debug('AI stage finished', { stage, durationMs: Date.now() - startedAt });
}

// Main AI function with RAG tool integration
export async function getAiResponse({
  prompt,
  messages,
  schema,
  model = defaultModel,
  tools,
  abortSignal,
  temperature = 0.2,
  stage,
  timeoutMs,
  maxRetries = AI_MAX_RETRIES,
}: {
  prompt: string;
  messages: ModelMessage[];
  schema?: z.ZodSchema<any>;
  model?: LanguageModel;
  tools?: Record<string, any>;
  abortSignal?: AbortSignal;
  // null omits temperature for models that reject sampling parameters.
  temperature?: number | null;
  /** Names the step in logs and Slack; also picks the default cap from AI_STAGE_TIMEOUT_MS. */
  stage?: AiStage;
  /** Cap on the whole call, retries and the structured second pass included. */
  timeoutMs?: number;
  maxRetries?: number;
}): Promise<unknown> {
  const stageTimeoutMs = timeoutMs ?? (stage ? AI_STAGE_TIMEOUT_MS[stage] : undefined);
  const stageSignal = stageTimeoutMs ? AbortSignal.timeout(stageTimeoutMs) : undefined;
  const callSignal = stageSignal
    ? (abortSignal ? AbortSignal.any([abortSignal, stageSignal]) : stageSignal)
    : abortSignal;
  const startedAt = Date.now();
  try {
    const defaultTools = {
      findSuppliers: findSuppliersTool,
      findCompanies: findCompaniesTool,
      findCostCenters: findCostCentersTool,
      findPaymentTerms: findPaymentTermsTool,
      findEvents: findEventsTool,
      findLobs: findLobsTool,
      findFunds: findFundsTool,
      findSpendCategories: findSpendCategoriesTool,
      resolveReferenceCode: resolveReferenceCodeTool,
    };
    const toolsToUse = tools === undefined ? defaultTools : tools;
    const hasTools = Object.keys(toolsToUse).length > 0;
    const generateTextOptions: any = {
      model,
      messages,
      system: prompt,
      stopWhen: stepCountIs(10),
      ...(temperature === null ? {} : { temperature }),
      maxRetries,
      abortSignal: callSignal,
      ...(hasTools
        ? { tools: toolsToUse }
        : schema
          ? { output: Output.object({ schema }) }
          : {})
    };

    const textResult = await generateText(generateTextOptions);

    // If no schema is provided, return the text result
    if (!schema) {
      logStageFinished(stage, startedAt);
      return textResult.text;
    }

    // When tools are provided, the first pass runs the tool loop and returns analysis text.
    // Run a second pass to coerce the analysis into the requested schema.
    if (hasTools) {
      const structuredResult = await generateText({
        model,
        messages: [
          ...messages,
          ...textResult.response.messages,
          { role: 'user', content: 'Now return your analysis as structured JSON matching the required schema.' }
        ],
        system: prompt,
        output: Output.object({ schema }),
        temperature: 0.1,
        maxRetries,
        abortSignal: callSignal,
      });
      logStageFinished(stage, startedAt);
      return structuredResult.output;
    }

    logStageFinished(stage, startedAt);
    return textResult.output;

  } catch (error) {
    debug(`AI call error: ${error}`, { stage, durationMs: Date.now() - startedAt });
    if (abortSignal?.aborted) {
      throw deadlineErrorFromSignal(abortSignal, stage);
    }
    if (stageSignal?.aborted && stageTimeoutMs) {
      debug(`AI stage cap fired: ${stage ?? 'unnamed'} exceeded ${stageTimeoutMs}ms (retries included)`, {
        stage,
        timeoutMs: stageTimeoutMs,
        durationMs: Date.now() - startedAt,
      });
      throw new ProcessorDeadlineError(
        'stage_timeout',
        `AI stage ${stage ?? 'unnamed'} exceeded its ${stageTimeoutMs}ms cap`,
        { stage, timeoutMs: stageTimeoutMs, cause: error }
      );
    }
    if (NoObjectGeneratedError.isInstance(error)) {
      debug(`NoObjectGeneratedError: ${error}`);
      debug('Cause:', error.cause);
      debug('Text:', error.text);
      debug('Response:', error.response);
      debug('Usage:', error.usage);
      debug('Finish Reason:', error.finishReason);
    }
    if (NoOutputGeneratedError.isInstance(error)) {
      debug(`NoOutputGeneratedError: ${error}`);
      debug('Cause:', error.cause);
    }
    throw error;
  }
}