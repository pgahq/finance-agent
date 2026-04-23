# ADR 0001: Finance Agent — serverless architecture for Workday invoice enrichment

## Status

Accepted

## Date

2026-04-22

## Context

The Finance Agent (`finance-agent`) automates accounts-payable work against **Workday**: find supplier invoices that need attention, pull attachments and metadata, run **AI-assisted** supplier matching with **RAG** over a local supplier corpus, optionally **write back** to Workday (SOAP), and **notify** operators. The workload is **integration- and batch-oriented** (invoked Lambdas processing backlogs and deltas), not an interactive product surface.

That forces a few cross-cutting concerns: **multiple Workday APIs** (WQL for discovery and bulk reads; SOAP for invoice documents, attachments, and submits), **long-running steps** (embedding batches, PDF rasterization, model calls) within Lambda limits, **durable side data** (vectors, attachments, audit), **shared network** constraints (existing VPC), and **failure isolation** (e.g. Workday validation faults that must not retry forever).

Without a written decision, new work in this repository tends to re-litigate the same questions: where queries live vs. where mutation and AI run, how to paginate large WQL results, how to persist embeddings, and how to handle known-bad invoices. This ADR fixes those **idioms for future features**, not the behavior of a single user-facing feature.

## Decision

**We adopt a serverless, split-handler architecture on AWS** as the default way to build Finance Agent capabilities.

Concretely:

1. **Deploy and runtime** — **AWS SAM / CloudFormation**, **Node.js 20** Lambdas in the VPC imported from the **`pgagent`** stack (subnets and security groups shared with that footprint). **CircleCI** deploys; **`@pga/lambda-env`** and **`@pga/logger`** are the standard runtime bootstrap.

2. **Query vs. processor** — **Query** Lambdas run Workday WQL (and similar read paths), optionally paginate, and **asynchronously invoke** **processor** Lambdas per page or with a delegated query (`pageSize: null` so the processor runs WQL itself). Processors own **OpenAI**, **PostgreSQL**, **S3**, **SOAP** reads/writes, and **DynamoDB** where applicable. New bulk or multi-step flows should extend **`withQueryHandler` / `withProcessorHandler`** in `src/lib/handlers.ts` unless this ADR is superseded.

3. **Data plane** — **Aurora PostgreSQL** (including **pgvector**) for application and RAG data; **S3** for derived invoice imagery and presigned model access; **DynamoDB** for the **enrich-path validation skip registry** only (partition key `invoiceWorkdayID`); secrets via **SSM Parameter Store** and **Secrets Manager** (database password).

4. **Workday writes** — All supplier-invoice mutations go through **Resource Management SOAP** (`Get_Supplier_Invoices` then **`Submit_Supplier_Invoice`** with merged `Supplier_Invoice_Data`, **`Submit: false`** in our payload builder). WQL is not used for writes.

5. **PDF in Lambda** — Invoice PDF handling uses a **Poppler** Lambda **layer** on the enrich processor for rasterization; new code that needs PDF-to-image should reuse that pattern.

### Alternatives considered

- **Single Lambda per flow** — Simpler mentally, but risks timeout on large WQL pages and mixes read pagination with heavy processing; rejected for operability at scale.
- **Long-running service (ECS/EC2)** — More control over warm connections and long jobs; rejected in favor of managed scale-to-zero and alignment with existing PGA Lambda + SAM usage for this class of integration.
- **Writes via WQL or custom REST only** — Workday supplier invoice updates are not expressed that way in our integration; SOAP submit after GET is the supported path we standardize on.

## Architecture

The following diagrams document the decided shape; they are **illustrative detail**, not a second decision.

### Process topology: compute, data, and integrations

```mermaid
flowchart TB
  T["Entry<br/>Lambda invoke"]

  subgraph Compute["AWS Lambda (VPC)"]
    Q["Query handlers<br/>WQL + pagination"]
    P["Processor handlers<br/>AI, DB, S3, SOAP"]
    R["Retrieval<br/>RAG queries"]
    O["Other handlers<br/>e.g. validation rules"]
  end

  subgraph Data["Managed data services"]
    PG[("Aurora PostgreSQL<br/>+ pgvector")]
    S3["S3 bucket<br/>invoice images / artifacts"]
    DDB[("DynamoDB<br/>validation failures")]
  end

  subgraph External["External integrations"]
    WD["Workday<br/>WQL / REST / SOAP"]
    OAI["OpenAI<br/>chat + embeddings"]
    SL["Slack webhooks"]
  end

  subgraph Platform["Platform & secrets"]
    SSM["SSM Parameter Store"]
    SM["Secrets Manager<br/>(DB password)"]
  end

  T --> Q
  T --> O
  T --> R
  Q -->|"InvokeFunction (async)"| P
  P --> WD
  P --> OAI
  P --> PG
  P --> S3
  P -->|"EnrichInvoiceProcessor only<br/>GetItem / PutItem"| DDB
  R --> PG
  R --> OAI
  Q --> SSM
  P --> SSM
  P --> SM
  P --> SL
  Q --> SL
```

