# Finance agent evals

Manual evals for the finance agent. Nothing here runs in CI, and nothing here makes a paid model call unless a person runs
an `npm run eval*` command.

| Command | What it does | Needs |
| --- | --- | --- |
| `npm run export:eval-cases` | Turns AP's before/after corrections into case files | AWS role, Aurora tunnel |
| `npm run eval:replay` | Re-runs the current pipeline for each case without writing to Workday, scores it against AP | Same, plus `AI_GATEWAY_API_KEY` |
| `npm run eval:suites` | Runs two synthetic model suites: the Workday validation-field classifier and the invoice line merge | `AI_GATEWAY_API_KEY` only |

## Data-handling rules

finance-agent is a public repository.

- Never commit invoice PDFs, OCR text, vendor bank or remittance details, member numbers, real Workday payloads, case
  files, baselines, or reports. Only synthetic or fully redacted fixtures go in git (`evals/fixtures/`, which holds
  synthetic data only; a test checks it for emails, URLs, phone numbers, and long digit strings).
- Keep real cases, baselines, and reports in `eval-local/` (gitignored) or a private S3 prefix. Delete them when the run is done.
  Case files are created owner-only (`0600`) and are never overwritten; baselines and reports too, unless you pass `--force`.
- Source documents stay in the finance-agent bucket and are read in place by key and version ID. Do not copy them anywhere.
- Evals never write to Workday, Aurora, or S3. See [Safety](#safety).
- Do not paste case contents into issues, PRs, or Slack. Invoice numbers (`SUPIN-…`) are fine.

## Access

The harness reads from the production account, so it has its own read-only role, `finance-agent-eval-readonly`
(`EvalReadOnlyRole` in `template.yml`). It exists only when the stack is deployed with `EvalRoleTrustedPrincipalArns` set.

**Who can assume it:** only the role ARNs listed in that parameter, normally the IAM Identity Center permission-set roles of
the named people who run evals. Anyone else, and the account root, cannot. Sessions last at most one hour. To change who can
assume it, change the parameter and redeploy.

**What it can do:**

- `s3:GetObject`, `s3:GetObjectVersion` on `new-invoices/*` and `attachments/*` in the finance-agent bucket
- `s3:ListBucketVersions` on the bucket, only for prefix `attachments/*` (to find enrich attachments)
- `secretsmanager:GetSecretValue` on the database secret
- `ssm:StartSession` on one tunnel instance and on one SSM document that can only forward to the Aurora endpoint on 5432
  (plus ending its own session)

It has no write, delete, or put action, no Lambda invoke, and no SSM parameter access, so it cannot reach Workday or its
credentials. Two things IAM cannot enforce, so the harness does:

- The database secret is the master `postgres` password. The harness opens the connection read-only (read-only session, only
  `SELECT`/`WITH`/`SHOW`/`EXPLAIN` accepted, no schema setup). Do not point other tools at it with the same credentials.
- The role cannot read Workday. `--include-po` and `--include-ocr-email` need Workday read credentials of your own, outside the role.

### One-time setup

Add a profile that assumes the role from your SSO profile (the role ARN is the `EvalReadOnlyRoleArn` stack output):

```ini
[profile finance-agent-eval]
role_arn = arn:aws:iam::<account>:role/finance-agent-eval-readonly
source_profile = <your SSO profile>
region = us-east-1
```

Then `aws sso login --profile <your SSO profile>` and `export AWS_PROFILE=finance-agent-eval`. The CLI and SDK refresh the
assumed credentials; after an hour of idle, log in again.

### Open the tunnel

In its own terminal, leave it running:

```bash
aws ssm start-session \
  --target <AuroraTunnelInstanceId> \
  --document-name finance-agent-eval-aurora-port-forward \
  --parameters localPortNumber=15432
```

This needs the AWS CLI session-manager plugin. The instance ID is the `AuroraTunnelInstanceId` the stack was deployed with.

### Environment

Put these in `.env` at the repo root (gitignored) or export them. Stack outputs `EvalDatabaseSecretArn`, `EvalBucketName`
supply the first and third.

| Variable | Value | Used by |
| --- | --- | --- |
| `AWS_PROFILE` | `finance-agent-eval` | all |
| `DATABASE_SECRET_ARN` | `EvalDatabaseSecretArn` output | export, replay |
| `DATABASE_CLUSTER_ENDPOINT` | `localhost` (the tunnel) | export, replay |
| `DATABASE_PORT` | `15432` | export, replay |
| `S3_BUCKET_NAME` | `finance-agent-<account id>` | export (or `--bucket`) |
| `AI_GATEWAY_API_KEY` | your Vercel AI Gateway key | replay, suites |
| `INTERCOM_ACCESS_TOKEN` | optional | export `--include-messages` |
| `WORKDAY_DOMAIN`, `WORKDAY_TENANT`, `WORKDAY_CLIENT_ID`, `WORKDAY_CLIENT_SECRET`, `WORKDAY_REFRESH_TOKEN` | optional, read access, not from the role | export `--include-po`, `--include-ocr-email` |

The replay also needs the deployed pipeline settings so it builds the same payload production would. Copy the non-secret IDs
from the Lambda configuration into `evals/.env.local` (see `evals/.env.example`): `FALLBACK_*`, `WORKDAY_DEFAULT_SUPPLIER_WID`,
and, if set, `WORKDAY_DEFAULT_COMPANY_WID`, `WORKDAY_DEFAULT_COMPANY_NAME`, `OCR_MODEL`. The replay removes Workday, Slack, and
Intercom credentials from its own environment before it starts.

## Export cases

Someone with the role runs the exporter. It reads `agent_invoice_scores` and `agent_invoice_snapshots` from Aurora and pins the
source documents in S3.

```bash
# The two worst invoices for Oct 12-18, with what the agent saw
npm run export:eval-cases -- --out eval-local/worst.cases.jsonl \
  --invoice-number SUPIN-467195,SUPIN-466263 --include-messages --include-po

# Everything AP submitted that week (Central time), clean and convention-only invoices included
npm run export:eval-cases -- --out eval-local/oct12-18.cases.jsonl \
  --since 2026-10-12T00:00:00-05:00 --until 2026-10-19T00:00:00-05:00 --include-clean --include-messages --include-po
```

Selection: with no selector, the exporter takes invoices AP materially corrected (`submitted_edited`).

| Flag | Effect |
| --- | --- |
| `--include-clean` | Also `submitted_clean` invoices. The scorer calls an invoice clean when AP changed only memo, line memo, item description, or the supplier invoice number, so convention-only invoices are included too |
| `--outcomes a,b` | Explicit outcomes, for example `submitted_edited,denied` |
| `--since`, `--until` | AP entry-read window. A bare date is UTC midnight; use an offset for Central time. `--until` is exclusive |
| `--origin create\|enrich`, `--limit N` | Filter and cap |
| `--invoice-number`, `--wid`, `--suppliers-invoice-number` | Pick specific invoices by Workday number (`SUPIN-467195`), Workday WID, or the number printed on the supplier's invoice. Naming invoices skips the outcome filter |
| `--no-s3` | Do not pin documents. The cases cannot be replayed |

Each case holds: the documents (`{bucket, key, versionId, etag}`), what the agent submitted, what AP saved at submit
(`expected`), every change AP made at submit (`entryDiff`) and after submit (`lateDiff`), the PO lines the agent used, and the
sources below. The exporter prints a note for anything it could not capture and reports how many cases have every document pinned.

| Source | Flag | Notes |
| --- | --- | --- |
| Documents | default | `HeadObject` pins the version and ETag. A key that no longer exists, or that the role cannot read, is marked `missing` and the replay skips that case |
| PO responses | `--include-po` | Raw `Get_Purchase_Orders` response for each PO the agent coded against, read from Workday **at export time**. A PO line the invoice consumed can now read as fully invoiced. Without it, the replay treats the invoice as having no PO |
| Intercom context | `--include-messages` | Rebuilt from the conversation **as of the agent's write**. Messages written later (AP's corrections, supplier replies) are left out of what the replay sees; the full message list is kept in `emailMessages` for reading only |
| OCR email | `--include-ocr-email` | Enrich only; from Workday's inbound email query, which looks back 90 days |

