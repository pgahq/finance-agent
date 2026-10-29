/**
 * Raised when the Lambda deadline signal fires. The AI SDK reports an aborted call as a generic
 * AbortError ("Delay was aborted" when the abort lands in retry backoff) and drops the signal's reason,
 * so callers rethrow this error instead to give Slack and the logs a readable cause.
 */
export class ProcessorDeadlineError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProcessorDeadlineError';
  }

  /** What AP reads in Slack. It makes no claim about Workday, since it is shared by every processor. */
  userMessage(): string {
    return 'The run ran out of time and stopped before finishing. Check Workday for any partial result before re-running it.';
  }
}

export function isDeadlineError(error: unknown): error is ProcessorDeadlineError {
  return error instanceof ProcessorDeadlineError
    || (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'ProcessorDeadlineError');
}

export function deadlineErrorFromSignal(signal: AbortSignal): ProcessorDeadlineError {
  const reason: unknown = signal.reason;
  if (isDeadlineError(reason)) return reason;
  return new ProcessorDeadlineError(
    reason instanceof Error ? reason.message : 'Processor deadline reached; aborting AI calls',
    { cause: reason }
  );
}
