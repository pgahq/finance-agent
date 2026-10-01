---
name: agent-invoice-scoring
description: >-
  Scores finance-agent supplier invoices against what AP finally saved in
  Workday: snapshots of each agent write, the daily ScoreInvoices job and
  processor, cancel attribution, and the weekly audit digest posted to
  #notify-finance-agent-audit. Use when changing agent_invoice_snapshots,
  agent_invoice_scores, cancel_labels, the scored-field whitelist, material vs
  convention fields, invoice status classification, CANCEL_REASON_ATTRIBUTION,
  SCORE_* settings, ScoreInvoices, ScoreDigest, AUDIT_SLACK_WEBHOOK_URL,
  snapshotSync, or what the create, resend-update, and enrich paths record
  after a Workday write.
---

# Agent invoice scoring

The score is what AP changed in Workday on the fields the agent is responsible
for entering. Workday's own audit trail is not read: it mixes the agent's
write, approval steps, and recalculated fields. Instead the agent saves what it
wrote, and the scorer diffs that against later reads.

## Snapshots (write path)

After every agent write, the processor reads the invoice back with
`Get_Supplier_Invoices` and stores `extractScoredFields` of it in
`agent_invoice_snapshots` (next `write_seq` per invoice).

| Source | Where | Notes |
| --- | --- | --- |
| `create` | `CreateInvoiceProcessor` after `submitNewSupplierInvoice` | Reuses the read-back create already does (`createdInvoice`), no extra call. |
| `resend_update` | `CreateInvoiceProcessor` after `submitSupplierInvoiceUpdate` on a resend | `previousInvoice` (the live read update already does) is diffed against the latest snapshot and stored as `pre_write_diff`: AP edits the update overwrote. One extra Get after the update. |
| `enrich_baseline` | `EnrichInvoiceProcessor` before the update | The invoice as OCR left it (`detailedInvoice`). Not an agent write. |
| `enrich` | `EnrichInvoiceProcessor` after `submitSupplierInvoiceUpdate` | One extra Get. The notes-only `annotateSupplierInvoice` path takes no snapshot. |

A snapshot never fails the invoice: `snapshotAgentWrite` and
`snapshotEnrichBaseline` catch everything and return false, and the Slack
message gains `snapshotSync: failed`. Each row carries `release_sha`
(`RELEASE_SHA` from the `ReleaseSha` template parameter, set to `CIRCLE_SHA1`
on deploy) and `clustering_mode`.

### Scored fields

`extractScoredFields` is the whitelist. Header: supplier, company, supplier
invoice number, invoice date, control total, memo. Each line: amount, PO line,
spend category, cost center, fund, line of business, other worktags (sorted),
memo, item description. References are keyed by their first non-WID ID
(`Supplier_ID=S-…`), else the WID. Notes, assignee, tags, attachments, the
conversation URL field, and Workday-computed tax are left out on purpose.

`diffScoredFields` pairs lines by same position and amount, then same amount
anywhere, then position; leftovers are `line.added` / `line.removed`. A
reorder alone is not a change.

## Daily scoring

`ScoreInvoices` (14:00 UTC) lists snapshots of non-terminal invoices, reads
status in batches of 50 through WQL (`workdayID in (…)`), and Event-invokes
`ScoreInvoicesProcessor` in groups of 20 for invoices that reached a stage
they were not scored for. A WID missing from WQL is treated as not in Workday.

`classifyStatus` (`src/lib/invoice_score.ts`): canceled flag or status, then
paid or partially paid, denied, approved, Draft; any other status counts as
entered by AP. Status text is tenant configuration, so `SCORE_DRAFT_STATUSES`,
`SCORE_APPROVED_STATUSES`, `SCORE_DENIED_STATUSES`, and
`SCORE_CANCELED_STATUSES` (comma-separated) override the defaults.

