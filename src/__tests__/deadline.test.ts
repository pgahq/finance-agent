import { ProcessorDeadlineError, deadlineErrorFromSignal, isDeadlineError } from '../lib/deadline.js';

describe('ProcessorDeadlineError', () => {
  it('names the stage and says what reached Workday for each disposition', () => {
    const error = new ProcessorDeadlineError('lambda', 'Processor deadline reached; aborting AI calls', { stage: 'matching' });

    expect(error.userMessage()).toBe('The run hit its time limit during supplier and company matching.');

    error.disposition = 'no_retry';
    expect(error.userMessage()).toBe('The run hit its time limit during supplier and company matching. Nothing was written to Workday. Re-trigger the conversation to try again.');

    error.writeStarted = true;
    expect(error.userMessage()).toContain('A Workday write may have started. Check Workday before re-triggering');
    expect(error.userMessage()).not.toContain('Nothing was written');
    error.writeStarted = false;

    error.disposition = 'retrying';
    expect(error.userMessage()).toContain('Nothing has been written to Workday yet');
    expect(error.userMessage()).toContain('queued again automatically');

    error.disposition = 'retry_failed';
    expect(error.userMessage()).toContain('automatic retry could not be queued');

    error.disposition = 'retry_exhausted';
    expect(error.userMessage()).toContain('already retried once');
    expect(error.userMessage()).toContain('Nothing was written to Workday');
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

  it('turns an aborted signal into a deadline error, keeping a staged deadline reason as is', () => {
    const staged = new ProcessorDeadlineError('lambda', 'Processor deadline reached; aborting AI calls', { stage: 'matching' });
    const withStaged = new AbortController();
    withStaged.abort(staged);
    expect(deadlineErrorFromSignal(withStaged.signal, 'ocr')).toBe(staged);

    const noStage = new ProcessorDeadlineError('lambda', 'Processor deadline reached; aborting AI calls');
    const withReason = new AbortController();
    withReason.abort(noStage);
    expect(deadlineErrorFromSignal(withReason.signal)).toBe(noStage);
  });

  it('gives a deadline reason with no stage its own error when the caller knows the stage', () => {
    const shared = new ProcessorDeadlineError('lambda', 'Processor deadline reached; aborting AI calls');
    const controller = new AbortController();
    controller.abort(shared);

    const staged = deadlineErrorFromSignal(controller.signal, 'line_merge');

    expect(staged).not.toBe(shared);
    expect(staged).toMatchObject({ kind: 'lambda', stage: 'line_merge', message: shared.message });
    expect(staged.userMessage()).toContain('during invoice line coding');
    staged.disposition = 'retrying';
    expect(shared.disposition).toBeUndefined();
  });

  it('wraps a plain abort reason as a lambda deadline error with the stage', () => {
    const plain = new AbortController();
    plain.abort(new Error('stop'));
    expect(deadlineErrorFromSignal(plain.signal, 'ocr')).toMatchObject({ name: 'ProcessorDeadlineError', kind: 'lambda', stage: 'ocr', message: 'stop' });
  });
});
