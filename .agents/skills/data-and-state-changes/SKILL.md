---
name: data-and-state-changes
description: >-
  Cold-start Postgres schema init, documents RAG table migrations, and cached
  Workday reference IDs for finance-agent. Use when changing DocumentType,
  documents CHECK constraints, getDatabaseConnection schema setup, pgvector
  indexes, debugging documents_type_check / schema init Lambda failures, cache
  prune in syncDataSource, companyReferenceId / exact reference ID lookup,
  cache_companies SOAP Get_Workday_Companies, financeAgentAliases,
  findCompanies billed-name search, company address tags, email short codes
  such as 912, or cache_suppliers Workday Supplier IDs (S-XXXXXX,
  metadata.supplierId) and the supplier re-sync backfill.
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

`employee` documents cache rows from the **Worker Assignment For AP Agent** custom report. Metadata: `email` (exact assignee lookup on create-invoice), `active` (boolean from Workday `Active_Status` / terminated flag; missing treated as active for legacy rows), optional `name` (Full Legal Name), `preferredName`, and `employeeId`. Slack and Workday assignee notes use `preferredName`, then `name`. Inactive workers remain in the cache with `active: false`; assignee lookup ignores them. Populated by `cache_employees`, not WQL. Until the next cache run, existing rows have no `preferredName` and display legal name.

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

`findDocumentsByReferenceId` exact-matches `metadata.code`, `metadata.referenceId`, and `metadata.companyReferenceId` across selected types. Company cache stores `companyReferenceId` from SOAP `Company_Reference_ID` (e.g. `912`). Do not use `companyID` or `company.id` — those are the 32-character Workday WID and match each other. Skip WID-shaped values and the company name. Embed the code in RAG content as `Company Reference ID`. Existing company rows need a recache before `912` lookup works.

Supplier cache (`cache_suppliers.ts`, WQL `suppliers1`) stores the Workday Supplier ID (`supplierID`, e.g. `S-001234`) as `metadata.supplierId` and embeds it in RAG content as `Supplier ID`. Read it with `textFromWqlValue` and skip WID-shaped values. `isUpdated` re-syncs a row when `lastUpdatedDateTime` or `supplierId` differs, so the first sync after this field shipped re-embeds every active supplier. That run can exceed the 900s `CacheSuppliersProcessor` timeout (it is not paged); batches of 50 commit as they go and later daily runs finish the backfill, or run `RefreshSuppliers` (paged at 500) once after deploy. Supplier ID hints from Intercom notes resolve only against `metadata.supplierId` by exact match, so an ID cannot resolve until its row has been backfilled. `findDocumentsByReferenceId` does not cover suppliers.

When a code has no exact metadata hit (or the token is not guaranteed exact), `searchDocumentsByTypes` ranks company, cost center, fund, LOB, and spend category by confidence. `pickTopReferenceMatch` treats the highest-confidence document as the object type for `resolveReferenceCode` and the email directory. Do not assign a type when two different types are nearly tied. Create/enrich company SOAP override uses exact metadata matches only (`confidence === 1`); do not submit an inexact similar neighbor as `Company_Reference_ID`. An LLM-supplied company WID is applied only when it matches an exact company from codes in the email body, or when the email has no codes (findCompanies-only). When the body is present, do not add `emailWorktags.company.extracted` or the model's `referenceId` to the lookup set unless that code appears in the body. Use extracted text only when there is no email body. Skip 4-digit calendar years (`19xx` / `20xx`), currency digit groups (`$1,912.00`), zip+4 fragments, and phone-number fragments so invoice amounts and contact data do not trigger lookups. Cap inexact embedding searches at `MAX_INEXACT_REFERENCE_LOOKUPS` per email. `resolveReferenceCode` / `findCachedReferenceMatches` rethrow similarity outages (do not treat an outage as "no match"). The email directory (`resolveReferenceCodesFromText`) keeps exact metadata rows when an inexact embedding fails; that failed code is listed as no cached match. Include empty-match rows in the prompt so the model sees codes the extractor found but the cache missed.

Do not dump all cached IDs into prompts. Extract candidate codes from the email, look up only those codes, and inject matches. A numeric code such as `912` may be a company, not a cost center — resolve across types before assigning. Use the highest-confidence match to decide the object type in the directory and `resolveReferenceCode`. Auto-select the invoice company only from a unique exact company hit.

