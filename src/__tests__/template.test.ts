import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONVERSATION_INVOICE_CLAIM_TTL_MINUTES } from '../lib/conversation_invoices.js';

describe('SAM template', () => {
  const globals = readFileSync(join(process.cwd(), 'template.yml'), 'utf8').split('\nResources:')[0];
  const circleci = readFileSync(join(process.cwd(), '.circleci/config.yml'), 'utf8');

  it('keeps the create-invoice processor timeout shorter than the invoice and cluster claim lifetime', () => {
    const template = readFileSync(join(process.cwd(), 'template.yml'), 'utf8');
    const processorBlock = template.split('\n  CreateInvoiceProcessor:')[1]?.split('\n  # ')[0] ?? '';
    const timeoutSeconds = Number(processorBlock.match(/Timeout:\s*(\d+)/)?.[1]);
    expect(timeoutSeconds).toBeGreaterThan(0);
    expect(timeoutSeconds).toBeLessThan(CONVERSATION_INVOICE_CLAIM_TTL_MINUTES * 60);
  });

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

  it('reads INVOICE_ATTACHMENT_CLUSTERING_ENABLED from SSM at runtime, not a deploy parameter', () => {
    expect(globals).toMatch(
      /INVOICE_ATTACHMENT_CLUSTERING_ENABLED:\s*ssm:\/finance-agent\/invoice-attachment-clustering-enabled/
    );
    expect(globals).not.toMatch(/InvoiceAttachmentClusteringEnabled/);
    expect(circleci).not.toMatch(/INVOICE_ATTACHMENT_CLUSTERING_ENABLED|InvoiceAttachmentClusteringEnabled/);
  });

  it('reads PO_LINE_SELECTION_ENABLED from SSM at runtime, not a deploy parameter', () => {
    expect(globals).toMatch(/PO_LINE_SELECTION_ENABLED:\s*ssm:\/finance-agent\/po-line-selection-enabled/);
    expect(circleci).not.toMatch(/PO_LINE_SELECTION_ENABLED|PoLineSelectionEnabled/);
  });

  it('keeps Global SSM references low enough for a single GetParameters call', () => {
    const globalSsmRefs = globals.match(/:\s*ssm:\//g) ?? [];
    const maxFunctionSsmRefs = 2;
    expect(globalSsmRefs.length + maxFunctionSsmRefs).toBeLessThanOrEqual(10);
  });

  it('wires WORKDAY_UI_BASE_URL from the WorkdayUiBaseUrl parameter', () => {
    expect(globals).toMatch(/WorkdayUiBaseUrl:/);
    expect(globals).toMatch(/WORKDAY_UI_BASE_URL:\s*!Ref WorkdayUiBaseUrl/);
    expect(globals).not.toMatch(/WorkdayUiBaseUrl:[\s\S]*?Default:/);
    expect(circleci).toMatch(/WorkdayUiBaseUrl=\$WORKDAY_UI_BASE_URL/);
    expect(circleci).toMatch(/WORKDAY_UI_BASE_URL:\s*https:\/\/impl\.workday\.com/);
    expect(circleci).toMatch(/WORKDAY_UI_BASE_URL:\s*https:\/\/www\.myworkday\.com/);
  });

});
