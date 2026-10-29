import { ProcessorDeadlineError, deadlineErrorFromSignal, isDeadlineError } from '../lib/deadline.js';

describe('ProcessorDeadlineError', () => {
  it('reads as a time-out without claims about Workday state', () => {
    const message = new ProcessorDeadlineError('Processor deadline reached; aborting AI calls').userMessage();

    expect(message).toContain('ran out of time');
    expect(message).toContain('Check Workday');
    expect(message).not.toContain('No invoice was created');
  });

  it('is recognised across module copies by name', () => {
    expect(isDeadlineError(new ProcessorDeadlineError('x'))).toBe(true);
    expect(isDeadlineError({ name: 'ProcessorDeadlineError' })).toBe(true);
    expect(isDeadlineError(new Error('Delay was aborted'))).toBe(false);
    expect(isDeadlineError(undefined)).toBe(false);
  });

  it('turns an aborted signal into a deadline error, keeping a deadline reason as is', () => {
    const reason = new ProcessorDeadlineError('Processor deadline reached; aborting AI calls');
    const withReason = new AbortController();
    withReason.abort(reason);
    expect(deadlineErrorFromSignal(withReason.signal)).toBe(reason);

    const plain = new AbortController();
    plain.abort(new Error('stop'));
    expect(deadlineErrorFromSignal(plain.signal)).toMatchObject({ name: 'ProcessorDeadlineError', message: 'stop' });
  });
});
