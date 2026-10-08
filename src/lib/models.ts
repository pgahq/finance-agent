import { defaultSettingsMiddleware, gateway, wrapLanguageModel, type LanguageModel } from 'ai';

// Bare IDs (no `provider/` prefix) are OpenAI models, so env overrides like `gpt-5.4` keep working.
export function toGatewayModelId(modelId: string): string {
  return modelId.includes('/') ? modelId : `openai/${modelId}`;
}

// Invoice PDFs and supplier data must reach only the model's own vendor, never a gateway fallback host (Azure, Bedrock, Vertex).
export function gatewayProviderPin(gatewayModelId: string) {
  return { gateway: { only: [gatewayModelId.split('/')[0]] } };
}

export function createLanguageModel(modelId: string): LanguageModel {
  const gatewayModelId = toGatewayModelId(modelId);
  return wrapLanguageModel({
    model: gateway(gatewayModelId),
    middleware: defaultSettingsMiddleware({ settings: { providerOptions: gatewayProviderPin(gatewayModelId) } }),
  });
}

export const defaultModel: LanguageModel = createLanguageModel('openai/gpt-5.4');
