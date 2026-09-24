---
name: invoice-attachment-clustering
description: >-
  Classify and cluster create-invoice PDFs (same invoice vs different invoices,
  supporting docs ride along, unrelated docs stay off) and report the plan in
  shadow mode. Use when changing attachment classification, clustering rules,
  the parse_invoice_attachments prompt, the create_invoice_shadow Slack report,
  or INVOICE_ATTACHMENT_CLUSTERING_ENABLED.
---

# Invoice attachment clustering

An Intercom conversation can hold several PDFs: the supplier invoice, backup
(packing slip, W-9, statement), and unrelated files. Today every PDF becomes
its own Workday supplier invoice. This module decides which PDFs belong to
which invoice.

It currently runs in **shadow mode only**: invoices are still created one per
PDF, and the grouping is reported to Slack so the classifier can be proven on
real traffic with no write risk. Creating one invoice per cluster is a
separate, later change.

## Mode (`invoiceAttachmentClusteringMode`)

`INVOICE_ATTACHMENT_CLUSTERING_ENABLED` resolves at runtime from SSM
`/finance-agent/invoice-attachment-clustering-enabled`, so it can be flipped
without a release.

| SSM value | Mode | Behavior |
| --- | --- | --- |
| `shadow` | `shadow` | Per-PDF invoices as usual, plus one report-only shadow record per conversation. |
| anything else, including `true` or missing | `off` | Per-PDF invoices only. |

## Shadow flow

1. `TriggerCreateInvoice` sends the normal one-invoke-per-PDF records first.
   In `shadow` it then sends one more Event invoke with `shadow: true`,
   `conversationId`, `intercomAppId`, and `attachments` (every uploaded file's
   metadata, including Intercom `receivedAt`). A failed shadow invoke is only
   logged and never fails the 202. The trigger never classifies.
2. `CreateInvoiceProcessor` routes any record with `shadow: true` to
   `reportShadowClustering`, whatever its own cached flag says, so a shadow
   record is read-only in every container. It loads the PDFs from S3 and calls
   `parseAndClusterInvoiceAttachments` (`src/lib/invoice_attachment_clustering.ts`):
   one structured LLM call (`src/prompts/parse_invoice_attachments_prompt.ts`,
   `tools: {}`, no RAG) over every file, then deterministic clustering in code.
3. It posts `create_invoice_shadow` to Slack: would-create count, each cluster's
   invoice file with its supporting files, unrelated files, and a note that
   nothing was written. It never enriches, never calls Workday, and never
   invokes other Lambdas.
4. A classification failure Slacks a `create_invoice_shadow` error and throws.
   Async retries stay off (`MaximumRetryAttempts: 0`). The per-PDF invoices run
   in their own invocations and are unaffected.

Cost: one extra classification LLM call per triggered conversation.

## Taxonomy (per file)

- `kind`: `supplier_invoice` | `supporting` | `unrelated`
- `supportingKind` (Slack only): `packing_slip`, `w9`, `statement`, `terms`,
  `correspondence`, `other`
- Clustering keys: supplier name, supplier invoice number, PO, date, amount
  due, confidence, short reason

These kinds are **not** RAG `DOCUMENT_TYPES` — do not add them to the Postgres
`documents` type check.

`joinClassifications` joins model output back to S3 objects by `fileNumber`
(1-based input position), not by file name — resends often reuse a name such
as `Invoice.pdf`. It falls back to a unique file name, then to position when
counts match. A file the model skipped becomes `supporting` with confidence 0
so a dropped classification never adds an extra invoice to the plan.

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
  order).
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

## Flag discipline

- The toggle is a plain String SSM parameter created by hand in each account.
  Do not add it to `template.yml` as an `AWS::SSM::Parameter` or pass it
  through CircleCI; a template-owned value would be reset by deploys.
  `@pga/lambda-env` resolves every `ssm:` env value in one `GetParameters` call
  (AWS limit: 10 names), so keep Global plus per-function SSM references at or
  under 10 (`template.test.ts` guards this).
- `lambda-env` caches values per container. A flip applies as new containers
  start; to apply immediately, update the functions' configuration.
- Read the mode inside the handler after `loadEnv()`, via
  `invoiceAttachmentClusteringMode` — never as a module-level constant or an
  inline string compare. The helper lives in
  `src/lib/invoice_attachment_clustering_flag.ts` so the trigger can use it
  without importing the AI/RAG clustering module.
- Shadow must stay write-free: any new shadow behavior needs a test proving no
  enrichment, Workday call, or Lambda invoke happens for a `shadow: true`
  record under every flag value.