| State | What the processor does |
| --- | --- |
| Draft | Nothing until `SCORE_STUCK_DRAFT_DAYS` (default 14) after the last agent write, then `stuck_draft` (not terminal). |
| Entered (first non-Draft) | Entry diff against the latest agent snapshot; outcome `submitted_clean` or `submitted_edited`. |
| Approved, paid, denied | Late diff against the entry read, then terminal. Draft straight to terminal between runs uses the one read for both, with an empty late diff. Denied sets outcome `denied`. |
| Canceled, not found | Outcome `canceled` or `deleted`, cancel attribution, terminal. |

Each stage is written once and terminal rows are never rescored.

### Material vs convention

Material (counts against the agent): supplier, company, invoice date, control
total, line amount, PO line, spend category, cost center, fund, line of
business, other worktags, lines added or removed. Convention (reported apart):
header memo, supplier invoice number (composed from the HQ convention), line
memo, item description. An invoice with only convention changes is
`submitted_clean`.

For an enrich invoice, a change only counts against the agent when the agent
changed that field from the OCR baseline (`agentOwned`); added or removed lines
count when the agent changed line amounts or lines. AP fixing OCR text the
agent left alone is not an agent miss.

### Cancel attribution

No Workday cancel reason points at the agent today, so `attributeCancel` relies
on facts and leaves anything unproven `unattributed`. First match wins:

1. `cancel_labels` row (`ap_label`).
2. `CANCEL_REASON_ATTRIBUTION` agent reasons or `agentTags` work queue tags.
3. Business reasons, then duplicate reasons (agent).
4. `replacement`: a live invoice with the same supplier invoice number (and
   supplier WID when WQL returns it) that the agent did not write. Its fields
   are diffed against the agent snapshot so the miss still has a field score.
   Needs `SCORE_SUPPLIERS_INVOICE_NUMBER_WQL_FIELD`; skipped while unset.
5. `duplicate`: another agent invoice with the same supplier and supplier
   invoice number that is still live.
6. `wrong_document`: the primary attachment was classified `supporting` or
   `unrelated`; `per_pdf_without_clustering`: clustering was not `on` and the
   conversation produced more than one agent invoice.
7. `supplier_void_or_credit` (business): a conversation message after the first
   agent write mentions a void, credit memo or note, or disregarding the invoice.
   Needs `INTERCOM_ACCESS_TOKEN`; a failed read is skipped.
8. `early_draft_cancel` stays `unattributed`: canceled without AP submitting,
   no AP edits, within `SCORE_EARLY_CANCEL_HOURS` (default 72) of detection.
9. Otherwise `no_signal`.

The cancel reason comes from the canceled invoice itself:
`Get_Supplier_Invoices` returns a read-only `Invoice_Cancel_Reason_Reference`
(name from its `Descriptor`, IDs such as `INVOICE_CANCEL_REASON-3-3`).
`SCORE_CANCEL_REASON_WQL_FIELD` is only a fallback for when that read fails.

`CANCEL_REASON_ATTRIBUTION` is the `CancelReasonAttribution` template
parameter. Entries match a reason's name or any of its IDs, case-insensitively.
The sandbox is a copy of production, so the IDs are the same in both tenants
and the template default serves both:

| Reason | ID | Mapping |
| --- | --- | --- |
| Incorrect Supplier | `INVOICE_CANCEL_REASON-3-1` | unmapped: agent supplier match or supplier billing the wrong entity |
| Invoiced in Error | `INVOICE_CANCEL_REASON-3-2` | unmapped: supplier mistake or a backup document turned into an invoice |
| Order Canceled | `INVOICE_CANCEL_REASON-3-3` | business |
| Alternate Payment Method Used | `INVOICE_CANCEL_REASON-3-4` | business |

Unmapped reasons fall through to the evidence rules; AP labels on them show
whether either one should be mapped later. Adding an agent reason or tag is a
configuration change.

