# AGENTS.md

Guidance for AI agents and automated reviewers (including Divot) working in this repository.

## Every invoice is created as a Workday draft

This agent never submits an invoice for approval or payment. `buildSubmitInvoiceData` in `src/lib/workday.ts` always sends `Submit: false`, and it is the only place the `Submit` flag is set. Create, update, and every repair retry go through that builder, so each invoice lands in Workday as a draft that AP reviews and submits by hand.

When scoring risk or reviewing a change to invoice lines, coding, amounts, or PO matching:

- A wrong line quantity, unit cost, worktag, or PO link on a draft is corrected by AP before it can become a payment. Weigh it as a review-time defect, not a payment error.
- Do not ask for an environment gate or feature flag on that basis alone. Ask for one when a change alters what is submitted outside the draft path, or what is sent to a system other than Workday.
- Keep the invoice total unchanged. AP notes and fallback labels must describe what was actually submitted (see the notes built from applied fallbacks in `src/lib/workday.ts`), because AP relies on them when reviewing the draft.
- If a change ever sets `Submit: true` or adds another submit path, treat it as high risk and say so in the PR.

## Where the rules live

Detailed behavior (amount alignment, PO line matching, repair retries, Workday contracts) is documented in the skills under `.agents/skills/`. Read the relevant skill before changing that area, and update it in the same PR:

- `integrations-and-external-contracts`: HTTP APIs, Workday invoice lines, amounts, memos, fallbacks and repair retries
- `data-and-state-changes`: Postgres schema, documents table, cached Workday reference IDs
- `invoice-attachment-clustering`: attachment classification and resend dedupe
- `infra-and-runtime`: `template.yml`, Lambda retries and timeouts
- `agent-invoice-scoring`: scoring finance-agent invoices against what AP saved

## Checks

- `npx tsc --noEmit`
- `npx jest --ci`
