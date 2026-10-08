import { z } from 'zod';
import { InvoiceEnrichmentSchema } from './enrich_invoice_prompt.js';

const enrichment = InvoiceEnrichmentSchema.shape;
const extractedLine = enrichment.extractedInvoiceLines.unwrap().element;

// Anthropic structured outputs reject numeric bounds, and z.number().int() emits safe-integer minimum/maximum.
const ocrInvoiceLine = extractedLine.extend({
  tableNumber: z.number().nullable().describe(`${extractedLine.shape.tableNumber.description ?? ''} Whole numbers only.`),
});

// Document-only extraction. Field rules are shared with InvoiceEnrichmentSchema so the merged result keeps the same meaning.
export const InvoiceOcrSchema = z.object({
  printedSupplier: enrichment.supplier.shape.extractedInformation.extend({
    remitToAddress: z.string().nullable().describe('The remit-to or payment address printed on the invoice when it differs from the supplier street address. Null if none is printed.'),
  }).describe('The supplier (vendor) exactly as printed on the invoice'),
  printedBillTo: enrichment.companyVerification.shape.extractedInformation.describe('The bill-to company (the buyer being billed, not the supplier) exactly as printed on the invoice'),
  extractedInvoiceDate: enrichment.extractedInvoiceDate,
  extractedAmountDue: enrichment.extractedAmountDue,
  extractedSuppliersInvoiceNumber: enrichment.extractedSuppliersInvoiceNumber,
  extractedFreightAmount: enrichment.extractedFreightAmount,
  extractedFreightLabel: enrichment.extractedFreightLabel,
  extractedTaxAmount: enrichment.extractedTaxAmount,
  extractedTaxLabel: enrichment.extractedTaxLabel,
  extractedPurchaseOrderNumber: enrichment.extractedPurchaseOrderNumber,
  extractedAccountNumber: enrichment.extractedAccountNumber,
  extractedJobNumber: enrichment.extractedJobNumber,
  extractedCustomerId: enrichment.extractedCustomerId,
  extractedServicePeriod: enrichment.extractedServicePeriod,
  extractedPaymentTerms: z.object({
    name: z.string().describe('The payment terms as printed on the invoice (e.g. "Net 30", "Due on Receipt")'),
  }).nullable().describe('Payment terms printed on the invoice. Null if none are printed.'),
  invoiceLineQuantityDisplayed: enrichment.invoiceLineQuantityDisplayed,
  extractedInvoiceLines: z.array(ocrInvoiceLine).nullable().describe(enrichment.extractedInvoiceLines.description ?? ''),
});

export type InvoiceOcrResult = z.infer<typeof InvoiceOcrSchema>;

