import { z } from 'zod';

export const MergeInvoiceLinesSchema = z.object({
  lines: z.array(z.object({
    lineOrder: z.number().describe('Sequential line number starting at 1'),
    description: z.string().describe('Line item description from the invoice'),
    memo: z.string().nullable().describe('A terse 1-sentence memo describing what this line item is for, generated from the invoice line description (e.g. "Monthly software subscription", "Event catering services"). If a matched PO line has a memo, use it as context but still generate your own. Null only if the description is too vague to summarize.'),
    quantity: z.number().nullable().describe('Quantity for the line item. Null if not stated.'),
    unitCost: z.number().nullable().describe('Unit cost as a decimal number (e.g. 1000.00). Null if not stated.'),
    extendedAmount: z.number().nullable().describe('Total/extended price as a decimal number. Null if not stated.'),
    costCenterId: z.string().nullable().describe('Cost_Center_Reference_ID from matched PO lines only. Null if no PO line was matched. Never copy a code from the email body.'),
    fundId: z.string().nullable().describe('Fund_ID from matched PO lines only. Null if no PO line was matched. Never copy a code from the email body.'),
    spendCategoryId: z.string().nullable().describe('Spend_Category_ID from PO lines only. Never infer this from email text — spend category is resolved upstream and applied separately. Null if no PO line was matched.'),
    lineOfBusinessId: z.string().nullable().describe('Copy lineOfBusinessId from the matched PO line when present (already extracted in code, e.g. "LOB-Technology_Services"). Null if no PO line was matched or the PO line has no lineOfBusinessId.'),
    eventId: z.string().nullable().describe('Organization_Reference_ID value of an event worktag from the matched PO line, if one can be identified. Inspect the matched PO line\'s worktagsReference array for a worktag that looks like a specific event, tournament, championship, conference, or occasion (e.g. "2026-PGA_Championship" — often starts with a year or contains event-like language). Return the Organization_Reference_ID value of that worktag. Do not confuse events with line-of-business worktags. Null if no PO line was matched, no event-like worktag is present, or you are unsure.'),
    shipToAddressId: z.string().nullable().describe('The shipToAddressId from the matched PO line. Copy it directly from the matched PO line\'s shipToAddressId field. Null if no PO line was matched or the PO line has no shipToAddressId.'),
    purchaseOrderLineId: z.string().nullable().describe('The purchaseOrderLineId from the matched PO line. Copy it directly from the matched PO line\'s purchaseOrderLineId field. Null if no PO line was matched.'),
    hasDiscount: z.boolean().nullable().describe('True if a discount is explicitly shown on this line in the invoice document. Copy the value directly from the matching extracted invoice line. Null if not stated.'),
  })).describe('Final merged invoice lines with worktag data filled in from available sources'),
});

export type MergeInvoiceLinesResult = z.infer<typeof MergeInvoiceLinesSchema>;

export const mergeInvoiceLinesPrompt = `You are an expert at mapping invoice line items to financial worktags for a Workday accounting system.

You will receive a JSON object with the following fields:
- **extractedInvoiceLines**: Line items extracted from the invoice document (description, quantity, unitCost as string, totalPrice as string)
- **purchaseOrderLines** (optional): Lines from a matching Purchase Order in Workday, each with purchaseOrderLineId, costCenterId, fundId, spendCategoryId, lineOfBusinessId (extracted ID strings), and worktagsReference (the full array of raw Workday worktag reference objects for that line)
- **emailBody** (optional): The plain-text email that accompanied this invoice. Do not copy codes from it into ID fields; email coding is resolved upstream.

Your task is to produce final invoice lines by:

1. Using the extracted invoice lines as the source of truth for line data (description, quantity, unit cost, total price)
2. Matching each extracted line to a PO line by semantic similarity of description and applying the PO line's worktag IDs (costCenterId, fundId, spendCategoryId, lineOfBusinessId) to the matched invoice line
3. For lineOfBusinessId: copy the matched PO line's lineOfBusinessId value when it is present. Do not invent an LOB id from the description or email.
4. For eventId: inspect the matched PO line's worktagsReference array for a worktag that looks like a specific event, tournament, championship, conference, or occasion (e.g. "2026-PGA_Championship" — often starts with a year or contains event-like language). Return the Organization_Reference_ID value of that worktag. Set null if you are unsure or no event-like worktag is present
5. For shipToAddressId: copy the shipToAddressId value directly from the matched PO line
6. For purchaseOrderLineId: copy the purchaseOrderLineId value directly from the matched PO line
7. For hasDiscount: copy the value directly from the matching extracted invoice line
8. For memo: write a terse 1-sentence description of what the line item is for, based on the invoice line's description. If a matched PO line has a memo, use it as additional context. Set null only if the description is too vague to summarize
9. Do not copy codes from the email body into costCenterId, fundId, or other ID fields. Email coding is resolved upstream and applied separately. A short code in the email may be a company, cost center, fund, LOB, or spend category — do not assume it is a cost center. If there is no PO match, set those IDs to null.
10. For any worktag field you cannot determine from any source, set it to null — fallback values will be applied separately

Guidelines:
- CRITICAL: The output array MUST contain exactly as many lines as extractedInvoiceLines — no more, no fewer. Even if a line has no item name, is missing amounts, or seems like a sub-item or continuation, it is a separate invoice line and must appear as a separate output line. Never collapse, skip, or combine invoice lines.
- Return the lines in the same order as extractedInvoiceLines
- Line order is sequential starting at 1
- Convert unitCost and totalPrice strings to decimal numbers (e.g. "$1,000.00" → 1000.00). Strip currency symbols and commas
- If a PO has fewer lines than the invoice, apply the worktags from the best-matching PO line to each unmatched invoice line
- If all PO lines share the same worktags, apply those worktags to all invoice lines
- If the invoice has fewer lines than the PO, match each invoice line to the single best-matching PO line
- Cost center IDs and fund IDs must come from matched PO lines only. Never copy a number or token from the email body into costCenterId or fundId — those values are resolved and applied outside this step
- Spend category IDs come from PO lines only — never construct them from email text
- Set null for any worktag field you cannot confidently determine from the available sources`;
