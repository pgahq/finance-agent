---
name: data-and-state-changes
description: >-
  Cold-start Postgres schema init, documents RAG table migrations, and cached
  Workday reference IDs for finance-agent. Use when changing DocumentType,
  documents CHECK constraints, getDatabaseConnection schema setup, pgvector
  indexes, debugging documents_type_check / schema init Lambda failures, cache
  prune in syncDataSource, companyReferenceId / exact reference ID lookup,
  cache_companies, findCompanies billed-name search, or email short codes such as 912.
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
block Lambda startup. Schema-init failures clear the pool so a later invocation
(next schedule, concurrent cold start, or the next processor Event invoke)
reruns the migration. Lambda async retries are disabled
(`MaximumRetryAttempts: 0` in `template.yml`). A
transaction-scoped advisory lock serializes the constraint DDL across concurrent
Lambda cold starts.

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

`findDocumentsByReferenceId` exact-matches `metadata.code`, `metadata.referenceId`, and `metadata.companyReferenceId` across selected types. Company cache stores `companyReferenceId` from Workday `referenceID1` (Company_Reference_ID, e.g. `912`). The companies WQL data source has no `referenceID` field — do not SELECT it. Do not use `companyID` or `company.id` — those are the 32-character Workday WID and match each other. Skip WID-shaped values and the company name. Embed the code in RAG content as `Company Reference ID`. Existing company rows need a recache before `912` lookup works.

When a code has no exact metadata hit (or the token is not guaranteed exact), `searchDocumentsByTypes` ranks company, cost center, fund, LOB, and spend category by confidence. `pickTopReferenceMatch` treats the highest-confidence document as the object type for `resolveReferenceCode` and the email directory. Do not assign a type when two different types are nearly tied. Create/enrich company SOAP override uses exact metadata matches only (`confidence === 1`); do not submit an inexact similar neighbor as `Company_Reference_ID`. An LLM-supplied company WID is applied only when it matches an exact company from codes in the email body, or when the email has no codes (findCompanies-only). When the body is present, do not add `emailWorktags.company.extracted` or the model's `referenceId` to the lookup set unless that code appears in the body. Use extracted text only when there is no email body. Skip 4-digit calendar years (`19xx` / `20xx`), currency digit groups (`$1,912.00`), zip+4 fragments, and phone-number fragments so invoice amounts and contact data do not trigger lookups. Cap inexact embedding searches at `MAX_INEXACT_REFERENCE_LOOKUPS` per email. `resolveReferenceCode` / `findCachedReferenceMatches` rethrow similarity outages (do not treat an outage as "no match"). The email directory (`resolveReferenceCodesFromText`) keeps exact metadata rows when an inexact embedding fails; that failed code is listed as no cached match. Include empty-match rows in the prompt so the model sees codes the extractor found but the cache missed.

Do not dump all cached IDs into prompts. Extract candidate codes from the email, look up only those codes, and inject matches. A numeric code such as `912` may be a company, not a cost center — resolve across types before assigning. Use the highest-confidence match to decide the object type in the directory and `resolveReferenceCode`. Auto-select the invoice company only from a unique exact company hit.

`findCompanies` searches by billed company name or Company_Reference_ID only. Street, city, state, and ZIP are stripped from the query (`companyNameSearchQuery`) before embedding so a bill-to line such as `PGA JR. LEAGUE 100 Avenue of the Stars Palm Beach Gardens FL 33418` does not rank a similarly named affiliate. Keep address on `extractedInformation` and compare it after name candidates exist. Do not put the bill-to address in the search string. `findSuppliers` may still search by address.

## When adding a new document type

1. Add it to `DOCUMENT_TYPES`
2. Wire the cache/RAG path that writes that type
3. Ensure the value fits `documents.type VARCHAR(20)`

## Cost center related LOB metadata

