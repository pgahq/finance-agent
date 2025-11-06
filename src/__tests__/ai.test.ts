import { getAiResponse } from '../lib/ai.js';

// Mock the AI SDK
jest.mock('ai', () => ({
  generateText: jest.fn(),
  generateObject: jest.fn(),
  tool: jest.fn(),
  stepCountIs: jest.fn(),
  NoObjectGeneratedError: {
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
  const mockGenerateObject = require('ai').generateObject;
  const mockNoObjectGeneratedError = require('ai').NoObjectGeneratedError;
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
        _def: {
          shape: jest.fn().mockReturnValue({
            supplierId: { type: 'string' },
            supplierName: { type: 'string' },
            confidence: { type: 'number' },
            reasoning: { type: 'string' }
          })
        }
      } as any;

      // Mock Step 1: generateText result
      mockGenerateText.mockResolvedValue({
        text: 'JSON response with supplier data',
        toolResults: []
      });

      // Mock Step 2: generateObject result
      mockGenerateObject.mockResolvedValue({
        object: {
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

      // Verify Step 1: generateText was called with enhanced system prompt
      expect(mockGenerateText).toHaveBeenCalledWith({
        model: 'mocked-openai-model',
        messages: [{ role: 'user', content: 'Test message' }],
        system: expect.stringContaining('Test prompt'),
        stopWhen: 'mocked-step-count-is',
        temperature: 0.2,
        tools: {
          findSuppliers: expect.any(Object)
        }
      });

      // Verify Step 2: generateObject was called
      expect(mockGenerateObject).toHaveBeenCalledWith({
        model: 'mocked-openai-model',
        prompt: 'Convert this text into structured JSON:\n\nJSON response with supplier data',
        schema: mockSchema,
        temperature: 0.1
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
