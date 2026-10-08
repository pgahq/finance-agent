import { createLanguageModel, defaultModel, toGatewayModelId } from '../lib/models.js';

describe('models', () => {
  it('routes the default model through the gateway as openai/gpt-5.4', () => {
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
});
