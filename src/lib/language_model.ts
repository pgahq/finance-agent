import { openai } from '@ai-sdk/openai';
import { gateway } from 'ai';

function toGatewayModelId(model: string): string {
  return model.includes('/') ? model : `openai/${model}`;
}

function hasUsableOpenAiKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'MISSING_KEY');
}

export function getConfiguredModel(defaultModel: string): string {
  return (process.env.LLM_MODEL || defaultModel).replace(/^openai\//, '');
}

export function resolveLanguageModel(model: string) {
  const normalizedModel = model.replace(/^openai\//, '');

  if (hasUsableOpenAiKey()) {
    return openai(normalizedModel);
  }

  if (process.env.AI_GATEWAY_API_KEY) {
    return gateway(toGatewayModelId(normalizedModel));
  }

  return openai(normalizedModel);
}

export function getEmbeddingRequestConfig(): {
  url: string;
  apiKey: string;
  model: string;
} {
  if (hasUsableOpenAiKey()) {
    return {
      url: 'https://api.openai.com/v1/embeddings',
      apiKey: process.env.OPENAI_API_KEY!,
      model: 'text-embedding-3-small',
    };
  }

  if (process.env.AI_GATEWAY_API_KEY) {
    return {
      url: 'https://ai-gateway.vercel.sh/v1/embeddings',
      apiKey: process.env.AI_GATEWAY_API_KEY,
      model: 'openai/text-embedding-3-small',
    };
  }

  return {
    url: 'https://api.openai.com/v1/embeddings',
    apiKey: 'MISSING_KEY',
    model: 'text-embedding-3-small',
  };
}
