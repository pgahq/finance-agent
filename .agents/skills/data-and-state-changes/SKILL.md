---
name: data-and-state-changes
description: >-
  Cold-start Postgres schema init and documents RAG table migrations for
  finance-agent. Use when changing DocumentType, documents CHECK constraints,
  getDatabaseConnection schema setup, pgvector indexes, debugging
  documents_type_check / schema init Lambda failures, or cache prune behavior
  in syncDataSource.
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
only when `sourceTotal` equals `items.size` (Workday `total` matches fetched
rows). Empty snapshots, missing totals, and incomplete pulls skip prune and
report `pruneSkipped` in Slack. Set `pruneDryRun: true` (cost centers:
`COST_CENTER_PRUNE_DRY_RUN=true`) to log `absent` / `absentIds` without deleting.
Do not enable prune for windowed sources such as events.

## When adding a new document type

1. Add it to `DOCUMENT_TYPES`
2. Wire the cache/RAG path that writes that type
3. Ensure the value fits `documents.type VARCHAR(20)`

## Cost center related LOB metadata

`cache_cost_centers` stores Workday related Line of Business worktags on existing `cost_center` documents (`metadata.relatedLob`). It does not add a document type. Lookup is exact by `metadata.code` / `workday_id` via `getCostCenterRelatedLobsByCodes`, not RAG.

`relatedLob` shape:

```ts
{
  requiredOnTransaction: boolean;
  defaultReferenceId: string | null;
  allowedReferenceIds: string[];
}
```

Source is Financial Management `Get_Related_Worktags_for_Worktags`. Invoice line build fills a missing `lineOfBusinessId` from the default (or the single allowed id) after PO and email worktags.
