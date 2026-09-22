---
name: integrations-and-external-contracts
description: >-
  Documents finance-agent HTTP APIs and external integrations (Intercom
  create-invoice, enrich-invoice, Workday, SSM secrets). Use when changing
  POST /create-invoice or /enrich-invoice, Intercom Data Connectors, bearer
  auth tokens, attachment upload contracts, Workday invoice memos, line item
  descriptions, supplier invoice numbers (check-print order and pay-file-safe
  characters), or Slack Workday object deep links.
---

# Integrations and external contracts

## HTTP triggers

Both routes share bearer auth against SSM `/finance-agent/enrich-invoice-api-token` (`ENRICH_INVOICE_API_TOKEN`). Callers send `Authorization: Bearer <token>`.

### `POST /create-invoice`

Intercom Data Connector entry point for new supplier invoices (no existing Workday record).

Request body:

```json
{ "conversationId": "1234567890" }
```

This is a new Intercom-only contract. Direct-upload bodies
(`fileName` / `contentType` / `fileContent`) are not accepted.

Flow:

1. `GET {INTERCOM_API_BASE_URL}/conversations/{id}?display_as=plaintext` with `INTERCOM_ACCESS_TOKEN` and `Intercom-Version: 2.14`
2. Collect every `application/pdf` attachment from `source` + conversation parts (non-PDF only → 400)
3. Download signed CDN URLs as **raw binary** immediately (URLs expire ~30 minutes; host allowlisted to Intercom CDN; combined max 20MB)
4. Upload each file to S3 (`new-invoices/{requestId}/{index}-{sanitizedFileName}`)
5. Resolve **assignee email** from the same conversation GET: among `conversation_parts.conversation_parts`, use the **last** part with `part_type === "custom_action_started"` and take `author.email` (any `author.type`). Forward as `assigneeEmail` on each processor invoke.
6. Async-invoke `CreateInvoiceProcessor` once per attachment with `emailContext` (`emailFrom` / `subject` from the attachment’s message when applicable; `plainTextBody` is the **source email body plus every non-empty `conversation_parts` body**, joined with blank lines in API order — including internal notes, not only the message that holds the PDF), shared `assigneeEmail`, and `conversationCreatedAt` from Intercom `created_at`. Processor Lambda async retries are off (`MaximumRetryAttempts: 0`); a thrown error Slacks once and does not re-run.
7. Each record creates a separate Workday invoice; return HTTP status to the Data Connector
8. Workday `Invoice_Received_Date` on each new supplier invoice is set from the Intercom conversation `created_at` (mailbox receipt), formatted as `YYYY-MM-DD` like other SOAP dates

**Workday assignee on create:** `CreateInvoiceProcessor` looks up `assigneeEmail` in the daily **Worker Assignment For AP Agent** custom report cache (`employee` documents, exact email match). Report **Workday ID** values must be Worker WIDs (`WorkerObjectType`: `WID`, `Employee_ID`, or `Contingent_Worker_ID`; we send `WID`). When a Worker WID is found, SOAP `Submit_Supplier_Invoice` sets `Supplier_Invoice_Data.Work_Queue_Information_Data.Assignee_Reference` (not a top-level `Supplier_Invoice_Data` field); when the part is missing, email is blank, or there is no cache match, **omit** `Assignee_Reference` (create still succeeds). If Workday returns a validation fault that references assignee, submit **retries once** without `Assignee_Reference`. Cache job: `CacheEmployees` / `CacheEmployeesProcessor` fetches `AP_AGENT_WORKERS_CUSTOM_REPORT_PATH` in `ap_agent_workers_report.ts` (`wdw-7212/Worker_Assignment_For_AP_Agent`, `customreport2` JSON). Report columns: `Workday_ID`, `Primary_Work_-_Email`, `Active_Status`, `Full_Legal_Name`, `Preferred_Name`, `Employee_ID` (logged on each sync). All parseable report rows are cached; `metadata.active` is a boolean derived from `Active_Status` (and terminated when present). Assignee lookup requires `active !== false`. Create-invoice Slack and Workday notes display `preferredName`, falling back to Full Legal Name (`name`) when Preferred Name is blank or not yet cached. Prune removes employees no longer in the report snapshot.

`CreateInvoiceProcessor` looks for a purchase order number in the email/filename and fetches that PO **before** enrichment when one is present. If the PO is only on the PDF, enrichment extracts it and the processor fetches the PO afterward. If enrichment extracts a *different* PO number than the email/filename hit, submit uses that matched PO for company and lines — not the early PO. If that late load misses, submit drops the early PO and falls through to **Default OCR Company** (`Company_Reference_ID` `Default_OCR_Company`, or `WORKDAY_DEFAULT_COMPANY_WID` when set) and skips early PO lines.

