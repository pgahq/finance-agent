import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('SAM template', () => {
  const globals = readFileSync(join(process.cwd(), 'template.yml'), 'utf8').split('\nResources:')[0];
  const circleci = readFileSync(join(process.cwd(), '.circleci/config.yml'), 'utf8');

  it('disables Lambda async retries for all functions', () => {
    expect(globals).toContain('EventInvokeConfig:');
    expect(globals).toMatch(/MaximumRetryAttempts:\s*0\b/);
  });

  it('wires INTERCOM_APP_ID from the IntercomAppId parameter', () => {
    expect(globals).toMatch(/IntercomAppId:/);
    expect(globals).toMatch(/INTERCOM_APP_ID:\s*!Ref IntercomAppId/);
    expect(circleci).toMatch(/IntercomAppId=\$INTERCOM_APP_ID/);
    expect(circleci).toMatch(/INTERCOM_APP_ID:\s*c722leqk/);
    expect(circleci).toMatch(/INTERCOM_APP_ID:\s*jyi16dpc/);
  });

  it('wires INVOICE_ATTACHMENT_CLUSTERING_ENABLED from the InvoiceAttachmentClusteringEnabled parameter', () => {
    expect(globals).toMatch(/InvoiceAttachmentClusteringEnabled:/);
    expect(globals).toMatch(/INVOICE_ATTACHMENT_CLUSTERING_ENABLED:\s*!Ref InvoiceAttachmentClusteringEnabled/);
    expect(circleci).toMatch(/InvoiceAttachmentClusteringEnabled=\$INVOICE_ATTACHMENT_CLUSTERING_ENABLED/);
    expect(circleci).toMatch(/INVOICE_ATTACHMENT_CLUSTERING_ENABLED:\s*"true"/);
    expect(circleci).toMatch(/INVOICE_ATTACHMENT_CLUSTERING_ENABLED:\s*"false"/);
  });

});
