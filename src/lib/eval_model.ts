import { openai } from '@ai-sdk/openai';
import { gateway } from 'ai';

function toGatewayModelId(model: string): string {
  return model.includes('/') ? model : `openai/${model}`;
}

export function resolveEvalLanguageModel(model: string) {
  if (process.env.AI_GATEWAY_API_KEY) {
    return gateway(toGatewayModelId(model));
  }

  return openai(model.replace(/^openai\//, ''));
}

export function getEvalLanguageModel(): string {
  return process.env.EVAL_LLM_MODEL || 'gpt-5.4-mini';
}

export function getEmbeddingRequestConfig(): {
  url: string;
  apiKey: string;
  model: string;
} {
  if (process.env.RUN_EVALS === '1' && process.env.AI_GATEWAY_API_KEY) {
    return {
      url: 'https://ai-gateway.vercel.sh/v1/embeddings',
      apiKey: process.env.AI_GATEWAY_API_KEY,
      model: 'openai/text-embedding-3-small',
    };
  }

  return {
    url: 'https://api.openai.com/v1/embeddings',
    apiKey: process.env.OPENAI_API_KEY || process.env.EVALS_API_KEY || 'MISSING_KEY',
    model: 'text-embedding-3-small',
  };
}
