import { createLanguageModel, defaultModel, gatewayProviderPin, toGatewayModelId } from '../lib/models.js';

jest.mock('ai', () => {
  const actual = jest.requireActual<Record<string, unknown>>('ai');
  return {
    ...actual,
    gateway: jest.fn((modelId: string) => ({
      specificationVersion: 'v3',
      provider: 'gateway',
      modelId,
      supportedUrls: {},
      doGenerate: jest.fn().mockResolvedValue({ content: [], finishReason: 'stop', usage: {}, warnings: [] }),
      doStream: jest.fn(),
    })),
  };
});

describe('models', () => {
  const mockGateway = jest.requireMock<{ gateway: jest.Mock }>('ai').gateway;

  type CallableModel = { doGenerate: jest.Mock | ((options: { prompt: unknown[] }) => Promise<unknown>) };

  function lastGatewayModel(): CallableModel {
    return mockGateway.mock.results[mockGateway.mock.results.length - 1].value as CallableModel;
  }

  it('routes the default model through the gateway as openai/gpt-5.4', () => {
    expect(mockGateway).toHaveBeenCalledWith('openai/gpt-5.4');
    expect(defaultModel).toEqual(expect.objectContaining({ provider: 'gateway', modelId: 'openai/gpt-5.4' }));
  });

  it('builds a gateway model for the requested id', () => {
    expect(createLanguageModel('openai/gpt-5.4-mini')).toEqual(
      expect.objectContaining({ provider: 'gateway', modelId: 'openai/gpt-5.4-mini' })
    );
    expect(createLanguageModel('anthropic/claude-haiku-4.5')).toEqual(
      expect.objectContaining({ provider: 'gateway', modelId: 'anthropic/claude-haiku-4.5' })
    );
  });

  it('treats a bare model id as an OpenAI model', () => {
    expect(toGatewayModelId('gpt-5.4-mini')).toBe('openai/gpt-5.4-mini');
    expect(toGatewayModelId('openai/gpt-5.4')).toBe('openai/gpt-5.4');
    expect(createLanguageModel('gpt-5.4')).toEqual(expect.objectContaining({ modelId: 'openai/gpt-5.4' }));
  });

  it('pins each model to its own vendor on every call', async () => {
    expect(gatewayProviderPin('openai/gpt-5.4')).toEqual({ gateway: { only: ['openai'] } });
    expect(gatewayProviderPin('anthropic/claude-haiku-4.5')).toEqual({ gateway: { only: ['anthropic'] } });

    const model = createLanguageModel('gpt-5.4-mini') as unknown as CallableModel;
    const underlying = lastGatewayModel();
    await model.doGenerate({ prompt: [] });

    expect(underlying.doGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ providerOptions: { gateway: { only: ['openai'] } } })
    );
  });
});
