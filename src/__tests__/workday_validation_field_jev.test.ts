import {
  buildValidationFieldQuestions,
  classifyWorkdayValidationField,
  JEV_VALIDATION_FIELD_MODE_ENV,
  type WorkdayValidationFieldInput,
} from '../lib/workday_validation_field_agent.js';
import { resetJevBreaker } from '../lib/jev.js';

const mockDebug = jest.fn();
jest.mock('@pga/logger', () => ({ debug: (...args: unknown[]) => mockDebug(...args) }));

jest.mock('ai', () => ({
  ...jest.requireActual<Record<string, unknown>>('ai'),
  ToolLoopAgent: jest.fn(),
  experimental_decide: jest.fn(),
  gateway: jest.fn((modelId: string) => ({ specificationVersion: 'v3', provider: 'gateway', modelId })),
}));

const mockToolLoopAgent = jest.requireMock<{ ToolLoopAgent: jest.Mock }>('ai').ToolLoopAgent;
const mockDecide = jest.requireMock<{ experimental_decide: jest.Mock }>('ai').experimental_decide;

const input: WorkdayValidationFieldInput = {
  validation: {
    message: 'The Line of Business is required',
    detailMessage: undefined,
    xpath: '/wd:Submit_Supplier_Invoice_Request[1]/wd:Supplier_Invoice_Data[1]/wd:Invoice_Line_Replacement_Data[1]/wd:Worktags_Reference[1]',
  },
  allowedRetryFields: ['worktag:lob', 'worktag:costCenter', 'supplier'],
};

function jevAnswers(distribution: Record<string, number> | undefined, choice: string) {
  mockDecide.mockResolvedValue({
    answers: { retryField: { type: 'choice', choice, ...(distribution ? { probabilities: distribution } : {}) } },
  });
}

function languageModelAnswers(retryField: string) {
  mockToolLoopAgent.mockImplementation(() => ({
    generate: jest.fn().mockResolvedValue({
      staticToolCalls: [{ toolName: 'done', input: { retryField, reason: 'language model' } }],
    }),
  }));
}