PO line parsing (`parsePurchaseOrderLines`) merges line `Worktags_Reference`, **Additional Worktags** (`Purchase_Order_Line_Worktags_Data`), and split `Worktag_Reference` rows into a deduped passthrough list. When the PO line has splits, matched invoice lines also submit `Supplier_Invoice_Split_Line_Data` copied from the PO split rows (amounts and worktags). Accepts both legacy `Service_Line_Data` / `Goods_Line_Data` and Get PO `*_Replacement_Data` field names. Org passthrough (`Organization_Reference_ID` / `Custom_Organization_Reference_ID`, e.g. venue `VENU-...`) is matched by value against related LOB, not blocked by ID type alone, so venue/event coexist with LOB. Additional worktags always copy: shared/uniform PO tags apply to unmatched lines (splits need exact match), splits inherit line-level venue/event/custom missing on that split, shared fund/cost-center/LOB stay on the parent when splits lack that dimension, and PO fund/cost-center/LOB replace fallback (email/real scalar still wins ties). Synthetic remainder lines merge without PO line matching so they do not inherit a `Purchase_Order_Line_ID` or split rows; shared additional PO worktags still overlay afterward.

Company priority is:

1. Email-coded company
2. PO company, if a matching PO is available
3. Recommended `different` company from the supplier invoice PDF
4. Default OCR Company

When the default company is used and any invoice lines remain, those lines must use Default OCR fallback worktags (`FALLBACK_COST_CENTER_ID`, `FALLBACK_FUND_ID`, `FALLBACK_SPEND_CATEGORY_ID` / `Default_OCR_Spend_Category`, `FALLBACK_LOB_ID`). Do not keep PO line references, email coding, events, or ship-to on those lines. Invoice notes must not list email worktags in that case; they should say Default OCR fallback coding was applied instead.

| HTTP | Meaning |
| --- | --- |
| 202 | Accepted — body includes `status: accepted`, `message`, `requestId`, and `conversationId` |
| 400 | Missing `conversationId`, invalid JSON, no PDF, or attachment too large |
| 401 | Bad/missing finance-agent bearer token |
| 404 | Intercom conversation not found |
| 502 | Intercom API or CDN download failed |
| 500 | Missing Intercom token, S3/invoke failure, unexpected error |

Error bodies include `status: error` and `message` so Fin can map response fields.

### `POST /enrich-invoice`

On-demand enrichment for an existing Workday supplier invoice. Body: `{ "supplierInvoiceId": "<WID or invoice number>" }`. Looks up email context from Workday OCR inbound email data, not Intercom.

## Invoice memos

Create and enrich compose Workday header and line `Memo` values in code after enrichment (`src/lib/invoice_memo.ts`). Include a token only when that field is present (any combination). Join with `. ` (never `|`). Token order is check-print first: `AC`, `Customer ID`, `Job`, PO, `Service Period`, then the existing one-sentence description.

Pay-file / check print safety:

- Do not emit `|`, `>`, or `<`. Labels we control do not use `#` (`AC 1033562`, `Job 5914196`). A `#` that is part of a supplier-provided value may stay.
- After compose, keep letters, digits, space, hyphen, period, comma, apostrophe, slash, and `#`; replace other characters with a space.
- `sanitizeSuppliersInvoiceNumber` runs on create and enrich before SOAP `Suppliers_Invoice_Number` (letters, digits, hyphen, period, slash, `#`; other characters become `-`). Do not rewrite an existing Workday `Invoice_Number` on enrich.

- Memo PO is the **matched Workday document number** when a PO was loaded, otherwise the normalized extracted value (`PO-` + 6 word chars). Free-text PO column values that are not `PO-xxxxxx` (e.g. `PGA COACHING`) are not put in the memo.
- Account number is PGA's customer/sold-to account at the supplier (`Account #`, `Sold To Number`). Skip bank/ABA/ACH remittance account numbers (Cushman `FOR ELECTRONIC PAYMENTS`) in the **enrichment prompt only** — there is no code-side remittance parser. Do not use GL, cost center, company code, or the supplier invoice number. Do not strip an `AC-` prefix from a sold-to value such as `AC-1033562`.
- Job aliases include **Order #**. Do not map unlabeled Project / `PRJ…` to Job. Drop Job when it normalizes to the same PGA PO already in the memo.
- Customer ID aliases include **Bill-To Customer ID** and **Cust ID**. If it equals the account number, emit only `AC`.
- Service period may appear inside a line description; keep the document wording.
- The same identifier prefix is applied to every invoice line memo. Header `extractedInformation.memo` and the line-merge prompt must not prepend identifiers — composition strips those tokens if the model still includes them.
- **Create** always submits the composed memo, including a description-only sentence on a new invoice.
- **Enrich** submits a composed header memo only when identifier tokens exist, so a description-only extraction does not overwrite an existing OCR header memo. Workday keeps `currentInvoice.Memo` when `memo` is omitted. Line memos still get the identifier prefix when identifiers exist.

