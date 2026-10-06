export const FREIGHT_RECONCILIATION_ENV_VAR = 'FREIGHT_RECONCILIATION_ENABLED';

/**
 * When on (`true`), all-freight invoices submit freight as coded invoice lines with no header
 * Freight_Amount, and invoice lines that repeat the header freight or tax are removed before submit.
 * Anything else, including a missing SSM parameter, keeps freight on the header and every line as
 * extracted; the Amount check note still flags totals that do not equal the amount due.
 */
export function isFreightReconciliationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[FREIGHT_RECONCILIATION_ENV_VAR] === 'true';
}
