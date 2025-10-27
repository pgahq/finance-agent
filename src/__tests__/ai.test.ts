import { getAiResponse } from '../lib/ai.js';

// Mock the AI SDK
jest.mock('ai', () => ({
  generateText: jest.fn(),
  tool: jest.fn(),
  stepCountIs: jest.fn(),
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
        temperature: 0.2,
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
        temperature: 0.2,
        tools: {
          findSuppliers: expect.any(Object)
        }
      });
    });

    it('should return structured output when schema is provided', async () => {
      const mockSchema = {
        parse: jest.fn().mockReturnValue({
          supplierId: 'test-id',
          supplierName: 'Test Supplier',
          confidence: 0.9,
          reasoning: 'Test reasoning'
        })
      } as any;

      // Mock result with structured output
      mockGenerateText.mockResolvedValue({
        text: 'Some text response',
        experimental_output: {
          supplierId: 'test-id',
          supplierName: 'Test Supplier',
          confidence: 0.9,
          reasoning: 'Test reasoning'
        },
        toolResults: []
      });

      const result = await getAiResponse({
        prompt: 'Test prompt',
        schema: mockSchema,
        messages: [{ role: 'user', content: 'Test message' }]
      });

      expect(mockGenerateText).toHaveBeenCalledWith({
        model: 'mocked-openai-model',
        messages: [{ role: 'user', content: 'Test message' }],
        system: 'Test prompt',
        stopWhen: 'mocked-step-count-is',
        temperature: 0.2,
        tools: {
          findSuppliers: expect.any(Object)
        },
        experimental_output: 'mocked-output-object'
      });

      expect(result).toEqual({
        supplierId: 'test-id',
        supplierName: 'Test Supplier',
        confidence: 0.9,
        reasoning: 'Test reasoning'
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
