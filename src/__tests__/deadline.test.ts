import { ProcessorDeadlineError, deadlineErrorFromSignal, isDeadlineError } from '../lib/deadline.js';

describe('ProcessorDeadlineError', () => {
  it('names the stage and says no invoice was created for each disposition', () => {
    const error = new ProcessorDeadlineError('lambda', 'Processor deadline reached; aborting AI calls', { stage: 'matching' });

    expect(error.userMessage()).toBe('The run hit its time limit during supplier and company matching. No invoice was created in Workday. Re-trigger the conversation to try again.');

    error.disposition = 'retrying';
    expect(error.userMessage()).toContain('No invoice has been created in Workday yet');
    expect(error.userMessage()).toContain('queued again automatically');

    error.disposition = 'retry_failed';
    expect(error.userMessage()).toContain('automatic retry could not be queued');

    error.disposition = 'retry_exhausted';
    expect(error.userMessage()).toContain('already retried once');
  });

  it('describes a stage cap and the submit gate without SDK internals', () => {
    expect(new ProcessorDeadlineError('stage_timeout', 'cap', { stage: 'line_merge', timeoutMs: 240000 }).userMessage())
      .toContain('The AI service was too slow during invoice line coding (gave up after 240s).');
    expect(new ProcessorDeadlineError('submit_gate', 'gate').userMessage())
      .toContain('too close to its time limit to safely submit to Workday');
  });

  it('is recognised across module copies by name', () => {
    expect(isDeadlineError(new ProcessorDeadlineError('lambda', 'x'))).toBe(true);
    expect(isDeadlineError({ name: 'ProcessorDeadlineError' })).toBe(true);
    expect(isDeadlineError(new Error('Delay was aborted'))).toBe(false);
    expect(isDeadlineError(undefined)).toBe(false);
  });

  it('turns an aborted signal into a deadline error, keeping a deadline reason as is', () => {
    const reason = new ProcessorDeadlineError('lambda', 'Processor deadline reached; aborting AI calls');
    const withReason = new AbortController();
    withReason.abort(reason);
    expect(deadlineErrorFromSignal(withReason.signal, 'ocr')).toBe(reason);

    const plain = new AbortController();
    plain.abort(new Error('stop'));
    expect(deadlineErrorFromSignal(plain.signal, 'ocr')).toMatchObject({ name: 'ProcessorDeadlineError', kind: 'lambda', stage: 'ocr', message: 'stop' });
  });
});
