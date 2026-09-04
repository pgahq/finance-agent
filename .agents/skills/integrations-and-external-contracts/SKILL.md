---
name: integrations-and-external-contracts
description: >-
  Documents finance-agent HTTP APIs and external integrations (Intercom
  create-invoice, Gmail create-invoice, Gmail Workspace add-on, enrich-invoice,
  Workday, SSM and Secrets Manager). Use when changing POST /create-invoice,
  POST /create-invoice/gmail, POST /gmail-addon, Intercom Data Connectors,
  Gmail labels, bearer auth tokens, attachment upload contracts, or Workday
  invoice memos / supplier invoice numbers (check-print order and pay-file-safe
  characters).
---

# Integrations and external contracts

## HTTP triggers

Intercom, Gmail, and enrich-invoice HTTP triggers share bearer auth against SSM
`/finance-agent/enrich-invoice-api-token` (`ENRICH_INVOICE_API_TOKEN`). Callers
send `Authorization: Bearer <token>`. The Gmail Workspace add-on endpoint does
**not** use that token; it verifies Google OIDC instead.

### `POST /create-invoice`

Intercom Data Connector entry point for new supplier invoices (no existing Workday record).

Request body:

```json
{ "conversationId": "1234567890" }
```

This is an Intercom-only contract. Do not add Gmail fields. Direct-upload bodies
(`fileName` / `contentType` / `fileContent`) are not accepted. Extra Data Connector
fields such as `email` are ignored; only `conversationId` is required.

Flow:

1. Debug-log the decoded HTTP request body (`Trigger create invoice request body`)
2. `GET {INTERCOM_API_BASE_URL}/conversations/{id}?display_as=plaintext` with `INTERCOM_ACCESS_TOKEN` and `Intercom-Version: 2.14`
3. Debug-log the Intercom conversation JSON (`conversationId` + raw `payload`)
4. Collect every `application/pdf` attachment from `source` + conversation parts (non-PDF only → 400)
5. Download signed CDN URLs as **raw binary** immediately (URLs expire ~30 minutes; host allowlisted to Intercom CDN; combined max 20MB)
6. Upload each file to S3 (`new-invoices/{requestId}/{index}-{sanitizedFileName}`)
7. Async-invoke `CreateInvoiceProcessor` once per attachment with its owning message's `emailContext`. Processor Lambda async retries are off (`MaximumRetryAttempts: 0`); a thrown error Slacks once and does not re-run.
8. Each record creates a separate Workday invoice; return HTTP status to the Data Connector

`CreateInvoiceProcessor` looks for a purchase order number in the email/filename and fetches that PO **before** enrichment when one is present. If the PO is only on the PDF, enrichment extracts it and the processor fetches the PO afterward. If enrichment extracts a *different* PO number than the email/filename hit, submit uses that matched PO for company and lines — not the early PO. If that late load misses, submit drops the early PO and falls through to **Default OCR Company** (`Company_Reference_ID` `Default_OCR_Company`, or `WORKDAY_DEFAULT_COMPANY_WID` when set) and skips early PO lines.

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

### `POST /create-invoice/gmail`

Gmail entry point. Does not share a request body with Intercom.

Request body:

```json
{ "gmailMessageId": "msg-f:123", "userEmail": "ap@pgahq.com", "force": false, "gmailAccessToken": "ya29..." }
```

`force` is optional. Without it, any exclusive supplier-invoice label on the
message returns **409**. With `force: true`, the add-on re-runs and resets the
label to Processing (this can create another Workday supplier invoice).

`gmailAccessToken` is optional on this HTTP route. The Gmail Workspace add-on
always sends the Google `authorizationEventObject.userOAuthToken` value here.
When it is present, Gmail API calls use that bearer token and skip the service
account JWT. When it is omitted, the Gmail HTTP route still mints a
domain-wide-delegation JWT from Secrets Manager
`finance-agent/gmail-service-account`. Do not log `gmailAccessToken`.

