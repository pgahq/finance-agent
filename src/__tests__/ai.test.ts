import { getAiResponse } from '../lib/ai.js';

// Mock the AI SDK
jest.mock('ai', () => ({
  generateText: jest.fn(),
  tool: jest.fn(),
  stepCountIs: jest.fn(),
  NoObjectGeneratedError: {
    isInstance: jest.fn()
  },
  NoOutputGeneratedError: {
    isInstance: jest.fn()
  },
  Output: {
    object: jest.fn()
  }
}));

jest.mock('@ai-sdk/openai', () => ({
  openai: jest.fn()
}));

jest.mock('../lib/rag.js', () => ({
  findSuppliersTool: {
    description: 'Mock tool',
    inputSchema: {},
    execute: jest.fn()
  }
}));

describe('AI utilities', () => {
  const mockGenerateText = require('ai').generateText;
  const mockNoObjectGeneratedError = require('ai').NoObjectGeneratedError;
  const mockNoOutputGeneratedError = require('ai').NoOutputGeneratedError;
  const mockOpenai = require('@ai-sdk/openai').openai;
  const mockStepCountIs = require('ai').stepCountIs;
  const mockOutputObject = require('ai').Output.object;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENAI_API_KEY = 'test-key';
    
    // Setup default mocks
    mockGenerateText.mockResolvedValue({
      text: '{"supplierId": "test-id", "supplierName": "Test Supplier", "confidence": 0.9, "reasoning": "Test reasoning"}',
      toolResults: []
    });
    
    mockOpenai.mockReturnValue('mocked-openai-model');
    mockStepCountIs.mockReturnValue('mocked-step-count-is');
    mockOutputObject.mockReturnValue('mocked-output-object');
    mockNoObjectGeneratedError.isInstance.mockReturnValue(false);
    mockNoOutputGeneratedError.isInstance.mockReturnValue(false);
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
        stopWhen: 'mocked-step-count-is',
        tools: {
          findSuppliers: expect.any(Object)
        }
      });

      expect(result).toEqual('{"supplierId": "test-id", "supplierName": "Test Supplier", "confidence": 0.9, "reasoning": "Test reasoning"}');
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
        stopWhen: 'mocked-step-count-is',
        tools: {
          findSuppliers: expect.any(Object)
        }
      });
    });

    it('should return structured output when schema is provided', async () => {
      const mockSchema = {
        _def: {
          shape: jest.fn().mockReturnValue({
            supplierId: { type: 'string' },
            supplierName: { type: 'string' },
            confidence: { type: 'number' },
            reasoning: { type: 'string' }
          })
        }
      } as any;

      mockGenerateText
        .mockResolvedValueOnce({
          text: 'JSON response with supplier data',
          toolResults: [],
          response: { messages: [] }
        })
        .mockResolvedValueOnce({
          text: '',
          output: {
            supplierId: 'test-id',
            supplierName: 'Test Supplier',
            confidence: 0.9,
            reasoning: 'Test reasoning'
          }
        });

      const result = await getAiResponse({
        prompt: 'Test prompt',
        schema: mockSchema,
        messages: [{ role: 'user', content: 'Test message' }]
      });

      expect(mockGenerateText).toHaveBeenCalledWith({
        model: 'mocked-openai-model',
        messages: [{ role: 'user', content: 'Test message' }],
        system: expect.stringContaining('Test prompt'),
        stopWhen: 'mocked-step-count-is',
        tools: {
          findSuppliers: expect.any(Object)
        }
      });

      expect(mockGenerateText).toHaveBeenNthCalledWith(2, {
        model: 'mocked-openai-model',
        messages: expect.arrayContaining([
          expect.objectContaining({ role: 'user' }),
          expect.objectContaining({ role: 'user', content: 'Now return your analysis as structured JSON matching the required schema.' })
        ]),
        system: expect.any(String),
        output: 'mocked-output-object',
      });
      expect(mockOutputObject).toHaveBeenCalledWith({ schema: mockSchema });

      expect(result).toEqual({
        supplierId: 'test-id',
        supplierName: 'Test Supplier',
        confidence: 0.9,
        reasoning: 'Test reasoning'
      });
    });

    it('should use a single structured call when schema is provided without tools', async () => {
      const mockSchema = {
        _def: {
          shape: jest.fn().mockReturnValue({
            lines: { type: 'array' }
          })
        }
      } as any;

      mockGenerateText.mockResolvedValueOnce({
        text: '',
        output: { lines: [] }
      });

      const result = await getAiResponse({
        prompt: 'Merge lines',
        schema: mockSchema,
        messages: [{ role: 'user', content: 'payload' }],
        tools: {},
      });

      expect(mockGenerateText).toHaveBeenCalledTimes(1);
      expect(mockGenerateText).toHaveBeenCalledWith({
        model: 'mocked-openai-model',
        messages: [{ role: 'user', content: 'payload' }],
        system: 'Merge lines',
        output: 'mocked-output-object',
      });
      expect(result).toEqual({ lines: [] });
    });

    it('should pass temperature for models that support it', async () => {
      await getAiResponse({
        prompt: 'Test prompt',
        schema: undefined,
        messages: [{ role: 'user', content: 'Test message' }],
        model: 'gpt-4o',
      });

      expect(mockGenerateText).toHaveBeenCalledWith(expect.objectContaining({
        temperature: 0.2,
      }));
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
