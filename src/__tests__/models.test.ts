import { createLanguageModel, defaultModel } from '../lib/models.js';

jest.mock('@ai-sdk/openai', () => ({
  openai: jest.fn((modelId: string) => ({ specificationVersion: 'v3', provider: 'openai.responses', modelId }))
}));

describe('models', () => {
  const mockOpenai = jest.requireMock<{ openai: jest.Mock }>('@ai-sdk/openai').openai;

  it('builds the default model from gpt-5.4', () => {
    expect(mockOpenai).toHaveBeenCalledWith('gpt-5.4');
    expect(defaultModel).toEqual(expect.objectContaining({ modelId: 'gpt-5.4' }));
  });

  it('builds a model for the requested id', () => {
    expect(createLanguageModel('gpt-5.4-mini')).toEqual(expect.objectContaining({ modelId: 'gpt-5.4-mini' }));
    expect(mockOpenai).toHaveBeenLastCalledWith('gpt-5.4-mini');
  });
});
