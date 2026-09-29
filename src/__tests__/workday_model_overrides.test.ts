import type { LanguageModel } from 'ai';
import { proposeWorkdaySubmitRepair } from '../lib/workday_submit_repair.js';
import { classifyWorkdayValidationField } from '../lib/workday_validation_field_agent.js';

jest.mock('ai', () => ({
  ...jest.requireActual<Record<string, unknown>>('ai'),
  ToolLoopAgent: jest.fn(),
}));

jest.mock('@ai-sdk/openai', () => ({
  openai: jest.fn((modelId: string) => ({ specificationVersion: 'v3', provider: 'openai.responses', modelId }))
}));

describe('Workday agent models', () => {
  const mockToolLoopAgent = jest.requireMock<{ ToolLoopAgent: jest.Mock }>('ai').ToolLoopAgent;
  const originalEnv = { ...process.env };
  const customModel = { specificationVersion: 'v3', provider: 'custom', modelId: 'custom-model' } as unknown as LanguageModel;

  const repairInput = {
    operationName: 'Submit_Supplier_Invoice',
    currentInvoiceSummary: {},
    latestAttempt: { attemptNumber: 1, request: {}, validationError: 'Invalid invoice date' },
    previousAttempts: [],
    hasDefaultSupplier: false,
    getValidationRules: jest.fn().mockResolvedValue([]),
  };

  const validationInput = {
    validation: { message: 'Invalid Fund', detailMessage: undefined, xpath: undefined },
    allowedRetryFields: ['worktag:fund' as const],
  };

  function mockDoneCall(input: unknown) {
    mockToolLoopAgent.mockImplementation(() => ({
      generate: jest.fn().mockResolvedValue({ staticToolCalls: [{ toolName: 'done', input }] }),
    }));
  }

  function agentModel(): unknown {
    const [options] = mockToolLoopAgent.mock.calls[0] as [{ model: unknown }];
    return options.model;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.WORKDAY_SUBMIT_REPAIR_MODEL;
    delete process.env.WORKDAY_VALIDATION_FIELD_MODEL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('proposeWorkdaySubmitRepair', () => {
    beforeEach(() => mockDoneCall({ decision: 'give_up', reason: 'No safe change' }));

    it('passes a supplied model to the agent', async () => {
      await proposeWorkdaySubmitRepair(repairInput, { model: customModel });
      expect(agentModel()).toBe(customModel);
    });

    it('defaults to gpt-5.4-mini', async () => {
      await proposeWorkdaySubmitRepair(repairInput);
      expect(agentModel()).toEqual(expect.objectContaining({ modelId: 'gpt-5.4-mini' }));
    });

    it('uses WORKDAY_SUBMIT_REPAIR_MODEL when set', async () => {
      process.env.WORKDAY_SUBMIT_REPAIR_MODEL = 'gpt-5.4';
      await proposeWorkdaySubmitRepair(repairInput);
      expect(agentModel()).toEqual(expect.objectContaining({ modelId: 'gpt-5.4' }));
    });
  });

  describe('classifyWorkdayValidationField', () => {
    beforeEach(() => mockDoneCall({ retryField: 'worktag:fund', reason: 'Fund is invalid' }));

    it('passes a supplied model to the agent', async () => {
      await classifyWorkdayValidationField(validationInput, { model: customModel });
      expect(agentModel()).toBe(customModel);
    });

    it('prefers WORKDAY_VALIDATION_FIELD_MODEL over WORKDAY_SUBMIT_REPAIR_MODEL', async () => {
      process.env.WORKDAY_SUBMIT_REPAIR_MODEL = 'repair-model';
      process.env.WORKDAY_VALIDATION_FIELD_MODEL = 'validation-model';
      await classifyWorkdayValidationField(validationInput);
      expect(agentModel()).toEqual(expect.objectContaining({ modelId: 'validation-model' }));
    });

    it('falls back to WORKDAY_SUBMIT_REPAIR_MODEL, then gpt-5.4-mini', async () => {
      process.env.WORKDAY_SUBMIT_REPAIR_MODEL = 'repair-model';
      await classifyWorkdayValidationField(validationInput);
      expect(agentModel()).toEqual(expect.objectContaining({ modelId: 'repair-model' }));

      mockToolLoopAgent.mockClear();
      delete process.env.WORKDAY_SUBMIT_REPAIR_MODEL;
      await classifyWorkdayValidationField(validationInput);
      expect(agentModel()).toEqual(expect.objectContaining({ modelId: 'gpt-5.4-mini' }));
    });
  });
});
