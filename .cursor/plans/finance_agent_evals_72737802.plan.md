---
name: Finance Agent Evals
overview: 'Add three small, high-signal eval suites to finance-agent targeting production AI paths that are currently only mocked in Jest: validation fault classification, invoice line worktag merging, and supplier RAG retrieval.'
todos:
  - id: harness
    content: 'Add evals/ directory, RUN_EVALS gate, npm run eval script, shared case runner + score reporter'
    status: pending
  - id: eval-validation-classifier
    content: Seed ~10 validation fault cases; scorer for retryField accuracy; run-validation-field.test.ts
    status: pending
  - id: eval-line-merge
    content: Seed ~10 invoice/PO merge cases; per-field scorer; run-invoice-line-merge.test.ts calling buildFinalInvoiceLines
    status: pending
  - id: eval-supplier-rag
    content: Seed supplier docs + queries; extend getDatabaseConfig for EVAL_DATABASE_URL; seed script; Hit@1/Hit@3 scorer
    status: pending
  - id: eval-db-docker
    content: Add docker-compose.eval.yml (pgvector/pg15 on port 5433) and npm scripts eval:db:up, eval:db:down, eval:seed
    status: pending
  - id: docs
    content: Add README section for evals — EVALS_API_KEY, docker-compose.eval.yml, eval:seed, npm run eval
    status: pending
  - id: ci-eval-job
    content: Add CircleCI eval job with EVALS_API_KEY, pgvector service container, postgres wait loop, eval:seed, npm run eval
    status: pending
isProject: false
---
# Finance Agent Eval Plan

## Context

[finance-agent](.) is a TypeScript/AWS Lambda app that uses OpenAI (`gpt-5.4`, `gpt-5.4-mini`) via the Vercel AI SDK for invoice enrichment, line merging, and Workday submit retry logic. Today, all LLM calls are **mocked** in Jest ([`src/__tests__/ai.test.ts`](src/__tests__/ai.test.ts), [`src/__tests__/enrich_invoice.test.ts`](src/__tests__/enrich_invoice.test.ts)) — tests verify wiring, not model quality. There is no `evals/` directory or labeled dataset.

The three evals below are chosen because each:
- Maps to a **real production function** with a clear pass/fail signal
- Uses **JSON or text fixtures** (no PDF binaries to start)
- Is **small enough to seed by hand** (~8–15 cases each)
- Catches regressions that unit tests cannot

```mermaid
flowchart TB
  subgraph eval1 [Eval1_ValidationClassifier]
    Fault[Workday SOAP fault JSON] --> Classifier[classifyWorkdayValidationField]
    Classifier --> RetryField[retryField label]
  end

  subgraph eval2 [Eval2_LineMerge]
  LinesIn[extracted lines + PO lines JSON] --> Merge[buildFinalInvoiceLines]
  Merge --> Worktags[costCenter fund spendCategory PO lineId]
  end

  subgraph eval3 [Eval3_SupplierRAG]
  Query[supplier search query] --> RAG[queryDocuments supplier]
  RAG --> WID[expected workday_id in top3]
  end

  Enrich[enrichInvoice multimodal] -.->|"phase 2"| eval1
  eval3 --> Enrich
```

---

## Recommended eval harness (minimal)

Keep it inside the existing Jest + TypeScript stack rather than adding promptfoo/Braintrust on day one.

| Piece | Location | Notes |
| --- | --- | --- |
| Fixtures | `evals/fixtures/<name>.json` | One JSON file per eval; redacted real examples |
| Scorers | `evals/scorers/<name>.ts` | Pure functions, no LLM |
| Runner | `evals/run-<name>.test.ts` | Jest tests gated by `RUN_EVALS=1` |
| Setup | `evals/setup.ts` | Maps eval API key → `OPENAI_API_KEY` before imports |
| Script | `package.json` → `"eval": "RUN_EVALS=1 jest evals"` | Opt-in; CI job separate from `npm test` |

**Why Jest:** repo already has ts-jest ESM config ([`jest.config.js`](jest.config.js)); evals stay TypeScript-native and can import production code directly. Gate with `RUN_EVALS` so normal `npm test` stays fast and mock-only.

### API key handling

Production code reads `OPENAI_API_KEY` ([`src/lib/ai.ts`](src/lib/ai.ts), [`src/lib/rag.ts`](src/lib/rag.ts)). Evals use a dedicated secret so CI can run live model calls without exposing the production Lambda key.

