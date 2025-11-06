# Finance Agent 🏦

> **AI-Powered Finance Automation for Workday**  
> Serverless system for intelligent invoice processing and supplier management

[![TypeScript](https://img.shields.io/badge/TypeScript-5.5.2-blue.svg)](https://www.typescriptlang.org/)
[![AWS Lambda](https://img.shields.io/badge/AWS-Lambda-orange.svg)](https://aws.amazon.com/lambda/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org/)
[![OpenAI](https://img.shields.io/badge/OpenAI-GPT--4.1-purple.svg)](https://openai.com/)

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
- **Enhanced Test Coverage**: 88 tests with 74.72% coverage including comprehensive RAG and PDF testing
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
        AI[OpenAI GPT-4<br/>Supplier identification]
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
├── enrich_invoice_supplier.ts      # Invoice processing with AI (handler + processor)
├── query_documents.ts              # Document search endpoint
├── lib/
│   ├── handlers.ts                 # Handler architecture (withQueryHandler, withProcessorHandler)
│   ├── ai.ts                       # AI integration
│   ├── database.ts                 # PostgreSQL database
│   ├── pdf.ts                      # PDF processing utilities
│   ├── rag.ts                      # RAG and embedding functionality
│   ├── slack.ts                    # Slack notifications
│   ├── workday.ts                  # Workday API client
│   └── types.ts                    # Type definitions
└── __tests__/                      # Test suite (88 tests, 74.72% coverage)
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

### PDF Processing
- Downloads invoice PDFs from Workday
- Splits multi-page PDFs into separate images using pdftocairo
- Uses vision models to extract text and data
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
- OpenAI GPT-4 for supplier identification
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
npm test                    # Run all tests (88 tests)
npm run test:coverage      # Run with coverage (74.72% overall)
```

### Test Coverage
- **88 tests passing** across 11 test suites
- **74.72% overall coverage** with comprehensive test coverage for:
  - Handler architecture (`handlers.ts`: 97.67%)
  - RAG functionality (`rag.ts`: 86%)
  - PDF processing (`pdf.ts`: 58.92%)
  - Supplier refresh (`refresh_suppliers.ts`: 100%)
  - Core business logic and Workday API interactions

Tests cover all core functions including supplier sync, invoice processing, AI integration, handler architecture, and Workday API interactions.

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
flowchart TD
    START[Start RAG Query] --> CREATE_EMB[Create Query Embedding<br/>OpenAI text-embedding-3-small]
    CREATE_EMB --> HYBRID_SEARCH[Hybrid Search<br/>PostgreSQL + pgvector]
    
    HYBRID_SEARCH --> SEMANTIC[Semantic Similarity<br/>Vector cosine distance]
    HYBRID_SEARCH --> TEXT_MATCH[Exact Text Match<br/>LIKE query boost]
    
    SEMANTIC --> COMBINE[Combine Results<br/>Boost exact matches to 1.0]
    TEXT_MATCH --> COMBINE
    
    COMBINE --> FILTER[Filter by Threshold<br/>Default: 0.3 similarity]
    FILTER --> SORT[Sort by Similarity<br/>DESC]
    SORT --> LIMIT[Limit Results<br/>Default: 100]
    LIMIT --> RETURN[Return RAG Results]
    
    subgraph "Document Storage"
        SUPPLIER_DATA[Supplier Data<br/>from Workday] --> CREATE_CONTENT[Create Content<br/>Name, Address, Phone, Email]
        CREATE_CONTENT --> CREATE_DOC_EMB[Create Document Embedding]
        CREATE_DOC_EMB --> STORE[(PostgreSQL<br/>with pgvector)]
    end
    
    STORE -.-> HYBRID_SEARCH
    
    style CREATE_EMB fill:#e1f5ff
    style HYBRID_SEARCH fill:#fff4e1
    style STORE fill:#e8f5e9
```

#### Enrich Invoices Process

The invoice enrichment process identifies missing suppliers using AI and RAG:

```mermaid
flowchart TD
    START[Scheduled Trigger<br/>8:00 AM Central] --> QUERY_HANDLER[Query Handler<br/>WQL Query]
    
    QUERY_HANDLER --> WQL[Workday WQL<br/>Find invoices missing suppliers]
    WQL --> FILTER[Filter Results<br/>OCRSupplierInvoice not empty<br/>supplier is empty<br/>isCanceled = false]
    
    FILTER --> PAGE[Page Results<br/>1 invoice per invocation]
    PAGE --> INVOKE_PROC[Invoke Processor<br/>EnrichInvoiceSupplierProcessor]
    
    INVOKE_PROC --> GET_DETAILS[Get Invoice Details<br/>Workday SOAP API]
    GET_DETAILS --> GET_ATTACH[Get Attachments<br/>PDF documents]
    
    GET_ATTACH --> PROCESS_PDF[Process PDFs<br/>Split multi-page PDFs<br/>Convert to images]
    PROCESS_PDF --> UPLOAD_S3[Upload to S3<br/>Generate presigned URLs]
    
    UPLOAD_S3 --> EXTRACT_DATA[Extract Invoice Data<br/>Company name, address<br/>phone, email, invoice number]
    
    EXTRACT_DATA --> AI_ANALYSIS[AI Analysis<br/>GPT-4 with RAG tool]
    
    AI_ANALYSIS --> RAG_SEARCH[RAG Search<br/>findSuppliers tool]
    RAG_SEARCH --> VECTOR_DB[(Vector Database<br/>Semantic search)]
    VECTOR_DB --> RAG_RESULTS[RAG Results<br/>Similar suppliers]
    
    RAG_RESULTS --> AI_DECIDE[AI Decision<br/>Analyze invoice + images<br/>Match with RAG results]
    
    AI_DECIDE --> RESULT{Result Type}
    
    RESULT -->|High Confidence| FOUND[Found<br/>Supplier identified]
    RESULT -->|Multiple Matches| AMBIGUOUS[Ambiguous<br/>Flag for review]
    RESULT -->|No Match| NOT_FOUND[Not Found<br/>Extract supplier info]
    RESULT -->|Error| ERROR[Error<br/>Flag for review]
    
    FOUND --> NOTIFY[Slack Notification<br/>Success with details]
    AMBIGUOUS --> NOTIFY
    NOT_FOUND --> NOTIFY
    ERROR --> NOTIFY
    
    NOTIFY --> END[End]
    
    style AI_ANALYSIS fill:#e1f5ff
    style RAG_SEARCH fill:#fff4e1
    style VECTOR_DB fill:#e8f5e9
```

#### PDF Processing Pipeline

The PDF processing pipeline converts invoice PDFs into images for AI vision analysis:

```mermaid
flowchart TD
    START[Receive PDF Attachment<br/>from Workday SOAP] --> CHECK_TYPE{Attachment Type?}
    
    CHECK_TYPE -->|PDF| PDF_PATH[Create Temp Directory<br/>/tmp/pdf-processing]
    CHECK_TYPE -->|Image/Other| DIRECT_UPLOAD[Upload Directly to S3]
    
    PDF_PATH --> WRITE_TEMP[Write PDF Buffer<br/>to Temporary File]
    WRITE_TEMP --> CREATE_OUTPUT[Create Output Directory<br/>for page images]
    
    CREATE_OUTPUT --> PDFTOCAIRO[Execute pdftocairo<br/>Convert PDF to PNG<br/>All pages at once]
    
    PDFTOCAIRO --> FIND_PAGES[Find Generated PNGs<br/>page-1.png, page-2.png, ...]
    FIND_PAGES --> SORT_PAGES[Sort by Page Number<br/>Ascending order]
    
    SORT_PAGES --> LOOP{More Pages?}
    
    LOOP -->|Yes| READ_PAGE[Read PNG File<br/>into Buffer]
    READ_PAGE --> CREATE_IMAGE[Create ProcessedImage<br/>fileName, buffer, contentType<br/>pageNumber]
    
    CREATE_IMAGE --> UPLOAD_S3[Upload to S3<br/>Generate S3 Key<br/>workdayID/attachmentIndex/page-N]
    
    UPLOAD_S3 --> GEN_PRESIGNED[Generate Presigned URL<br/>Expires in 1 hour]
    GEN_PRESIGNED --> ADD_TO_LIST[Add to PresignedAttachment List]
    
    ADD_TO_LIST --> CLEANUP_PAGE[Delete Temp PNG File]
    CLEANUP_PAGE --> LOOP
    
    LOOP -->|No| CLEANUP_TEMP[Cleanup Temp Files<br/>Delete PDF and directories]
    
    DIRECT_UPLOAD --> GEN_PRESIGNED_DIRECT[Generate Presigned URL]
    GEN_PRESIGNED_DIRECT --> ADD_TO_LIST
    
    CLEANUP_TEMP --> RETURN[Return Processed Attachments<br/>Array of PresignedAttachment]
    ADD_TO_LIST --> RETURN
    
    RETURN --> END[End<br/>Ready for AI Vision Analysis]
    
    style PDFTOCAIRO fill:#fff4e1
    style UPLOAD_S3 fill:#e8f5e9
    style GEN_PRESIGNED fill:#e1f5ff
```

#### Refresh Suppliers Process

The refresh process performs a full rebuild of the supplier database:

```mermaid
flowchart TD
    START[Manual Trigger<br/>Refresh Suppliers] --> DELETE[Delete All Suppliers<br/>deleteAllDocumentsByType]
    
    DELETE --> GET_COUNT[Get Total Count<br/>Workday WQL Query]
    GET_COUNT --> CALC_PAGES[Calculate Pages<br/>500 suppliers per batch]
    
    CALC_PAGES --> CREATE_HANDLER[Create Internal Handler<br/>withQueryHandler]
    
    CREATE_HANDLER --> LOOP{More Batches?}
    
    LOOP -->|Yes| QUERY_BATCH[Query Batch<br/>500 suppliers via WQL]
    QUERY_BATCH --> INVOKE_CACHE[Invoke Cache Processor<br/>CacheSuppliersProcessor]
    
    INVOKE_CACHE --> PROCESS_BATCH[Process Batch]
    
    PROCESS_BATCH --> FILTER_ACTIVE[Filter Active Suppliers<br/>Only Active status]
    FILTER_ACTIVE --> CREATE_CONTENT[Create Supplier Content<br/>Name, alternate names<br/>phone, email, address]
    
    CREATE_CONTENT --> CREATE_EMB[Create Embeddings<br/>OpenAI text-embedding-3-small]
    CREATE_EMB --> BULK_INSERT[Bulk Insert<br/>50 suppliers per batch]
    
    BULK_INSERT --> STORE[(PostgreSQL<br/>with embeddings)]
    
    STORE --> LOOP
    
    LOOP -->|No| NOTIFY[Slack Notification<br/>Total suppliers processed<br/>Total batches]
    
    NOTIFY --> END[End]
    
    style DELETE fill:#ffebee
    style CREATE_EMB fill:#e1f5ff
    style STORE fill:#e8f5e9
```

#### Cache Suppliers Process

The daily supplier sync process incrementally updates the supplier database:

```mermaid
flowchart TD
    START[Scheduled Trigger<br/>7:00 AM Central] --> QUERY_HANDLER[Query Handler<br/>WQL Query]
    
    QUERY_HANDLER --> WQL[Workday WQL<br/>Query all suppliers]
    WQL --> GET_EXISTING[Get Existing Suppliers<br/>from PostgreSQL]
    
    GET_EXISTING --> COMPARE[Compare Suppliers<br/>by workday_id]
    
    COMPARE --> NEW[New Suppliers<br/>Not in database]
    COMPARE --> UPDATED[Updated Suppliers<br/>lastUpdatedDateTime changed]
    COMPARE --> UNCHANGED[Unchanged Suppliers<br/>Skip processing]
    
    NEW --> FILTER_NEW[Filter Active Only]
    FILTER_NEW --> PREP_NEW[Prepare New Suppliers<br/>Create content + embeddings]
    
    UPDATED --> FILTER_UPD[Filter Active Only]
    FILTER_UPD --> PREP_UPD[Prepare Updated Suppliers<br/>Create content + embeddings]
    
    PREP_NEW --> BATCH_NEW[Batch Process<br/>50 suppliers per batch]
    PREP_UPD --> BATCH_UPD[Batch Process<br/>50 suppliers per batch]
    
    BATCH_NEW --> CREATE_EMB_NEW[Create Embeddings<br/>OpenAI API]
    BATCH_UPD --> CREATE_EMB_UPD[Create Embeddings<br/>OpenAI API]
    
    CREATE_EMB_NEW --> BULK_INSERT[Bulk Insert<br/>PostgreSQL]
    CREATE_EMB_UPD --> BULK_UPDATE[Bulk Update<br/>PostgreSQL]
    
    BULK_INSERT --> STORE[(PostgreSQL<br/>with pgvector)]
    BULK_UPDATE --> STORE
    
    STORE --> STATS[Calculate Stats<br/>New, Updated, Unchanged]
    STATS --> NOTIFY[Slack Notification<br/>Sync statistics]
    
    NOTIFY --> END[End]
    
    style CREATE_EMB_NEW fill:#e1f5ff
    style CREATE_EMB_UPD fill:#e1f5ff
    style STORE fill:#e8f5e9
```
