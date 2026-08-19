---
name: integrations-and-external-contracts
description: >-
  Documents finance-agent HTTP APIs and external integrations (Intercom
  create-invoice, Gmail create-invoice, Gmail Workspace add-on, enrich-invoice,
  Workday, SSM and Secrets Manager). Use when changing POST /create-invoice,
  POST /create-invoice/gmail, POST /gmail-addon, Intercom Data Connectors,
  Gmail labels, bearer auth tokens, or attachment upload contracts.
---

# Integrations and external contracts

## HTTP triggers

Intercom and Gmail HTTP triggers share bearer auth against SSM
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
(`fileName` / `contentType` / `fileContent`) are not accepted.

Flow:

1. `GET {INTERCOM_API_BASE_URL}/conversations/{id}?display_as=plaintext` with `INTERCOM_ACCESS_TOKEN` and `Intercom-Version: 2.14`
2. Collect every `application/pdf` attachment from `source` + conversation parts (non-PDF only → 400)
3. Download signed CDN URLs as **raw binary** immediately (URLs expire ~30 minutes; host allowlisted to Intercom CDN; combined max 20MB)
4. Upload each file to S3 (`new-invoices/{requestId}/{index}-{sanitizedFileName}`)
5. Async-invoke `CreateInvoiceProcessor` once per attachment with its owning message's `emailContext`
6. Each record creates a separate Workday invoice; return HTTP status to the Data Connector

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
{ "gmailMessageId": "msg-f:123", "userEmail": "ap@pgahq.com", "force": false }
```

`force` is optional. Without it, any exclusive supplier-invoice label on the
message returns **409**. With `force: true`, the add-on re-runs and resets the
label to Processing (this can create another Workday supplier invoice).

Flow:

1. Domain-wide delegation JWT as `userEmail` (`gmail.modify`) using the service account in Secrets Manager `finance-agent/gmail-service-account`
2. Read exclusive labels; 409 unless `force`
3. Fetch the message, collect every `application/pdf` (same 20MB / four-download cap as Intercom)
4. Set the exclusive **Processing** label
5. Upload S3 `new-invoices/{requestId}/...` and Event-invoke `CreateInvoiceProcessor` once per PDF with `gmailMessageId` and `userEmail` in the payload
6. Processor success/failure updates Success, Failure, or Partial (see labels below)

| HTTP | Meaning |
| --- | --- |
| 202 | Accepted — `status: accepted`, `requestId`, `gmailMessageId`, `attachmentCount` |
| 400 | Missing ids, invalid JSON, no PDF, or attachment too large |
| 401 | Bad/missing finance-agent bearer token |
| 404 | Gmail message not found |
| 409 | Already labeled and `force` was not true |
| 502 | Gmail API failed |
| 500 | Missing service account, S3/invoke failure, unexpected error |

### `POST /gmail-addon`

HTTP alternate runtime for the unpublished Gmail Workspace add-on. Google sends
the add-on event JSON. Auth is the `Authorization: Bearer` **system ID token**
(`GMAIL_ADDON_OAUTH_CLIENT_ID`). The user's email comes from
`authorizationEventObject.userIdToken`.

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

## Secrets / env

| Name | Source | Used by |
| --- | --- | --- |
| `ENRICH_INVOICE_API_TOKEN` | SSM `/finance-agent/enrich-invoice-api-token` | Intercom and Gmail HTTP triggers (inbound auth). Not the add-on. |
| `INTERCOM_ACCESS_TOKEN` | SSM `/finance-agent/intercom-access-token` | Create-invoice Intercom client |
| `INTERCOM_API_BASE_URL` | Lambda env (default `https://api.intercom.io`) | Create-invoice; override for EU/AU |
| `GMAIL_SERVICE_ACCOUNT_SECRET_ARN` | Secrets Manager name `finance-agent/gmail-service-account` | Gmail trigger, add-on, and `CreateInvoiceProcessor` (JSON `client_email` + `private_key`). Never put the PEM in Lambda env or SSM `ssm:` dynamic refs. |
| `ADDON_ENVIRONMENT` | CFT `AddonEnvironment` | `sandbox` on `deploy-to-dev` (development); `production` on `deploy-to-prod` (main) |
| `GMAIL_ADDON_OAUTH_CLIENT_ID` | CFT `GmailAddonOauthClientId` | Add-on OIDC audience |

The Gmail service account needs **Google Admin domain-wide delegation** with
scope `https://www.googleapis.com/auth/gmail.modify`. Do not log the service
account JSON or private key.

Intercom Access Token needs **Read conversations** only (`read_conversations`).

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
`gmail.addons.current.message.readonly`, `userinfo.email`. Message fetch and
label writes use the Gmail DWD service account, not the add-on user OAuth token.

A private Marketplace listing is optional later. Do not org-install.

### What to add so gcloud works from CI

This is separate from the Gmail domain-wide-delegation key in AWS Secrets
Manager (`finance-agent/gmail-service-account`). CI needs a **second** GCP
service account that can manage Workspace add-on deployments.

1. In the GCP project that owns the HTTP add-on (same project for both gcloud
   names is fine):
   - Enable [Google Workspace Add-ons API](https://console.cloud.google.com/apis/library/gsuiteaddons.googleapis.com) (`gsuiteaddons.googleapis.com`)
   - Create a CI service account (for example `finance-agent-gmail-addon-ci`)
   - Grant it `roles/gsuiteaddons.developer`
   - Create a JSON key
2. In CircleCI contexts **chatbot-development** and **chatbot-production**, add:

   | Name | Value |
   | --- | --- |
   | `GCP_PROJECT_ID` | That GCP project id |
   | `GCP_SERVICE_ACCOUNT_KEY` | The JSON key (raw JSON starting with `{`, or base64 of that JSON) |
   | `GMAIL_ADDON_OAUTH_CLIENT_ID` | Add-on OAuth client id (CFT `GmailAddonOauthClientId`; Lambda OIDC audience) |

   `GCLOUD_SERVICE_KEY` / `GOOGLE_PROJECT_ID` are accepted as aliases.

   Read the client id with:

   ```bash
   gcloud workspace-add-ons get-authorization --project=YOUR_GCP_PROJECT \
     --format='value(oauthClientId)'
   ```

Until `GCP_SERVICE_ACCOUNT_KEY` and `GCP_PROJECT_ID` are both present, the
deploy job skips gcloud and still finishes the AWS stack. If only one of them
is set, the job fails.

Individual testers still install once:

```bash
gcloud workspace-add-ons deployments install finance-agent-gmail-sandbox \
  --project=YOUR_GCP_PROJECT
```

## Workday SOAP authentication

`CreateInvoiceProcessor` and `EnrichInvoiceProcessor` deliberately share:

- `EnrichInvoiceProcessorRole`
- Global `WORKDAY_DOMAIN`, `WORKDAY_TENANT`, `WORKDAY_CLIENT_ID`, `WORKDAY_CLIENT_SECRET`, and `WORKDAY_REFRESH_TOKEN` environment sources
- `buildResourceManagementClient` in `src/lib/workday.ts`
- OAuth refresh-token grant, `strong-soap` `BearerSecurity`, and the Resource Management v44.1 endpoint

Do not add a separate Workday auth path or secret set for create-invoice.

Submit logging must not include `client.lastRequest` or raw strong-soap error
objects. Those structures contain attachment bytes and the HTTP Authorization
header. Log request byte count plus a safe error summary, and throw a new error
containing only the original name/message.
For attachment submissions, log redacted outbound headers and only the SOAP
envelope `Header` element.

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
