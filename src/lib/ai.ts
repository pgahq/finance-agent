import { debug } from '@pga/logger';
import { openai } from '@ai-sdk/openai';
import { generateText, generateObject, stepCountIs } from 'ai';
import { z } from 'zod';
import { findSuppliersTool } from './rag.js';

// Set OpenAI API key globally
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'MISSING_KEY';

// Main AI function with RAG tool integration
export async function getAiResponse({
  prompt,
  messages,
  schema,
  model = 'gpt-4.1-2025-04-14'
}: {
  prompt: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | Array<{ type: 'text' | 'image'; text?: string; image?: string | URL }> }>;
  schema?: z.ZodSchema<any>;
  model?: string;
}): Promise<unknown> {
  try {
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
      model: openai(model),
      messages,
      system: systemPrompt,
      stopWhen: stepCountIs(10),
      temperature: 0.2,
      tools: {
        findSuppliers: findSuppliersTool
      }
    };

    const textResult = await generateText(generateTextOptions);

    // If no schema is provided, return the text result
    if (!schema) {
      return textResult.text;
    }

    // Step 2: Convert to structured output using a fast model
    const structuredResult = await generateObject({
      model: openai('gpt-4.1-mini-2025-04-14'),
      messages: [
        {
          role: 'system',
          content: 'Convert the provided text into structured JSON that matches the schema. Return only valid JSON data.'
        },
        {
          role: 'user',
          content: `Convert this text into structured JSON:\n\n${textResult.text}`
        }
      ],
      schema: schema,
      temperature: 0.1 // Low temperature for consistent structured output
    });

    return structuredResult.object;

  } catch (error) {
    debug(`AI call error: ${error}`);
    throw error;
  }
}