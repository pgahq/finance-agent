# Open Source Release Tracker (v0.0.1-a)

Use this file to create GitHub issues if they were not opened automatically during the legal-files PR. Copy each section into a new issue.

---

## Issue 1: Open source scrub — Remove internal operational references from documentation

**Title:** `Open source scrub: Remove internal operational references from documentation`

**Body:**

### Summary

Before making this repository public, remove or generalize internal PGA operational references in documentation so external contributors are not pointed at private channels or internal-only resources.

### Current examples

- `README.md` references internal Slack channel `#notify-finance-agent-dev`

### Acceptance criteria

- [ ] Documentation uses generic placeholders for notification targets (for example, "your configured Slack webhook channel")
- [ ] No internal-only Slack channel names, mailing lists, or runbook links remain in public-facing docs
- [ ] README monitoring section describes configuration without PGA-specific channel names

### Context

Tracked as part of the v0.0.1-a open source release preparation. The repository will remain private until leadership approves going public.

---

## Issue 2: Open source scrub — Parameterize PGA-specific Workday and infrastructure defaults

**Title:** `Open source scrub: Parameterize PGA-specific Workday and infrastructure defaults`

**Body:**

### Summary

Before making this repository public, replace hardcoded PGA-specific Workday identifiers and infrastructure defaults with configurable parameters or documented placeholders.

### Current examples

- `template.yml` hardcodes `WORKDAY_DEFAULT_SUPPLIER_WID`
- `template.yml` and `src/enrich_invoice.ts` reference `FINAGENT-invoice-modified` tag identifiers
- `.circleci/config.yml` sets `WORKDAY_TENANT: pgahq`
- `template.yml` IAM policies reference SSM paths under `ap-ingest-service/`

### Acceptance criteria

- [ ] No PGA-production Workday WIDs or tenant names are hardcoded in templates or source
- [ ] SSM parameter paths are scoped to this project or documented as operator-supplied configuration
- [ ] Cross-service references (for example, `ap-ingest-service`) are removed or made optional
- [ ] Example/default values in docs use clearly fictional placeholders

### Context

Tracked as part of the v0.0.1-a open source release preparation.

---

## Issue 3: Open source scrub — Decouple CircleCI from PGA-internal AWS deployment

**Title:** `Open source scrub: Decouple CircleCI from PGA-internal AWS deployment`

**Body:**

### Summary

Before making this repository public, review and decouple CircleCI configuration from PGA-internal AWS accounts, artifact buckets, and deployment contexts so external users can adopt their own CI/CD paths.

### Current scope

- `.circleci/config.yml` deploys via CloudFormation to PGA-managed AWS infrastructure
- Context variables and artifact buckets are organization-specific

### Acceptance criteria

- [ ] Document a generic deployment path for external adopters (SAM/CloudFormation with operator-supplied credentials)
- [ ] CircleCI config is either removed, gated behind internal-only contexts, or split into a public example workflow
- [ ] No PGA-internal account IDs, bucket names, or secret paths are required for a clean fork to build and test

### Context

Tracked as part of the v0.0.1-a open source release preparation.

---

## Issue 4: Open source blocker — Make @pga/lambda-env available to external contributors

**Title:** `Open source blocker: Make @pga/lambda-env available to external contributors`

**Body:**

### Summary

`finance-agent` depends on the private package `@pga/lambda-env` (^0.0.11). External contributors cannot run `npm install` or build the project without access to this package.

### Current usage

- Imported in handlers such as `src/trigger_enrich_invoice.ts`
- Mocked in multiple test files
- Declared in `package.json` dependencies

### Options to resolve

1. Publish `@pga/lambda-env` publicly on npm
2. Vendor a minimal equivalent into this repository
3. Replace with a public alternative and remove the private dependency

### Acceptance criteria

- [ ] Decision recorded on which option to pursue
- [ ] `npm ci` succeeds without PGA-internal registry credentials
- [ ] Tests and build pass using the chosen approach
- [ ] README documents any migration notes for adopters

### Context

Blocked for a fully public, clone-and-build open source release. Related to v0.0.1-a preparation.

---

## Issue 5: Open source blocker — Make @pga/logger available to external contributors

**Title:** `Open source blocker: Make @pga/logger available to external contributors`

**Body:**

### Summary

`finance-agent` depends on the private package `@pga/logger` (^0.1.10). It is used broadly across source and test files. External contributors cannot install dependencies without PGA-internal registry access.

### Current usage

- Imported across cache, enrich, query, and lib modules
- Mocked throughout the Jest test suite
- Declared in `package.json` dependencies

### Options to resolve

1. Publish `@pga/logger` publicly on npm
2. Vendor a minimal equivalent into this repository
3. Replace with a public alternative (for example, `@aws-lambda-powertools/logger`)

### Acceptance criteria

- [ ] Decision recorded on which option to pursue
- [ ] `npm ci` succeeds without PGA-internal registry credentials
- [ ] Logging behavior remains acceptable for Lambda deployments
- [ ] Tests and build pass using the chosen approach

### Context

Blocked for a fully public, clone-and-build open source release. Related to v0.0.1-a preparation.
