import { debug } from '@pga/logger';

export interface OpenAICallOptions {
  prompt: string;
  schema: Record<string, unknown>;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  model?: string;
}

export async function callOpenAIWithSchema({
  prompt,
  schema,
  messages,
  model = 'gpt-4.1-2025-04-14'
}: OpenAICallOptions): Promise<unknown> {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'MISSING_KEY';

  debug('Prompt length:', prompt.length);
  debug('Schema length:', JSON.stringify(schema).length);
  debug('Messages length:', JSON.stringify(messages).length);

  // Ensure system prompt is first
  const finalMessages = [...messages];
  if (!finalMessages.find(m => m.role === 'system')) {
    finalMessages.unshift({ role: 'system', content: prompt });
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: finalMessages,
      max_tokens: 1024,
      temperature: 0.2,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'response',
          schema,
          strict: true
        }
      }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${errText}`);
  }

  const data = await response.json() as { choices: Array<{ message: { content: string } }> };
  let result: unknown;
  try {
    result = JSON.parse(data.choices[0].message.content);
  } catch (e) {
    throw new Error('Failed to parse OpenAI response as JSON');
  }
  
  return result;
}
