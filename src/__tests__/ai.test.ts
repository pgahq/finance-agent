import type { LanguageModel } from 'ai';
import { getAiResponse } from '../lib/ai.js';
import { ProcessorDeadlineError } from '../lib/deadline.js';

jest.mock('@pga/logger', () => ({ debug: jest.fn() }));

// Mock the AI SDK
jest.mock('ai', () => ({
  generateText: jest.fn(),
  gateway: jest.fn((modelId: string) => ({ specificationVersion: 'v3', provider: 'gateway', modelId })),
  wrapLanguageModel: jest.fn(({ model }) => model),
  defaultSettingsMiddleware: jest.fn(),
  tool: jest.fn((definition) => definition),
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

jest.mock('../lib/rag.js', () => ({
  createEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  findSuppliersTool: {
    description: 'Mock tool',
    inputSchema: {},
    execute: jest.fn()
  },
  findCompaniesTool: { description: 'Mock tool', inputSchema: {}, execute: jest.fn() },
  findCostCentersTool: { description: 'Mock tool', inputSchema: {}, execute: jest.fn() },
  findPaymentTermsTool: { description: 'Mock tool', inputSchema: {}, execute: jest.fn() },
  findEventsTool: { description: 'Mock tool', inputSchema: {}, execute: jest.fn() },
  findLobsTool: { description: 'Mock tool', inputSchema: {}, execute: jest.fn() },
  findFundsTool: { description: 'Mock tool', inputSchema: {}, execute: jest.fn() },
  findSpendCategoriesTool: { description: 'Mock tool', inputSchema: {}, execute: jest.fn() }
}));

describe('AI utilities', () => {
  const mockGenerateText = require('ai').generateText;
  const mockNoObjectGeneratedError = require('ai').NoObjectGeneratedError;
  const mockNoOutputGeneratedError = require('ai').NoOutputGeneratedError;
  const mockStepCountIs = require('ai').stepCountIs;
  const mockOutputObject = require('ai').Output.object;

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup default mocks
    mockGenerateText.mockResolvedValue({
      text: '{"supplierId": "test-id", "supplierName": "Test Supplier", "confidence": 0.9, "reasoning": "Test reasoning"}',
      toolResults: []
    });

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
        messages: [{ role: 'user', content: 'Test message' }],
        tools: {},
      });

      expect(mockGenerateText).toHaveBeenCalledWith({
        model: expect.objectContaining({ modelId: 'openai/gpt-5.4' }),
        messages: [{ role: 'user', content: 'Test message' }],
        system: 'Test prompt',
        stopWhen: 'mocked-step-count-is',
        temperature: 0.2,
        maxRetries: 1,
        abortSignal: undefined,
      });

      expect(result).toEqual('{"supplierId": "test-id", "supplierName": "Test Supplier", "confidence": 0.9, "reasoning": "Test reasoning"}');
    });

    it('omits temperature when the caller passes null', async () => {
      mockGenerateText.mockResolvedValueOnce({ text: '', output: { ok: true } });

      await getAiResponse({
        prompt: 'Test prompt',
        schema: { _def: {} } as any,
        messages: [{ role: 'user', content: 'Test message' }],
        tools: {},
        temperature: null,
      });

      expect(mockGenerateText.mock.calls[0][0]).not.toHaveProperty('temperature');
    });

    it('should use a supplied LanguageModel for the single generation pass when no tools are needed', async () => {
      const customModel = { specificationVersion: 'v3', provider: 'custom', modelId: 'custom-model' } as unknown as LanguageModel;
      mockGenerateText.mockResolvedValueOnce({ text: '', output: { ok: true } });

      await getAiResponse({
        prompt: 'Test prompt',
        schema: { _def: {} } as any,
        messages: [{ role: 'user', content: 'Test message' }],
        model: customModel,
        tools: {},
      });

      expect(mockGenerateText).toHaveBeenCalledTimes(1);
      expect(mockGenerateText.mock.calls[0][0].model).toBe(customModel);
      expect(mockGenerateText.mock.calls[0][0].output).toBe('mocked-output-object');
    });

    it('should use a supplied LanguageModel for both generation passes when tools are provided', async () => {
      const customModel = { specificationVersion: 'v3', provider: 'custom', modelId: 'custom-model' } as unknown as LanguageModel;
      mockGenerateText
        .mockResolvedValueOnce({ text: 'analysis', toolResults: [], response: { messages: [] } })
        .mockResolvedValueOnce({ text: '', output: { ok: true } });

      await getAiResponse({
        prompt: 'Test prompt',
        schema: { _def: {} } as any,
        messages: [{ role: 'user', content: 'Test message' }],
        model: customModel,
      });

      expect(mockGenerateText).toHaveBeenCalledTimes(2);
      expect(mockGenerateText.mock.calls[0][0].model).toBe(customModel);
      expect(mockGenerateText.mock.calls[1][0].model).toBe(customModel);
    });

    it('should add system prompt if not present', async () => {
      await getAiResponse({
        prompt: 'System prompt',
        schema: undefined,
        messages: [{ role: 'user', content: 'User message' }],
        tools: {},
      });

      expect(mockGenerateText).toHaveBeenCalledWith({
        model: expect.objectContaining({ modelId: 'openai/gpt-5.4' }),
        messages: [{ role: 'user', content: 'User message' }],
        system: 'System prompt',
        stopWhen: 'mocked-step-count-is',
        temperature: 0.2,
        maxRetries: 1,
        abortSignal: undefined,
      });
    });

    it('should return structured output via a single pass when no tools are needed', async () => {
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

      mockGenerateText.mockResolvedValueOnce({
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
        messages: [{ role: 'user', content: 'Test message' }],
        tools: {},
      });

      expect(mockGenerateText).toHaveBeenCalledTimes(1);
      expect(mockGenerateText).toHaveBeenCalledWith({
        model: expect.objectContaining({ modelId: 'openai/gpt-5.4' }),
        messages: [{ role: 'user', content: 'Test message' }],
        system: 'Test prompt',
        stopWhen: 'mocked-step-count-is',
        temperature: 0.2,
        maxRetries: 1,
        abortSignal: undefined,
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

    it('should return structured output via two passes when tools are provided', async () => {
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

      // Verify Step 1: generateText was called with tools
      expect(mockGenerateText).toHaveBeenCalledWith({
        model: expect.objectContaining({ modelId: 'openai/gpt-5.4' }),
        messages: [{ role: 'user', content: 'Test message' }],
        system: 'Test prompt',
        stopWhen: 'mocked-step-count-is',
        temperature: 0.2,
        maxRetries: 1,
        abortSignal: undefined,
        tools: expect.objectContaining({
          findSuppliers: expect.any(Object),
          resolveReferenceCode: expect.any(Object),
        })
      });

      // Verify Step 2: structured output via generateText + Output.object
      expect(mockGenerateText).toHaveBeenNthCalledWith(2, {
        model: expect.objectContaining({ modelId: 'openai/gpt-5.4' }),
        messages: expect.arrayContaining([
          expect.objectContaining({ role: 'user' }),
          expect.objectContaining({ role: 'user', content: 'Now return your analysis as structured JSON matching the required schema.' })
        ]),
        system: 'Test prompt',
        output: 'mocked-output-object',
        temperature: 0.1,
        maxRetries: 1,
        abortSignal: undefined,
      });
      expect(mockOutputObject).toHaveBeenCalledWith({ schema: mockSchema });

      expect(result).toEqual({
        supplierId: 'test-id',
        supplierName: 'Test Supplier',
        confidence: 0.9,
        reasoning: 'Test reasoning'
      });
    });

    it('forwards the abort signal to the single-pass call and to both tool-path calls', async () => {
      const { signal } = new AbortController();
      mockGenerateText.mockResolvedValueOnce({ text: '', output: { ok: true } });

      await getAiResponse({
        prompt: 'Test prompt',
        schema: { _def: {} } as any,
        messages: [{ role: 'user', content: 'Test message' }],
        tools: {},
        abortSignal: signal,
      });

      expect(mockGenerateText.mock.calls[0][0].abortSignal).toBe(signal);

      mockGenerateText
        .mockResolvedValueOnce({ text: 'analysis', toolResults: [], response: { messages: [] } })
        .mockResolvedValueOnce({ text: '', output: { ok: true } });

      await getAiResponse({
        prompt: 'Test prompt',
        schema: { _def: {} } as any,
        messages: [{ role: 'user', content: 'Test message' }],
        abortSignal: signal,
      });

      expect(mockGenerateText).toHaveBeenCalledTimes(3);
      expect(mockGenerateText.mock.calls[1][0].abortSignal).toBe(signal);
      expect(mockGenerateText.mock.calls[2][0].abortSignal).toBe(signal);
    });

    it('passes a combined signal and the retry cap when a stage is named', async () => {
      const controller = new AbortController();
      mockGenerateText.mockResolvedValueOnce({ text: '', output: { ok: true } });

      await getAiResponse({
        prompt: 'Test prompt',
        schema: { _def: {} } as any,
        messages: [{ role: 'user', content: 'Test message' }],
        tools: {},
        abortSignal: controller.signal,
        stage: 'line_merge',
      });

      const call = mockGenerateText.mock.calls[0][0];
      expect(call.maxRetries).toBe(1);
      expect(call.abortSignal).not.toBe(controller.signal);
      expect(call.abortSignal.aborted).toBe(false);
      controller.abort(new Error('deadline'));
      expect(call.abortSignal.aborted).toBe(true);
    });

    it('rethrows the deadline signal reason, tagged with the stage, instead of the SDK AbortError', async () => {
      const controller = new AbortController();
      const reason = new ProcessorDeadlineError('lambda', 'Processor deadline reached; aborting AI calls');
      mockGenerateText.mockImplementationOnce(async () => {
        controller.abort(reason);
        throw Object.assign(new Error('Delay was aborted'), { name: 'AbortError' });
      });

      await expect(getAiResponse({
        prompt: 'Test prompt',
        schema: undefined,
        messages: [{ role: 'user', content: 'Test message' }],
        tools: {},
        abortSignal: controller.signal,
        stage: 'ocr',
      })).rejects.toMatchObject({ name: 'ProcessorDeadlineError', kind: 'lambda', stage: 'ocr', message: reason.message });
      expect(reason.stage).toBeUndefined();
    });

    it('wraps a stage cap that fired in a stage_timeout deadline error and logs it', async () => {
      const { debug } = require('@pga/logger');
      mockGenerateText.mockImplementationOnce(async (options: { abortSignal: AbortSignal }) => {
        await new Promise<void>((_resolve, reject) => {
          options.abortSignal.addEventListener('abort', () => reject(new Error('Delay was aborted')), { once: true });
        });
      });

      const error = await getAiResponse({
        prompt: 'Test prompt',
        schema: undefined,
        messages: [{ role: 'user', content: 'Test message' }],
        tools: {},
        stage: 'line_merge',
        timeoutMs: 20,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ProcessorDeadlineError);
      expect(error).toMatchObject({ kind: 'stage_timeout', stage: 'line_merge', timeoutMs: 20 });
      expect(debug).toHaveBeenCalledWith(expect.stringContaining('AI stage cap fired: line_merge'), expect.any(Object));
    });

    it('keeps non-timeout failures as they were', async () => {
      mockGenerateText.mockRejectedValueOnce(new Error('Gateway error: 500'));
      await expect(getAiResponse({
        prompt: 'Test prompt',
        schema: undefined,
        messages: [{ role: 'user', content: 'Test message' }],
        tools: {},
        stage: 'line_merge',
      })).rejects.toThrow('Gateway error: 500');
    });

    it('should handle API errors', async () => {
      mockGenerateText.mockRejectedValue(new Error('Gateway error: 401 Unauthorized'));

      await expect(getAiResponse({
        prompt: 'Test prompt',
        schema: undefined,
        messages: [{ role: 'user', content: 'Test message' }]
      })).rejects.toThrow('Gateway error:');
    });
  });
});