Flow:

1. Obtain a Gmail access token: prefer `gmailAccessToken`; otherwise JWT as `userEmail` (`gmail.modify`)
2. Read exclusive labels; 409 unless `force`. If labels.list is forbidden, continue as unlabeled
3. Fetch the message, collect every `application/pdf` (same 20MB / four-download cap as Intercom)
4. Best-effort exclusive **Processing** label (do not block processor invoke if `gmail.modify` / labels APIs fail)
5. Upload S3 `new-invoices/{requestId}/...` and Event-invoke `CreateInvoiceProcessor` once per PDF with `gmailMessageId`, `userEmail`, and `gmailAccessToken` (when present) in the **payload only** — never S3 object metadata
6. Processor success/failure updates Success, Failure, or Partial using the same token (see labels below)

| HTTP | Meaning |
| --- | --- |
| 202 | Accepted — `status: accepted`, `requestId`, `gmailMessageId`, `attachmentCount` |
| 400 | Missing ids, invalid JSON, no PDF, or attachment too large |
| 401 | Bad/missing finance-agent bearer token |
| 404 | Gmail message not found |
| 409 | Already labeled and `force` was not true |
| 502 | Gmail API failed |
| 500 | Missing Gmail auth, S3/invoke failure, unexpected error |

### `POST /gmail-addon`

HTTP alternate runtime for the unpublished Gmail Workspace add-on. Google sends
the add-on event JSON. Auth is the `Authorization: Bearer` **system ID token**
(`GMAIL_ADDON_OAUTH_CLIENT_ID`). The user's email comes from
`authorizationEventObject.userIdToken`. Gmail API calls (read message, PDFs,
labels) use `authorizationEventObject.userOAuthToken` as a bearer access token.
That token is passed into `runCreateInvoiceFromGmail` and the processor payload
so Success/Failure/Partial labels still apply after Workday. Do not log it or
write it to S3 metadata.

The add-on calls `runCreateInvoiceFromGmail` in-process (same 30s Lambda budget
as the Gmail trigger). Google shows the native spinner while that request runs.
`CreateInvoiceProcessor` stays async (up to 5 minutes); Slack still notifies.
There is no job poller.

| Card | Controls |
| --- | --- |
| Homepage (no message open) | Copy only — open a supplier email with a PDF |
| Unlabeled message | **Create supplier invoice** (`force: false`) |
| Labeled message | Create is hidden; **Create supplier invoice again** opens a confirm card (`force: true`) |

Sandbox vs production **copy and Gmail labels** come from stack parameter
`AddonEnvironment` (`ADDON_ENVIRONMENT`). Workday sandbox vs prod is the
existing CFT/CircleCI split, not this parameter.

## Gmail labels

Exclusive nested labels, visible in the Gmail UI. The received email body is
not edited.

| Environment | Labels |
| --- | --- |
| production (`AddonEnvironment=production`) | `Supplier invoice/Processing`, `Success`, `Failure`, `Partial` |
| sandbox (`AddonEnvironment=sandbox`) | `Supplier invoice (sandbox)/Processing`, `Success`, `Failure`, `Partial` |

Both add-ons can be installed on the same mailbox; the distinct prefixes keep
sandbox and prod status from colliding.

Processor mapping for multiple PDFs on one message: success+success → Success;
failure+failure → Failure; mixed → Partial.

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

## Secrets / env