**Resolution order** in `evals/setup.ts` (imported first from each eval runner):

```ts
process.env.OPENAI_API_KEY =
  process.env.EVALS_API_KEY
  ?? process.env.OPENAI_API_KEY
  ?? '';
```

| Environment | Key to set | Notes |
| --- | --- | --- |
| CircleCI eval job | `EVALS_API_KEY` | Already added to CircleCI project/context |
| Local dev | `EVALS_API_KEY` or `OPENAI_API_KEY` | Either works; prefer `EVALS_API_KEY` to match CI |
| Unit tests (`npm test`) | neither | Mocks only; no live calls |

If neither key is set when `RUN_EVALS=1`, eval runners should fail fast with a clear message.

### CircleCI integration

Add a separate `eval` job in [`.circleci/config.yml`](.circleci/config.yml) — **not** bundled into the existing `build` job (keeps PR builds fast and avoids accidental API spend).

The job runs all three eval suites. Evals 1–2 need only `EVALS_API_KEY`; Eval 3 uses an **ephemeral pgvector sidecar** (no `EVAL_DATABASE_URL` CircleCI secret).

```yaml
eval:
  working_directory: ~/app
  docker:
    - image: cimg/node:20.11.0
      environment:
        RUN_EVALS: "1"
        EVALS_API_KEY: $EVALS_API_KEY
        EVAL_DATABASE_URL: postgresql://postgres:postgres@localhost:5432/finance_agent_eval
    - image: pgvector/pgvector:pg15
      environment:
        POSTGRES_USER: postgres
        POSTGRES_PASSWORD: postgres
        POSTGRES_DB: finance_agent_eval
  steps:
    - checkout
    - run:
        name: Install dependencies
        command: npm ci
    - run:
        name: Wait for Postgres
        command: |
          sudo apt-get update && sudo apt-get install -y postgresql-client
          for i in $(seq 1 30); do
            pg_isready -h localhost -p 5432 -U postgres && break
            sleep 1
          done
    - run:
        name: Seed eval database
        command: npm run eval:seed
    - run:
        name: Run evals
        command: npm run eval
```

**Workflow wiring** (start non-blocking):

- Run `eval` on `main` after `build` passes, or on a schedule (nightly)
- Do **not** `require` eval for deploy until thresholds are stable
- Ensure `EVALS_API_KEY` is available via the CircleCI context used for this repo