export const invoiceOcrPrompt = `You read supplier invoice documents (PDFs and images) and extract what is printed on them. You have no tools and no access to Workday. Do not guess Workday IDs, suppliers, or companies. A separate step matches the supplier and company and codes the invoice from your output, so report every printed detail that helps identify the supplier and the bill-to company.

Use null for any field that is not printed on the document. Do not guess.

---

## Part 1: Supplier as printed

Populate \`printedSupplier\` with the supplier (vendor) details printed on the invoice:
- supplierName, street address, phone, email, tax ID or EIN, website, and contact person
- remitToAddress when a separate remit-to or payment address is printed
- industry only when the document makes the business type clear
- memo: a terse 1-sentence summary of what the invoice is for (e.g., "Office supplies for Q1 2024"). If not clear, leave the memo empty. Do not prepend PO, account, job, customer ID, or service period identifiers — those are applied after extraction. Do not use pipe |, greater-than, less-than, or # labels in this sentence.

## Part 2: Bill-to company as printed

Populate \`printedBillTo\` with the company being billed (the buyer or recipient, NOT the supplier): company name, street address, phone, and email exactly as printed. A short form such as "PGA of America" stays as printed.

---

## Part 3: Invoice Date

Read the invoice attachment and extract the invoice date shown on the document. Populate \`extractedInvoiceDate\` using normalized \`YYYY-MM-DD\` format.

Guidelines:
- Only return the invoice date if it is clearly visible on the document.
- Prefer the document's invoice date over service dates, due dates, delivery dates, billing period dates, or Default_OCR_Spend_Category dates.
- If the document shows multiple dates and the invoice date is ambiguous, omit the field.
- Do not guess a date.

---

## Part 4: Amount Due

Read the invoice attachment and extract the amount due or invoice total as it appears on the document. Populate \`extractedAmountDue\` with this value (e.g. "$8,573.40"). If no amount can be found, omit the field.

---

## Part 5: Freight Amount

Read the invoice attachment and extract the freight amount. It may be labeled as "Freight", "Shipping", "Handling", "Shipping & Handling", "Delivery", or similar. Populate \`extractedFreightAmount\` with this value (e.g. "$150.00") and populate \`extractedFreightLabel\` with the exact label you read.

If the invoice presents freight/shipping/handling as a line item rather than a summary field, still capture it here — do NOT include it in \`extractedInvoiceLines\`. If no freight amount could be found or if it is ambiguous, omit both \`extractedFreightAmount\` and \`extractedFreightLabel\`.

---

## Part 5.5: Tax Amount

Read the invoice attachment and extract the tax amount. It may be labeled as "Tax", "VAT", "GST", "HST", "Sales Tax", or similar. Populate \`extractedTaxAmount\` with this value (e.g. "$45.00") and populate \`extractedTaxLabel\` with the exact label you read.

CRITICAL: If the invoice shows a "Shipping and Handling" or similar row with no amount, and a separate "Sales Tax" row with an amount, do NOT put the sales tax amount in \`extractedFreightAmount\`. Put the sales tax amount in \`extractedTaxAmount\` with label "Sales Tax", and leave \`extractedFreightAmount\` null. For example, an invoice with Sub-Total $8,514.38, blank Shipping and Handling, Sales Tax $510.86, and Invoice Total $9,025.24 must return extractedFreightAmount null, extractedFreightLabel null, extractedTaxAmount "$510.86", extractedTaxLabel "Sales Tax".

If the invoice presents the tax as a line item rather than a summary field, still capture it here — do NOT include it in \`extractedInvoiceLines\`. If no tax amount could be found or if it is ambiguous, omit both \`extractedTaxAmount\` and \`extractedTaxLabel\`.

---

## Part 6: Supplier's Invoice Number

Read the invoice attachment and extract the supplier's invoice number as it appears on the document. Populate \`extractedSuppliersInvoiceNumber\`. Prefer letters, digits, hyphen, period, and slash. Do not use pipe \`|\`, \`>\`, or \`<\`. If no invoice number is visible or the value is ambiguous, omit the field.

---

## Part 7: Purchase Order Number

Read the invoice attachment and extract the purchase order number if one is referenced. It may be labeled as "PO Number", "Purchase Order Number", "PO#", or prefixed with "PO-". Populate \`extractedPurchaseOrderNumber\` with the value as it appears on the document. If no PO number is visible or the value is ambiguous, omit the field. Do not treat a non-numeric PO column (e.g. "PGA COACHING") as a purchase order number.

---

## Part 7.5: Memo identifiers

Extract these identifiers independently when they appear on the invoice or in a line description. Omit a field when it is not on the document. Code joins values with a period, in check-print order (account, customer ID, job/order, PO, service period, then the memo sentence). Do not copy these identifiers into \`printedSupplier.memo\`, and do not use pipe \`|\` or \`#\` labels there.

1. **Account number** (\`extractedAccountNumber\`): PGA's customer/sold-to account at this supplier. Labels: "Account Number", "Account #", "Acct #", "AC #", "Customer Account", "Sold To Number" (when that sold-to value is the billed-account id, as on Topgolf). If "Account Number" sits next to ABA/routing in an electronic payments, remit-to, ACH, or wire block, skip it — that is a bank account (Cushman pattern). Never use GL, cost center, company code, or the supplier invoice number.

2. **Job number** (\`extractedJobNumber\`): "Job #", "Job Number", "Job No", **"Order #" / "Order Number"** (Order # is the same as Job #). Do not use an unlabeled Project / PRJ value as the job number. If Order # / Job # is the same PGA PO already extracted (\`PO-\` + 6 word chars), leave job number null.

3. **Customer ID** (\`extractedCustomerId\`): "Customer ID", **"Bill-To Customer ID"**, "Customer #", "Cust ID". If this value is the same as \`extractedAccountNumber\`, leave customer ID null and keep the account number.

4. **Service period** (\`extractedServicePeriod\`): billing/service window as shown, including inside a line description (e.g. "Service Period: 2026 - September"). Also "Billing Period", "Period Covered", or From/To. Keep the document wording; do not invent dates.

---

## Part 8: Payment Terms

If payment terms are printed on the invoice (e.g. "Net 30", "Net 60", "Due on Receipt"), populate \`extractedPaymentTerms.name\` with the text as it appears. If no payment terms are printed, set \`extractedPaymentTerms\` to null.

---

## Part 9: Invoice Lines

First, set \`invoiceLineQuantityDisplayed\` from the document layout (column headers and visible cells on the line table), not from guessing or math:
- **true** when the invoice shows a quantity column or per-line quantity values (Qty, Quantity, etc.)
- **false** when there is no quantity column and no per-line quantity values on the merchandise lines

Extract the individual line items from the invoice document:

1. For each line item, extract:
   - **Description cells**: Every meaningful text cell on **that invoice row**, in left-to-right document order. Do not use only the column labeled Description / Item / Service. Include Activity, Resource, Consultant, Employee, Staff, Person, Role, SKU, Item #, Part #, Product, Service, Description, Project, Location, and any other identifying text on the row. Skip empty cells, quantity, rate, amount, Notes, and Comments. Populate \`descriptionCells\` with those values. Code concatenates \`descriptionCells\` into description and drops cells that match the line's printed quantity, unit cost, or amount.
   - **Description**: Concatenate those cells with \` - \`. Do not summarize, paraphrase, or drop a name, SKU, or activity in favor of a shorter category. The terse 1-sentence summary belongs in memo later, not here. Do not include quantity, rate/unit price, amount/extended, tax, or freight. Do not include PO, account, job, customer ID, or header billing/service-period values — those are extracted separately. A date **on the row** that identifies the work may be included; header service dates must not be copied onto every line. Example: Activity \`Ryan Poland\` + Description \`Project Management\` → descriptionCells \`["Ryan Poland", "Project Management"]\` and description \`Ryan Poland - Project Management\`.
   - **Quantity**: The quantity ordered/delivered when \`invoiceLineQuantityDisplayed\` is true and a value is shown. When \`invoiceLineQuantityDisplayed\` is false, leave quantity **null** on every line — do not infer quantity from unit cost and total.
   - **Unit Cost**: The price per unit only when a unit price is printed (a unit-price / rate column or per-unit value). When it is not stated, leave unitCost **null** — do not compute it from quantity and total.
   - **Total Price**: The total/extended price for the line (if stated)
   - **Table Number**: Which table on the document the row came from, numbered 1, 2, 3... in document order. Some invoices print the same charges in more than one table, for example an hourly line-item table and a monthly summary or remittance table that restates it. When you extract rows from more than one table, give each table its own number so code can tell a restated table from the original. Use 1 when the document has one line-item table.

Exclude any lines that represent tax charges (e.g. "VAT", "GST", "HST", "Sales Tax") — capture those in \`extractedTaxAmount\` instead.
Exclude any lines that represent freight, shipping, handling, or delivery charges — capture those in \`extractedFreightAmount\` instead.

Populate \`extractedInvoiceLines\` with all remaining line items found. If no line items can be extracted, omit the field.

---

Remember: report only what the documents show. When document roles are given, extract the header, lines, and amounts from the supplier invoice, and use supporting files only as backup context — do not extract a separate invoice from them.`;