`findCompanies` embeds billed company name or Company_Reference_ID only. Street, city, state, and ZIP are stripped from the query (`parseCompanySearchQuery` / `companyNameSearchQuery`) before embedding so a bill-to line such as `PGA JR. LEAGUE 100 Avenue of the Stars Palm Beach Gardens FL 33418` does not rank a similarly named affiliate. Peel city tokens only while at least two name tokens remain (unless the remainder is a house number or empty, which skips search). That keeps `PGA TOUR` instead of leftover `PGA`. Keep a one-word city peel when three or more name tokens remain (`PGA JR. LEAGUE Miami FL 33418` → `PGA JR. LEAGUE`); still restore that peel for shorter names so `PGA of America NY 10001` stays intact. Trailing state tokens must be USPS abbreviations; title-case `Co` is a company suffix, not Colorado. If peeling would drop the whole line and it did not start with a house number, keep the tokens before the state. Skip embedding when the remainder is a street address, a leftover house number, or a single org-stop token such as `PGA`, including after a street or PO Box strip (`PGA 100 Avenue of the Stars`). Pass bill-to in the separate `address` argument (or recover it as the stripped remainder). Company name search uses embedding similarity, plus a 1.0 only for exact `metadata.companyName`, `metadata.companyReferenceId`, or any `metadata.financeAgentAliases` value — not substring `LIKE` on content. Substring 1.0 would score every section whose legal name contains `PGA of America` above The Professional Golfers Association of America (`310`), whose legal name does not contain that phrase. Finance Agent aliases are External IDs on the company keyed to Integration System `FinanceAgent` (`WORKDAY_FINANCE_AGENT_SYSTEM_ID` overrides the System ID). Do not add aliases to `findDocumentsByReferenceId` (that path is short codes such as `912`, not nicknames). When address is present, `findCompanies` loads every cached company and tags house number plus distinctive street tokens, or PO Box, against `metadata.addressPrimary` and `metadata.publicAddresses` without reordering name results. Cache companies on that street that name search missed are appended so both signals are visible. ZIP / city / state alone never count as a street match. A single shared token such as `pga` is not enough (`100 PGA Tour Blvd` does not match `100 PGA Drive`). Two or more cache hits on the same street set `shared`; do not use ZIP/city to pick among them. Create-invoice submit does not auto-pick unique street over the LLM recommendation. Cache formatted addresses from SOAP `@Formatted_Address` (primary vs public usage flags). Store those address fields and `financeAgentAliases` on metadata and recache when name, reference ID, addresses, or aliases change. An empty alias list on a successful Get clears a removed nickname. Do not put the bill-to address in the embedding string. `findSuppliers` may still search by address.

Company cache is SOAP-only: `CacheCompanies` Event-invokes `CacheCompaniesProcessor`, which calls Financial Management `Get_Workday_Companies` (unfiltered, `Response_Filter.Count` 999, page only when `Total_Pages` is greater than 1; later pages reuse page 1 `As_Of_Entry_DateTime`). That Get returns catalog fields plus `Integration_ID_Data` `@System_ID=FinanceAgent`. Skip `Organization_Active` false. Empty `financeAgentAliases` on a successful Get clears nicknames; missing SOAP formatted addresses keep previously cached `addressPrimary` / `publicAddresses` instead of wiping streets. There is no companies WQL recache. If `Get_Workday_Companies` fails, skip the whole company sync and Slack — do not half-write aliases onto stale rows. A successful Get that reports companies (`Total_Results` or Company nodes) but parses none is the same fail-closed path, so a wrapper mismatch cannot look like an empty catalog. Quiet skip remains only when Workday itself returns none, or every returned node is inactive. Prune stays off: inactive orgs omitted from the snapshot keep their existing rows and aliases until a later prune or recache. The finance-agent ISU needs Get on `Get_Workday_Companies` (a separate Workday task from `Get_Payment_Terms` / `Get_Related_Worktags_for_Worktags` / `Submit_Supplier_Invoice`). That grant is unproven; without it production cache cannot refresh.

## When adding a new document type