### Enrich invoices have no S3 keys

The create path records its keys (`new-invoices/{requestId}/…`) on the agent's snapshot. The enrich path does not: it uploads to
`attachments/{workdayInvoiceWid}/{fileName}`, and every re-enrich overwrites that key. So for an enrich case the exporter lists the
versions under `attachments/{wid}/`, and for each file name pins the newest version written at or before the agent's write.
A file whose only remaining versions are newer is marked `missing`, because a re-enrich replaced the one the agent read and
the bucket expires replaced versions after 30 days. Each document also records `workdayAttachmentRef`: the invoice WID, the
`{wid}-{index}` attachment ID the pipeline stored as S3 object metadata, and the original file name. Workday's own attachment ID
is not stored anywhere, so to rebuild an expired version, read the invoice's attachments from Workday and take the one at that
index with that name. The OCR email is never saved by the pipeline, which is why `--include-ocr-email` goes back to Workday.
Export enrich cases soon after the week closes, while the versions still exist.

## Run the replay

```bash
npm run eval:replay -- --cases eval-local/oct12-18.cases.jsonl --label main-d64ac81 --out eval-local/report.json
```

For each case it reads the pinned documents (by version ID, checking the ETag), runs the real `processInvoiceCluster` (create) or
`processInvoice` (enrich) with Workday switched off, takes the `Submit_Supplier_Invoice` request the pipeline built, maps it to
the scored shape, and scores it with the production scorer: `diffScoredFields`, `scoreChanges`, `touchCount`. For an enrich
invoice, fields the replay leaves as the OCR baseline had them are not the agent's, as `ScoreInvoices` decides it.

