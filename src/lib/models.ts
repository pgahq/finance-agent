import { openai } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';

export function createLanguageModel(modelId: string): LanguageModel {
  return openai(modelId);
}

export const defaultModel: LanguageModel = createLanguageModel('gpt-5.4');