Optional WQL fields stay unset until confirmed in the tenant:
`SCORE_HOLD_REASON_WQL_FIELD`, `SCORE_SUPPLIERS_INVOICE_NUMBER_WQL_FIELD`, and
the `SCORE_CANCEL_REASON_WQL_FIELD` fallback. Without the hold field the score
records `On hold` from the Get `On_Hold` flag. None of the `SCORE_*` settings
is in `template.yml` yet; add them under `Environment` on `ScoreInvoicesFunction`
and `ScoreInvoicesProcessor` (both classify status) once the values are known.
Status text is confirmed: Draft, In Progress, Approved, Canceled (Denied
assumed), which the defaults already match.

To record AP's call on an unattributed cancel:

```sql
INSERT INTO cancel_labels (workday_invoice_wid, attribution, note, labeled_by)
VALUES ('<invoice WID>', 'agent', 'backup PDF became an invoice', 'ap@pgahq.com')
ON CONFLICT (workday_invoice_wid) DO UPDATE SET attribution = EXCLUDED.attribution, note = EXCLUDED.note;
```

A label set before the invoice is scored decides its attribution. A label on
an already-scored cancel leaves the stored score alone, but the digest applies
it (basis `ap_label`) and drops the invoice from the to-label list.

## Weekly digest

`ScoreDigest` (Mondays 14:30 UTC) posts to `AUDIT_SLACK_WEBHOOK_URL`
(`/finance-agent/audit-slack-webhook-url`, `#notify-finance-agent-audit` in
prod, `#notify-finance-agent-audit-dev` in dev). `postSlackBlocks` never falls
back to the per-invoice `SLACK_WEBHOOK_URL`. The post covers the trailing seven
days against the seven before: outcomes, per-field change rates (material
first), edit rate by release, late corrections, cancels by attribution and
basis, memo and supplier invoice number rewrite examples, the five worst
invoices, up to ten unlabeled unattributed cancels (early Draft first), and an
outcome-only count of `FINAGENT-invoice-modified` invoices with no snapshot.

## Sandbox refresh (dev only)

The implementation tenant is overwritten with production every Saturday, so
every invoice the dev agent wrote that week disappears, and production's
agent-tagged invoices appear. `SCORE_TENANT_REFRESH_WEEKDAY` (UTC weekday,
`TenantRefreshWeekday` parameter, `6` on `deploy-to-dev`, `none` on
`deploy-to-prod`) handles that:

- `ScoreInvoices` skips the refresh day.
- An invoice missing from WQL whose last agent write was before 00:00 UTC on
  the latest refresh day closes with final status `Lost to tenant refresh`, with
  no cancel attribution. One that never left Draft gets outcome
  `lost_to_refresh`; one AP had submitted keeps its entry score.
- The digest leaves those out of late corrections and cancels, reports them on
  their own line, and skips the outcome-only "before snapshots" count.

A real deletion in the sandbox is also treated as lost to the refresh. Dev
scores prove the jobs and queries work; production carries the real numbers.

## Eval cases

`tsx src/export-eval-cases.ts [--since YYYY-MM-DD] [--out cases.jsonl]` exports
every `submitted_edited` invoice as a JSON Lines case (`src/lib/eval_cases.ts`):
the S3 keys and attachment kinds the agent read, its PO lines, what the agent
submitted, what AP saved at entry, the misses (material and agent-owned), and
convention changes. With `INTERCOM_ACCESS_TOKEN` set, each case also carries
the conversation messages. It needs database access, so run it where the
Lambdas' Aurora cluster is reachable.

## Gotchas

- The scorer depends on snapshots; invoices written before they shipped only
  appear in the digest's outcome-only line.
- A resend update still overwrites AP edits on a Draft invoice; scoring only
  records them in `pre_write_diff`.
- The digest Lambda reads `WORKDAY_UI_BASE_URL` and `WORKDAY_TENANT` for
  invoice links, like the per-invoice Slack messages.
