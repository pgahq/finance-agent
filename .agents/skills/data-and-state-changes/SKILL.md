---
name: data-and-state-changes
description: >-
  Cold-start Postgres schema init, documents RAG table migrations, and cached
  Workday reference IDs for finance-agent. Use when changing DocumentType,
  documents CHECK constraints, getDatabaseConnection schema setup, pgvector
  indexes, debugging documents_type_check / schema init Lambda failures, cache
  prune in syncDataSource, companyReferenceId / exact reference ID lookup,
  cache_companies, or email short codes such as 912.
---

# Data and state changes

## Cold-start schema init

`getDatabaseConnection` in `src/lib/database.ts`:

1. Enable `vector`
2. `CREATE TABLE IF NOT EXISTS documents`
3. Create indexes
4. Recreate `documents_type_check` via `migrateDocumentsTypeCheck`

`CREATE TABLE IF NOT EXISTS` does not alter existing tables. Type allowlist
changes must go through the migration helper.

## Shared pool lifetime

The Postgres `Pool` is process-global. Do not close it after individual RAG
queries; concurrent tools share it. Use `closeDatabasePool` only in tests or
intentional shutdown paths.

## Document types

`DOCUMENT_TYPES` in `src/lib/database.ts` is the source of truth. The migration
includes existing unknown values in the CHECK constraint so orphan rows do not
block Lambda startup. Schema-init failures clear the pool so retries rerun the
migration. A transaction-scoped advisory lock serializes the constraint DDL
across concurrent Lambda cold starts.

Do not delete production orphan rows from app code without an explicit ops decision.

## Cache prune

`syncDataSource` does not delete by default. `pruneAbsent: true` deletes existing
rows of that type whose `workday_id` is missing from the incoming snapshot, and
only when `sourceTotal` equals `sourceFetchedCount` (Workday `total` matches the
raw fetched array, not Map size after duplicate IDs). Empty snapshots, missing
totals, and incomplete pulls skip prune and report `pruneSkipped` in Slack. Set
`pruneDryRun: true` (cost centers: `COST_CENTER_PRUNE_DRY_RUN=true`) to log
`absent` / `absentIds` without deleting. Cost-center cache passes
`requireCompleteTotal: true` into `executeWorkdayQuery`; other WQL callers do
not. Do not enable prune for windowed sources such as events.

## Exact reference ID lookup

`findDocumentsByReferenceId` exact-matches `metadata.code`, `metadata.referenceId`, and `metadata.companyReferenceId` across selected types. Company cache stores `companyReferenceId` from Workday `referenceID1` (Company_Reference_ID, e.g. `912`), falling back to `referenceID` when that value is not a WID. Do not use `companyID` or `company.id` — those are the 32-character Workday WID and match each other. Skip WID-shaped values and the company name. Embed the code in RAG content as `Company Reference ID`. Existing company rows need a recache before `912` lookup works.

When a code has no exact metadata hit (or the token is not guaranteed exact), `searchDocumentsByTypes` ranks company, cost center, fund, LOB, and spend category by confidence. `pickTopReferenceMatch` treats the highest-confidence document as the object type for `resolveReferenceCode` and the email directory. Do not assign a type when two different types are nearly tied. Create/enrich company SOAP override uses exact metadata matches only (`confidence === 1`); do not submit an inexact similar neighbor as `Company_Reference_ID`. An LLM-supplied company WID is applied only when it matches an exact company from codes in the email body, or when the email has no codes (findCompanies-only). When the body is present, do not add `emailWorktags.company.extracted` or the model's `referenceId` to the lookup set unless that code appears in the body. Use extracted text only when there is no email body. Skip 4-digit calendar years (`19xx` / `20xx`), currency digit groups (`$1,912.00`), zip+4 fragments, and phone-number fragments so invoice amounts and contact data do not trigger lookups. Cap inexact embedding searches at `MAX_INEXACT_REFERENCE_LOOKUPS` per email. `resolveReferenceCode` / `findCachedReferenceMatches` rethrow similarity outages (do not treat an outage as "no match"). The email directory (`resolveReferenceCodesFromText`) keeps exact metadata rows when an inexact embedding fails; that failed code is listed as no cached match. Include empty-match rows in the prompt so the model sees codes the extractor found but the cache missed.

Do not dump all cached IDs into prompts. Extract candidate codes from the email, look up only those codes, and inject matches. A numeric code such as `912` may be a company, not a cost center — resolve across types before assigning. Use the highest-confidence match to decide the object type in the directory and `resolveReferenceCode`. Auto-select the invoice company only from a unique exact company hit.

## When adding a new document type

1. Add it to `DOCUMENT_TYPES`
2. Wire the cache/RAG path that writes that type
3. Ensure the value fits `documents.type VARCHAR(20)`
