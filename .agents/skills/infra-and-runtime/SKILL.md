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

## Jev audit mode

`JevAuditMode` (`off`, `shadow`, `on`; default `off`; CircleCI passes
`JEV_AUDIT_MODE` from the job environment, `off` when unset) sets `JEV_AUDIT_MODE`
on `ScoreInvoicesProcessor` and `ScoreDigestFunction` only. It adds no secret,
VPC route, or egress beyond the existing `AI_GATEWAY_API_KEY` Global. Each
invoice costs a few Jev calls of at most 15s each (one retry); `jevDecide`'s
circuit breaker (three failures, five minutes) keeps an outage inside the
processor's 900s with `PROCESSOR_BATCH_SIZE` 20, and the per-invocation Jev time
budget (`JEV_BUDGET_MS`, default 300s, started in the processor) covers slow
answers that never fail. If you raise the Timeout, batch size, or per-call
timeout, recheck that budget. Set the parameter to `off` to stop all Jev traffic; see
`agent-invoice-scoring`.

## Jev validation-field mode

`JevValidationFieldMode` (`off`, `shadow`, `on`; default `off`; CircleCI passes
`JEV_VALIDATION_FIELD_MODE`, `off` when unset) sets `JEV_VALIDATION_FIELD_MODE` as a
template Global, because the classifier runs inside the create and enrich
processors' submit retry; only that code path reads it. It adds no secret, but while
it is `shadow` or `on` the Workday validation message, detail message, and XPath go
to TypeSafe through the existing gateway key (zero data retention), which is why it
is off until the vendor review is done. Latency, worst case, per failed submit
retry: `on` waits up to 5 seconds for Jev and then, if Jev is not accepted, runs the
same `gpt-5.4-mini` tool loop as before, so the bound is 5 seconds plus that loop's
own; `shadow` runs both at once, so it takes the slower of the two: it adds time only
when Jev is slower than the tool loop, and then at most the difference, up to Jev's
5-second cap. Both sit inside the Lambda
`Timeout` of 600 seconds, and no step takes a deadline signal (the submit path has
none). Set the parameter to `off` to stop its Jev traffic; see
`integrations-and-external-contracts`.

## Change checklist

- Edit `Globals.Function` for settings that should apply to every function
- Override per function only for timeout, memory, env, role, or VPC exceptions
- Keep `MaximumRetryAttempts: 0` unless the user explicitly asks to restore AWS retries
- Confirm `src/__tests__/template.test.ts` still asserts Globals `MaximumRetryAttempts: 0` after template retry-policy edits