### Query / processor collaboration

```mermaid
sequenceDiagram
  autonumber
  participant Tr as Trigger<br/>(invoke)
  participant QF as Query Lambda
  participant WD as Workday WQL
  participant PF as Processor Lambda
  participant DDB as DynamoDB<br/>validation skip registry
  participant Ex as External deps<br/>(OpenAI, Aurora, S3, SOAP)

  Tr->>QF: Invoke handler
  QF->>QF: setupContext() via withQueryHandler
  QF->>WD: executeWorkdayQuery()
  WD-->>QF: Rows + totals
  loop Each page
    QF->>PF: InvokeFunction (Event)<br/>Payload: data[], page, totalPages
    PF->>PF: setupContext() via withProcessorHandler
    opt EnrichInvoiceProcessor path
      PF->>DDB: GetItem by invoiceWorkdayID
      alt Item exists
        DDB-->>PF: Item found
        Note over PF: Early return — skip processing
      else No item
        DDB-->>PF: No item
        PF->>Ex: Process batch (AI, persistence, files)
        opt Workday validation error
          PF->>DDB: PutItem (invoiceWorkdayID, createdAt, errorMessage)
        end
      end
    end
  end

  Note over PF,DDB: Other processor Lambdas do not use this table.
  Note over QF,PF: Alternate mode: pageSize null sends {query}<br/>and processor runs WQL itself.
```

### Invoice enrichment data path (conceptual)

```mermaid
flowchart LR
  WQL["Workday WQL<br/>candidate invoices"]
  DDB1[("DynamoDB<br/>skip registry<br/>GetItem")]
  PROC["EnrichInvoiceProcessor"]
  SOAP["Workday SOAP<br/>attachments + detail"]
  PDF["Poppler / pdftocairo<br/>PDF → images"]
  S3["S3 presigned URLs"]
  AI["OpenAI (vision + tools)"]
  VDB[("PostgreSQL<br/>hybrid / vector search")]
  WD2["Workday SOAP<br/>Submit_Supplier_Invoice"]
  DDB2[("DynamoDB<br/>PutItem on<br/>validation fault")]
  SL["Slack status"]

  WQL --> DDB1
  DDB1 -->|"not skipped"| PROC
  PROC --> SOAP
  SOAP --> PDF
  PDF --> S3
  S3 --> AI
  VDB --> AI
  AI --> WD2
  WD2 -->|"validation error"| DDB2
  PROC --> SL
```

### DynamoDB: validation-failure skip registry (enrich path)

**Problem** — Some invoices hit **Workday validation faults** (SOAP `Validation_Fault` shape or message text matching a validation pattern). Retrying the same invoice on every processor run would spam errors and waste capacity without fixing the underlying Workday data.

**Table** — CloudFormation defines `InvoiceValidationFailuresTable` (`template.yml`): partition key **`invoiceWorkdayID`** (string), on-demand billing. Only **`EnrichInvoiceProcessor`** receives `INVOICE_VALIDATION_FAILURES_TABLE_NAME` and IAM for `dynamodb:GetItem` / `dynamodb:PutItem` on that table.

**Write (record failure)** — In `processInvoice`, if any thrown error passes `isWorkdayValidationError`, the processor calls `recordInvoiceValidationFailure`, which **`PutItem`s** an item:

- `invoiceWorkdayID` — Workday invoice WID (same as the table key).
- `createdAt` — ISO timestamp when the failure was recorded.
- `errorMessage` — truncated summary of the fault (for debugging; max ~1000 chars).

The handler **returns without rethrowing**, so Lambda does not retry this invocation as a hard failure for that path.

**Read (avoid retry loop)** — At the start of `processInvoice`, **`GetItem`** by `invoiceWorkdayID`. If an item exists, processing **returns immediately** (no Workday GET, no AI, no submit). The invoice can still appear in WQL results, but the processor becomes a cheap no-op until the DynamoDB row is removed or the invoice drops out of the query scope.

