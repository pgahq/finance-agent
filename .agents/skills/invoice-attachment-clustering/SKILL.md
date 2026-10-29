---
name: invoice-attachment-clustering
description: >-
  Classify and cluster create-invoice PDFs before supplier-invoice processing
  (same invoice vs different invoices, supporting docs ride along) and dedupe
  conversation resends via the Postgres invoice registry. Use when changing
  attachment classification, clustering rules, the parse_invoice_attachments
  prompt, CreateInvoiceProcessor fan-out, resend update/skip behavior, or
  INVOICE_ATTACHMENT_CLUSTERING_ENABLED.
---

# Invoice attachment clustering

An Intercom conversation can hold several PDFs: the supplier invoice, backup
(packing slip, W-9, statement), and unrelated files. Without clustering, every
PDF becomes its own Workday supplier invoice. Clustering runs only on the
**create-invoice** path and only when `INVOICE_ATTACHMENT_CLUSTERING_ENABLED`
is exactly `true`. That env var resolves at runtime from SSM
`/finance-agent/invoice-attachment-clustering-enabled`, so AP can turn it on
or off without a release. A missing parameter leaves it off. Enrich-invoice is
unchanged.

## Modes (`invoiceAttachmentClusteringMode`)

| SSM value | Mode | Behavior |
| --- | --- | --- |
| `true` | `on` | Everything below: cluster, one invoice per cluster, resend dedupe. |
| `shadow` | `shadow` | Invoices are created one per PDF exactly as when off. The trigger also sends one extra grouped invoke with `shadow: true`; the processor classifies and clusters it and posts a `create_invoice_shadow` Slack message with the plan (would-create count, each cluster's invoice and supporting files, unrelated files). |
| anything else or missing | `off` | One invoice per PDF. |

Shadow exists to prove the classifier on real traffic with no write risk:

- A `shadow: true` record never enriches, never writes to Workday or the
  registry, and never fans out. The processor keys off the record, not its own
  flag, so containers with a different cached flag value still stay read-only.
- The trigger sends the per-PDF invokes first; a failed shadow invoke is only
  logged and never fails the 202.
- A shadow classification failure Slacks as `create_invoice_shadow` error and
  throws; the per-PDF invoices run in their own invocations and are unaffected.
- Shadow does not read or write the registry, so it reports clustering only,
  not resend decisions (the registry is only populated in `on`).
- Cost: one extra classification LLM call per triggered conversation.

## Flow

1. `TriggerCreateInvoice` (30s timeout) downloads, uploads to S3, and — when
   the flag is on — Event-invokes `CreateInvoiceProcessor` **once per
   conversation** with `attachments` metadata. Flag off keeps one invoke per
   PDF. The trigger never classifies.
2. `CreateInvoiceProcessor` loads the PDFs from S3 and calls
   `parseAndClusterInvoiceAttachments` (`src/lib/invoice_attachment_clustering.ts`):
   one structured LLM call (`src/prompts/parse_invoice_attachments_prompt.ts`,
   `tools: {}`, no RAG) over every file, then deterministic clustering in code.
3. The processor creates **one Workday invoice per invoice cluster**. It first
   records a cluster plan (`invoice_cluster_plans`, one `pending` row per
   cluster, `src/lib/invoice_cluster_plans.ts`), then Event-invokes itself
   (`clustered: true`, `planId`, `clusterIndex`, no re-parse) for each leftover
   cluster, then processes the first cluster inline, keeping the 840s timeout
   per invocation. The first cluster reuses the PDFs already downloaded for
   classification; fanned-out clusters download their own.
   - `withProcessorHandler` starts a deadline signal 20s before the Lambda
     limit (it logs the real remaining time when it fires). Only AI calls take
     the signal; S3, database, Workday, and Slack calls do not. Each AI stage
     also has its own cap (`src/lib/ai_budgets.ts`: clustering 120s, OCR 300s,
     second OCR read 150s, matching 300s, line merge 240s, covering retries;
     `maxRetries` 1; embeddings 30s) and logs `AI stage cap fired` when it
     trips. A run that would start inside the reserve posts a Slack error and
     stops before connecting to the database.
   - A run that runs out of time (deadline, stage cap, or the submit gate)
     fails with a `ProcessorDeadlineError` (`src/lib/deadline.ts`). A
     line-merge cap requeues instead of falling back to fallback-coded lines;
     other AI errors keep the fallback. `createInvoiceFromCluster` requeues
     the cluster once (`retryAttempt` 1, an immediate `fanOutCluster` Event
     invoke, no delay) only when a plan row exists, no Workday write started,
     the invoice claim was not contended, and the plan row was marked `failed`
     first. The invoice claim is released before the requeue, so the retry
     does not skip as "in progress elsewhere". The submit gate
     (`beforeWorkdayWrite`) refuses to start a Workday write with under 90s
     left, because Workday writes cannot be aborted. A second timeout posts a
     Slack message saying no invoice was created and a re-trigger is needed.
     The requeue never sets `Submit: true`; every invoice stays a draft.
   - Every cluster run claims its plan row (`pending`/`failed` → `processing`,
     or a `processing` row older than 20 minutes) before loading files, and
     marks it `done` (with the Workday invoice WID) or `failed`. A duplicate
     delivery of the same record finds the row taken and does nothing. Once
     Workday accepted the invoice, a later error still marks the row `done`,
     so it is never retried. A run that skipped because another run held the
     invoice claim returns the row to `pending`. A failure to mark the row
     `done` posts a Slack error, since the row becomes claimable again after
     the TTL.
   - The 20-minute takeover TTL (claims and plan rows) is longer than the
     processor timeout (840s; `template.test.ts` guards this), so a row or
     claim is only taken over after its owner was stopped.
   - Fan-out dispatches settle independently: a failed dispatch marks that row
     `failed` only if it is still `pending`, the first cluster still runs, and Slack posts one error naming
     the clusters that were not processed so a re-trigger picks them up
     (clusters already created are deduped by the registry).
4. Word and Excel attachments (`.docx`, `.xlsx`) cluster like PDFs. Classification and enrichment see them as PDFs converted in memory (`toModelDocument`); the stored original is what `Attachment_Data` sends. A file that cannot be opened is forced to `supporting` in code (whatever the model guessed from its name), so it is never a cluster primary unless nothing else is; when it still ends up first, the processor stops with an error Slack post instead of drafting from the email text. Unreadable backup files are listed in the Slack post under `*Not read*`.
   Enrichment receives every PDF in the cluster with document roles (invoice vs
   supporting); header, lines, and amounts come from the invoice file only.
5. `submitNewSupplierInvoice` sends the cluster's PDFs as `Attachment_Data`
   (invoice first), with the Intercom conversation transcript appended last.
   `buildSubmitInvoiceData` reverses the list in `Attachment_Data` because Workday
   lists attachments newest-first, so the invoice is shown first.
   Slack success lists cluster filenames plus kinds; errors list filenames.
   Older copies of a repeated document are not attached (see "Superseded
   copies" under the clustering rules); Slack lists them as `supersededAttachments`.

## Taxonomy (per file)

- `kind`: `supplier_invoice` | `supporting` | `unrelated`
- `supportingKind` (Slack/notes only): `packing_slip`, `w9`, `statement`,
  `terms`, `correspondence`, `other`
- Clustering keys: supplier name, supplier invoice number, PO, date, amount
  due, confidence, short reason

These kinds are **not** RAG `DOCUMENT_TYPES` — do not add them to the Postgres
`documents` type check.

`joinClassifications` joins model output back to S3 objects by `fileNumber`
(1-based input position), not by file name — resends often reuse a name such
as `Invoice.pdf`. It falls back to a unique file name, then to position when
counts match. A file the model skipped becomes `supporting` with confidence 0
so a dropped classification never creates an extra supplier invoice.

## Clustering rules (`clusterClassifiedAttachments`)

- Each `supplier_invoice` starts a cluster. Two invoice PDFs merge only when
  normalized invoice numbers match (`normalizeClusterInvoiceNumber`, case and
  whitespace insensitive) **and** suppliers agree or one side is missing.
  Supplier names compare after dropping punctuation, `&`/`and`, and legal
  suffixes (`Inc`, `LLC`, `Corp`, `Company`, `The`, ...).
  Different numbers, missing numbers, or disagreeing suppliers stay separate.
- Within a merged same-invoice group, the **latest-received** file is primary
  (`receivedAt` from the Intercom part `created_at`, source falls back to
  conversation `created_at`; missing counts as oldest, ties keep conversation
  order). Extraction, PO matching, and submit all key off the primary.
- **Superseded copies** (`dedupeClusterFiles`, after supporting files are
  assigned): when a document appears more than once in a cluster, only the
  latest copy is kept in `[primary, ...supporting]`; older copies go to
  `cluster.superseded` and are never loaded, enriched, or sent to Workday.
  A file is superseded when it is an invoice PDF of the primary's invoice
  that is **strictly older** than the primary (same-message PDFs, or PDFs
  with no `receivedAt`, are pages of one invoice and are all kept), or when a
  later file in the cluster has identical bytes (`contentHash`, SHA-256
  computed in `parseAndClusterInvoiceAttachments`). File names are never
  used, since scanners and phones reuse names such as `scan.pdf`. Latest means
  highest `receivedAt`, a missing time counts as oldest, and a tie goes to the
  later conversation position. In a cluster with a primary invoice the
  primary is never dropped; in the fallback cluster (no invoice found)
  byte-identical copies are set aside first, so the fallback primary is
  chosen from the latest copies only. Nothing is deduped across clusters.
  Classification still sees every file, and the conversation transcript
  still records the history. Dropped files are older than a kept copy of
  the same document, so the cluster's max `receivedAt` and the resend
  watermark are unchanged. The one exception is a byte-identical copy of the
  primary that the classifier called `supporting`: it is dropped even when
  newer, so an identical resend does not count as a newer file. The processor passes the dropped names as
  `supersededFileNames` (also on fan-out records) for Slack and shadow output
  only.
- `supporting` joins by invoice number, else PO
  (`normalizePurchaseOrderNumber`), else supplier; with exactly one invoice
  cluster it attaches there. With several clusters and no key match it falls
  back to the first candidate cluster.
- `unrelated` stays off invoice clusters and is listed in Slack. When no
  `supplier_invoice` exists, fall back to **one** cluster whose primary is a
  supporting file when there is one (highest confidence among those), else the
  most confident file, and attach the rest — never drop the conversation.
  Confidence is confidence in the kind, so a confidently `unrelated` file never
  outranks a supporting one.
- Parser throw: Slack-then-throw like other processor failures. Async retries
  stay off (`MaximumRetryAttempts: 0`).

## One PDF, several invoices

Clustering works per file: a PDF that bundles several supplier invoices (one per page) is one `supplier_invoice`, so one SUPIN is created from its first invoice and the rest are not entered. The classifier does not look inside the file. Instead OCR lists every invoice number in the primary file and `create_invoice` adds a review note to the Workday note and Slack telling AP to enter the rest manually (see `integrations-and-external-contracts`, "Several invoices in one PDF"). Splitting such a file into one SUPIN per invoice is not implemented.

## Resends: update instead of duplicating

A conversation can be triggered again after the supplier sends corrected or
missing documents. The processor keeps a Postgres registry
(`conversation_supplier_invoices`, keyed by conversation plus normalized
supplier invoice number) so a resend updates or skips instead of creating a
second supplier invoice. Exceptions are listed below: a different real
supplier, a canceled invoice re-sent with a newer document, no extracted
invoice number, and concurrent double-fires.

- Registry miss (or same number resolving to a **different** real supplier):
  create as usual, then upsert the registry row with the Workday WID/number,
  the resolved supplier WID, and the cluster's max `receivedAt` watermark.
- The configured default supplier (`WORKDAY_DEFAULT_SUPPLIER_WID`) means
  "not resolved", never "a different supplier". The registry stores only a
  real resolved supplier (null otherwise), and a supplier change counts only
  when both the registered and the newly resolved supplier are real and differ.
  A resend that moves resolution between default and real (for example once a
  W-9 arrives) updates the existing invoice, keeping the real supplier.
- The watermark is the newest of the cluster's `receivedAt` values and the
  conversation's `latestMessageAt` (newest source/part with a body or
  attachment; body-less assignments, custom actions, and Intercom **Message
  delivery failed** bounce notes do not count) at the last processing. The
  saved watermark only moves forward (`GREATEST` on upsert). The registry is the only source for create vs update; it
  never searches Workday for a matching supplier and invoice number.
- "Newer for this invoice" means one of:
  - a file in **this cluster** is newer than the watermark, or
  - `latestMessageAt` is newer **and** the newest message is not the one
    that brought a file for another cluster (`otherClustersLatestReceivedAt`,
    computed at parse time and passed to every fanned-out cluster, is older
    than `latestMessageAt`). A supplier reply or an AP note (for example coding
    instructions, which enrichment reads from the thread) can change the
    invoice with no new PDF, so it triggers a full update. A reply that brought
    another invoice is about that invoice, so it does not reprocess this one,
    but anything after it still counts. Unrelated files do not block. When neither
    the cluster's files nor the conversation have any known time
    (`receivedAt` and `latestMessageAt` both missing), treat it as newer.
- On every registry hit (same real supplier or unresolved), check the
  registered invoice's status via WQL (`getSupplierInvoiceEditability`) first.
  If AP **canceled** it or it is **no longer in Workday**, create a fresh
  supplier invoice only when **this cluster** has a newer file (the supplier
  re-sent it); repoint the registry row and note "Replaces canceled invoice X"
  in the work queue notes and Slack (`replacesCanceledInvoice`). A newer
  message alone never brings a canceled invoice back: skip with a `*Skipped*`
  note instead.
- Registry hit with nothing newer for this invoice: skip with a Slack
  `*Skipped*` note and a "skipped resend" headline (never "created"). No
  Workday write. Skips advance the row's watermark to the newest time seen, so
  a later text-only reply about this invoice still counts after an unrelated
  invoice arrived.
- Registry hit with newer documents: editability uses the same guards as
  enrich (Draft, not canceled, not paid/partially paid). Only explicit false
  values (`false`, `'false'`, `0`, `'0'`) count as not canceled or paid;
  missing or unexpected encodings fail closed as not editable, so an
  unrecognized canceled value goes to manual review rather than creating a
  duplicate. Editable → `submitSupplierInvoiceUpdate`
  with the latest cluster (lines, memo, company; assignee is left untouched)
  and bump the watermark. Each `Submit_Supplier_Invoice` call sets the
  invoice's full `Attachment_Data` — anything left out is dropped — so the
  update resends the latest copy of every cluster document (superseded older
  copies are dropped, so they leave the draft) plus a fresh
  conversation transcript that records the back-and-forth with the supplier.
  Never send only the new files on an update. Work queue notes and Slack
  (`newAttachments`) name the files received since the last processing. Not
  editable for another reason (approved, paid, partially paid, unknown state)
  → skip with a `*Skipped*` note naming manual review,
  `needsManualReview: true`, and a "needs manual review" headline.
  Status-check errors fail closed (Slack error, throw).
- No invoice number printed on the document: the registry cannot key the
  invoice, so always create. The registry and claims key on the printed number
  (`result.extractedSuppliersInvoiceNumber`), never on a number generated for
  the Workday submit, so two unnumbered invoices from one supplier on the same
  day never share a row.
- Duplicate supplier invoice numbers: when Workday rejects a supplier invoice
  number already used for that supplier, the create stops and reports the
  original Workday validation message. It does not retry on the fallback
  supplier (`WORKDAY_DEFAULT_SUPPLIER_WID`) and is not flagged as a possible
  duplicate. The registry row records the resolved supplier as usual on
  successful creates.
- Registry writes never fail the invoice: a failed upsert after a successful
  create/update, or after a skip that advances the watermark, surfaces as
  `registrySync: failed` in the Slack details.
- Claims: after enrichment extracts the invoice number and before reading the
  registry, the run claims conversation plus number in
  `conversation_invoice_claims` (`acquireConversationInvoiceClaim`, insert or
  take over a claim older than 20 minutes, longer than the processor timeout).
  A run that finds a live claim skips with a Slack `*Skipped*` note
  (`inProgressElsewhere`, headline "another run is processing it") and never
  touches Workday or the registry. The claim is released (only by its token)
  after the create/update and registry write, including on failure. A cluster
  with no extracted invoice number cannot be claimed or registered; only its
  plan row protects it from duplicate deliveries.

## Flag discipline

- The toggle is a plain String SSM parameter created by hand in each account
  (`true` to enable, `shadow` for report-only). Do not add it to `template.yml` as an
  `AWS::SSM::Parameter` or pass it through CircleCI; a template-owned value
  would be reset by deploys. `@pga/lambda-env` resolves every `ssm:` env value
  in one `GetParameters` call (AWS limit: 10 names), so keep Global plus
  per-function SSM references at or under 10 (`template.test.ts` guards this).
- `lambda-env` caches values per container. A flip applies as new containers
  start; to apply immediately, update the functions' configuration. While
  containers disagree, the trigger and processor stay compatible: a processor
  with the flag off handles any `attachments` payload, grouped from the trigger
  or clustered from a fan-out, one PDF at a time.
- Read `INVOICE_ATTACHMENT_CLUSTERING_ENABLED` inside the handler after
  `loadEnv()`, via `invoiceAttachmentClusteringMode` or
  `isInvoiceAttachmentClusteringEnabled` (true only for `on`) — never as a
  module-level constant or an inline string compare. The helper lives in
  `src/lib/invoice_attachment_clustering_flag.ts` so the trigger can use it
  without importing the AI/RAG clustering module.
- Gate the whole path: trigger invoke shape, parse/cluster/fan-out,
  multi-file `Attachment_Data`, Slack cluster details, and tests for both
  states. The legacy single-`s3Key` request shape keeps working as a one-file
  cluster.
