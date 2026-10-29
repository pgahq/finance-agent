/**
 * Errors for work that ran out of time, whether the Lambda deadline fired, one AI stage hit its own
 * cap, or the run was too close to the limit to start a Workday write. None of them means a Workday
 * invoice was written, so the processor may requeue the run once.
 */
export type DeadlineKind = 'lambda' | 'stage_timeout' | 'submit_gate';

/** What the processor did about the run, so the Slack post can tell AP what happens next. */
export type DeadlineDisposition = 'retrying' | 'retry_failed' | 'retry_exhausted' | 'no_retry';

const STAGE_LABELS: Record<string, string> = {
  clustering: 'attachment classification',
  ocr: 'invoice PDF reading',
  ocr_second_read: 'the second read of the invoice PDF',
  matching: 'supplier and company matching',
  line_merge: 'invoice line coding',
};

export function stageLabel(stage: string | undefined): string | undefined {
  return stage ? STAGE_LABELS[stage] ?? stage : undefined;
}

export class ProcessorDeadlineError extends Error {
  readonly kind: DeadlineKind;
  readonly stage?: string;
  readonly timeoutMs?: number;
  disposition?: DeadlineDisposition;

  constructor(
    kind: DeadlineKind,
    message: string,
    options: { stage?: string; timeoutMs?: number; cause?: unknown } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProcessorDeadlineError';
    this.kind = kind;
    this.stage = options.stage;
    this.timeoutMs = options.timeoutMs;
  }

  /** The sentence AP reads in Slack, without the SDK or Lambda internals. */
  userMessage(): string {
    const label = stageLabel(this.stage);
    const where = label ? ` during ${label}` : '';
    const what = this.kind === 'stage_timeout'
      ? `The AI service was too slow${where}${this.timeoutMs ? ` (gave up after ${Math.round(this.timeoutMs / 1000)}s)` : ''}.`
      : this.kind === 'submit_gate'
        ? 'The run was too close to its time limit to safely submit to Workday.'
        : `The run hit its time limit${where}.`;
    switch (this.disposition) {
      case 'retrying':
        return `${what} No invoice has been created in Workday yet. The run was queued again automatically, so no action is needed unless a second alert follows.`;
      case 'retry_failed':
        return `${what} No invoice was created in Workday, and the automatic retry could not be queued. Re-trigger the conversation to try again.`;
      case 'retry_exhausted':
        return `${what} The run was already retried once. No invoice was created in Workday. Re-trigger the conversation to try again.`;
      default:
        return `${what} No invoice was created in Workday. Re-trigger the conversation to try again.`;
    }
  }
}

export function isDeadlineError(error: unknown): error is ProcessorDeadlineError {
  return error instanceof ProcessorDeadlineError
    || (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'ProcessorDeadlineError');
}

/**
 * The AI SDK reports an aborted call as a generic AbortError and drops the signal's reason, so callers
 * that see their deadline signal fired rethrow the reason as a deadline error.
 */
export function deadlineErrorFromSignal(signal: AbortSignal, stage?: string): ProcessorDeadlineError {
  const reason: unknown = signal.reason;
  if (isDeadlineError(reason)) return reason;
  return new ProcessorDeadlineError(
    'lambda',
    reason instanceof Error ? reason.message : 'Processor deadline reached; aborting AI calls',
    { stage, cause: reason }
  );
}
