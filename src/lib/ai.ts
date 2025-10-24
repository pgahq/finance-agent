import { debug } from '@pga/logger';
import { openai } from '@ai-sdk/openai';
import { generateText, stepCountIs } from 'ai';
import { z } from 'zod';
import { findSuppliersTool } from './rag.js';

// Set OpenAI API key globally
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'MISSING_KEY';

// Main AI function with RAG tool integration
export async function getAiResponse({
  prompt,
  messages,
  schema,
  model = 'gpt-4o'
}: {
  prompt: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | Array<{ type: 'text' | 'image'; text?: string; image?: string | URL }> }>;
  schema?: z.ZodSchema<any>;
  model?: string;
}): Promise<unknown> {
  try {
    const generateTextOptions: any = {
      model: openai(model),
      messages,
      system: prompt,
      stopWhen: stepCountIs(10),
      temperature: 0.2,
      tools: {
        findSuppliers: findSuppliersTool
      }
    };

    // Add structured output if schema is provided
    if (schema) {
      generateTextOptions.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'response',
          schema: schema,
          strict: true
        }
      };
    }

    const result = await generateText(generateTextOptions);
    debug(`AI Response: ${result}`);
    
    let parsedResult: unknown;
    
    try {
      parsedResult = JSON.parse(result.text);
    } catch (parseError) {
      debug(`JSON parse error: ${parseError}`);
      throw new Error('Failed to parse OpenAI response as JSON');
    }
    
    return parsedResult;
  } catch (error) {
    debug(`AI call error: ${error}`);
    throw error;
  }
}