`cache_cost_centers` stores Workday related Line of Business worktags on existing `cost_center` documents (`metadata.relatedLob`). It does not add a document type. Lookup is by `metadata.code` / `workday_id` via `getCostCenterRelatedLobsByCodes`, not RAG. Cost center codes match with spaces or underscores (`CC-Building Services-PBG` and `CC-Building_Services-PBG`). RAG content is name + code only; a relatedLob-only rewrite updates metadata and keeps the existing embedding so an OpenAI 500 cannot block the cache.

`relatedLob` shape:

```ts
{
  requiredOnTransaction: boolean;
  defaultReferenceId: string | null;
  allowedReferenceIds: string[];
  defaultIds: { type: string; value: string }[];
  allowedIds: { type: string; value: string }[];
}
```

`defaultIds` / `allowedIds` keep SOAP `WID`, `Organization_Reference_ID`, and `Custom_Organization_Reference_ID`. Submit prefers `Organization_Reference_ID` (example `LOB-Building_Services`), then custom org id, then WID.

Source is Financial Management `Get_Related_Worktags_for_Worktags`. PGA Line of Business is a custom organization, so SOAP `Worktag_Type_ID` is typically `CUSTOM_ORGANIZATION_01` (or a WID plus Descriptor `Line of Business`), not `LINE_OF_BUSINESS`. Do not treat `CUSTOM_ORGANIZATION_02`–`10` as LOB. Allowed ids are `Organization_Reference_ID` / `Custom_Organization_Reference_ID` and often have no `LOB-` prefix (example: `Building Services` on `CC-Building Services-PBG`). Parse those as related LOB. `Related_Worktags_Data` is unbounded in the WSDL, so strong-soap returns an array; flatten `Related_Worktags_by_Type_Data` from each item. Lookup matches `metadata.code` / `workday_id` and treats space vs underscore in the cost center code as the same key.

Invoice line build fills a missing `lineOfBusinessId` from the related default, or from an allowed LOB only when exactly one non-fallback allowed value exists. Do not pick the first of several allowed LOBs at extract/submit time. `Default_Line_Of_Business` is used when related worktags do not yield a unique real LOB. A validation retry that is already replacing the fallback LOB may use any allowed value. SOAP submit treats an existing related org/custom-org/WID worktag as Line of Business even without a `LOB-` prefix, and does not append the global fallback beside it. Event `Organization_Reference_ID` values are not Line of Business.

If `Get_Related_Worktags_for_Worktags` fails (including unauthorized), keep previously cached `relatedLob` metadata instead of writing `EMPTY_RELATED_LOB` over it. If the follow-up `getCostCenterRelatedLobsByCodes` read also fails, existing rows still keep their stored `relatedLob` (including when name/code changes); only new cost center inserts get `EMPTY_RELATED_LOB`. Do not Slack on every unauthorized cache run; log at debug. Required-LOB faults that also mention an unavailable cost center stay on the LOB retry path; they are not classified as a cost-center value error.

When Workday returns a related-worktag fault that requires Line of Business (`must also have a value: Line of Business`), retry as `worktag:lob` — even if another `Validation_Error` says the Cost Center is not available for the company. Do not send that combination to the validation-field classifier; it will pick `worktag:costCenter` and swap to the fallback cost center. If related fill and fallback LOB are already applied, do not omit Line of Business; surface the original required-LOB fault.

Empty cached `relatedLob` is not a hit. Retry loads related worktags live by cost center code and Workday id (`getCostCenterWorkdayIdsByCodes`, then `Get_Related_Worktags_for_Worktags`) and applies an allowed LOB to every line missing one. If that live call is not authorized, submit keeps the original validation error and does not replace it with the processing fault. If Workday rejects the default (`does not allow worktag values: Line of Business`), the same related-LOB swap runs.

Related-LOB cache and live submit lookup require the finance-agent ISU to have Get (Integration Permissions) on domain **Manage: Related Worktags** for Financial Management `Get_Related_Worktags_for_Worktags`. `Submit_Supplier_Invoice` is not enough. Without that grant, cache and live lookup soft-fail and only `FALLBACK_LOB_ID` / the original validation error remain.
