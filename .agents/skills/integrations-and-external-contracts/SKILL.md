---
name: integrations-and-external-contracts
description: >-
  Documents finance-agent HTTP APIs and external integrations (Intercom
  create-invoice, enrich-invoice, Workday, SSM secrets). Use when changing
  POST /create-invoice or /enrich-invoice, Intercom Data Connectors, bearer
  auth tokens, or attachment upload contracts.
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

Flow:

1. `GET {INTERCOM_API_BASE_URL}/conversations/{id}?display_as=plaintext` with `INTERCOM_ACCESS_TOKEN` and `Intercom-Version: 2.14`
2. Pick the first `application/pdf` attachment from `source` + conversation parts (non-PDF only → 400)
3. Download the signed CDN URL as **raw binary** immediately (URLs expire ~30 minutes; host allowlisted to Intercom CDN; max 20MB)
4. Upload binary to S3 (`new-invoices/{requestId}/{sanitizedFileName}`)
5. Async-invoke `CreateInvoiceProcessor` with `s3Key`, `fileName`, `contentType`, `conversationId`, `emailContext`
6. Return HTTP status to the Data Connector (Workday create is async; Slack notifies that outcome)

| HTTP | Meaning |
| --- | --- |
| 202 | Accepted — body includes `status: accepted`, `message`, `requestId`, `conversationId` |
| 400 | Missing `conversationId`, invalid JSON, no PDF, or attachment too large |
| 401 | Bad/missing finance-agent bearer token |
| 404 | Intercom conversation not found |
| 502 | Intercom API or CDN download failed |
| 500 | Missing Intercom token, S3/invoke failure, unexpected error |

Error bodies include `status: error` and `message` so Fin can map response fields.

### `POST /enrich-invoice`

On-demand enrichment for an existing Workday supplier invoice. Body: `{ "supplierInvoiceId": "<WID or invoice number>" }`. Looks up email context from Workday OCR inbound email data, not Intercom.

## Secrets / env

| Name | Source | Used by |
| --- | --- | --- |
| `ENRICH_INVOICE_API_TOKEN` | SSM `/finance-agent/enrich-invoice-api-token` | Both HTTP triggers (inbound auth) |
| `INTERCOM_ACCESS_TOKEN` | SSM `/finance-agent/intercom-access-token` | Create-invoice Intercom client |
| `INTERCOM_API_BASE_URL` | Lambda env (default `https://api.intercom.io`) | Create-invoice; override for EU/AU |

Intercom Access Token needs **Read conversations** only (`read_conversations`).

## Workday SOAP authentication

`CreateInvoiceProcessor` and `EnrichInvoiceProcessor` deliberately share:

- `EnrichInvoiceProcessorRole`
- Global `WORKDAY_DOMAIN`, `WORKDAY_TENANT`, `WORKDAY_CLIENT_ID`, `WORKDAY_CLIENT_SECRET`, and `WORKDAY_REFRESH_TOKEN` environment sources
- `buildResourceManagementClient` in `src/lib/workday.ts`
- OAuth refresh-token grant, `strong-soap` `BearerSecurity`, and the Resource Management v44.1 endpoint

Do not add a separate Workday auth path or secret set for create-invoice.

Each OAuth token request logs 12-character SHA-256 fingerprints for the resolved
client ID, client secret, and refresh token. Compare these with fingerprints
computed directly from SSM when diagnosing runtime secret resolution; never log
the credential values or access token.

`CreateInvoiceProcessor` currently sets `WORKDAY_CREATE_SOAP_AUTH_PROBE=true`.
Immediately before the strong-soap submit, it sends a non-mutating all-zero WID
request with native `fetch` and the same access token, then logs only HTTP status,
fault code, and fault string. Remove this temporary probe after transport
authentication is diagnosed.

## Attachment bytes

- Intercom CDN → binary `Buffer` → `putBinaryToS3`
- Download URL must be `https` on `intercomcdn.com` / `*.intercomcdn.com` or `intercom-attachments-<n>.com` / `*.intercom-attachments-<n>.com` (SSRF allowlist); `fetch` uses `redirect: 'error'` so redirects cannot leave that host
- Only `application/pdf` attachments are accepted; missing PDF → 400
- Max download size 20MB (`Content-Length` and body checked); trigger Lambda timeout is 30s (HTTP API integration ceiling) with 1024 MB memory
- Attachment names are sanitized to a basename before the S3 key
- Processor Event payload is metadata only (no file bytes)
- Workday `Attachment_Data` base64 is produced in `create_invoice` after `getBinaryFromS3`
