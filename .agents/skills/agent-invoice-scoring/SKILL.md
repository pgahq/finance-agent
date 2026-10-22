---
name: agent-invoice-scoring
description: >-
  Scores finance-agent supplier invoices against what AP finally saved in
  Workday: agent write snapshots, the daily ScoreInvoices job and processor,
  cancel attribution, touch buckets, and the daily and weekly ScoreDigest posts
  to #notify-finance-agent-audit. Use when changing agent_invoice_snapshots,
  agent_invoice_scores, cancel_labels, agent_invoice_touches,
  agent_invoice_touch_daily, agent_invoice_coverage_daily, agent coverage,
  COVERAGE_COMPANY_WIDS, snapshotAgentWrite or snapshotEnrichBaseline,
  the scored-field whitelist, material vs convention fields, invoice status
  classification, CANCEL_REASON_ATTRIBUTION, SCORE_* settings, ScoreInvoices,
  ScoreDigest, AUDIT_SLACK_BOT_TOKEN, AUDIT_SLACK_CHANNEL_ID, or
  export-eval-cases.
---

# Agent invoice scoring

The score is what AP changed in Workday on the fields the agent is responsible
for entering. Workday's audit trail is not read: it mixes the agent's write,
approval steps, and recalculated fields. The agent saves what it wrote, and the
scorer diffs that against later reads.

## Snapshots (write path)

After each agent write the processor reads the invoice back and stores
`extractScoredFields` of it in `agent_invoice_snapshots`
(`src/lib/invoice_snapshots.ts`).

| Source | Where | Notes |
| --- | --- | --- |
| `create` | `CreateInvoiceProcessor` after `submitNewSupplierInvoice` | Reuses the create read-back (`createdInvoice`). |
| `resend_update` | `CreateInvoiceProcessor` after a resend update | AP edits the update overwrote are stored as `pre_write_diff`. |
| `enrich_baseline` | `EnrichInvoiceProcessor` before the update | The invoice as OCR left it. Not an agent write. |
| `enrich` | `EnrichInvoiceProcessor` after the update | The notes-only `annotateSupplierInvoice` path takes no snapshot. |

A snapshot never fails the invoice: the helpers return false and the Slack
message gains `snapshotSync: failed`; an invoice with no agent-write snapshot is
simply not scored. `write_seq` is the next number per invoice, and an insert
that loses a race for it retries. Every row carries `release_sha`
(`ReleaseSha` parameter, `CIRCLE_SHA1` on deploy). `create`, `resend_update`,
and `enrich` rows also carry `clustering_mode`; only create and resend rows
carry the Intercom conversation and S3 attachments, because enrich starts from
Workday OCR email.

`extractScoredFields` is the scored-field whitelist and `diffScoredFields` the
line pairing (a reorder alone is not a change). A deposit invoice (see
`integrations-and-external-contracts`) is submitted as one deposit line instead
of the printed rows, so a run of line-count or line-amount differences on
invoices whose notes say `Deposit invoice:` reflects that choice, not an
extraction miss; AP's booking method for deposits is still unconfirmed. Notes, assignee, tags,
attachments, and Workday-computed tax are left out on purpose. `dueDate` is
`Due_Date_Override`, set from the printed due date; it is absent when Workday
derives the due date from payment terms, and it is a material field. On an
enrich invoice the agent owns it like any other field: when the enrich write
changed the override from the baseline, a later AP change counts against the
agent. Snapshots saved before `dueDate` was scored have no value for it, so on
create and resend invoices written before then, any override on a later read
(one AP set, or one already on a resent draft) counts as a change, while on enrich
invoices written before then it is not agent-owned, because neither that
baseline nor that snapshot recorded it.

## Daily scoring

