import { debug } from '@pga/logger';
import { generateText, Output, stepCountIs, NoObjectGeneratedError, NoOutputGeneratedError, type LanguageModel, type ModelMessage } from 'ai';
import { z } from 'zod';
import { findSuppliersTool, findCompaniesTool, findCostCentersTool, findPaymentTermsTool, findEventsTool, findLobsTool, findFundsTool, findSpendCategoriesTool } from './rag.js';
import { resolveReferenceCodeTool } from './reference_ids.js';
import { defaultModel } from './models.js';
import { deadlineErrorFromSignal } from './deadline.js';

// Main AI function with RAG tool integration
export async function getAiResponse({
  prompt,
  messages,
  schema,
  model = defaultModel,
  tools,
  abortSignal,
  temperature = 0.2,
}: {
  prompt: string;
  messages: ModelMessage[];
  schema?: z.ZodSchema<any>;
  model?: LanguageModel;
  tools?: Record<string, any>;
  abortSignal?: AbortSignal;
  // null omits temperature for models that reject sampling parameters.
  temperature?: number | null;
}): Promise<unknown> {
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
    const baseOptions = {
      model,
      messages,
      system: prompt,
      stopWhen: stepCountIs(10),
      ...(temperature === null ? {} : { temperature }),
      abortSignal,
    };

    if (!hasTools) {
      if (!schema) {
        const textResult = await generateText(baseOptions);
        return textResult.text;
      }
      const objectResult = await generateText({ ...baseOptions, output: Output.object({ schema }) });
      return objectResult.output;
    }

    const toolResult = await generateText({ ...baseOptions, tools: toolsToUse });

    if (!schema) {
      return toolResult.text;
    }

    // The first pass runs the tool loop and returns analysis text.
    // Run a second pass to coerce the analysis into the requested schema.
    const structuredResult = await generateText({
      model,
      messages: [
        ...messages,
        ...toolResult.responseMessages,
        { role: 'user', content: 'Now return your analysis as structured JSON matching the required schema.' }
      ],
      system: prompt,
      output: Output.object({ schema }),
      temperature: 0.1,
      abortSignal,
    });
    return structuredResult.output;

  } catch (error) {
    debug(`AI call error: ${error}`);
    if (abortSignal?.aborted) {
      throw deadlineErrorFromSignal(abortSignal);
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