1. Add it to `DOCUMENT_TYPES`
2. Wire the cache/RAG path that writes that type
3. Ensure the value fits `documents.type VARCHAR(20)`

## Cost center related LOB metadata

`cache_cost_centers` stores Workday related Line of Business worktags on existing `cost_center` documents (`metadata.relatedLob`). It does not add a document type. Lookup is by `metadata.code` / `workday_id` via `getCostCenterRelatedLobsByCodes`, not RAG. Cost center codes match with spaces or underscores (`CC-Building Services-PBG` and `CC-Building_Services-PBG`). RAG content is name + code only; a relatedLob-only rewrite updates metadata and keeps the existing embedding so an OpenAI 500 cannot block the cache.

Hybrid `findCostCenters` reranks via `rankCostCenterSearchResults`; inexact `resolveReferenceCode` cost-center hits use `adjustCostCenterSimilarity` plus the same non-DNU tie-break when adjusted confidence ties (`cost_center_match.ts`). Name or code starting with `zDNU` or `DNU` get a lower effective score unless the query is that explicit code or starts with `zDNU`/`DNU`.

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

Invoice line build fills a missing `lineOfBusinessId` from the related default, or from an allowed LOB only when exactly one non-fallback allowed value exists. Do not pick the first of several allowed LOBs at extract/submit time. `Default_Line_Of_Business` is used when related worktags do not yield a unique real LOB. When email coding includes both a cost center and a Line of Business, do not match that LOB against the full LOB catalog (`findLobs`). Keep the email LOB if it is in that cost center's related allowed/default set (including when ids differ only by an optional `LOB-` prefix). Otherwise use the related default, or the unique allowed value when there is no default. If several allowed values exist and there is no default, keep the email LOB until a validation retry. A validation retry that is already replacing the fallback LOB may use any allowed value. When Workday rejects a submitted Line of Business (`does not allow worktag values: Line of Business`), the first retry looks up related worktags for that cost center and swaps to the related default, or the first allowed LOB when there is no default — including when the rejected value is a real LOB, not only `Default_Line_Of_Business`. Keep a line whose current id already matches that related default. Do not omit Line of Business on that first retry. SOAP submit treats an existing related org/custom-org/WID worktag as Line of Business even without a `LOB-` prefix, and does not append the global fallback beside it. Event `Organization_Reference_ID` values are not Line of Business.

If `Get_Related_Worktags_for_Worktags` fails (including unauthorized), keep previously cached `relatedLob` metadata instead of writing `EMPTY_RELATED_LOB` over it. If the follow-up `getCostCenterRelatedLobsByCodes` read also fails, existing rows still keep their stored `relatedLob` (including when name/code changes); only new cost center inserts get `EMPTY_RELATED_LOB`. Do not Slack on every unauthorized cache run; log at debug. Required-LOB faults that also mention an unavailable cost center stay on the LOB retry path; they are not classified as a cost-center value error.

When Workday returns a related-worktag fault that requires Line of Business (`must also have a value: Line of Business`), retry as `worktag:lob` — even if another `Validation_Error` says the Cost Center is not available for the company. Do not send that combination to the validation-field classifier; it will pick `worktag:costCenter` and swap to the fallback cost center. If related fill and fallback LOB are already applied, do not omit Line of Business; surface the original required-LOB fault.

Empty cached `relatedLob` is not a hit. Retry loads related worktags live by cost center code and Workday id (`getCostCenterWorkdayIdsByCodes`, then `Get_Related_Worktags_for_Worktags`) and applies an allowed LOB to every line missing one. If that live call is not authorized, submit keeps the original validation error and does not replace it with the processing fault. If Workday rejects a Line of Business (`does not allow worktag values: Line of Business`), the same related-LOB lookup runs and the first retry replaces the rejected value with the related default, or the first allowed LOB when there is no default. Keep a line already on that related default. Do not omit Line of Business on that first retry.

Related-LOB cache and live submit lookup require the finance-agent ISU to have Get (Integration Permissions) on domain **Manage: Related Worktags** for Financial Management `Get_Related_Worktags_for_Worktags`. `Submit_Supplier_Invoice` is not enough. Without that grant, cache and live lookup soft-fail and only `FALLBACK_LOB_ID` / the original validation error remain.
