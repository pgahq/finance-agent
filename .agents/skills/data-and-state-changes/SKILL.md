---
name: data-and-state-changes
description: >-
  Cold-start Postgres schema init and documents RAG table migrations for
  finance-agent. Use when changing DocumentType, documents CHECK constraints,
  getDatabaseConnection schema setup, pgvector indexes, or debugging
  documents_type_check / schema init Lambda failures.
---

# Data and state changes

## Cold-start schema init

`getDatabaseConnection` in `src/lib/database.ts` runs on every Lambda cold start:

1. Enable `vector`
2. `CREATE TABLE IF NOT EXISTS documents`
3. Create indexes (including ivfflat on `embedding`)
4. Recreate `documents_type_check` via `migrateDocumentsTypeCheck`

`CREATE TABLE IF NOT EXISTS` does **not** alter an existing table. Type allowlist changes must go through the migration helper, not only the CREATE TABLE DDL.

## Document types

`DOCUMENT_TYPES` / `DocumentType` in `src/lib/database.ts` is the source of truth for types the app reads and writes. Keep cache Lambdas, RAG tools, and the CHECK allowlist aligned with that list.

## Orphan `documents.type` rows

Preview or unmerged deploys can insert types (for example `shipping_address` / `address`) that are not on the current allowlist. A naive `DROP` + `ADD CONSTRAINT` then fails with `documents_type_check` / `23514` and aborts processor startup (including CreateInvoiceProcessor) before Workday work runs.

`migrateDocumentsTypeCheck` must:

- Discover distinct `type` values outside `DOCUMENT_TYPES`
- Log them
- Include those existing values in the CHECK so cold start succeeds
- Not leave a half-applied migration: on schema init failure, close and clear the module pool so the next invoke re-runs init

Do not delete production orphan rows from app code without an explicit ops decision.

## When adding a new document type

1. Add it to `DOCUMENT_TYPES`
2. Wire the cache/RAG path that writes that type
3. Rely on `migrateDocumentsTypeCheck` (no separate one-shot SQL migration file)
4. Ensure the value fits `documents.type VARCHAR(20)`