**Scope** — Only **validation-class** Workday errors are recorded. Other errors are rethrown (normal Lambda retry / DLQ behavior applies per function configuration). Clearing a stuck invoice requires **operational removal** of the DynamoDB item (or a future admin tool); that is intentionally out of band so bad data does not loop forever.

```mermaid
flowchart TD
  A[processInvoice starts] --> B{GetItem<br/>invoiceWorkdayID}
  B -->|item exists| Z[Return — skipped]
  B -->|no item| C[Enrich + Workday SOAP]
  C --> D{Error?}
  D -->|no| E[Done]
  D -->|yes| F{isWorkdayValidationError?}
  F -->|yes| G[PutItem skip record]
  G --> H[Return — no rethrow]
  F -->|no| I[Rethrow — Lambda retry]
```

### Workday writes: payload, transport, and when they run

Reads use **WQL** (`GET` to `/api/wql/v1/.../data` with a bearer token). **Mutations to supplier invoices** do not use WQL; they use the **Resource Management** SOAP web service (`Resource_Management.wsdl`, endpoint `.../Resource_Management/v44.1`) with **OAuth2 bearer** security (`strong-soap` + `BearerSecurity`), same token source as WQL (`getAccessToken`).

Every invoice update follows the same mechanical pattern in `src/lib/workday.ts`:

1. **Load current state** — `Get_Supplier_Invoices` (SOAP) returns the existing `Supplier_Invoice` document (header, lines, work queue data, etc.).
2. **Build replacement data** — `buildSubmitInvoiceData` merges the current invoice with intended changes. The payload sets **`Submit: false`** so Workday treats the call as an in-place supplier-invoice update path (not “submit this document for approval” in the boolean sense of that field name—see Workday web service docs for exact semantics).
3. **Post the change** — `Submit_Supplier_Invoice` with `Submit_Supplier_Invoice_Request` containing `Supplier_Invoice_Reference` (invoice **WID**) and `Supplier_Invoice_Data` (the merged structure).

**What goes into `Supplier_Invoice_Data` (high level)** — largely a **round-trip** of the current invoice plus deltas:

- **Identity / amounts** — `Company_Reference`, `Currency_Reference`, `Invoice_Number`, `Control_Amount_Total`, optional tax/freight/discount fields, ship-to, on-hold/prepaid flags, currency rate data, etc., copied from the GET response so Workday receives a coherent document.
- **Supplier** — `Supplier_Reference` is set from the AI-resolved **`Supplier_ID`**, or from configured fallbacks (for example `WORKDAY_DEFAULT_SUPPLIER_ID` when tagging “no supplier”).
- **Dates** — `Invoice_Date` is resolved from AI-extracted date when provided, otherwise first day of current UTC month; `Invoice_Received_Date` preserved when present.
- **Lines** — `Invoice_Line_Replacement_Data` is rebuilt from existing lines (with tax data stripped per mapping); optional **fallback worktags** (`FALLBACK_FUND_ID`, `FALLBACK_COST_CENTER_ID`) are merged onto lines that have spend/item references when those env vars are set.
- **Payment terms** — uses existing `Payment_Terms_Reference` or `FALLBACK_PAYMENT_TERMS_ID` when missing on the invoice.
- **Human-visible audit** — `Memo` and/or `Work_Queue_Information_Data` with **work queue notes** (agent text prefixed with `FINANCE AGENT:`) and optional **work queue tags** (WIDs from `WORKDAY_AGENT_MODIFIED_TAG_WID`, `WORKDAY_AGENT_NO_SUPPLIER_TAG_WID`).

**Application entry points** (all ultimately call `client.Submit_Supplier_Invoice`):

| Function | Typical use | Supplier / tags / notes |
| --- | --- | --- |
| `updateSupplierInvoiceSupplier` | High-confidence match | Sets supplier to resolved **Supplier_ID**; adds **agent-modified** tag when `WORKDAY_AGENT_MODIFIED_TAG_WID` is set; merges **notes** and optional **memo** / **invoice date**. |
| `addNoSupplierTagToInvoice` | `not_found`, `ambiguous`, `error` when modifications allowed | Sets supplier reference from **`WORKDAY_DEFAULT_SUPPLIER_ID`**; adds **no-supplier** tag; notes/memo/date as provided. |
| `updateVerifySupplierInvoiceData` | Verification-only outcomes, or when modifications disabled | Keeps supplier from current invoice (unless default path in builder applies); updates **notes/memo/date** and optional agent-modified tag. |