`ScoreInvoices` (01:00 UTC: 8pm Central in daylight time, 7pm in standard time) reads status for non-terminal agent invoices in WQL
batches and Event-invokes `ScoreInvoicesProcessor` for invoices that reached a
stage they were not scored for, at most `SCORE_MAX_INVOICES_PER_RUN` (default
500) per run; the rest are selected again the next day. Status is read for at
most twice that many pending invoices, least recently checked first
(`agent_invoice_status_checks`, created by the job), so every pending invoice gets a
turn. A WID
missing from WQL is not in Workday.

`classifyStatus` (`src/lib/invoice_score.ts`) maps status to a stage; any status
that is not Draft, approved, paid, denied, or canceled counts as entered by AP,
and the processor logs one that is not in `SCORE_ENTRY_STATUSES` either.
`SCORE_DRAFT_STATUSES`, `SCORE_ENTRY_STATUSES`, `SCORE_APPROVED_STATUSES`,
`SCORE_DENIED_STATUSES`, and `SCORE_CANCELED_STATUSES` override the confirmed
defaults (Draft, In Progress, Approved, Canceled; Denied assumed).

| Stage | What the processor stores |
| --- | --- |
| Draft | Nothing until `SCORE_STUCK_DRAFT_DAYS` (default 14), then `stuck_draft` (not terminal). |
| Entered | Entry diff against the latest agent snapshot: `submitted_clean` or `submitted_edited`. |
| Approved, paid, denied | Late diff against the entry read, then terminal. |
| Canceled, not found | `canceled` or `deleted` with cancel attribution, terminal. |

Each stage is written once, and the upsert never reopens a terminal row.

`MATERIAL_FIELDS` (including `dueDate`) count against the agent; `CONVENTION_FIELDS` (memos, item
description, supplier invoice number) are reported apart, so an invoice with
only convention changes is `submitted_clean`. On an enrich invoice a change
counts only when the agent changed that field from the OCR baseline
(`agentOwned`); without a saved baseline, nothing counts against the agent.

### Cancel attribution

No Workday cancel reason points at the agent, so `attributeCancel` relies on
evidence and leaves anything unproven `unattributed`. The rule order and
`CancelBasis` values live in `src/lib/invoice_score.ts`. Points that are easy to
miss:

- The cancel reason comes from `Invoice_Cancel_Reason_Reference` on the
  canceled invoice; `SCORE_CANCEL_REASON_WQL_FIELD` is only a fallback.
- `CANCEL_REASON_ATTRIBUTION` (`CancelReasonAttribution` parameter) maps reason
  names or IDs. The template default maps Order Canceled and Alternate Payment
  Method Used to business and Workday's `DUPLICATE` to the agent; Incorrect
  Supplier and Invoiced in Error stay unmapped. The sandbox shares production's
  IDs.
- When the canceled invoice cannot be read and no cancel reason is known, the
  cancel stays `unattributed` (`invoice_unreadable`) unless AP labeled it.
- A `replacement` needs the canceled invoice's supplier WID, so no replacement
  is looked for when that invoice could not be read. The lookup uses
  `SCORE_SUPPLIERS_INVOICE_NUMBER_WQL_FIELD`, set in `template.yml` on
  `ScoreInvoicesProcessor`. Configured WQL field names must be plain aliases.
- `duplicate` compares each other invoice's latest agent snapshot only.
- `supplier_void_or_credit` needs `INTERCOM_ACCESS_TOKEN` and counts only
  supplier messages (Intercom author `user`, `lead`, or `contact`, not notes);
  AP replies and internal notes never clear the agent.

`template.yml` sets only `SCORE_SUPPLIERS_INVOICE_NUMBER_WQL_FIELD`
(`suppliersInvoiceNumber`, on `ScoreInvoicesProcessor`) and
`SCORE_TENANT_REFRESH_WEEKDAY` (global). Every other `SCORE_*` setting,
including `SCORE_HOLD_REASON_WQL_FIELD` and `SCORE_CANCEL_REASON_WQL_FIELD`, is
unset; add it under `Environment` on both `ScoreInvoicesFunction` and
`ScoreInvoicesProcessor` when needed.

