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

  it('loads the Vercel AI Gateway key from SSM instead of an OpenAI key', () => {
    expect(globals).toMatch(/AI_GATEWAY_API_KEY:\s*ssm:\/finance-agent\/ai-gateway-api-key/);
    expect(globals).not.toMatch(/OPENAI_API_KEY|openai-api-key/);
  });

  it('loads the Vercel AI Gateway key from SSM instead of an OpenAI key', () => {
    expect(globals).toMatch(/AI_GATEWAY_API_KEY:\s*ssm:\/finance-agent\/ai-gateway-api-key/);
    expect(globals).not.toMatch(/OPENAI_API_KEY|openai-api-key/);
  });

  it('keeps Global SSM references low enough for a single GetParameters call', () => {
    const globalSsmRefs = globals.match(/:\s*ssm:\//g) ?? [];
    const maxFunctionSsmRefs = 2;
    expect(globalSsmRefs.length + maxFunctionSsmRefs).toBeLessThanOrEqual(10);
  });

  describe('agent invoice scoring', () => {
    const template = readFileSync(join(process.cwd(), 'template.yml'), 'utf8');
    const resourceBlock = (name: string) => template.split(`\n  ${name}:`)[1]?.split(/\n  (?:# |[A-Z][A-Za-z]+:)/)[0] ?? '';

    it('stamps snapshots with the deployed commit from CircleCI', () => {
      expect(globals).toMatch(/ReleaseSha:/);
      expect(globals).toMatch(/RELEASE_SHA:\s*!Ref ReleaseSha/);
      expect(circleci).toMatch(/ReleaseSha=\$CIRCLE_SHA1/);
    });

    it('maps the Workday cancel reasons by reference ID by default', () => {
      const raw = globals.match(/CancelReasonAttribution:[\s\S]*?Default:\s*'([^']+)'/)?.[1] ?? '';
      expect(JSON.parse(raw)).toEqual({
        business: ['INVOICE_CANCEL_REASON-3-3', 'INVOICE_CANCEL_REASON-3-4'],
        duplicate: ['DUPLICATE'],
        agent: [],
        agentTags: [],
      });
    });

    it('marks only the dev tenant as refreshed from production on Saturdays', () => {
      expect(globals).toMatch(/TenantRefreshWeekday:/);
      expect(globals).toMatch(/SCORE_TENANT_REFRESH_WEEKDAY:\s*!Ref TenantRefreshWeekday/);
      expect(circleci).toMatch(/TenantRefreshWeekday=\$TENANT_REFRESH_WEEKDAY/);
      const devJob = circleci.split('deploy-to-dev:')[1]?.split('deploy-to-prod:')[0] ?? '';
      const prodJob = circleci.split('deploy-to-prod:')[1]?.split('workflows:')[0] ?? '';
      expect(devJob).toMatch(/TENANT_REFRESH_WEEKDAY:\s*"6"/);
      expect(prodJob).toMatch(/TENANT_REFRESH_WEEKDAY:\s*none/);
    });

    it('runs the scoring query daily and dispatches to its processor', () => {
      const query = resourceBlock('ScoreInvoicesFunction');
      expect(query).toContain('Handler: dist/score_invoices.handler');
      expect(query).toMatch(/Schedule:\s*cron\(0 1 \* \* \? \*\)/);
      const processor = resourceBlock('ScoreInvoicesProcessor');
      expect(processor).toContain('FunctionName: !Sub "${AWS::StackName}-ScoreInvoicesProcessor"');
      expect(processor).toContain('Handler: dist/score_invoices_processor.processor');
      expect(processor).toMatch(/CANCEL_REASON_ATTRIBUTION:\s*!Ref CancelReasonAttribution/);
      expect(processor).toMatch(/SCORE_SUPPLIERS_INVOICE_NUMBER_WQL_FIELD:\s*suppliersInvoiceNumber/);
      expect(Number(processor.match(/Timeout:\s*(\d+)/)?.[1])).toBeLessThanOrEqual(900);
    });

    it('posts the audit only through the Slack API with the audit bot token', () => {
      const digest = resourceBlock('ScoreDigestFunction');
      expect(digest).toContain('Handler: dist/score_digest.handler');
      expect(digest).toMatch(/Schedule:\s*cron\(30 14 \? \* MON \*\)\s*\n\s*Input: '\{"mode":"weekly"\}'/);
      expect(digest).toMatch(/Schedule:\s*cron\(20 1 \* \* \? \*\)\s*\n\s*Input: '\{"mode":"daily"\}'/);
      expect(digest).toMatch(/AUDIT_SLACK_BOT_TOKEN:\s*ssm:\/finance-agent\/audit-slack-bot-token/);
      expect(template.match(/AUDIT_SLACK_BOT_TOKEN:/g)).toHaveLength(1);
      expect(template).not.toMatch(/AUDIT_SLACK_WEBHOOK_URL|audit-slack-webhook-url/);
    });

    it('takes the audit channel from CircleCI per environment', () => {
      expect(globals).toMatch(/AuditSlackChannelId:/);
      expect(globals).not.toMatch(/AuditSlackChannelId:\n(?: {4}.*\n)*? {4}Default:/);
      const pattern = new RegExp(globals.match(/AuditSlackChannelId:\n(?: {4}.*\n)*? {4}AllowedPattern: "([^"]+)"/)?.[1] ?? '^$');
      expect(['C0C6VS0BDPA', 'C0C5W6B0G4V'].every((id) => pattern.test(id))).toBe(true);
      expect(['', ' ', 'notify-finance-agent-audit', '#C0C5W6B0G4V'].some((id) => pattern.test(id))).toBe(false);
      expect(resourceBlock('ScoreDigestFunction')).toMatch(/AUDIT_SLACK_CHANNEL_ID:\s*!Ref AuditSlackChannelId/);
      expect(template.match(/AUDIT_SLACK_CHANNEL_ID:/g)).toHaveLength(1);
      expect(circleci).toMatch(/AuditSlackChannelId=\$AUDIT_SLACK_CHANNEL_ID/);
      const devJob = circleci.split('deploy-to-dev:')[1]?.split('deploy-to-prod:')[0] ?? '';
      const prodJob = circleci.split('deploy-to-prod:')[1]?.split('workflows:')[0] ?? '';
      expect(devJob).toMatch(/AUDIT_SLACK_CHANNEL_ID:\s*C0C6VS0BDPA/);
      expect(prodJob).toMatch(/AUDIT_SLACK_CHANNEL_ID:\s*C0C5W6B0G4V/);
    });

    it('keeps every function within the per-function SSM reference budget', () => {
      const resources = template.split('\nResources:')[1].split(/\n  (?=[A-Z][A-Za-z]+:\n)/);
      for (const resource of resources) {
        expect((resource.match(/:\s*ssm:\//g) ?? []).length).toBeLessThanOrEqual(2);
      }
    });
  });

  it('wires WORKDAY_UI_BASE_URL from the WorkdayUiBaseUrl parameter', () => {
    const workdayUiParam = globals.match(
      /WorkdayUiBaseUrl:\n(?:    .*\n)+/,
    )?.[0];
    expect(workdayUiParam).toBeDefined();
    expect(workdayUiParam).not.toMatch(/Default:/);
    expect(globals).toMatch(/WORKDAY_UI_BASE_URL:\s*!Ref WorkdayUiBaseUrl/);
    expect(circleci).toMatch(/WorkdayUiBaseUrl=\$WORKDAY_UI_BASE_URL/);
    expect(circleci).toMatch(/WORKDAY_UI_BASE_URL:\s*https:\/\/impl\.workday\.com/);
    expect(circleci).toMatch(/WORKDAY_UI_BASE_URL:\s*https:\/\/www\.myworkday\.com/);
  });

});
