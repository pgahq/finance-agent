# Legal pre-release scan report

**Repository:** `finance-agent` (working title; public name TBD — generic, no PGA/Workday in product name)  
**Scan date:** 2026-05-27  
**Purpose:** Evidence for PGA of America legal review before AGPL-3.0 open-source release.

> Re-run scans before the first **public** git push. This report reflects a one-time snapshot on a private clone.

---

## Recommended tools (run today / before public launch)

| Tool | What it answers for Legal | Status (2026-05-27) |
|------|---------------------------|---------------------|
| **`license-checker`** (`npx license-checker --production --summary`) | Dependency license mix; AGPL compatibility of *incoming* deps | ✅ Run — see §1 |
| **`npm audit --omit=dev`** | Known CVEs in production dependency tree | ✅ Run — see §2 |
| **`detect-secrets scan`** (Yelp) | Secrets in tree (incl. test fixtures, SSM key *names*) | ✅ Run — see §3 |
| **Gitleaks** (`gitleaks detect --source . -v`) | Secrets in **full git history** | ⚠️ Not run — install blocked in this environment; **run locally/CI** |
| **TruffleHog** or **GitGuardian** | Verified secrets + history | ⚠️ Not run — recommend for CI |
| **FOSSA / Snyk Open Source / Mend** | Policy rules (e.g. block GPL in deps), SBOM, ongoing monitoring | ⚠️ Not run — recommend if PGA has org license |
| **Syft + Grype** (or `cyclonedx-npm`) | SBOM + vulnerability match for legal archive | ⚠️ Optional — attach to legal packet |
| **`reuse lint`** (REUSE specification) | SPDX headers, LICENSE/NOTICE consistency | ⚠️ After `LICENSE` added |
| **Manual review** | `template.yml`, `.circleci/config.yml` for tenant IDs, ARNs, internal service names | ✅ Spot-check — see §4 |
| **Workday API terms** | Right to publish integration *patterns* (not just WSDL files) | 📋 Legal — WSDLs publicly hosted at [Workday Community Production API](https://community.workday.com/sites/default/files/file-hosting/productionapi/index.html) |

---

## 1. Production dependency licenses

Command: `npx license-checker --production --summary` (after `npm install` with generated lockfile locally).

| License family | Count (approx.) |
|----------------|-----------------|
| MIT | 150 |
| Apache-2.0 | 54 |
| ISC | 18 |
| BSD-3-Clause | 8 |
| Other (0BSD, Unlicense, BlueOak, Artistic, AFL/BSD) | 4 |

**PGA-scoped npm packages (direct dependencies):**

| Package | License (npm registry) | Notes |
|---------|------------------------|--------|
| `@pga/lambda-env@0.0.11` | ISC | Public on npm; OSS phase may still replace for neutral branding |
| `@pga/logger@0.1.11` | ISC | Public on npm |

**Direct runtime dependency of note:**

| Package | License | Notes |
|---------|---------|--------|
| `strong-soap@5.0.x` | MIT | Transitive advisories via `httpntlm` / `underscore` (see §2) |

**AGPL outbound:** Project intends **AGPL-3.0** on PGA-authored code. Production dependencies observed are permissive (MIT/Apache/ISC/BSD) — typical for AGPL projects; Legal should confirm no copyleft dependency conflicts under PGA policy.

**Gap:** No `package-lock.json` committed in repo at scan time — reproducible license audits need a committed lockfile + CI gate.

---

## 2. Production vulnerability summary (`npm audit --omit=dev`)

| Severity | Count |
|----------|-------|
| High | 3 |
| Moderate | 4 |
| Low | 1 |

**Notable paths:**

- **`strong-soap`** → `@cypress/request` → `qs` (moderate DoS advisory)
- **`strong-soap`** → `httpntlm` → `underscore` (high — recursion DoS)
- **`uuid`** (moderate) — multiple nested copies; override in `package.json` may not apply to all paths
- **`@pga/lambda-env`** → legacy **`aws-sdk` v2** (low/moderate advisory on region validation)

**For Legal:** Vulnerabilities affect **operators who deploy** the stack; discuss whether release notes must disclose known transitive CVEs and remediation timeline (not a license issue, but liability narrative).

---

## 3. Secret scanning (`detect-secrets scan`)

| File area | Findings | Assessment |
|-----------|----------|------------|
| `src/__tests__/*.ts` | 12 | Test doubles (`test-client-secret`, `test-api-key`, `testpass`) — expected; no rotation needed |
| `template.yml` | 3 | **False positives** — env var *names* referencing SSM parameters (`WORKDAY_CLIENT_SECRET`, `OPENAI_API_KEY`, IAM `secretsmanager`) |

**No verified live credentials** in application source from this scan.

**Still required before public push:**

- **Gitleaks / TruffleHog on full `git log`** (historical commits, force-pushes, old `.env` leaks)
- Confirm CircleCI/context secrets never committed

---

## 4. Organization-specific identifiers (scrub before public repo)

Manual grep found PGA-internal deployment hints to parameterize in OSS phase:

| Location | Example |
|----------|---------|
| `.circleci/config.yml` | `WORKDAY_TENANT: pgahq`, `pgahq8` |
| `template.yml` | `WORKDAY_DEFAULT_SUPPLIER_WID`, SSM paths `ap-ingest-service/workday-isu-*` |
| `README.md` | Internal Slack channel name |

These are **configuration leaks**, not secrets — Legal may care for branding/neutral naming policy.

---

## 5. Large third-party artifacts

| Artifact | Size | Note |
|----------|------|------|
| `src/soap/Financial_Management.wsdl` | ~5.1 MB | Workday publishes production APIs publicly on Community site |
| `src/soap/Resource_Management.wsdl` | ~5.6 MB | Same |

Engineering position: WSDLs are sourced from public Workday hosting; Legal should still confirm publishing integration code + bundled WSDL copies is acceptable under Workday terms.

---

## 6. Data / LLM (for Legal narrative)

- Supplier invoice **attachments** may contain PII/confidential data.
- When enabled, content is sent to configured **LLM provider** (e.g. OpenAI).
- **PGA and partners will not host** a shared SaaS instance; each operator deploys to their own environment.
- Product/security controls (write-back, LLM, notifications) intended as **deploy-time feature flags / configuration**.

---

## 7. Suggested CI gates (post-legal approval)

```bash
npx license-checker --production --onlyAllow "MIT;Apache-2.0;ISC;BSD-2-Clause;BSD-3-Clause;0BSD;Unlicense;BlueOak-1.0.0;Artistic-2.0;(AFL-2.1 OR BSD-3-Clause)"
npm audit --omit=dev --audit-level=high
gitleaks detect --source . --verbose
detect-secrets scan --baseline .secrets.baseline   # after triaging false positives
```

---

## Open items for tomorrow’s legal conversation

1. Approve **AGPL-3.0** with **self-hosted-only** distribution model (operators are network users; PGA does not host).
2. **Corporate + individual CLA** vendor (e.g. CLA Assistant, EasyCLA, Google CLA).
3. **PGA Tour** funding/contributions to PGA — permissible structure?
4. **Partner mentions** in README (e.g. Okta for optional SSO) — trademark/disclaimer template.
5. **Generic public project name** + `TRADEMARK.md` for PGA marks (separate from product name).
6. **Export control** — trigger formal review Y/N.
7. **Workday API terms** beyond public WSDL hosting.
8. Waive or complete **NOTICE** file + committed **package-lock.json**.