AP records its call on an unattributed cancel with a `cancel_labels` row
(`attribution` `agent` or `business`). A label set before scoring decides the
attribution; a later label is applied by the digest (basis `ap_label`).

## Touches

A touch is one agent-owned field AP changed on an invoice AP submitted, before
or after submit (`touchCount` in `src/lib/score_touches.ts`). Cancels, deletions,
and stuck Drafts are not bucketed. Buckets are `TOUCH_BUCKETS` (0, 1–3, 4–10,
11–20, 21+).

Every audit post leads with the zero-touch share, the change from the previous
period, a bar per bucket, sparklines, and a QuickChart line chart
(`SCORE_CHART_BASE_URL`, `none` turns it off). Daily periods are Central
calendar days; weekly periods are complete Monday-to-Sunday Central weeks, so
the Monday digest leads with last week. If Slack answers `ok: false` because it
cannot load the chart, `postSlackChannelMessage` resends once without image
blocks. An HTTP 429 (Slack did not post) is resent once after its `Retry-After`
when that is within 5 seconds; other failures are not resent.

`ensureTouchReporting` (`src/lib/touch_reporting.ts`) creates the
`agent_invoice_touch_daily` table and, only when missing, the
`agent_invoice_touches` view at cold start. A failure there is logged and never
blocks invoice processing. Because an existing view is never replaced, changing
its columns needs a migration that drops it first. Each `ScoreDigest` run
recomputes the last 15 days of the table. Both live in the VPC-only Aurora
cluster.

## Audit posts

`ScoreDigest` posts only to `AUDIT_SLACK_CHANNEL_ID` through `chat.postMessage`
with the `AUDIT_SLACK_BOT_TOKEN` bot token (`/finance-agent/audit-slack-bot-token`).
The channel comes from CircleCI (`AuditSlackChannelId`: `C0C6VS0BDPA` dev,
`C0C5W6B0G4V` prod). Its own error alerts go to the operator channel like every
other Lambda. A post that does not go through stops the run with an error, and
so does a failed rollup refresh (after posting). Invoice values are escaped, so
memo text cannot mention the channel or add links.

- Daily (01:20 UTC, 9:20pm Eastern in daylight time, `{"mode":"daily"}`): the touch lead (the Central day) as a
  top-level message, then, as replies in its thread, one message per invoice
  scored since the last full daily post
  (`agent_invoice_audit_posts`, created by `ScoreDigest`; at most a week back,
  today on the first run), so scores from processors that finish after the post
  go in the next one. Before → after values, about a second apart. Up to
  `MAX_DAILY_INVOICE_MESSAGES` invoice messages; a closing reply counts the rest
  and any sandbox-refresh removals. If the lead fails or comes back without a
  `ts`, no replies are sent. Nothing is posted when nothing was scored or
  removed.
- Weekly (Mondays 14:30 UTC): a single top-level message (no thread) holding the touch lead, then the last complete
  Monday-to-Sunday Central week against the week before (`digestWindow`), so
  Sunday evening's scoring run (01:00 UTC Monday) is reported in that Monday's digest: outcomes,
  per-field change rates, edit rate by release, late corrections, cancels,
  convention examples, worst invoices, unlabeled cancels, and a count of
  agent-tagged invoices with no snapshot (or a note when that query fails).
  The agent coverage section follows the title (see Coverage).

## Coverage

The KPI is the share of PGA Corp supplier invoices created in a period that the
agent created or enriched (`src/lib/invoice_coverage.ts`). Sections create their
own invoices and are out of scope, so the WQL filters `company1` to
`COVERAGE_COMPANY_WIDS` (comma-separated company WIDs; defaults to the six PGA
Corp companies in `DEFAULT_COVERAGE_COMPANY_WIDS`, without PGA Golf Club).

