---
name: infra-and-runtime
description: >-
  finance-agent SAM/Lambda runtime contracts: template.yml Globals, EventInvokeConfig
  retry policy, async Event vs HTTP API invocations, timeouts, and VPC. Use when
  changing template.yml, Lambda retries, EventBridge schedules, processor Event
  invokes, or deploy-time function settings.
---

# Infra and runtime

`template.yml` is the source of truth for Lambda runtime settings. CircleCI
packages and deploys that file (`.circleci/config.yml`).

## Async retries stay off

`Globals.Function.EventInvokeConfig.MaximumRetryAttempts` must remain `0`.

AWS defaults async invocations to two retries. Cache processors, invoice
processors, and EventBridge schedules are async (`InvocationType: Event` or a
Schedule event). Lambda retries would run the same work again.

Slack-then-throw today: `create_invoice` / `enrich_invoice` processor catches,
`syncDataSource`, and `withQueryHandler` / `withProcessorHandler` query
failures. `setupContext` (env + DB schema init), `withHandler` bodies that
only notify on success (`cache_validation_rules`, EnrichInvoice query
handler), and `query_documents` throw without Slack — CloudWatch only. Do not
wrap those in a generic catch that also wraps paths that already Slack.

Keep report-then-throw where it exists so CloudWatch still records the
failure. Do not swallow errors just to avoid retries. Failed async events are
discarded (no OnFailure destination).

HTTP API functions (`TriggerCreateInvoice`, `TriggerEnrichInvoice`) are
synchronous request/response. EventInvokeConfig does not retry those HTTP
invocations. They still Event-invoke processors, which inherit the global
`MaximumRetryAttempts: 0`.

## Not Lambda retries

Do not change these when the ask is "stop Lambda retries":

- Workday submit validation/fallback loops in `src/lib/workday.ts`
- Related-LOB fill retries during SOAP submit
- Enrich invoice skip-registry / task-not-authorized handling

Those run inside a single invocation.

## Eval role and tunnel

`EvalReadOnlyRole` (created only when `EvalRoleTrustedPrincipalArns` is set) is read-only access for the eval harness:
`s3:GetObject` and `GetObjectVersion` on `new-invoices/*` and `attachments/*`, `s3:ListBucketVersions` for prefix
`attachments/*`, `secretsmanager:GetSecretValue` on the database secret, and `ssm:StartSession` on one instance
(`AuroraTunnelInstanceId`) and on `EvalAuroraPortForwardDocument`, a Session document that can forward only to the Aurora
endpoint on 5432. The trust policy lists role ARNs from the parameter, never the account root. Keep it free of write, delete,
put, Lambda invoke, and SSM parameter actions (`src/__tests__/template.test.ts` asserts this), and add no `Deny` statements or
bucket policy: they could cut off the Lambda roles. `AuroraTunnelSecurityGroupId` adds one ingress rule on the database security
group. All three parameters default to empty, so a deploy that does not pass them creates nothing. The role is not wired
into `.circleci/config.yml`; passing the parameters there is a separate, deliberate change. The bucket has `DeletionPolicy` and
`UpdateReplacePolicy: Retain`.

## Change checklist

- Edit `Globals.Function` for settings that should apply to every function
- Override per function only for timeout, memory, env, role, or VPC exceptions
- Keep `MaximumRetryAttempts: 0` unless the user explicitly asks to restore AWS retries
- Confirm `src/__tests__/template.test.ts` still asserts Globals `MaximumRetryAttempts: 0` after template retry-policy edits
