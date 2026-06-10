import { z } from 'zod';

export const MergeInvoiceLinesSchema = z.object({
  lines: z.array(z.object({
    lineOrder: z.number().describe('Sequential line number starting at 1'),
    description: z.string().describe('Line item description from the invoice'),
    quantity: z.number().nullable().describe('Quantity for the line item. Null if not stated.'),
    unitCost: z.number().nullable().describe('Unit cost as a decimal number (e.g. 1000.00). Null if not stated.'),
    extendedAmount: z.number().nullable().describe('Total/extended price as a decimal number. Null if not stated.'),
    costCenterId: z.string().nullable().describe('Cost_Center_Reference_ID from PO lines or email context. Null if not determinable.'),
    fundId: z.string().nullable().describe('Fund_ID from PO lines or email context. Null if not determinable.'),
    spendCategoryId: z.string().nullable().describe('Spend_Category_ID from PO lines or email context. Null if not determinable.'),
  })).describe('Final merged invoice lines with worktag data filled in from available sources'),
});

export type MergeInvoiceLinesResult = z.infer<typeof MergeInvoiceLinesSchema>;

export const mergeInvoiceLinesPrompt = `You are an expert at mapping invoice line items to financial worktags for a Workday accounting system.

You will receive a JSON object with the following fields:
- **extractedInvoiceLines**: Line items extracted from the invoice document (description, quantity, unitCost as string, totalPrice as string)
- **purchaseOrderLines** (optional): Lines from a matching Purchase Order in Workday, each with their resolved worktag IDs (costCenterId, fundId, spendCategoryId)
- **emailBody** (optional): The plain-text email body that accompanied this invoice, which may contain cost center references

Your task is to produce final invoice lines by:

1. Using the extracted invoice lines as the source of truth for line data (description, quantity, unit cost, total price)
2. Matching each extracted line to a PO line by semantic similarity of description and applying the PO line's worktag IDs (costCenterId, fundId, spendCategoryId) to the matched invoice line
3. If no PO lines are available, or a line cannot be matched to a PO line, check the email body for cost center or fund references and use those
4. For any worktag field you cannot determine from any source, set it to null — fallback values will be applied separately

Guidelines:
- Return exactly one output line per extracted invoice line, in the same order
- Line order is sequential starting at 1
- Convert unitCost and totalPrice strings to decimal numbers (e.g. "$1,000.00" → 1000.00). Strip currency symbols and commas
- If a PO has fewer lines than the invoice, apply the worktags from the best-matching PO line to each unmatched invoice line
- If all PO lines share the same worktags, apply those worktags to all invoice lines
- Cost center IDs, fund IDs, and spend category IDs are alphanumeric strings (e.g. "72200", "FD-001")
- Set null for any worktag field you cannot confidently determine from the available sources`;
