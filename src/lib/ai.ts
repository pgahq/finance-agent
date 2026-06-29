import { debug } from '@pga/logger';
import { generateText, Output, stepCountIs, NoObjectGeneratedError, NoOutputGeneratedError, type ModelMessage } from 'ai';
import { z } from 'zod';
import { getConfiguredModel, resolveLanguageModel } from './language_model.js';
import { findSuppliersTool, findCompaniesTool, findCostCentersTool, findPaymentTermsTool, findEventsTool, findLobsTool, findFundsTool, findSpendCategoriesTool } from './rag.js';

// Set OpenAI API key globally
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'MISSING_KEY';

// Main AI function with RAG tool integration
export async function getAiResponse({
  prompt,
  messages,
  schema,
  model = 'gpt-5.4',
  tools,
}: {
  prompt: string;
  messages: ModelMessage[];
  schema?: z.ZodSchema<any>;
  model?: string;
  tools?: Record<string, any>;
}): Promise<unknown> {
  try {
    const resolvedModel = getConfiguredModel(model);
    const languageModel = resolveLanguageModel(resolvedModel);
    const hasTools = tools !== undefined
      ? Object.keys(tools).length > 0
      : true;

    if (schema && !hasTools) {
      const structuredResult = await generateText({
        model: languageModel,
        messages,
        system: prompt,
        output: Output.object({ schema }),
        temperature: 0.1,
      });

      return structuredResult.output;
    }

    // Step 1: Generate text with tools (if needed)
    let systemPrompt = prompt;
    
    // If schema is provided, append schema information to encourage JSON format
    if (schema) {
      try {
        const schemaShape = (schema as any)._def?.shape?.();
        if (schemaShape) {
          systemPrompt += '\n\n## Output Format\nPlease provide your response in JSON format that matches this structure:\n' + 
            JSON.stringify(schemaShape, null, 2) + 
            '\n\nFocus on providing accurate data in this JSON structure.';
        }
      } catch (error) {
        // If we can't extract schema shape, just add a general JSON instruction
        systemPrompt += '\n\n## Output Format\nPlease provide your response in JSON format.';
      }
    }
    
    const generateTextOptions: any = {
      model: languageModel,
      messages,
      system: systemPrompt,
      stopWhen: stepCountIs(10),
      temperature: 0.2,
      tools: tools ?? {
        findSuppliers: findSuppliersTool,
        findCompanies: findCompaniesTool,
        findCostCenters: findCostCentersTool,
        findPaymentTerms: findPaymentTermsTool,
        findEvents: findEventsTool,
        findLobs: findLobsTool,
        findFunds: findFundsTool,
        findSpendCategories: findSpendCategoriesTool,
      }
    };

    const textResult = await generateText(generateTextOptions);

    // If no schema is provided, return the text result
    if (!schema) {
      return textResult.text;
    }

    // Step 2: Structured output via generateText + Output.object (replaces deprecated generateObject)
    const structuredResult = await generateText({
      model: languageModel,
      messages: [
        ...messages,
        ...textResult.response.messages,
        { role: 'user', content: 'Now return your analysis as structured JSON matching the required schema.' }
      ],
      system: prompt,
      output: Output.object({ schema }),
      temperature: 0.1
    });

    return structuredResult.output;

  } catch (error) {
    debug(`AI call error: ${error}`);
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