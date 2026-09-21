---
name: invoice-attachment-clustering
description: >-
  Classify and cluster create-invoice PDFs before supplier-invoice processing
  (same invoice vs different invoices, supporting docs ride along). Use when
  changing attachment classification, clustering rules, the
  parse_invoice_attachments prompt, CreateInvoiceProcessor fan-out, or
  INVOICE_ATTACHMENT_CLUSTERING_ENABLED.
---

# Invoice attachment clustering

An Intercom conversation can hold several PDFs: the supplier invoice, backup
(packing slip, W-9, statement), and unrelated files. Without clustering, every
PDF becomes its own Workday supplier invoice. Clustering runs only on the
**create-invoice** path and only when `INVOICE_ATTACHMENT_CLUSTERING_ENABLED`
is `true` (`InvoiceAttachmentClusteringEnabled` CFT parameter: `"true"` on
`deploy-to-dev`, `"false"` on `deploy-to-prod`). Enrich-invoice is unchanged.

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
   (invoice first). Slack success/error lists cluster filenames plus kinds.

## Taxonomy (per file)

- `kind`: `supplier_invoice` | `supporting` | `unrelated`
- `supportingKind` (Slack/notes only): `packing_slip`, `w9`, `statement`,
  `terms`, `correspondence`, `other`
- Clustering keys: supplier name, supplier invoice number, PO, date, amount
  due, confidence, short reason

These kinds are **not** RAG `DOCUMENT_TYPES` — do not add them to the Postgres
`documents` type check.

## Clustering rules (`clusterClassifiedAttachments`)

- Each `supplier_invoice` starts a cluster. Two invoice PDFs merge only when
  normalized invoice numbers match (`normalizeClusterInvoiceNumber`, case and
  whitespace insensitive) **and** suppliers agree or one side is missing.
  Different numbers, missing numbers, or disagreeing suppliers stay separate.
- `supporting` joins by invoice number, else PO
  (`normalizePurchaseOrderNumber`), else supplier; with exactly one invoice
  cluster it attaches there. With several clusters and no key match it falls
  back to the first candidate cluster.
- `unrelated` stays off invoice clusters and is listed in Slack. When no
  `supplier_invoice` exists, fall back to **one** cluster from the
  highest-confidence file (supporting preferred on ties) and attach the rest —
  never drop the conversation.
- Parser throw: Slack-then-throw like other processor failures. Async retries
  stay off (`MaximumRetryAttempts: 0`).

## Flag discipline

- Read `INVOICE_ATTACHMENT_CLUSTERING_ENABLED` inside the handler after
  `loadEnv()`, via `isInvoiceAttachmentClusteringEnabled` — never as a
  module-level constant.
- Gate the whole path: trigger invoke shape, parse/cluster/fan-out,
  multi-file `Attachment_Data`, Slack cluster details, and tests for both
  states. The legacy single-`s3Key` request shape keeps working as a one-file
  cluster.
