export const REPEATED_LINE_REMOVAL_ENV_VAR = 'REPEATED_LINE_REMOVAL_ENABLED';

/**
 * - `on` (`true`): create removes extracted line tables that repeat another table's charges.
 * - `shadow` (`shadow`): keep every line, and log which lines removal would drop.
 * - `off` (anything else, including a missing SSM parameter): keep every line.
 */
export type RepeatedLineRemovalMode = 'off' | 'shadow' | 'on';

export function repeatedLineRemovalMode(env: NodeJS.ProcessEnv = process.env): RepeatedLineRemovalMode {
  const value = env[REPEATED_LINE_REMOVAL_ENV_VAR];
  if (value === 'true') return 'on';
  if (value === 'shadow') return 'shadow';
  return 'off';
}
