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
3. The processor creates **one Workday invoice per invoice cluster** inline for
   the first cluster and Event-invokes itself (`clustered: true`, no re-parse)
   for each leftover cluster, keeping the 300s timeout per invoice.
4. Enrichment receives every PDF in the cluster with document roles (invoice vs
   supporting); header, lines, and amounts come from the invoice file only.
5. `submitNewSupplierInvoice` sends the cluster's PDFs as `Attachment_Data`
   (invoice first), with the Intercom conversation transcript appended last.
   Slack success/error lists cluster filenames plus kinds.

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

## Resends: update instead of duplicating

A conversation can be triggered again after the supplier sends corrected or
missing documents. The processor keeps a Postgres registry
(`conversation_supplier_invoices`, keyed by conversation plus normalized
supplier invoice number) so a resend never creates a second supplier invoice:

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
  attachment; body-less assignments and custom actions do not count) at the
  last processing. The registry is the only source for create vs update; it
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
    but anything after it still counts. Unrelated files do not block. When no
    `receivedAt` is known at all, treat it as newer.
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
  update resends every cluster PDF (latest invoice version first) plus a fresh
  conversation transcript that records the back-and-forth with the supplier.
  Never send only the new files on an update. Work queue notes and Slack
  (`newAttachments`) name the files received since the last processing. Not
  editable for another reason (approved, paid, partially paid, unknown state)
  → skip with a `*Skipped*` note naming manual review,
  `needsManualReview: true`, and a "needs manual review" headline.
  Status-check errors fail closed (Slack error, throw).
- No extracted invoice number: the registry cannot key the invoice, so always
  create (current behavior).
- Possible duplicates: Workday rejects a supplier invoice number already used
  for that supplier, and the submit repair then retries with the default
  supplier. The retry stays, because it also rescues a wrong supplier match.
  With the registry on, a create that only succeeded after that rejection
  (`isDuplicateSuppliersInvoiceNumberMessage` on a prior failure plus a
  validation-driven supplier fallback) is flagged as a possible duplicate in
  the work queue notes and the Slack headline/body (`possibleDuplicate`), and
  the registry row records an unresolved supplier. This covers invoices the
  registry never saw (created before the flag, by AP, or in another
  conversation). `buildNotes` receives each attempt's prior failures for this.
- Registry writes never fail the invoice: a failed upsert after a successful
  create/update surfaces as `registrySync: failed` in the success Slack
  details. Concurrent double-fires can still race lookup-then-create; the
  unique key keeps the registry to one row (last write wins).

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
  with the flag off handles the clustered `attachments` payload one PDF at a
  time.
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
