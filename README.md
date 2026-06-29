# Finance Agent 🏦

> **AI-Powered Finance Automation for Workday**  
> Serverless system for intelligent invoice processing and supplier management

[![TypeScript](https://img.shields.io/badge/TypeScript-5.5.2-blue.svg)](https://www.typescriptlang.org/)
[![AWS Lambda](https://img.shields.io/badge/AWS-Lambda-orange.svg)](https://aws.amazon.com/lambda/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org/)
[![OpenAI](https://img.shields.io/badge/OpenAI-GPT--5.4-purple.svg)](https://openai.com/)

## 🎯 Overview

The Finance Agent automates financial data processing in Workday by intelligently identifying suppliers for invoices. It uses AI to analyze invoice content, matches suppliers using semantic search, and enriches financial records automatically.

### Key Features

- 🤖 **AI-Powered Supplier Identification** - Automatically matches invoices with suppliers
- 📊 **Intelligent Data Processing** - Processes large datasets efficiently with modern handler architecture
- 🔄 **Event-Driven Architecture** - Scalable serverless design with query/processor separation
- 🔍 **Document Processing** - Handles PDF attachments and OCR data
- 📱 **Real-time Notifications** - Slack alerts for processing status
- 🧠 **RAG Integration** - Retrieval-Augmented Generation for intelligent supplier matching
- ⚡ **Self-Contained Operations** - Refresh operations use internal handlers for better reliability

### Recent Improvements

- **Modern Handler Architecture**: Separated query execution from data processing for better maintainability
- **Intelligent Pagination**: Configurable page sizes for efficient large dataset processing
- **Enhanced Test Coverage**: Focused Jest coverage for RAG, invoice enrichment, and Workday integration
- **Self-Contained Refresh**: Refresh operations no longer depend on external Lambda invocations
- **RAG Integration**: Added semantic search capabilities with OpenAI embeddings

## 🏗️ Architecture

The system runs on AWS Lambda with a modern handler architecture that separates query execution from data processing. It uses multiple Workday APIs for data access and includes intelligent pagination for large datasets.

### System Components

```mermaid
graph TB
    subgraph "Processing Pipeline"
        SCHED1[Daily Supplier Sync<br/>7:00 AM Central]
        SCHED2[Daily Invoice Processing<br/>8:00 AM Central]
    end

    subgraph "Handler Architecture"
        QUERY[Query Handlers<br/>Execute Workday queries]
        PROC[Processor Handlers<br/>Process data with AI]
    end

    subgraph "Core Functions"
        CACHE[Cache Suppliers<br/>Sync supplier data]
        ENRICH[Enrich Invoices<br/>Find invoices needing suppliers]
        REFRESH[Refresh Suppliers<br/>Full database rebuild]
    end

    subgraph "Data Sources"
        WQL[Workday WQL<br/>Query invoices & suppliers]
        REST[Workday REST<br/>Get invoice details]
        SOAP[Workday SOAP<br/>Get attachments]
    end

    subgraph "AI & Storage"
        AI[OpenAI GPT-5<br/>Supplier identification]
        DB[(PostgreSQL<br/>Supplier database)]
        S3[S3<br/>PDF attachments]
    end

    SCHED1 --> CACHE
    SCHED2 --> ENRICH

    CACHE --> QUERY
    CACHE --> PROC
    ENRICH --> QUERY
    ENRICH --> PROC
    REFRESH --> QUERY
    REFRESH --> PROC

    QUERY --> WQL
    PROC --> REST
    PROC --> SOAP
    PROC --> AI
    PROC --> DB
    PROC --> S3
```

### Workday API Usage

**WQL (Workday Query Language)**

- Queries supplier master data and invoices
- Used for bulk data retrieval and filtering
- Scheduled daily for supplier sync and invoice discovery

**SOAP API**

- Retrieves detailed invoice information with PDF attachments
- Provides structured data exchange for invoice processing
- Enables access to invoice documents and metadata

### Handler Architecture

The system uses a modern handler pattern that separates concerns:

- **Query Handlers**: Execute Workday queries and handle pagination
- **Processor Handlers**: Process data with AI and update databases
- **Intelligent Pagination**: Handles large datasets efficiently with configurable page sizes
- **Self-Contained Operations**: Refresh operations use internal query handlers instead of external Lambda invocations

### Daily Processing

1. **7:00 AM Central - Supplier Sync**: Updates supplier database with latest Workday data
2. **8:00 AM Central - Invoice Processing**: Finds invoices missing suppliers and processes them
3. **AI Analysis**: For each invoice, AI analyzes content and matches suppliers
4. **Notifications**: Slack alerts for processing results and any issues

### Manual Operations

- **Refresh Suppliers**: Full rebuild of supplier database with intelligent pagination
  - Deletes all existing suppliers
  - Uses internal query handler with 500-record batches
  - Self-contained operation with no external Lambda dependencies
  - Includes alternate names and updated metadata structure

## 📁 Project Structure

```
src/
├── cache_suppliers.ts              # Daily supplier data sync (handler + processor)
├── refresh_suppliers.ts            # Full supplier database rebuild
├── enrich_invoice.ts      # Invoice processing with AI (handler + processor)
├── query_documents.ts              # Document search endpoint
├── lib/
│   ├── handlers.ts                 # Handler architecture (withQueryHandler, withProcessorHandler)
│   ├── ai.ts                       # AI integration
│   ├── database.ts                 # PostgreSQL database
│   ├── rag.ts                      # RAG and embedding functionality
│   ├── slack.ts                    # Slack notifications
│   ├── workday.ts                  # Workday API client
│   └── types.ts                    # Type definitions
└── __tests__/                      # Test suite
```

## 🔧 System Architecture

### Handler Architecture

- **withQueryHandler**: Executes Workday queries with intelligent pagination
- **withProcessorHandler**: Processes data with AI and updates databases
- **Separation of Concerns**: Clean separation between query execution and data processing
- **Configurable Pagination**: Supports both bulk processing and paginated operations
- **Self-Contained Operations**: Refresh operations use internal handlers

### Vector Database

- PostgreSQL with pgvector for semantic supplier search
- Stores supplier embeddings for intelligent matching
- Enables fast similarity search across supplier data
- Incremental sync keeps data current

### Attachment Processing

- Downloads invoice PDFs from Workday
- Saves original attachments to S3 for audit/debug access
- Sends PDF attachments to the AI model as `application/pdf` file inputs
- Sends image attachments to the AI model as image inputs
- Generates presigned URLs for document access

### RAG (Retrieval-Augmented Generation)

- OpenAI embeddings for semantic search
- Hybrid search combining semantic similarity with exact text matching
- Configurable similarity thresholds and result limits
- AI tools for supplier identification

### Workday Integration

- **WQL**: Bulk data queries for suppliers and invoices
- **SOAP API**: Detailed invoice information and PDF attachments
- OAuth authentication with refresh tokens
- Handles large datasets with intelligent pagination

### AI Processing

- OpenAI GPT-5 for supplier identification
- Structured responses with confidence scoring
- Analyzes invoice content and metadata
- Integrates with vector database for context

## 🧠 AI-Powered Features

### Supplier Identification

AI analyzes invoice content and matches suppliers by examining metadata, OCR data, and company information using semantic search.

### Processing Results

- **High Confidence**: Automatic supplier assignment
- **Ambiguous**: Multiple candidates - flagged for review
- **Not Found**: No suitable match - requires manual processing
- **Error**: Processing failed - retry or manual intervention

## 🔧 Development

### Prerequisites

- Node.js 20+
- Workday API access
- OpenAI API key

### Local Development

```bash
git clone <repository-url>
cd finance-agent
npm install
npm run build
npm test
```

### Configuration

Set up parameters in AWS Systems Manager Parameter Store for Workday credentials, OpenAI API key, and Slack webhook URL.

## 🧪 Testing

```bash
npm test                    # Run all tests
npm run test:coverage      # Run with coverage
```

### Test Coverage

- Jest coverage includes:
  - Handler architecture (`handlers.ts`: 97.67%)
  - RAG functionality (`rag.ts`: 86%)
  - Supplier refresh (`refresh_suppliers.ts`: 100%)
  - Core business logic and Workday API interactions

Tests cover all core functions including supplier sync, invoice processing, AI integration, handler architecture, and Workday API interactions.

### AI evals

Unit tests mock all OpenAI calls. Evals run live model checks against JSON fixtures in `evals/`.

```bash
# Start local eval database (pgvector on port 5433)
npm run eval:db:up

export EVAL_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/finance_agent_eval
export EVALS_API_KEY=sk-...   # required for live evals

npm run eval:seed             # embed + load supplier fixtures
npm run eval                  # RUN_EVALS=1 jest evals/run-evals.test.ts
```

Eval suites:

| Suite | What it measures |
| --- | --- |
| `validation-field-classifier` | Workday fault → retry field classification |
| `invoice-line-merge` | Invoice line → PO worktag mapping |
| `supplier-rag` | Supplier query → correct `workday_id` in top 3 |

CircleCI runs unit tests on every push. Live evals run **only when AI-related files change** and still block merge when triggered.

**Ensure `EVALS_API_KEY` is in the `chatbot-development` CircleCI context** (the eval job uses that context).

When evals run, `evals/setup.ts` maps `EVALS_API_KEY` → `OPENAI_API_KEY` and `EVAL_DATABASE_URL` → `DATABASE_URL`. Commit cached supplier embeddings with `npm run eval:embeddings` after changing `supplier-rag.json` to avoid re-embedding documents on every CI run.

The `eval` job uses `EVALS_API_KEY` from the `chatbot-development` context and an ephemeral pgvector sidecar. Local `npm test` skips live evals unless `RUN_EVALS=1`.

## 🚀 Deployment

Deployment is automated via CircleCI:

- **Development**: Deploys on `development` branch
- **Production**: Deploys on `main` branch

### Infrastructure

- AWS Lambda functions with VPC integration
- Aurora PostgreSQL database with pgvector extension
- S3 bucket for PDF attachments
- CloudWatch for logging and monitoring
- Modern handler architecture with query/processor separation

## 📈 Monitoring

- **CloudWatch**: Function logs and metrics
- **Slack**: Real-time notifications to #notify-finance-agent-dev
- **Error Tracking**: Detailed error context and processing statistics

## 🔒 Security

- Workday OAuth authentication
- AWS IAM with least privilege access
- Encrypted secrets in Parameter Store
- VPC network isolation
- Data encryption at rest and in transit

## 📄 License

TBD

### Process Flows

#### RAG Pipeline

The RAG (Retrieval-Augmented Generation) pipeline enables semantic search for supplier matching:

```mermaid
sequenceDiagram
    participant Client
    participant OpenAI as OpenAI Embeddings
    participant DB as PostgreSQL<br/>+ pgvector
    participant Workday
    participant ContentCreator as Content Creator

    Note over Client,DB: Query Flow
    Client->>OpenAI: Create query embedding<br/>(text-embedding-3-small)
    OpenAI-->>Client: Query embedding vector

    Client->>DB: Hybrid search query<br/>(embedding + text)
    activate DB
    DB->>DB: Semantic similarity<br/>(vector cosine distance)
    DB->>DB: Exact text match<br/>(LIKE query boost)
    DB->>DB: Combine results<br/>(boost exact matches to 1.0)
    DB->>DB: Filter by threshold<br/>(default: 0.3)
    DB->>DB: Sort by similarity DESC
    DB->>DB: Limit results<br/>(default: 100)
    deactivate DB
    DB-->>Client: RAG results

    Note over Workday,DB: Document Storage Flow
    Workday->>ContentCreator: Supplier data
    ContentCreator->>ContentCreator: Create content<br/>(Name, Address, Phone, Email)
    ContentCreator->>OpenAI: Create document embedding
    OpenAI-->>ContentCreator: Document embedding
    ContentCreator->>DB: Store document<br/>(content + embedding + metadata)
    DB-->>ContentCreator: Document stored
```

#### Enrich Invoices Process

The invoice enrichment process identifies missing suppliers using AI and RAG:

```mermaid
sequenceDiagram
    participant Scheduler as Scheduled Trigger<br/>(8:00 AM Central)
    participant QueryHandler as Query Handler
    participant WorkdayWQL as Workday WQL
    participant Processor as EnrichInvoice<br/>Processor
    participant WorkdaySOAP as Workday SOAP
    participant S3
    participant AI as GPT-5
    participant RAG as RAG/Vector DB
    participant Slack

    Scheduler->>QueryHandler: Trigger query
    QueryHandler->>WorkdayWQL: Query invoices<br/>(missing suppliers, not canceled)
    WorkdayWQL-->>QueryHandler: Invoice list
    QueryHandler->>QueryHandler: Filter & page<br/>(1 invoice per invocation)
    QueryHandler->>Processor: Invoke processor<br/>(with invoice data)

    Processor->>WorkdaySOAP: Get invoice details
    WorkdaySOAP-->>Processor: Invoice data
    Processor->>WorkdaySOAP: Get attachments
    WorkdaySOAP-->>Processor: PDF attachments

    Processor->>S3: Upload original attachments
    S3-->>Processor: Presigned URLs

    Processor->>Processor: Extract invoice data<br/>(company, address, phone, email)

    Processor->>AI: Analyze invoice<br/>(with PDF files/images + RAG tool)
    activate AI
    AI->>RAG: findSuppliers tool<br/>(semantic search)
    activate RAG
    RAG->>RAG: Vector similarity search
    RAG-->>AI: Similar suppliers
    deactivate RAG

    AI->>AI: Analyze invoice attachments<br/>Match with RAG results
    deactivate AI
    AI-->>Processor: Supplier identification result

    alt High Confidence
        Processor->>Processor: Supplier identified
    else Multiple Matches
        Processor->>Processor: Ambiguous - flag for review
    else No Match
        Processor->>Processor: Extract supplier info
    else Error
        Processor->>Processor: Flag for review
    end

    Processor->>Slack: Send notification<br/>(with result details)
    Slack-->>Processor: Notification sent
```

#### Workday Submit Retry Process

Supplier invoice updates go through a guarded retry loop before the final Workday SOAP result is returned. The retry process applies to invoice submit operations such as supplier updates and note-only verification updates.

```mermaid
flowchart TD
    START[Build Supplier Invoice submit payload]
    SUBMIT[Submit payload to Workday SOAP]
    SUCCESS{Submit succeeded?}
    DONE[Return success]
    ERROR{Workday validation fault?}
    THROW[Throw original error]
    LIMIT{Attempts remaining?<br/>max 3 total}
    RECORD[Record failed request<br/>and summarized validation fault]
    REPAIR[Ask Workday submit repair agent<br/>for a safe repair plan]
    RULES[Optional: look up Workday<br/>Supplier Invoice validation rules]
    DECISION{Repair decision}
    APPLY[Apply allowed changes only:<br/>invoice date, memo, notes append,<br/>or configured default supplier]
    DUPLICATE{Payload already failed?}
    RETRY[Retry with repaired payload]

    START --> SUBMIT
    SUBMIT --> SUCCESS
    SUCCESS -- Yes --> DONE
    SUCCESS -- No --> ERROR
    ERROR -- No --> THROW
    ERROR -- Yes --> RECORD
    RECORD --> LIMIT
    LIMIT -- No --> THROW
    LIMIT -- Yes --> REPAIR
    REPAIR -. when useful .-> RULES
    RULES -. validation context .-> REPAIR
    REPAIR --> DECISION
    DECISION -- give_up --> THROW
    DECISION -- retry --> APPLY
    APPLY --> DUPLICATE
    DUPLICATE -- Yes --> THROW
    DUPLICATE -- No --> RETRY
    RETRY --> SUBMIT
```

Retry guardrails:

- Only Workday validation faults are eligible for repair; non-validation errors are rethrown immediately.
- The repair agent must inspect the latest failed request before deciding whether to retry.
- Repairs are intentionally narrow: invoice date, memo, appended notes, or switching to the configured default supplier when available.
- The loop tracks failed payload fingerprints and aborts if a repair would repeat a payload that already failed.
- The final validation fault is rethrown after the third failed submit attempt or when the repair agent chooses `give_up`.

#### Attachment Processing Pipeline

The attachment processing pipeline uploads the original Workday attachments for access/debugging and sends supported attachment content directly to the AI model:

```mermaid
sequenceDiagram
    participant Processor
    participant S3
    participant AI

    Processor->>Processor: Receive attachment<br/>(from Workday SOAP)

    Processor->>S3: Upload original attachment
    S3-->>Processor: S3 key
    Processor->>S3: Generate presigned URL<br/>(expires 1 hour)
    S3-->>Processor: Presigned URL

    alt PDF Attachment
        Processor->>AI: Send PDF buffer as file input<br/>(application/pdf)
    else Image Attachment
        Processor->>AI: Send image URL as image input
    else Other Attachment
        Processor->>Processor: Keep attachment metadata only
    end

    Processor->>Processor: Return processed attachments<br/>(array of PresignedAttachment)
```

#### Refresh Suppliers Process

The refresh process performs a full rebuild of the supplier database:

```mermaid
sequenceDiagram
    participant Trigger as Manual Trigger
    participant RefreshHandler as Refresh Handler
    participant DB as PostgreSQL
    participant WorkdayWQL as Workday WQL
    participant CacheProcessor as Cache Processor
    participant OpenAI as OpenAI Embeddings
    participant Slack

    Trigger->>RefreshHandler: Start refresh
    RefreshHandler->>DB: Delete all suppliers<br/>(deleteAllDocumentsByType)
    DB-->>RefreshHandler: Deletion complete

    RefreshHandler->>WorkdayWQL: Get total count
    WorkdayWQL-->>RefreshHandler: Total suppliers
    RefreshHandler->>RefreshHandler: Calculate pages<br/>(500 per batch)
    RefreshHandler->>RefreshHandler: Create internal handler<br/>(withQueryHandler)

    loop For each batch (500 suppliers)
        RefreshHandler->>WorkdayWQL: Query batch
        WorkdayWQL-->>RefreshHandler: Supplier batch
        RefreshHandler->>CacheProcessor: Invoke processor<br/>(with batch data)

        activate CacheProcessor
        CacheProcessor->>CacheProcessor: Filter Active suppliers
        CacheProcessor->>CacheProcessor: Create supplier content<br/>(name, alternate names,<br/>phone, email, address)

        loop For each supplier (50 per batch)
            CacheProcessor->>OpenAI: Create embedding<br/>(text-embedding-3-small)
            OpenAI-->>CacheProcessor: Embedding vector
        end

        CacheProcessor->>DB: Bulk insert<br/>(50 suppliers per batch)
        DB-->>CacheProcessor: Insert complete
        deactivate CacheProcessor
    end

    RefreshHandler->>Slack: Send notification<br/>(total suppliers, batches)
    Slack-->>RefreshHandler: Notification sent
```

#### Cache Suppliers Process

The daily supplier sync process incrementally updates the supplier database:

```mermaid
sequenceDiagram
    participant Scheduler as Scheduled Trigger<br/>(7:00 AM Central)
    participant QueryHandler as Query Handler
    participant WorkdayWQL as Workday WQL
    participant Processor as Cache Processor
    participant DB as PostgreSQL
    participant OpenAI as OpenAI Embeddings
    participant Slack

    Scheduler->>QueryHandler: Trigger sync
    QueryHandler->>WorkdayWQL: Query all suppliers
    WorkdayWQL-->>QueryHandler: All suppliers
    QueryHandler->>Processor: Invoke processor<br/>(with supplier data)

    activate Processor
    Processor->>DB: Get existing suppliers
    DB-->>Processor: Existing suppliers

    Processor->>Processor: Compare suppliers<br/>(by workday_id)
    Processor->>Processor: Identify changes:<br/>New, Updated, Unchanged

    alt New Suppliers
        Processor->>Processor: Filter Active only
        loop For each new supplier (50 per batch)
            Processor->>Processor: Create supplier content<br/>(name, alternate names,<br/>phone, email, address)
            Processor->>OpenAI: Create embedding<br/>(text-embedding-3-small)
            OpenAI-->>Processor: Embedding vector
        end
        Processor->>DB: Bulk insert<br/>(50 suppliers per batch)
        DB-->>Processor: Insert complete
    end

    alt Updated Suppliers
        Processor->>Processor: Filter Active only
        loop For each updated supplier (50 per batch)
            Processor->>Processor: Create supplier content
            Processor->>OpenAI: Create embedding
            OpenAI-->>Processor: Embedding vector
        end
        Processor->>DB: Bulk update<br/>(50 suppliers per batch)
        DB-->>Processor: Update complete
    end

    Processor->>Processor: Calculate statistics<br/>(new, updated, unchanged)
    Processor->>Slack: Send notification<br/>(sync statistics)
    Slack-->>Processor: Notification sent
    deactivate Processor
```