| Name | Source | Used by |
| --- | --- | --- |
| `ENRICH_INVOICE_API_TOKEN` | SSM `/finance-agent/enrich-invoice-api-token` | Intercom and Gmail HTTP triggers (inbound auth). Not the add-on. |
| `INTERCOM_ACCESS_TOKEN` | SSM `/finance-agent/intercom-access-token` | Create-invoice Intercom client |
| `INTERCOM_API_BASE_URL` | Lambda env (default `https://api.intercom.io`) | Create-invoice; override for EU/AU |
| `INTERCOM_APP_ID` | CFT `IntercomAppId` (`c722leqk` on `deploy-to-dev`, `jyi16dpc` on `deploy-to-prod`) | Slack inbox permalink workspace. Create-invoice uses this stack value, not the conversation `app_id`. |
| `GMAIL_SERVICE_ACCOUNT_SECRET_ARN` | Secrets Manager name `finance-agent/gmail-service-account` | Fallback only for `POST /create-invoice/gmail` when no `gmailAccessToken` is provided (JSON `client_email` + `private_key`). The add-on path does not use this. Never put the PEM in Lambda env or SSM `ssm:` dynamic refs. |
| `ADDON_ENVIRONMENT` | CFT `AddonEnvironment` | `sandbox` on `deploy-to-dev` (development); `production` on `deploy-to-prod` (main) |
| `GMAIL_ADDON_OAUTH_CLIENT_ID` | CI reads `gcloud workspace-add-ons get-authorization` (CFT `GmailAddonOauthClientId`) | Audience for the **user** ID token (`authorizationEventObject.userIdToken`) |
| `GMAIL_ADDON_SERVICE_ACCOUNT_EMAIL` | Same `get-authorization` `serviceAccountEmail` (CFT `GmailAddonServiceAccountEmail`) | Expected `email` on the **system** ID token in `Authorization` |

The add-on Gmail path uses the signed-in user's OAuth access token
(`userOAuthToken`) with scope `https://www.googleapis.com/auth/gmail.modify`.
Domain-wide delegation on the Gmail service account is only needed for the
HTTP Gmail trigger when the caller does not send `gmailAccessToken`. Do not log
the user access token, the service account JSON, or the private key.

Intercom Access Token needs **Read conversations** only (`read_conversations`).

Create-invoice Slack **errors** show the Workday `Message` plus prior submit attempts — not SOAP dumps. Remaining invoice details (`fileName`, `s3Key`, `workdayId`, not-authorized `note`) still appear as JSON; `conversationUrl` stays a footer link. Create-invoice Slack **success** uses the same human layout as enrich (`*Changes*`, fallbacks, `*Prior submit failures*`). The Workday invoice number (`SUPIN-XXXX`, SOAP `Supplier_Invoice_Reference_ID`) is in the headline and as the first Changes bullet, plus a small JSON of `invoiceNumber` / `invoiceWID` / `fileName` / `conversationId` / `lineCount`. Enrich success already puts that number in the `processed \`SUPIN-XXXX\`` headline and repeats it as `*Workday Invoice*`. Extract it from the Submit SOAP reference on create and from Get `Invoice_Number` (falling back to the same reference id) on enrich. Sanitized SOAP throws keep a `Validation_Fault` object so enrich skip-registry classification still matches, and keep `serializedError` for a future threaded dump once a Slack bot token exists. Successful Workday submits that retried after a validation fault also include `priorFailures` on create and enrich Slack success.

## AWS sandbox vs prod (already CFT)

Do not add a second AWS environment model for Gmail. CircleCI already deploys
two stacks:

- `development` → `deploy-to-dev` (Workday impl sandbox, `AddonEnvironment=sandbox`)
- `main` → `deploy-to-prod` (Workday prod, `AddonEnvironment=production`)

After deploy, CircleCI reads `GmailAddonApiUrl` and publishes the matching
gcloud Workspace add-on deployment. Deployment JSON is generated in CI from
`ADDON_ENVIRONMENT` and the stack URL; do not commit `deployment.*.json`.

## Gmail add-on via gcloud (two deployments)

AWS/Workday targeting is CFT. The extra split is **two unpublished Workspace
add-on deployments** that point at the two HttpApi URLs. CI builds the spec
with `scripts/build-gmail-addon-deployment.js` (display name + endpoint URL)
and create/replace with `scripts/deploy-gmail-addon.sh`.