- Source: one WQL query over `supplierInvoices` for `createdOn` padded by a day
  on each side, run with `requireCompleteTotal` so a short page fails the
  refresh instead of shrinking the denominator. Each invoice is placed on its
  Central day from `createdDateTime` (UTC), falling back to `createdOn`.
- Agent supported: the invoice has a row in `agent_invoice_snapshots` or carries
  the `FINAGENT-invoice-modified` tag (AP can replace the tag; older invoices
  predate snapshots). Only `AGENT_WRITE_SOURCES` snapshots count: an
  `enrich_baseline` row is saved before the update and stays behind when it
  fails, so a baseline-only invoice is not agent supported. `agent_created` is a
  `create` or `resend_update` snapshot, `agent_enriched` only `enrich`
  snapshots, `agent_notes_only` the tag alone.
- `invoiceCreatedBy` does not identify agent invoices: on them it is the AP
  teammate who started the Intercom action, and it is sometimes blank. It only
  splits the rest: `uncovered_ocr` (Workday OCR never enriched),
  `uncovered_manual` (a worker keyed it), `uncovered_integration` (no creator,
  such as Amazon and ODP batches).
- Canceled invoices are checked first and stay out of the share
  (`canceled`); companies outside the scope are `out_of_scope`. The headline
  share counts everything else; a second share leaves the integration invoices
  out of the denominator.
- Supplier Invoice Requests had no invoices in any company since 2025-01-01, so
  there is no category for them.
- `agent_invoice_coverage_daily` (`ensureCoverageReporting`, created at cold
  start) holds one row per Central creation day. The weekly `ScoreDigest` run
  recomputes the last 15 days (every 7 days, so no gap); the first run
  backfills 90. The nightly daily run does not touch it, so a Workday error
  never alerts on the daily run. A failed refresh is reported after posting
  and fails the run, like the touch rollup: on the weekly run that is a
  Workday or token problem, and the post itself went out.
- Rows older than 15 days keep the scope they were computed with. After
  changing `COVERAGE_COMPANY_WIDS`, invoke `ScoreDigest` with
  `{"coverageBackfill":true}` to rewrite the last 90 days in place (no truncate
  needed). The run posts the weekly digest as usual; adding
  `"mode":"daily"` posts the daily summary instead, which posts nothing when
  no invoice was scored since the last daily post.
- The weekly digest shows the share against the week before, the counts per
  category, the invoices created for other companies, the top suppliers the
  agent missed, who keyed by hand with their agent counts, and up to ten
  uncovered invoice links, one per person in turn. It is skipped on the sandbox
  refresh weekday, and says coverage is unavailable when the Workday query
  fails.

## Sandbox refresh (dev only)

The implementation tenant is overwritten with production every Saturday.
`SCORE_TENANT_REFRESH_WEEKDAY` (`TenantRefreshWeekday`: `6` in dev, `none` in
prod) makes `ScoreInvoices` skip that day, closes invoices that vanished in the
refresh as `Lost to tenant refresh` without cancel attribution, and keeps them
out of the cancel and pre-snapshot counts. A real deletion in the sandbox is
also recorded as lost to the refresh, so judge accuracy from production scores.

## Eval cases

`npm run export:eval-cases -- --out cases.jsonl [--since YYYY-MM-DD] [--include-messages]`
writes each `submitted_edited` invoice as a JSON Lines case (`src/lib/eval_cases.ts`).
The file is created owner-only and never overwritten; delete it after the eval
run. `--include-messages` adds the Intercom conversation and needs
`INTERCOM_ACCESS_TOKEN`. It needs a route to the Aurora cluster.

## Gotchas

- Invoices written before snapshots shipped only appear in the weekly
  outcome-only count.
- A resend update still overwrites AP edits on a Draft invoice; scoring only
  records them in `pre_write_diff`.
- Invoice links in the posts need `WORKDAY_UI_BASE_URL` and `WORKDAY_TENANT`.