## Invoice line item descriptions

Workday Line Item Description (`Item_Description`) is the concatenated identifying text from the invoice **row**, not a one-sentence summary and not only the column labeled Description.

Enrichment prompt (`src/prompts/enrich_invoice_prompt.ts` Part 9) extracts `descriptionCells` left-to-right (Activity, Resource, SKU, Description, and similar) and asks the model to skip Notes and Comments. `composeInvoiceLineDescription` / `withComposedLineDescriptions` in `src/lib/invoice_lines.ts` then join those cells with ` - ` when any identifying cells exist (the model `description` is fallback only). Code drops empty cells and cells that match the line's printed quantity, unit cost, amount, or a `$` currency value; it does not drop Notes/Comments by column name. A shorter cell is dropped only when a longer cell contains it as a whole token, not as a raw substring. Example: Activity `Ryan Poland` + Description `Project Management` → `Ryan Poland - Project Management`. Header service dates, PO, account, job, and customer ID stay out of Item Description. Freight is classified from the original Description column, then remaining merchandise rows are composed. Compose keeps that original Description when the concatenated cells would classify as freight and the original would not, so SOAP `splitFreightLines` does not reclass the merchandise row.

The terse 1-sentence summary is line `Memo`, generated **after** that concatenation (merge prompt), then identifier-prefixed in `composeInvoiceMemo`. After merge, `pinExtractedLineDescriptions` overlays the composed description by line index so the merge model cannot shorten Item Description.

## Secrets / env

| Name | Source | Used by |
| --- | --- | --- |
| `ENRICH_INVOICE_API_TOKEN` | SSM `/finance-agent/enrich-invoice-api-token` | Both HTTP triggers (inbound auth) |
| `INTERCOM_ACCESS_TOKEN` | SSM `/finance-agent/intercom-access-token` | Create-invoice Intercom client |
| `INTERCOM_API_BASE_URL` | Lambda env (default `https://api.intercom.io`) | Create-invoice; override for EU/AU |
| `INTERCOM_APP_ID` | CFT `IntercomAppId` (`c722leqk` on `deploy-to-dev`, `jyi16dpc` on `deploy-to-prod`) | Slack inbox permalink workspace. Create-invoice uses this stack value, not the conversation `app_id`. |
| `WORKDAY_UI_BASE_URL` | CFT `WorkdayUiBaseUrl` (`https://impl.workday.com` on `deploy-to-dev`, `https://www.myworkday.com` on `deploy-to-prod`) | Slack Workday object deep links. SOAP still uses `WORKDAY_DOMAIN`. |

Intercom Access Token needs **Read conversations** only (`read_conversations`).

Create-invoice Slack **errors** show the Workday `Message` plus prior submit attempts — not SOAP dumps. Remaining invoice details (`fileName`, `s3Key`) still appear as JSON; `conversationUrl` stays a footer link. Enrich Slack **errors** include `workdayId` in that JSON plus a not-authorized `note` when the task is not authorized; the Workday footer link uses `workdayId`. Create-invoice Slack **success** uses the same human layout as enrich (`*Changes*`, fallbacks, `*Prior submit failures*`). The Workday **Invoice Number** (`SUPIN-XXXX`, SOAP `Invoice_Number`) is in the headline and as the first Changes bullet, plus a small JSON of `invoiceNumber` / `invoiceWID` / `fileName` / `conversationId` / `lineCount`. If Get has no `Invoice_Number`, omit that number from the create headline, Changes bullet, and JSON. Enrich success already puts that number in the `processed \`SUPIN-XXXX\`` headline and repeats it as `*Workday Invoice*`. When Slack has an invoice WID (`invoiceWID` on create/enrich success, `workdayId` on enrich error), add a footer `<url|View in Workday>` and, when an invoice number is also present, make the Changes bullet number a Slack link. URL: `{WORKDAY_UI_BASE_URL}/{WORKDAY_TENANT}/d/inst/deeplink/{WID}.htmld` (`https://impl.workday.com` in implementation, `https://www.myworkday.com` in production). Omit the Workday link when the WID, UI base URL, or tenant is missing. Do not use `Supplier_Invoice_Reference_ID` (`SUPPLIER_INVOICE-3-…`) for Slack. After create, Get the invoice by WID and read `Invoice_Number`. Enrich uses Get `Invoice_Number` only — omit the Slack invoice number if Get does not return it. Sanitized SOAP throws keep a `Validation_Fault` object so enrich skip-registry classification still matches, and keep `serializedError` for a future threaded dump once a Slack bot token exists. Successful Workday submits that retried after a validation fault also include `priorFailures` on create and enrich Slack success.

