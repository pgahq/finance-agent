import { defaultSettingsMiddleware, gateway, wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from 'ai';
import { debug } from '@pga/logger';

// Bare IDs (no `provider/` prefix) are OpenAI models, so env overrides like `gpt-5.4` keep working.
export function toGatewayModelId(modelId: string): string {
  return modelId.includes('/') ? modelId : `openai/${modelId}`;
}

// Invoice PDFs and supplier data must reach only the model's own vendor, never a gateway fallback host (Azure, Bedrock, Vertex).
export function gatewayProviderPin(gatewayModelId: string) {
  return { gateway: { only: [gatewayModelId.split('/')[0]] } };
}

const SLOW_ATTEMPT_MS = 30_000;

// The SDK retries inside one call and drops earlier failures when a deadline aborts the backoff, so each
// provider attempt is logged here with its status and Retry-After.
function attemptLoggingMiddleware(gatewayModelId: string): LanguageModelMiddleware {
  return {
    specificationVersion: 'v3',
    wrapGenerate: async ({ doGenerate }) => {
      const startedAt = Date.now();
      try {
        const result = await doGenerate();
        const durationMs = Date.now() - startedAt;
        if (durationMs >= SLOW_ATTEMPT_MS) debug('Slow AI model attempt', { model: gatewayModelId, durationMs });
        return result;
      } catch (error) {
        const failure = error as { name?: string; message?: string; statusCode?: number; isRetryable?: boolean; responseHeaders?: Record<string, string> };
        debug('AI model attempt failed', {
          model: gatewayModelId,
          durationMs: Date.now() - startedAt,
          errorName: failure?.name,
          statusCode: failure?.statusCode,
          isRetryable: failure?.isRetryable,
          retryAfter: failure?.responseHeaders?.['retry-after'] ?? failure?.responseHeaders?.['retry-after-ms'],
          message: failure?.message,
        });
        throw error;
      }
    },
  };
}

export function createLanguageModel(modelId: string): LanguageModel {
  const gatewayModelId = toGatewayModelId(modelId);
  return wrapLanguageModel({
    model: gateway(gatewayModelId),
    middleware: [
      defaultSettingsMiddleware({ settings: { providerOptions: gatewayProviderPin(gatewayModelId) } }),
      attemptLoggingMiddleware(gatewayModelId),
    ],
  });
}

export const defaultModel: LanguageModel = createLanguageModel('openai/gpt-5.4');

export const DEFAULT_OCR_MODEL_ID = 'anthropic/claude-haiku-5.5';

// Reads invoice PDFs only; supplier and company matching stays on defaultModel. OCR_MODEL overrides the model ID.
export function getOcrModel(): LanguageModel {
  return createLanguageModel(process.env.OCR_MODEL || DEFAULT_OCR_MODEL_ID);
}