The **enrich invoice** processor (`src/enrich_invoice.ts`) chooses among these based on AI `status` and **`INVOICE_MOD_ENABLED`** (defaults to enabled unless env is `'false'`). **Supplier assignment and work-queue tag changes are only attempted for invoices in `Draft`** (`invoiceStatusAsText === 'Draft'`); non-draft invoices still receive **notes-only** updates via `updateVerifySupplierInvoiceData`. A standalone local script `src/update-invoice-supplier.ts` can call `updateSupplierInvoiceSupplier` for manual fixes.

```mermaid
sequenceDiagram
  autonumber
  participant L as EnrichInvoiceProcessor
  participant DDB as DynamoDB skip registry
  participant RM as Workday Resource Management SOAP
  participant INV as Supplier Invoice (Workday)

  L->>DDB: GetItem(invoiceWorkdayID)
  alt Skip registry hit
    DDB-->>L: Item present
    Note over L: Exit — do not retry enrichment
  else Continue
    DDB-->>L: No item
    L->>RM: Get_Supplier_Invoices (WID)
    RM-->>INV: Read current document
    INV-->>L: Supplier_Invoice payload

    Note over L: buildSubmitInvoiceData<br/>(merge deltas, Submit false)

    L->>RM: Submit_Supplier_Invoice<br/>(Supplier_Invoice_Reference + Supplier_Invoice_Data)
    alt Validation fault
      RM-->>L: Validation error
      L->>DDB: PutItem(invoiceWorkdayID, createdAt, errorMessage)
      Note over L: Return — no rethrow
    else Success
      RM-->>L: OK
    end
  end
```

```mermaid
flowchart TD
  D{Draft status?}
  M{INVOICE_MOD_ENABLED?}
  S{supplier.status}
  NotesOnly["updateVerifySupplierInvoiceData<br/>(notes / memo / date)"]
  UpdSupp["updateSupplierInvoiceSupplier<br/>supplier + tags + notes"]
  NoTag["addNoSupplierTagToInvoice<br/>default supplier + no-supplier tag + notes"]

  D -->|no| NotesOnly
  D -->|yes| M
  M -->|no| NotesOnly
  M -->|yes| S
  S -->|found| UpdSupp
  S -->|not_found, ambiguous, error| NoTag
  S -->|matching, different, uncertain| NotesOnly
```

## Consequences

### Positive

- **Operational isolation** — Query Lambdas stay short-lived; long work runs in processors with tailored timeouts/memory (for example, higher timeout on supplier cache processors).
- **Horizontal scale** — Each page invokes a separate processor execution, which maps naturally to large Workday datasets without a single oversized Lambda run.
- **Security posture** — No public database; Lambdas and Aurora sit in private subnets with least-privilege IAM, SSM-backed secrets, and generated DB passwords in Secrets Manager.
- **Observable boundaries** — Clear CloudWatch log groups per function; Slack notifications can attribute failures to query vs. processor stages.
- **Validation fault circuit breaker** — DynamoDB gives a cheap, idempotent “do not process this invoice again” flag for known-bad Workday payloads without changing WQL or Workday configuration.

### Negative / trade-offs

- **Distributed system complexity** — Async invokes add eventual consistency, duplicate-processing idempotency concerns, and the need to trace across two log streams.
- **Skip registry operations** — Invoices recorded in DynamoDB stay skipped until the item is deleted; there is no automatic TTL in the documented stack, so operators must clear rows deliberately when Workday is fixed.
- **Cold start surface** — Many distinct functions and VPC ENI setup can add latency variance versus a single long-running service.
- **Coupling to shared VPC exports** — Stack imports from `pgagent` tie deployment ordering and network design to that parent stack.

### Follow-up (feature / operational detail — use a Tech Spec or runbooks, not this ADR)

- Model and provider selection, prompt versioning, and evaluation criteria.
- RAG similarity thresholds, reindexing cadence, and embedding model changes.
- Disaster recovery, multi-region posture, and DynamoDB TTL or purge tooling for the skip registry.

## References

- `template.yml` — deployed functions, IAM, Aurora, S3, DynamoDB, Poppler layer.
- `README.md` — narrative architecture and extended Mermaid flows.
- `src/lib/handlers.ts` — `withQueryHandler` / `withProcessorHandler` implementation.
- `src/lib/invoice_validation_failures.ts` — DynamoDB skip registry (`isWorkdayValidationError`, `recordInvoiceValidationFailure`, `isInvoiceMarkedForSkip`).
- `src/enrich_invoice.ts` — early exit on skip; catch path records validation failures.