## Workday SOAP authentication

`CreateInvoiceProcessor` and `EnrichInvoiceProcessor` deliberately share:

- `EnrichInvoiceProcessorRole`
- Global `WORKDAY_DOMAIN`, `WORKDAY_TENANT`, `WORKDAY_CLIENT_ID`, `WORKDAY_CLIENT_SECRET`, and `WORKDAY_REFRESH_TOKEN` environment sources
- `buildResourceManagementClient` in `src/lib/workday.ts`
- OAuth refresh-token grant, `strong-soap` `BearerSecurity`, and the Resource Management v44.1 endpoint

Custom validation rules, payment terms, company cache, and cost-center related worktags use `buildFinancialManagementClient` (Financial Management v46.0) with the same OAuth secrets. `Get_Workday_Companies` is how `cache_companies` loads legal names, `Company_Reference_ID`, formatted addresses, and Finance Agent aliases (`Integration_ID_Data` `@System_ID=FinanceAgent`). That operation is a separate Workday task from `Get_Payment_Terms`, `Get_Related_Worktags_for_Worktags`, and Resource Management `Submit_Supplier_Invoice`. The finance-agent ISU needs Get on `Get_Workday_Companies` before the company cache can refresh; without it the whole recache skips (names and addresses too). `Get_Related_Worktags_for_Worktags` is how `cache_cost_centers` loads default/allowed Line of Business ids for each cost center, and how supplier-invoice submit retries look up an allowed LOB when Workday requires Line of Business or rejects a submitted Line of Business. That operation is a separate Workday task from Resource Management `Submit_Supplier_Invoice`. The finance-agent ISU needs Get (Integration Permissions) on domain **Manage: Related Worktags** before related-LOB fill can populate cache or live submit lookup; `Submit_Supplier_Invoice` is not enough. If the ISU is missing it, Workday returns `SOAP-ENV:Server.processingError` / `The task submitted is not authorized`; cache keeps previously stored `relatedLob` metadata (even if the follow-up Postgres related-LOB read throws) and does not Slack on every failed run. Required-LOB faults do not omit Line of Business after related fill and fallback are exhausted; submit surfaces the original validation error. PGA Line of Business related worktags come back as `CUSTOM_ORGANIZATION_01` (not `LINE_OF_BUSINESS` or `CUSTOM_ORGANIZATION_02`–`10`); parse org reference ids even without a `LOB-` prefix and keep SOAP `WID`, `Organization_Reference_ID`, and `Custom_Organization_Reference_ID` on cached `relatedLob`. Extract/submit fill uses the related default or a unique allowed LOB. When email coding includes both a cost center and a Line of Business, do not match the LOB from the full catalog; keep it if it is allowed for that cost center (including when ids differ only by an optional `LOB-` prefix), otherwise use the related default or unique allowed. If several allowed values exist and there is no default, keep the email LOB until a validation retry. A validation retry uses the related default, or any allowed value when there is no default. Keep a line already on that related default. Do not omit Line of Business as the first retry when Workday says a cost center does not allow the submitted Line of Business. SOAP submit treats an existing related org/custom-org/WID worktag as Line of Business even without a `LOB-` prefix, and does not append the global fallback beside it. Required-LOB faults that also mention an unavailable cost center stay on the LOB retry path; they are not classified as a cost-center value error.

Do not add a separate Workday auth path or secret set for create-invoice.

## Workday supplier invoice payload

Tax and freight/shipping/handling are header amounts, not invoice lines:

- `Tax_Amount` comes from `extractedTaxAmount`
- `Freight_Amount` comes from `extractedFreightAmount` (PDF labels may be freight, shipping, handling, or delivery)
- Those charge rows must not appear in `Invoice_Line_Replacement_Data`