describe('classifyWorkdayValidationField with Jev', () => {
  const originalMode = process.env[JEV_VALIDATION_FIELD_MODE_ENV];
  const originalModel = process.env.JEV_MODEL;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDecide.mockReset();
    resetJevBreaker();
    delete process.env.JEV_MODEL;
    languageModelAnswers('worktag:costCenter');
  });

  afterEach(() => {
    if (originalMode === undefined) delete process.env[JEV_VALIDATION_FIELD_MODE_ENV];
    else process.env[JEV_VALIDATION_FIELD_MODE_ENV] = originalMode;
    if (originalModel === undefined) delete process.env.JEV_MODEL;
    else process.env.JEV_MODEL = originalModel;
  });

  describe('off (the default)', () => {
    it('uses only the language model', async () => {
      delete process.env[JEV_VALIDATION_FIELD_MODE_ENV];
      jevAnswers({ 'worktag:lob': 0.95, unknown: 0.05 }, 'worktag:lob');

      const decision = await classifyWorkdayValidationField(input);

      expect(decision.retryField).toBe('worktag:costCenter');
      expect(mockDecide).not.toHaveBeenCalled();
    });

    it.each(['', 'of', 'true'])('treats %j as off', async (value) => {
      process.env[JEV_VALIDATION_FIELD_MODE_ENV] = value;

      await classifyWorkdayValidationField(input);

      expect(mockDecide).not.toHaveBeenCalled();
    });
  });

  describe('on', () => {
    beforeEach(() => {
      process.env[JEV_VALIDATION_FIELD_MODE_ENV] = 'on';
    });

    it('returns an accepted Jev field without calling the language model', async () => {
      jevAnswers({ 'worktag:lob': 0.93, 'worktag:costCenter': 0.04, supplier: 0.01, unknown: 0.02 }, 'worktag:lob');

      const decision = await classifyWorkdayValidationField(input);

      expect(decision).toEqual({
        retryField: 'worktag:lob',
        workdayField: 'Worktags_Reference',
        reason: 'Jev chose worktag:lob (probability 0.93).',
      });
      expect(mockToolLoopAgent).not.toHaveBeenCalled();
    });

    it('sends only the validation text, the offered fields, and the TypeSafe pin with zero data retention', async () => {
      jevAnswers({ 'worktag:lob': 0.93, 'worktag:costCenter': 0.04, supplier: 0.01, unknown: 0.02 }, 'worktag:lob');

      await classifyWorkdayValidationField(input);

      const [request] = mockDecide.mock.calls[0] as [{ state: unknown; questions: { retryField: { criteria: Record<string, string> } }; providerOptions: unknown; abortSignal: AbortSignal }];
      expect(request.state).toEqual({ message: input.validation.message, xpath: input.validation.xpath });
      expect(Object.keys(request.questions.retryField.criteria)).toEqual(['worktag:lob', 'worktag:costCenter', 'supplier', 'unknown']);
      expect(request.providerOptions).toEqual({ gateway: { only: ['typesafe-ai'], zeroDataRetention: true } });
      expect(request.abortSignal).toBeInstanceOf(AbortSignal);
    });

    it('accepts unknown, which is the no-retry outcome', async () => {
      jevAnswers({ 'worktag:lob': 0.02, 'worktag:costCenter': 0.03, supplier: 0.01, unknown: 0.94 }, 'unknown');

      const decision = await classifyWorkdayValidationField(input);

      expect(decision.retryField).toBe('unknown');
      expect(mockToolLoopAgent).not.toHaveBeenCalled();
    });

    it('falls back to the language model when the probability is below the bar', async () => {
      jevAnswers({ 'worktag:lob': 0.6, 'worktag:costCenter': 0.1, supplier: 0.1, unknown: 0.2 }, 'worktag:lob');

      const decision = await classifyWorkdayValidationField(input);

      expect(decision.retryField).toBe('worktag:costCenter');
      expect(mockToolLoopAgent).toHaveBeenCalledTimes(1);
    });

    it('falls back just below the probability bar and accepts exactly at it', async () => {
      jevAnswers({ 'worktag:lob': 0.79, 'worktag:costCenter': 0.2, supplier: 0.005, unknown: 0.005 }, 'worktag:lob');
      const below = await classifyWorkdayValidationField(input);
      expect(below.retryField).toBe('worktag:costCenter');

      mockToolLoopAgent.mockClear();
      jevAnswers({ 'worktag:lob': 0.8, 'worktag:costCenter': 0.1, supplier: 0.05, unknown: 0.05 }, 'worktag:lob');
      const at = await classifyWorkdayValidationField(input);
      expect(at.retryField).toBe('worktag:lob');
      expect(mockToolLoopAgent).not.toHaveBeenCalled();
    });

    it('falls back when Jev sends no distribution', async () => {
      jevAnswers(undefined, 'worktag:lob');

      const decision = await classifyWorkdayValidationField(input);

      expect(decision.retryField).toBe('worktag:costCenter');
    });

    it('falls back for a choice that was not offered', async () => {
      jevAnswers({ 'worktag:fund': 0.95, 'worktag:lob': 0.03, unknown: 0.02 }, 'worktag:fund');

      const decision = await classifyWorkdayValidationField(input);

      expect(decision.retryField).toBe('worktag:costCenter');
      expect(mockToolLoopAgent).toHaveBeenCalledTimes(1);
    });

    it('falls back when the SDK rejects a malformed answer or the call fails', async () => {
      mockDecide.mockRejectedValue(new Error('AI_InvalidResponseDataError'));

      const decision = await classifyWorkdayValidationField(input);

      expect(decision.retryField).toBe('worktag:costCenter');
    });

    it('falls back without calling Jev when JEV_MODEL is not a pinned version', async () => {
      process.env.JEV_MODEL = 'typesafe-ai/jev-latest';
      jevAnswers({ 'worktag:lob': 0.99, unknown: 0.01 }, 'worktag:lob');

      const decision = await classifyWorkdayValidationField(input);

      expect(decision.retryField).toBe('worktag:costCenter');
      expect(mockDecide).not.toHaveBeenCalled();
    });

    it('never asks Jev about a duplicate supplier invoice number', async () => {
      const decision = await classifyWorkdayValidationField({
        validation: {
          message: "Enter a Supplier's Invoice Number that isn't already in use on another supplier invoice",
          detailMessage: "The supplier's invoice number entered is already in use.",
          xpath: '/wd:Submit_Supplier_Invoice_Request[1]/wd:Supplier_Invoice_Data[1]/wd:Suppliers_Invoice_Number[1]',
        },
        allowedRetryFields: ['supplier', 'worktag:lob'],
      });

      expect(decision.retryField).toBe('unknown');
      expect(mockDecide).not.toHaveBeenCalled();
      expect(mockToolLoopAgent).not.toHaveBeenCalled();
    });
  });

  describe('shadow', () => {
    beforeEach(() => {
      process.env[JEV_VALIDATION_FIELD_MODE_ENV] = 'shadow';
    });

    it('returns the language model answer and logs how Jev compared', async () => {
      jevAnswers({ 'worktag:lob': 0.93, 'worktag:costCenter': 0.04, supplier: 0.01, unknown: 0.02 }, 'worktag:lob');

      const decision = await classifyWorkdayValidationField(input);

      expect(decision.retryField).toBe('worktag:costCenter');
      expect(mockDebug).toHaveBeenCalledWith('Jev shadow validation field', expect.objectContaining({
        current: 'worktag:costCenter',
        jev: 'worktag:lob',
        jevAccepted: true,
        agrees: false,
      }));
    });

    it('reports a malformed Jev answer as not accepted and keeps the language model answer', async () => {
      jevAnswers({ 'worktag:fund': 0.95, 'worktag:lob': 0.03, unknown: 0.02 }, 'worktag:fund');

      const decision = await classifyWorkdayValidationField(input);

      expect(decision.retryField).toBe('worktag:costCenter');
      expect(mockDebug).toHaveBeenCalledWith('Jev shadow validation field', expect.objectContaining({ jevAccepted: false }));
    });

    it('still returns the language model answer when Jev fails', async () => {
      mockDecide.mockRejectedValue(new Error('gateway down'));

      const decision = await classifyWorkdayValidationField(input);

      expect(decision.retryField).toBe('worktag:costCenter');
      expect(mockDebug).toHaveBeenCalledWith('Jev shadow validation field', expect.objectContaining({ jevAccepted: false }));
    });

    it('surfaces a language model failure as today, after logging what Jev would have done', async () => {
      mockToolLoopAgent.mockImplementation(() => ({ generate: jest.fn().mockRejectedValue(new Error('model down')) }));
      jevAnswers({ 'worktag:lob': 0.93, 'worktag:costCenter': 0.04, supplier: 0.01, unknown: 0.02 }, 'worktag:lob');

      await expect(classifyWorkdayValidationField(input)).rejects.toThrow('model down');

      expect(mockDebug).toHaveBeenCalledWith('Jev shadow validation field', expect.objectContaining({
        current: undefined,
        currentFailed: true,
        jev: 'worktag:lob',
        jevAccepted: true,
      }));
    });
  });
});

describe('buildValidationFieldQuestions', () => {
  it('offers only the allowed fields plus unknown', () => {
    const { retryField } = buildValidationFieldQuestions(['worktag:fund', 'supplier', 'unknown', 'supplier']);

    expect(Object.keys(retryField.criteria)).toEqual(['worktag:fund', 'supplier', 'unknown']);
    expect(retryField.type).toBe('choice');
  });

  it('keeps the rule that a Line of Business rule beats a cost center availability message', () => {
    const { retryField } = buildValidationFieldQuestions(['worktag:lob', 'worktag:costCenter']);

    expect(retryField.criteria['worktag:lob']).toMatch(/even if another message says the Cost Center is not available/);
  });
});
