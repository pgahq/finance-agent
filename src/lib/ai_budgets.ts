/**
 * Per-stage caps on one `getAiResponse` call, retries included. They sit well above normal latency
 * (OCR of a one-page invoice has taken 156s on a slow day) so they only fire on a stalled call, which
 * then fails into the requeue path instead of using the whole Lambda budget.
 */
export const AI_STAGE_TIMEOUT_MS = {
  clustering: 120_000,
  ocr: 300_000,
  ocr_second_read: 150_000,
  matching: 300_000,
  line_merge: 240_000,
} as const;

export type AiStage = keyof typeof AI_STAGE_TIMEOUT_MS;

/** One retry after a retryable provider error (SDK default is two retries with backoff). */
export const AI_MAX_RETRIES = 1;

/** One embedding call inside the RAG tools. */
export const EMBEDDING_TIMEOUT_MS = 30_000;

/** A Workday write is not abortable, so none starts with less than this left. */
export const SUBMIT_MIN_REMAINING_MS = 150_000;

/** Immediate requeues of a run that ran out of time. */
export const MAX_DEADLINE_RETRIES = 1;