See [Eval database setup](#eval-database-setup) for local Docker parity and `getDatabaseConfig` changes.

---

## Eval 1: Workday validation fault classifier

**Production code:** [`src/lib/workday_validation_field_agent.ts`](src/lib/workday_validation_field_agent.ts) → `classifyWorkdayValidationField()`, called from [`src/lib/workday.ts`](src/lib/workday.ts) `getValidationFallbackField()` during submit retries.

**What it does:** Given a Workday validation fault (`message`, `detailMessage`, `xpath`) and allowed retry fields, classify into `supplier | invoiceDate | paymentTerms | worktags | unknown`.

**Why this eval:** Smallest surface area — text-only input, bounded label set, temperature 0, production-critical for retry behavior. Current tests only mock the classifier with regex heuristics ([`src/__tests__/workday.test.ts`](src/__tests__/workday.test.ts)).

**Fixture shape** (`evals/fixtures/validation-field-classifier.json`):

```json
{
  "cases": [
    {
      "id": "invoice-date-first-of-month",
      "input": {
        "validation": {
          "message": "The entered information does not meet the restrictions defined for this field.",
          "detailMessage": "The invoice date must be the first day of the month.",
          "xpath": "/Submit_Supplier_Invoice_Request/Supplier_Invoice_Data/Invoice_Date"
        },
        "allowedRetryFields": ["supplier", "invoiceDate", "paymentTerms", "worktags"]
      },
      "expected": { "retryField": "invoiceDate" }
    }
  ]
}
```

**Seed cases (~10):** 2 per retry field + 2 `unknown` (e.g. company/contact errors the agent must not misclassify) + 1 worktags XPath case (prompt explicitly calls out `Worktags_Reference`).

**Metrics:**
- **Accuracy** on `retryField` (primary)
- **Safe-unknown rate** — `unknown` when expected `unknown` (no false retries on bad fields)

**Pass threshold:** ≥ 90% accuracy on seed set (tune after first run).

---

## Eval 2: Invoice line merge / worktag mapping

**Production code:** [`src/lib/invoice_lines.ts`](src/lib/invoice_lines.ts) → `buildFinalInvoiceLines()`, which calls `getAiResponse()` with [`mergeInvoiceLinesPrompt`](src/prompts/merge_invoice_lines_prompt.ts) and [`MergeInvoiceLinesSchema`](src/prompts/merge_invoice_lines_prompt.ts).

**What it does:** Map extracted invoice lines to PO worktags (`costCenterId`, `fundId`, `spendCategoryId`, `lineOfBusinessId`, `eventId`, `purchaseOrderLineId`) using semantic line matching — no RAG tools, no PDFs.

**Why this eval:** Pure structured JSON in/out; directly affects Workday submit payloads; has a deterministic rule fallback (`buildFallbackLines`) to compare against; **no dedicated test file exists today**.

**Fixture shape** (`evals/fixtures/invoice-line-merge.json`):

```json
{
  "cases": [
    {
      "id": "two-lines-match-po-by-description",
      "input": {
        "extractedInvoiceLines": [
          { "description": "PGA Championship catering", "quantity": 1, "totalPrice": "$5,000.00" }
        ],
        "purchaseOrderLines": [
          {
            "lineOrder": 1,
            "purchaseOrderLineId": "PO-LINE-001",
            "description": "2026 PGA Championship - catering services",
            "costCenterId": "72200",
            "fundId": "FD-001",
            "spendCategoryId": "SC-EVENT",
            "worktagsReference": [],
            "shipToAddressId": null
          }
        ],
        "emailBody": null,
        "fallbackIds": {}
      },
      "expected": {
        "lines": [
          {
            "lineOrder": 1,
            "purchaseOrderLineId": "PO-LINE-001",
            "costCenterId": "72200",
            "fundId": "FD-001",
            "spendCategoryId": "SC-EVENT"
          }
        ]
      }
    }
  ]
}
```

**Seed cases (~8–12):**
- 1:1 line match by description
- Invoice has more lines than PO (apply best-match PO worktags)
- All PO lines share same worktags → apply to all invoice lines
- Email-only cost center when no PO lines
- Event vs LOB disambiguation from `worktagsReference` (hardest case — include 1–2)
- Amount parsing (`"$1,000.00"` → `1000.00`)

**Metrics:**
- **Per-field exact match** on worktag IDs and `purchaseOrderLineId` (ignore `memo` initially)
- **Line count** must equal extracted line count
- **Baseline comparison:** same cases run through `buildFallbackLines` path to show AI lift

**Pass threshold:** ≥ 85% per-field accuracy on non-null expected fields.

---

## Eval 3: Supplier RAG retrieval

**Production code:** [`src/lib/rag.ts`](src/lib/rag.ts) → `queryDocuments()` / `findSuppliersTool`, backed by [`searchDocuments()`](src/lib/database.ts) (hybrid pgvector + text boost, threshold `0.3`).

**What it does:** Given a natural-language supplier query (name, phone, email, partial name), return the correct supplier `workday_id` in top results. This is the retrieval layer that [`enrichInvoice()`](src/enrich_invoice.ts) depends on via 8 RAG tools.

**Why this eval:** Retrieval quality is the ceiling on supplier matching; embedding model, content format (`createSupplierContent`), and similarity threshold are all tunable. Simpler than full multimodal enrichment but catches real regressions.

**Fixture shape** (`evals/fixtures/supplier-rag.json`):

```json
{
  "cases": [
    {
      "id": "exact-company-name",
      "query": "Acme Office Supplies Inc",
      "expectedWorkdayId": "wid-acme-001",
      "matchRank": 3
    },
    {
      "id": "phone-number-lookup",
      "query": "555-867-5309",
      "expectedWorkdayId": "wid-acme-001",
      "matchRank": 3
    }
  ],
  "documents": [
    {
      "workday_id": "wid-acme-001",
      "type": "supplier",
      "content": "Company Name: Acme Office Supplies Inc\nPhone: 555-867-5309\nEmail: billing@acme.com",
      "metadata": { "supplierName": "Acme Office Supplies Inc" }
    }
  ]
}
```

**Setup:** See [Eval database setup](#eval-database-setup). Summary: `evals/seed-rag-fixtures.ts` truncates supplier rows, embeds fixture documents via live OpenAI API, and inserts into Postgres at `EVAL_DATABASE_URL`.

**Seed cases (~10–15 queries against ~8–10 synthetic suppliers):**
- Exact name
- Alternate name / DBA
- Phone or email only
- Partial / typo-tolerant name ("Acme Office" vs "Acme Office Supplies Inc")
- Near-duplicate suppliers (ensure correct one ranks higher)
- Inactive supplier should not win (if metadata includes status)

**Metrics:**
- **Hit@1** and **Hit@3** (expected `workday_id` in top N)
- **MRR** (optional, one line of code)

**Pass threshold:** Hit@3 ≥ 90%, Hit@1 ≥ 75% on seed set.

---

## Eval database setup

Eval 3 (supplier RAG) needs PostgreSQL with the **pgvector** extension and the same `documents` schema as production ([`src/lib/database.ts`](src/lib/database.ts): `VECTOR(1536)`, hybrid search via `searchDocuments()`).

### Why not use dev/prod Aurora?

Production Aurora in [`template.yml`](template.yml) is **VPC-private** (`PubliclyAccessible: false`) and authenticates via Secrets Manager (`DATABASE_SECRET_ARN` + `DATABASE_CLUSTER_ENDPOINT`). CircleCI runners cannot reach it without VPN/bastion wiring, and evals should run against **small synthetic fixtures** anyway — not real supplier data.

**Recommendation:** ephemeral Postgres + pgvector per eval run (local Docker, CircleCI service container). No new AWS infra required to start.

### Architecture

```mermaid
flowchart LR
  subgraph local [Local]
    Docker[pgvector/pgvector:pg15] --> EvalURL[EVAL_DATABASE_URL]
  end

  subgraph ci [CircleCI eval job]
    Service[postgres service container] --> EvalURL2[EVAL_DATABASE_URL]
    Node[cimg/node job] --> Seed[evals/seed-rag-fixtures.ts]
    Seed --> EvalURL2
    Node --> Jest[supplier-rag eval tests]
    Jest --> EvalURL2
  end

  EvalURL --> Conn[getDatabaseConnection]
  EvalURL2 --> Conn
  Conn --> Schema[documents table + pgvector]
```

### 1. Connection string (`EVAL_DATABASE_URL`)

Single env var, standard Postgres URL:

```bash
EVAL_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/finance_agent_eval
```

**Code change (minimal):** extend [`getDatabaseConfig()`](src/lib/database.ts) to parse `EVAL_DATABASE_URL` when set, before falling back to Secrets Manager. Eval runners and the seed script set this; production Lambdas never do.

```ts
// When EVAL_DATABASE_URL is set, skip AWS Secrets Manager entirely
if (env.EVAL_DATABASE_URL) {
  const url = new URL(env.EVAL_DATABASE_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    database: url.pathname.slice(1),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}
```

Schema init already runs on first connect (`ENABLE_PGVECTOR`, `CREATE_DOCUMENTS_TABLE`, indexes) — eval DB gets the same DDL automatically.

### 2. Local setup (Docker)

Add [`docker-compose.eval.yml`](docker-compose.eval.yml) at repo root:

```yaml
services:
  eval-postgres:
    image: pgvector/pgvector:pg15
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: finance_agent_eval
    ports:
      - "5433:5432"   # avoid clashing with a local postgres on 5432
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 2s
      timeout: 5s
      retries: 10
```

**Local workflow:**

```bash
# Terminal 1 — start DB
docker compose -f docker-compose.eval.yml up

# Terminal 2 — seed + run Eval 3
export EVAL_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/finance_agent_eval
export EVALS_API_KEY=sk-...        # or OPENAI_API_KEY
npm run eval:seed                  # truncate + embed + insert fixtures
RUN_EVALS=1 npm run eval           # runs all eval suites
```

Add npm scripts:

| Script | Command |
| --- | --- |
| `eval:db:up` | `docker compose -f docker-compose.eval.yml up -d` |
| `eval:db:down` | `docker compose -f docker-compose.eval.yml down -v` |
| `eval:seed` | seed script (requires `EVAL_DATABASE_URL` + API key) |
| `eval` | `RUN_EVALS=1 jest evals` |

### 3. Seed script (`evals/seed-rag-fixtures.ts`)

Runs before supplier-rag evals (locally and in CI):

1. Connect via `EVAL_DATABASE_URL`
2. `TRUNCATE documents` (or `DELETE WHERE type = 'supplier'`)
3. Read `documents` from [`evals/fixtures/supplier-rag.json`](evals/fixtures/supplier-rag.json)
4. For each row: `createEmbedding(content)` → `bulkInsertDocuments()`
5. Log row count; exit non-zero on failure

Uses **live OpenAI embeddings** (`text-embedding-3-small`) so retrieval eval matches production behavior. Re-seed whenever fixture content changes.

**IVFFlat index note:** production creates an IVFFlat index on `embedding` ([`CREATE_INDEXES`](src/lib/database.ts)). With only ~10 eval documents, Postgres may warn or the index adds little value — acceptable for eval; optionally skip IVFFlat when `EVAL_DATABASE_URL` is set and doc count &lt; 100.

### 4. CircleCI (no separate DB secret needed)

Use a **secondary service container** in the `eval` job — ephemeral DB per run, no `EVAL_DATABASE_URL` secret to configure:

```yaml
eval:
  working_directory: ~/app
  docker:
    - image: cimg/node:20.11.0
      environment:
        RUN_EVALS: "1"
        EVALS_API_KEY: $EVALS_API_KEY
        EVAL_DATABASE_URL: postgresql://postgres:postgres@localhost:5432/finance_agent_eval
    - image: pgvector/pgvector:pg15
      environment:
        POSTGRES_USER: postgres
        POSTGRES_PASSWORD: postgres
        POSTGRES_DB: finance_agent_eval
  steps:
    - checkout
    - run:
        name: Install dependencies
        command: npm ci
    - run:
        name: Wait for Postgres
        command: |
          for i in $(seq 1 30); do
            pg_isready -h localhost -p 5432 -U postgres && break
            sleep 1
          done
    - run:
        name: Seed eval database
        command: npm run eval:seed
    - run:
        name: Run evals
        command: npm run eval
```

`pg_isready` may require `postgresql-client` on the node image (`sudo apt-get install -y postgresql-client`) or a simple `nc -z localhost 5432` loop.

**Evals 1–2** do not need the database — the CI job can run seed + full eval suite, or split into `eval-llm` (no DB) and `eval-rag` (with DB) later if seed time becomes annoying.

### 5. Optional: persistent hosted eval DB

Only if you want eval history across machines without Docker:

- Small RDS/Aurora instance or shared dev Postgres with pgvector enabled
- Store `EVAL_DATABASE_URL` as a CircleCI context secret
- Still run `eval:seed` before each eval job to ensure deterministic fixture state

Not required for v1.

### Checklist

| Step | Owner | When |
| --- | --- | --- |
| Add `docker-compose.eval.yml` | implementation | Eval 3 |
| Extend `getDatabaseConfig` for `EVAL_DATABASE_URL` | implementation | Eval 3 |
| Add `evals/seed-rag-fixtures.ts` | implementation | Eval 3 |
| Wire CircleCI service container + wait loop | implementation | ci-eval-job |
| Document local `eval:db:up` / `eval:seed` in README | implementation | docs |

---

## What we are intentionally deferring

| Feature | Why later |
| --- | --- |
| Full `enrichInvoice()` multimodal eval | Highest business value but needs redacted PDFs, RAG DB, and tool-loop tracing — build after the three simpler evals prove the harness |
| `proposeWorkdaySubmitRepair()` | Implemented in [`src/lib/workday_submit_repair.ts`](src/lib/workday_submit_repair.ts) but **not wired into production submit** today |
| Company verification / email worktags | Subsets of enrichment schema; better as slices once enrichment eval exists |

---

## File layout to add

```
evals/
  setup.ts                          # EVALS_API_KEY → OPENAI_API_KEY mapping
  seed-rag-fixtures.ts              # TRUNCATE + embed + insert supplier fixtures
  fixtures/
    validation-field-classifier.json
    invoice-line-merge.json
    supplier-rag.json
  scorers/
    validation-field.ts
    invoice-line-merge.ts
    supplier-rag.ts
  run-validation-field.test.ts
  run-invoice-line-merge.test.ts
  run-supplier-rag.test.ts
docker-compose.eval.yml             # local pgvector Postgres on port 5433
```

## Implementation order

1. Harness + `evals/setup.ts` key mapping + Eval 1 (no DB)
2. Eval 2 (JSON only, calls live `getAiResponse`)
3. Eval DB: `docker-compose.eval.yml`, `getDatabaseConfig` + `EVAL_DATABASE_URL`, `eval:seed` script
4. Eval 3 supplier RAG (depends on step 3)
5. CircleCI `eval` job: `EVALS_API_KEY` + pgvector sidecar + seed + `npm run eval`
6. README: local workflow (`eval:db:up`, `eval:seed`, `npm run eval`)
