import { getAiResponse } from '../lib/ai.js';

// Mock the AI SDK
jest.mock('ai', () => ({
  generateText: jest.fn(),
  tool: jest.fn()
}));

jest.mock('@ai-sdk/openai', () => ({
  openai: jest.fn()
}));

describe('AI utilities', () => {
  const mockGenerateText = require('ai').generateText;
  const mockOpenai = require('@ai-sdk/openai').openai;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENAI_API_KEY = 'test-key';
    
    // Setup default mocks
    mockGenerateText.mockResolvedValue({
      text: '{"supplierId": "test-id", "supplierName": "Test Supplier", "confidence": 0.9, "reasoning": "Test reasoning"}'
    });
    
    mockOpenai.mockReturnValue('mocked-openai-model');
  });

  describe('getAiResponse', () => {
    it('should make API call with correct parameters', async () => {
      const result = await getAiResponse({
        prompt: 'Test prompt',
        schema: undefined,
        messages: [{ role: 'user', content: 'Test message' }]
      });

      expect(mockGenerateText).toHaveBeenCalledWith({
        model: 'mocked-openai-model',
        messages: [{ role: 'user', content: 'Test message' }],
        system: 'Test prompt',
        temperature: 0.2,
        tools: {
          queryDocuments: undefined
        }
      });

      expect(result).toEqual({
        supplierId: 'test-id',
        supplierName: 'Test Supplier',
        confidence: 0.9,
        reasoning: 'Test reasoning'
      });
    });

    it('should add system prompt if not present', async () => {
      await getAiResponse({
        prompt: 'System prompt',
        schema: undefined,
        messages: [{ role: 'user', content: 'User message' }]
      });

      expect(mockGenerateText).toHaveBeenCalledWith({
        model: 'mocked-openai-model',
        messages: [{ role: 'user', content: 'User message' }],
        system: 'System prompt',
        temperature: 0.2,
        tools: {
          queryDocuments: undefined
        }
      });
    });

    it('should handle API errors', async () => {
      mockGenerateText.mockRejectedValue(new Error('OpenAI API error: 401 Unauthorized'));

      await expect(getAiResponse({
        prompt: 'Test prompt',
        schema: undefined,
        messages: [{ role: 'user', content: 'Test message' }]
      })).rejects.toThrow('OpenAI API error:');
    });
  });
});
