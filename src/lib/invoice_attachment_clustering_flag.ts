export const INVOICE_ATTACHMENT_CLUSTERING_ENV_VAR = 'INVOICE_ATTACHMENT_CLUSTERING_ENABLED';

export function isInvoiceAttachmentClusteringEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[INVOICE_ATTACHMENT_CLUSTERING_ENV_VAR] === 'true';
}
