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
Schedule event). A thrown error already Slacks; Lambda retries would run the
same work again and Slack again.

Keep the existing report-then-throw pattern so CloudWatch still records the
failure. Do not swallow errors just to avoid retries.

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

## Change checklist

- Edit `Globals.Function` for settings that should apply to every function
- Override per function only for timeout, memory, env, role, or VPC exceptions
- Keep `MaximumRetryAttempts: 0` unless the user explicitly asks to restore AWS retries
- Confirm `src/__tests__/template.test.ts` still asserts Globals `MaximumRetryAttempts: 0` after template retry-policy edits
