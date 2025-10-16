import { callOpenAIWithSchema } from '../lib/openai.js';

// Mock fetch
global.fetch = jest.fn();

describe('OpenAI utilities', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENAI_API_KEY = 'test-key';
  });

  describe('callOpenAIWithSchema', () => {
    it('should make API call with correct parameters', async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          choices: [{ message: { content: '{"result": "test"}' } }]
        })
      };
      (global.fetch as jest.Mock).mockResolvedValue(mockResponse);

      const result = await callOpenAIWithSchema({
        prompt: 'Test prompt',
        schema: { type: 'object' },
        messages: [{ role: 'user', content: 'Test message' }]
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Authorization': 'Bearer test-key',
            'Content-Type': 'application/json',
          },
          body: expect.stringContaining('"model":"gpt-4.1-2025-04-14"')
        })
      );

      expect(result).toEqual({ result: 'test' });
    });

    it('should add system prompt if not present', async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          choices: [{ message: { content: '{"result": "test"}' } }]
        })
      };
      (global.fetch as jest.Mock).mockResolvedValue(mockResponse);

      await callOpenAIWithSchema({
        prompt: 'System prompt',
        schema: { type: 'object' },
        messages: [{ role: 'user', content: 'User message' }]
      });

      const callBody = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      expect(callBody.messages[0]).toEqual({
        role: 'system',
        content: 'System prompt'
      });
    });

    it('should handle API errors', async () => {
      const mockResponse = {
        ok: false,
        text: jest.fn().mockResolvedValue('API Error')
      };
      (global.fetch as jest.Mock).mockResolvedValue(mockResponse);

      await expect(callOpenAIWithSchema({
        prompt: 'Test prompt',
        schema: { type: 'object' },
        messages: [{ role: 'user', content: 'Test message' }]
      })).rejects.toThrow('OpenAI API error:');
    });
  });
});