If the PDF lists shipping/handling as a line item, capture the amount on `Freight_Amount` and omit that row from the SOAP line payload. `splitFreightLines` in `src/lib/invoice_lines.ts` strips those rows before merge/PO matching and again when building the SOAP body. The matcher treats carrier-only service labels (`FedEx Ground`, `FedEx Home Delivery`, `UPS Ground`) and common service words (`standard`, `priority`, `2-Day`, `air`/`ocean` freight, `surcharge`, `freight in`/`out`) as freight, and still rejects merchandise lookalikes (`Shipping Container`, `Freightliner parts`, `Shipping Supplies`). Amount recovery reads SOAP `Unit_Cost` and `Quantity` when `Extended_Amount` is missing.

When the invoice document does not display a per-line quantity column (`invoiceLineQuantityDisplayed: false` from enrichment, or inferred when the model omits the flag and every extracted line has null quantity and at least one line amount), merchandise lines submit as `Quantity: 0`, `Unit_Cost: 0`, and `Extended_Amount` from the line total (`extendedAmount`, or `unitCost` when extended amount is missing) — including synthesized update remainder `Invoice` lines. If any extracted line has a quantity, the document is treated as quantity-displayed regardless of the model flag. Explicit `true` from the model is not overridden. This is distinct from discount lines (`hasDiscount`), which use the same SOAP amounts but drop `Purchase_Order_Line_Reference`.

Do not invent unit cost from quantity and line total. Enrichment and merge must leave `unitCost` null when no unit price is printed. After merge, `alignSupplierInvoiceLineAmounts` submits `Quantity: 0`, `Unit_Cost: 0`, and `Extended_Amount` from the printed line total when unit cost is missing or `quantity * unitCost` (SOAP uses quantity `1` when quantity is null) does not equal extended amount to the cent. Matching qty / unit / extended triples are left unchanged. `normalizeSupplierInvoiceLineAmounts` runs the missing-quantity-column shape first, then this alignment, in both create and enrich.

If Workday still rejects submit with `Either Quantity and Unit Cost must equal zero or the Extended Amount must equal Quantity * Unit Cost`, the submit retry loop zeros `Quantity` and `Unit_Cost` on every merchandise line that has (a non-zero quantity or unit cost) and an extended amount, then resubmits. That retry is matched from the validation message (not the field classifier). Discount lines are left unchanged. Lines that already have Quantity 0 and Unit Cost 0, or that have no extended amount, are not rewritten.

Create vs update when no merchandise lines remain:

- **Create** (`submitNewSupplierInvoice`): omit `Invoice_Line_Replacement_Data` and submit header `Freight_Amount`. If amount due exceeds freight plus tax, synthesize a non-freight remainder line instead of re-including shipping. Create has no OCR lines, so do not send `[]`.
- **Update** (`submitSupplierInvoiceUpdate`): if `finalLines` are all freight, keep OCR merchandise (freight stripped) so goods are not wiped. When OCR is also all freight, send a remainder `Invoice` line (control minus freight minus tax, floored at 0) so SOAP actually replaces the shipping row — strong-soap drops empty repeating `Invoice_Line_Replacement_Data` arrays, which would leave the OCR shipping line in place. Workday Get may return those header amounts as strings; parse them before subtracting so a string `Freight_Amount` is not treated as 0.

Workday Get / strong-soap may return a single line as an object rather than an array. Unwrap with `[].concat(...)` before `splitFreightLines` so freight-only create still omits the line payload and freight-only update still replaces that row with a remainder `Invoice` line.

Submit logging must not include `client.lastRequest` or raw strong-soap error
objects. Those structures contain attachment bytes and the HTTP Authorization
header. Log request byte count plus a safe error summary, and throw a new error
containing only the original name/message.
For attachment submissions, log redacted outbound headers and only the SOAP
envelope `Header` element.

## Attachment bytes

- Intercom CDN → binary `Buffer` → `putBinaryToS3`
- Download URL must be `https` on `intercomcdn.com` / `*.intercomcdn.com` or `intercom-attachments-<n>.com` / `*.intercom-attachments-<n>.com` (SSRF allowlist); `fetch` uses `redirect: 'error'` so redirects cannot leave that host
- Only `application/pdf` attachments are accepted; missing PDF → 400
- Max individual and combined download size is 20MB; downloads use at most four
  concurrent requests; trigger Lambda timeout is 30s with 1024 MB memory
- Attachment names are sanitized to a basename before the S3 key
- Processor Event payload is metadata only (no file bytes)
- Each Workday invoice receives its corresponding PDF as `Attachment_Data`
- Success Slack details include filename, content type, byte size, and
  `includedInline`; never include base64 content
- Success Slack details include `conversationId` / Intercom conversation URL
  for create-invoice, and `priorFailures` when submit retried before succeeding
