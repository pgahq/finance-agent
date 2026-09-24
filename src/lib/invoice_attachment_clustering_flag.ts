export const INVOICE_ATTACHMENT_CLUSTERING_ENV_VAR = 'INVOICE_ATTACHMENT_CLUSTERING_ENABLED';

/**
 * - `on` (`true`): cluster attachments and create one Workday invoice per cluster, with resend dedupe.
 * - `shadow` (`shadow`): keep one invoice per PDF, and also classify/cluster to report the plan in Slack only.
 * - `off` (anything else, including a missing SSM parameter).
 */
export type InvoiceAttachmentClusteringMode = 'off' | 'shadow' | 'on';

export function invoiceAttachmentClusteringMode(env: NodeJS.ProcessEnv = process.env): InvoiceAttachmentClusteringMode {
  const value = env[INVOICE_ATTACHMENT_CLUSTERING_ENV_VAR];
  if (value === 'true') return 'on';
  if (value === 'shadow') return 'shadow';
  return 'off';
}

export function isInvoiceAttachmentClusteringEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return invoiceAttachmentClusteringMode(env) === 'on';
}
