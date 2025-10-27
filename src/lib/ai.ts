import { debug } from '@pga/logger';
import { openai } from '@ai-sdk/openai';
import { generateText, stepCountIs, zodSchema } from 'ai';
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

    // Add structured output using experimental_output if schema is provided
    if (schema) {
      generateTextOptions.experimental_output = zodSchema(schema);
    }

    const result = await generateText(generateTextOptions);
    debug(`AI Response:`, result);
    
    // Return the structured output directly
    if (schema && 'object' in result) {
      return (result as any).object;
    }
    
    // Fallback to text if no structured output
    return result.text;
  } catch (error) {
    debug(`AI call error: ${error}`);
    throw error;
  }
}