| `ADDON_ENVIRONMENT` | gcloud name | Gmail add-on title | CircleCI job |
| --- | --- | --- | --- |
| `sandbox` | `finance-agent-gmail-sandbox` | Workday supplier invoice (sandbox) | `deploy-to-dev` |
| `production` | `finance-agent-gmail` | Workday supplier invoice | `deploy-to-prod` |

CI does **not** run `install` (that is per Google user).

Add-on OAuth scopes: `gmail.addons.execute`,
`gmail.addons.current.message.readonly`, `gmail.modify`, `userinfo.email`.
Message fetch, attachment download, and label writes use the add-on
`userOAuthToken`, not a Gmail domain-wide-delegation service account.
After CI publishes a deployment that adds `gmail.modify`, testers must
reinstall or re-consent so Google issues a token with that scope.

A private Marketplace listing is optional later. Do not org-install.

### What to add so gcloud works from CI

This is separate from the Gmail domain-wide-delegation key in AWS Secrets
Manager (`finance-agent/gmail-service-account`). CI needs a **second** GCP
service account that can manage Workspace add-on deployments.

1. In GCP project `finance-agent-506013` (shared; can publish add-ons for any
   number of apps):
   - Enable [Google Workspace Add-ons API](https://console.cloud.google.com/apis/library/gsuiteaddons.googleapis.com) (`gsuiteaddons.googleapis.com`)
   - Create a CI service account (for example `workspace-add-ons-ci`)
   - Grant it `roles/gsuiteaddons.developer`
   - Create a JSON key
2. Reuse the existing CircleCI contexts **chatbot-development** and
   **chatbot-production** (AWS deploy variables already live there).
   The only extra context secret is:

   | Name | Value |
   | --- | --- |
   | `FINANCE_AGENT_GCP_SERVICE_ACCOUNT_KEY` | JSON key for `workspace-add-ons-ci@finance-agent-506013.iam.gserviceaccount.com` (raw JSON starting with `{`, or base64 of that JSON) |

   GCP project id is `finance-agent-506013` in `scripts/deploy-gmail-addon.sh`.
   Before CloudFormation deploy, CI runs `gcloud workspace-add-ons get-authorization`
   and passes `oauthClientId` as `GmailAddonOauthClientId` and `serviceAccountEmail`
   as `GmailAddonServiceAccountEmail`. `oauthClientId` (`….apps.googleusercontent.com`)
   is the audience for the user ID token only. The system token in `Authorization`
   uses the add-on HTTPS URL as `aud` (the request URL, same as `GmailAddonApiUrl`)
   and must have `email` equal to `serviceAccountEmail`. Do not put `GmailAddonApiUrl`
   on the Lambda as an env var that `!Ref`s `ServerlessHttpApi`; that creates a
   CloudFormation cycle with the HttpApi event. These are not Gmail domain-wide-delegation service-account
   client ids. Sandbox and prod stacks share this GCP authorization because they
   share the GCP project.

   The OAuth consent screen in `finance-agent-506013` must be configured (Internal)
   or `get-authorization` returns an empty client id and add-on calls return 401.

Until `FINANCE_AGENT_GCP_SERVICE_ACCOUNT_KEY` is present, the deploy job skips gcloud and
still finishes the AWS stack.

Individual testers still install once:

```bash
gcloud workspace-add-ons deployments install finance-agent-gmail-sandbox \
  --project=finance-agent-506013
```

## Workday SOAP authentication

`CreateInvoiceProcessor` and `EnrichInvoiceProcessor` deliberately share:

- `EnrichInvoiceProcessorRole`
- Global `WORKDAY_DOMAIN`, `WORKDAY_TENANT`, `WORKDAY_CLIENT_ID`, `WORKDAY_CLIENT_SECRET`, and `WORKDAY_REFRESH_TOKEN` environment sources
- `buildResourceManagementClient` in `src/lib/workday.ts`
- OAuth refresh-token grant, `strong-soap` `BearerSecurity`, and the Resource Management v44.1 endpoint

Custom validation rules and cost-center related worktags use `buildFinancialManagementClient` (Financial Management v46.0) with the same OAuth secrets. `Get_Related_Worktags_for_Worktags` is how `cache_cost_centers` loads default/allowed Line of Business ids for each cost center, and how supplier-invoice submit retries look up an allowed LOB when Workday requires Line of Business or rejects `Default_Line_Of_Business`. That operation is a separate Workday task from Resource Management `Submit_Supplier_Invoice`. The finance-agent ISU needs Get (Integration Permissions) on domain **Manage: Related Worktags** before related-LOB fill can populate cache or live submit lookup; `Submit_Supplier_Invoice` is not enough. If the ISU is missing it, Workday returns `SOAP-ENV:Server.processingError` / `The task submitted is not authorized`; cache keeps previously stored `relatedLob` metadata (even if the follow-up Postgres related-LOB read throws) and does not Slack on every failed run. Required-LOB faults do not omit Line of Business after related fill and fallback are exhausted; submit surfaces the original validation error. PGA Line of Business related worktags come back as `CUSTOM_ORGANIZATION_01` (not `LINE_OF_BUSINESS` or `CUSTOM_ORGANIZATION_02`–`10`); parse org reference ids even without a `LOB-` prefix and keep SOAP `WID`, `Organization_Reference_ID`, and `Custom_Organization_Reference_ID` on cached `relatedLob`. Extract/submit fill uses the related default or a unique allowed LOB; a validation retry may use any allowed value. Required-LOB faults that also mention an unavailable cost center stay on the LOB retry path; they are not classified as a cost-center value error.

Do not add a separate Workday auth path or secret set for create-invoice.

## Workday supplier invoice payload

Tax and freight/shipping/handling are header amounts, not invoice lines:

- `Tax_Amount` comes from `extractedTaxAmount`
- `Freight_Amount` comes from `extractedFreightAmount` (PDF labels may be freight, shipping, handling, or delivery)
- Those charge rows must not appear in `Invoice_Line_Replacement_Data`

If the PDF lists shipping/handling as a line item, capture the amount on `Freight_Amount` and omit that row from the SOAP line payload. `splitFreightLines` in `src/lib/invoice_lines.ts` strips those rows before merge/PO matching and again when building the SOAP body. The matcher treats carrier-only service labels (`FedEx Ground`, `FedEx Home Delivery`, `UPS Ground`) and common service words (`standard`, `priority`, `2-Day`, `air`/`ocean` freight, `surcharge`, `freight in`/`out`) as freight, and still rejects merchandise lookalikes (`Shipping Container`, `Freightliner parts`, `Shipping Supplies`). Amount recovery reads SOAP `Unit_Cost` and `Quantity` when `Extended_Amount` is missing.

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

Create-invoice debug-logs the decoded Data Connector HTTP body first
(`Trigger create invoice request body`), including extra unused fields such as
`email`. After the Conversations API fetch it also logs that JSON
(`conversationId` plus the raw `payload`). That conversation payload includes
email bodies, author emails, and signed attachment URLs. Do not log Intercom
access tokens.

## Attachment bytes

- Intercom CDN or Gmail attachment API → binary `Buffer` → `putBinaryToS3`
- Intercom download URL must be `https` on `intercomcdn.com` / `*.intercomcdn.com` or `intercom-attachments-<n>.com` / `*.intercom-attachments-<n>.com` (SSRF allowlist); `fetch` uses `redirect: 'error'` so redirects cannot leave that host
- Gmail API host allowlist is `gmail.googleapis.com` / `www.gmail.googleapis.com`; `fetch` also uses `redirect: 'error'`
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
