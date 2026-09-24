export const INVOICE_ATTACHMENT_CLUSTERING_ENV_VAR = 'INVOICE_ATTACHMENT_CLUSTERING_ENABLED';

/**
 * - `shadow` (`shadow`): keep one invoice per PDF, and also classify/cluster to report the plan in Slack only.
 * - `off` (anything else, including a missing SSM parameter).
 */
export type InvoiceAttachmentClusteringMode = 'off' | 'shadow';

export function invoiceAttachmentClusteringMode(env: NodeJS.ProcessEnv = process.env): InvoiceAttachmentClusteringMode {
  return env[INVOICE_ATTACHMENT_CLUSTERING_ENV_VAR] === 'shadow' ? 'shadow' : 'off';
}
