import { gateway, type LanguageModel } from 'ai';

// Bare IDs (no `provider/` prefix) are OpenAI models, so env overrides like `gpt-5.4` keep working.
export function toGatewayModelId(modelId: string): string {
  return modelId.includes('/') ? modelId : `openai/${modelId}`;
}

export function createLanguageModel(modelId: string): LanguageModel {
  return gateway(toGatewayModelId(modelId));
}

export const defaultModel: LanguageModel = createLanguageModel('openai/gpt-5.4');
