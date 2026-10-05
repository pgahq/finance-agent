export const PO_LINE_SELECTION_ENV_VAR = 'PO_LINE_SELECTION_ENABLED';

/**
 * When on (`true`), PO line matching uses line statuses and service dates: fully invoiced,
 * fully paid, or closed PO lines are flagged unavailable and lose their reference when
 * matched, the merge model gets invoice and PO line dates, and the invoice-date guard runs.
 * Anything else, including a missing SSM parameter, keeps PO line matching as it was.
 */
export function isPoLineSelectionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PO_LINE_SELECTION_ENV_VAR] === 'true';
}
