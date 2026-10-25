# AGENTS.md

Facts about this repository that tools and contributors can rely on.

## Every invoice is created as a Workday draft

This agent never submits an invoice for approval or payment. `buildSubmitInvoiceData` in `src/lib/workday.ts` always sends `Submit: false`, and it is the only place the `Submit` flag is set. `Submit_Supplier_Invoice` is the only Workday write, and the first attempt and every repair retry build their payload through `buildSubmitInvoiceData`. Each invoice lands in Workday as a draft.

A change that sets `Submit: true` or adds another submit path changes this and should be called out in its PR.

The eval replay (`src/eval/`, `evals/README.md`) builds the same payload through `buildSubmitInvoiceData` but never sends it: a replay hook in `src/lib/workday.ts` records the request and blocks every other Workday call. It is installed only by `eval:replay`.

### Limits of the draft guarantee

- Nothing in this code makes AP review a draft before AP submits it. Review is a team process, not something the agent enforces.
- A supplier resend can overwrite AP's edits. The resend path calls `submitSupplierInvoiceUpdate` on a Draft, unpaid, uncancelled invoice and replaces its lines, so a fix AP made by hand can be lost and AP may have to correct the same defect again. `agent-invoice-scoring` describes this ("A resend update still overwrites AP edits on a Draft invoice") and `invoice-attachment-clustering` covers the resend flow.

So a draft is not a guarantee that AP corrects a defect. Notes on the invoice must describe what was actually submitted, because AP relies on them. Fallback labels come from the payload Workday accepted. Review notes are built before submit, so keep their claims true even if a repair retry changes the line.

## Where the rules live

Detailed behavior (amount alignment, PO line matching, repair retries, Workday contracts) is documented in the skills under `.agents/skills/`. Read the relevant skill before changing that area, and update it in the same PR:

- `integrations-and-external-contracts`: HTTP APIs, Workday invoice lines, amounts, memos, fallbacks and repair retries
- `data-and-state-changes`: Postgres schema, documents table, cached Workday reference IDs
- `invoice-attachment-clustering`: attachment classification and resend dedupe
- `infra-and-runtime`: `template.yml`, Lambda retries and timeouts
- `evals/README.md`: exporting AP-corrected cases, replaying them, baselines, and the data-handling rules for real invoice data
- `agent-invoice-scoring`: scoring finance-agent invoices against what AP saved

## Checks

- `npx tsc --noEmit`
- `npx jest --ci`