Useful flags: `--ids SUPIN-1,SUPIN-2`, `--limit N`, `--out FILE`, `--force` (overwrite output files).

### Mapping the request to what the scorer reads

The scorer reads `Get_Supplier_Invoices` read-backs. The pipeline's request uses the same `Supplier_Invoice_Data` field names, so
`extractScoredFields` reads it directly. The mapping (`src/eval/replay_payload.ts`) handles what Workday does on save:

- An extended amount the request leaves out is quantity times unit cost.
- A supplier or company sent as a WID is looked up in the cached `documents` table and written as the reference ID a read-back
  shows (`Supplier_ID=…`, `Company_Reference_ID=…`). If it cannot be resolved the case carries a warning.
- A read-back names a reference by whichever non-WID ID Workday lists first. When the replay and AP have the same value under a
  different ID type, the scorer takes AP's spelling. A different value is never touched.

### Reading the report

- **Coding touches**: AP corrections to everything except memo, line memo, and item description. The 0 / 1–3 / 4–10 / 11–20 / 21+
  buckets and the share at 0–3 are over this count. A pipeline error counts as 21+.
- **Formatting conventions** (memo, line memo, item description): reported separately, excluded from the coding count.
  The supplier invoice number counts as coding.
- **Digest-style touches**: every scored field, so it lines up with the weekly digest. The Oct 12–18 digest had 28 of 66 invoices
  (42%) at 0–3 touches including memo fields; compare that figure with this one.
- **Production on the same invoices**: what production got, entry plus late changes, from the case. Use it to check the
  replay against reality before trusting a change in either direction.
- **Per-field correction rate**: the share of scored cases where AP had to change that field at least once.

### Save and compare a baseline

```bash
# On the commit you treat as the release (this harness leaves the pipeline unchanged)
npm run eval:replay -- --cases eval-local/oct12-18.cases.jsonl --label main-d64ac81 --save-baseline eval-local/baseline-main-d64ac81.json

# On a change
npm run eval:replay -- --cases eval-local/oct12-18.cases.jsonl --baseline eval-local/baseline-main-d64ac81.json
```

The comparison covers only the cases both runs have. It exits non-zero and lists the regressions when the 0–3 share is lower, or
any field rate (coding or formatting) is worse by more than the tolerance. Defaults: share tolerance `0`, field tolerance `0.02`
(`--share-tolerance`, `--field-tolerance`). `--min-share 0.5` also fails a run below an absolute 0–3 share.

Model output varies run to run. With a few dozen cases one case moving is several points, so run the baseline twice, or set the
tolerances above that noise, before acting on a small difference.

## Synthetic suites

```bash
npm run eval:suites                      # both
npm run eval:suites -- --suite merge     # or classifier
```

The classifier suite checks `classifyWorkdayValidationField` against fixtures (pass at 85%). The merge suite runs
`buildFinalInvoiceLines` the way the create pipeline does, including `invoiceContext` (invoice date and printed service period)
so date-based PO line selection and consumed-PO-line handling are tested, and the legacy merge only for a closed PO (pass at 75%
per field). Fixtures are in `evals/fixtures/`. They are synthetic; keep them that way.

## Safety

- Workday: while a replay runs, `src/lib/workday.ts` has a hook installed (`setWorkdayReplayHook`). Every Workday request fails
  before the network (the OAuth token call refuses), except through a fake client that serves the invoice and PO reads from the
  case and records `Submit_Supplier_Invoice` instead of sending it. Any other SOAP operation is refused and logged.
- Aurora: `src/eval/readonly_db.ts`, described above.
- S3: replay and export use only `HeadObject`, `GetObject`, and `ListObjectVersions`; `putBinaryToS3` and `putJsonToS3` throw in a replay.
- Slack, Intercom, and Workday credentials are removed from the replay process environment.
- `buildSubmitInvoiceData` still sets `Submit: false` and is still the only place the flag is set; the replay changes nothing there.

## What the replay does not reproduce

- Repair retries. A real submit can be rejected by Workday and retried with a fallback (a different date, a dropped PO line
  reference, collapsed worktags). The replay scores the first payload, which is what Workday saw first.
- Workday rewriting a saved invoice beyond the extended amount and reference IDs. Lines with PO split rows are scored by their
  line-level worktags, as a read-back is; the case carries a warning.
- The PO and cache tables as they were at write time: POs are as of export, suppliers, companies, and cost centers are today's cache.
- Enrich invoices with image attachments, or with no OCR baseline snapshot: skipped.
- Late changes: AP edits after submit are carried as production touches, not re-scored against the replay.

## Where this should live

ADR 030 says evaluation criteria belong in a Tech Spec or runbook. This file is the runbook. The pass bar and criteria in the
Reading the report section (coding versus formatting touches, the 0–3 share, the tolerances) are the content for the tech spec.
