import { z } from 'zod';
import { InvoiceEnrichmentSchema } from './enrich_invoice_prompt.js';

const enrichment = InvoiceEnrichmentSchema.shape;
const extractedLine = enrichment.extractedInvoiceLines.unwrap().element.shape;

// Anthropic structured outputs allow at most 16 union-typed (nullable) and 24 optional parameters, and no numeric
// bounds. Text fields are therefore required strings where an empty string means "not printed"; only quantity,
// hasDiscount and tableNumber stay nullable. normalizeInvoiceOcrResult turns empty values back into null.
function printedText(field: z.ZodType): z.ZodString {
  return z.string().describe(`${field.description ?? ''} Return an empty string instead of null when it is not printed.`);
}

function printedTextShape<K extends string>(shape: Record<K, z.ZodType>): Record<K, z.ZodString> {
  return Object.fromEntries(
    Object.entries<z.ZodType>(shape).map(([key, field]) => [key, printedText(field)])
  ) as Record<K, z.ZodString>;
}

const ocrInvoiceLine = z.object({
  description: extractedLine.description,
  descriptionCells: z.array(z.string()).describe(`${extractedLine.descriptionCells.description ?? ''} Return an empty array instead of null.`),
  quantity: extractedLine.quantity,
  unitCost: printedText(extractedLine.unitCost),
  totalPrice: printedText(extractedLine.totalPrice),
  hasDiscount: extractedLine.hasDiscount,
  tableNumber: z.number().nullable().describe(`${extractedLine.tableNumber.description ?? ''} Whole numbers only.`),
});

export const InvoiceOcrSchema = z.object({
  printedSupplier: z.object({
    ...printedTextShape(enrichment.supplier.shape.extractedInformation.shape),
    remitToAddress: z.string().describe('The remit-to or payment address printed on the invoice when it differs from the supplier street address. Empty string if none is printed.'),
  }).describe('The supplier (vendor) exactly as printed on the invoice'),
  printedBillTo: z.object(printedTextShape(enrichment.companyVerification.shape.extractedInformation.shape))
    .describe('The bill-to company (the buyer being billed, not the supplier) exactly as printed on the invoice'),
  extractedInvoiceDate: printedText(enrichment.extractedInvoiceDate),
  extractedDueDate: printedText(enrichment.extractedDueDate),
  extractedAmountDue: printedText(enrichment.extractedAmountDue),
  extractedSuppliersInvoiceNumber: printedText(enrichment.extractedSuppliersInvoiceNumber),
  extractedFreightAmount: printedText(enrichment.extractedFreightAmount),
  extractedFreightLabel: printedText(enrichment.extractedFreightLabel),
  extractedTaxAmount: printedText(enrichment.extractedTaxAmount),
  extractedTaxLabel: printedText(enrichment.extractedTaxLabel),
  extractedOtherCharges: z.array(z.object({
    label: z.string().describe('The exact printed label of the tax row (e.g. "5% EnvChg Tax").'),
    amount: z.string().describe('The charge amount as printed (e.g. "$17.00"). Never compute it from a rate.'),
  })).describe('Every additional row whose printed label says tax, besides the main tax in extractedTaxAmount. Return an empty array when there is none.'),
  extractedSummaryCharges: z.array(z.object({
    label: z.string().describe('The exact printed label of the totals-block row (e.g. "Decoration", "Merchandise Discount").'),
    amount: z.string().describe('The amount as printed, keeping a printed minus sign or parentheses (e.g. "$5.00", "-$13.80", "($13.80)"). Empty string when only a rate is printed. Never compute it from a rate.'),
  })).describe('Every priced row in the invoice totals block that is not a line item, subtotal, freight, tax, total, payment, or deposit, such as a decoration fee or a discount. Return an empty array when there is none.'),
  extractedPurchaseOrderNumber: printedText(enrichment.extractedPurchaseOrderNumber),
  extractedAccountNumber: printedText(enrichment.extractedAccountNumber),
  extractedSupplierReference: printedText(enrichment.extractedSupplierReference),
  extractedSupplierReferenceKind: printedText(enrichment.extractedSupplierReferenceKind),
  extractedCustomerId: printedText(enrichment.extractedCustomerId),
  extractedServicePeriod: printedText(enrichment.extractedServicePeriod),
  extractedPaymentTerms: z.string().describe('The payment terms as printed on the invoice (e.g. "Net 30", "Due on Receipt"). Empty string if none are printed.'),
  invoiceLineQuantityDisplayed: enrichment.invoiceLineQuantityDisplayed,
  extractedInvoiceLines: z.array(ocrInvoiceLine).describe(`${enrichment.extractedInvoiceLines.description ?? ''} Return an empty array instead of null.`),
});

export type InvoiceOcrResponse = z.infer<typeof InvoiceOcrSchema>;

type NullableText<T> = { [K in keyof T]: T[K] extends string ? string | null : T[K] };
export interface InvoiceOcrOtherCharge {
  label: string;
  amount: string;
}
export interface InvoiceOcrSummaryCharge {
  label: string;
  /** Null when the row prints only a rate. */
  amount: string | null;
}
type InvoiceOcrLine = Omit<NullableText<InvoiceOcrResponse['extractedInvoiceLines'][number]>, 'description' | 'descriptionCells'> & {
  description: string;
  descriptionCells: string[] | null;
};

// The model response with empty strings and arrays turned back into null, matching InvoiceEnrichmentResult.
export type InvoiceOcrResult = Omit<NullableText<InvoiceOcrResponse>, 'printedSupplier' | 'printedBillTo' | 'extractedPaymentTerms' | 'extractedInvoiceLines' | 'extractedOtherCharges' | 'extractedSummaryCharges'> & {
  extractedOtherCharges: InvoiceOcrOtherCharge[] | null;
  extractedSummaryCharges: InvoiceOcrSummaryCharge[] | null;
  printedSupplier: NullableText<InvoiceOcrResponse['printedSupplier']>;
  printedBillTo: NullableText<InvoiceOcrResponse['printedBillTo']>;
  extractedPaymentTerms: { name: string } | null;
  extractedInvoiceLines: InvoiceOcrLine[] | null;
};

function textOrNull(value: string | null | undefined): string | null {
  return value?.trim() ? value : null;
}

function nullableTextFields<T extends Record<string, unknown>>(fields: T): NullableText<T> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, typeof value === 'string' ? textOrNull(value) : value])
  ) as NullableText<T>;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function monthNumber(name: string): number {
  const word = name.toLowerCase();
  const index = MONTHS.findIndex((month) => month === word || month.slice(0, 3) === word || (word === 'sept' && month === 'september'));
  return index + 1;
}

function isoCalendarDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function ordinalMatchesDay(day: string, suffix: string | undefined): boolean {
  if (!suffix) return true;
  const n = Number(day);
  const expected = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return suffix.toLowerCase() === expected;
}

function fullYear(year: string): number {
  return year.length === 2 ? 2000 + Number(year) : Number(year);
}

/**
 * A printed date as YYYY-MM-DD: exact ISO, US month/day/year with one separator (11/11/26, 11-11-2026), or a
 * month name with a four-digit year ("Nov 11, 2026", "11th November 2026"). Two-digit years are 20YY. Anything
 * else is null.
 */
export function normalizePrintedDate(value: string | null | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return isoCalendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const numeric = text.match(/^(\d{1,2})([/-])(\d{1,2})\2(\d{4}|\d{2})$/);
  if (numeric) return isoCalendarDate(fullYear(numeric[4]), Number(numeric[1]), Number(numeric[3]));

  const monthFirst = text.match(/^([A-Za-z]+)\.?\s+(\d{1,2})(st|nd|rd|th)?,?\s+(\d{4})$/i);
  const dayFirst = text.match(/^(\d{1,2})(st|nd|rd|th)?\s+([A-Za-z]+)\.?,?\s+(\d{4})$/i);
  const named = monthFirst
    ? { month: monthFirst[1], day: monthFirst[2], suffix: monthFirst[3], year: monthFirst[4] }
    : dayFirst ? { month: dayFirst[3], day: dayFirst[1], suffix: dayFirst[2], year: dayFirst[4] } : undefined;
  if (named) {
    const month = monthNumber(named.month);
    return month && ordinalMatchesDay(named.day, named.suffix)
      ? isoCalendarDate(Number(named.year), month, Number(named.day))
      : null;
  }

  return null;
}

export function normalizeInvoiceOcrResult(response: InvoiceOcrResponse): InvoiceOcrResult {
  const {
    printedSupplier, printedBillTo, extractedPaymentTerms, extractedInvoiceLines, extractedOtherCharges, extractedSummaryCharges,
    ...headerFields
  } = response;
  const paymentTerms = textOrNull(extractedPaymentTerms);
  const otherCharges = (extractedOtherCharges ?? [])
    .filter(charge => charge.label.trim() && charge.amount.trim())
    .map(charge => ({ label: charge.label.trim(), amount: charge.amount.trim() }));
  const summaryCharges = (extractedSummaryCharges ?? [])
    .filter(charge => charge.label.trim())
    .map(charge => ({ label: charge.label.trim(), amount: textOrNull(charge.amount)?.trim() ?? null }));
  return {
    ...nullableTextFields(headerFields),
    extractedDueDate: normalizePrintedDate(headerFields.extractedDueDate),
    extractedOtherCharges: otherCharges.length ? otherCharges : null,
    extractedSummaryCharges: summaryCharges.length ? summaryCharges : null,
    printedSupplier: nullableTextFields(printedSupplier),
    printedBillTo: nullableTextFields(printedBillTo),
    extractedPaymentTerms: paymentTerms ? { name: paymentTerms } : null,
    extractedInvoiceLines: extractedInvoiceLines.length
      ? extractedInvoiceLines.map((line) => ({
        ...nullableTextFields(line),
        description: line.description,
        descriptionCells: line.descriptionCells.length ? line.descriptionCells : null,
      }))
      : null,
  };
}

export const invoiceOcrPrompt = `You read supplier invoice documents (PDFs and images) and extract what is printed on them. You have no tools and no access to Workday. Do not guess Workday IDs, suppliers, or companies. A separate step matches the supplier and company and codes the invoice from your output, so report every printed detail that helps identify the supplier and the bill-to company.

For any text field that is not printed on the document, return an empty string; return an empty array when there are no lines or description cells. Only quantity, hasDiscount, and tableNumber take null. Where a rule below says to omit a field or leave it null, use the empty value instead. Do not guess.

---

## Part 1: Supplier as printed

Populate \`printedSupplier\` with the supplier (vendor) details printed on the invoice:
- supplierName, street address, phone, email, tax ID or EIN, website, and contact person
- remitToAddress when a separate remit-to or payment address is printed, starting with the payee company name exactly as printed (for example "SiteOne Landscape Supply, LLC, 24110 Network Place, Chicago, IL 60673-1241")
- industry only when the document makes the business type clear
- memo: a few lowercase words saying what the invoice is for (e.g., "elevator phone line service", "office supplies"). No ending period, and do not name PGA, the venue, or the location the service is for. If not clear, or if it would only repeat the supplier name or an identifier, leave the memo empty. Do not prepend account, customer ID, order, job, or service date identifiers — those are applied after extraction. Do not use pipe |, greater-than, less-than, or # labels.

## Part 2: Bill-to company as printed

Populate \`printedBillTo\` with the company being billed (the buyer or recipient, NOT the supplier): company name, street address, phone, and email exactly as printed. A short form such as "PGA of America" stays as printed.

---

## Part 3: Invoice Date

Read the invoice attachment and extract the invoice date shown on the document. Populate \`extractedInvoiceDate\` using normalized \`YYYY-MM-DD\` format.

Guidelines:
- Only return the invoice date if it is clearly visible on the document.
- Prefer the document's invoice date over service dates, due dates, delivery dates, billing period dates, or Default_OCR_Spend_Category dates.
- If the document shows multiple dates and the invoice date is ambiguous, omit the field.
- Read numeric dates as month/day/year. Read the invoice date and the due date (Part 3.5) in the same order.
- Do not guess a date.

---

## Part 3.5: Due Date

Populate \`extractedDueDate\` only with a date explicitly printed as the due date, payment due date, or pay-by date (e.g. "Due Date", "Payment Due", "Pay By", "Due"), normalized to \`YYYY-MM-DD\`.

Guidelines:
- Never compute a due date from payment terms such as "Net 30", and never add days to the invoice date.
- Return an empty string for "Due on receipt", "Due upon receipt", or "Immediate" with no printed date, when no due date is printed, or when it is ambiguous.
- Expand a two-digit year to 20YY. For example, an invoice that prints Invoice Date 10/10/26 and Due Date 11/11/26 must return extractedInvoiceDate "2026-10-10" and extractedDueDate "2026-11-11".
- Read numeric dates as month/day/year, the same order as the invoice date in Part 3.

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

## Part 5.6: Additional Tax Rows

An invoice can print more than one tax row, for example "Sales Tax 8.25%" and "5% EnvChg Tax". Put the main sales tax in \`extractedTaxAmount\`. List every additional row whose printed label says tax in \`extractedOtherCharges\` with its exact printed label and printed amount, even when the row is printed in the line table, and do not put it in \`extractedInvoiceLines\`.

- Only rows whose label says tax (tax, VAT, GST, HST). Do not list any other fee or charge here: fuel surcharges, service charges, convenience fees, and similar rows stay exactly where Parts 5, 5.7, and 9 put them (freight in the freight fields, a row printed only in the totals block in \`extractedSummaryCharges\`, everything else as a line item).
- Copy the label exactly as printed. Do not rename a row or add the word "Tax" to a label that does not print it.
- Copy the printed amount. If a rate is printed (for example "EnvChg Tax 5%") and the amount is not, leave that row out. Never compute an amount from a rate.
- Do not list subtotals, totals, amount due, balance, payments, deposits, discounts, or credits.
- For example, an invoice with two lines totaling $342.50, Sales Tax $28.26, and a "5% EnvChg Tax" row of $17.00, and Amount Due $387.76 must return extractedTaxAmount "$28.26", extractedTaxLabel "Sales Tax", and extractedOtherCharges [{ label: "5% EnvChg Tax", amount: "$17.00" }].
- If there is no additional tax row, return an empty array.

---

## Part 5.7: Other Totals-Block Rows

Many invoices print priced rows in the totals block (next to Sub Total and Total) that are not in the line table, for example "Decoration $5.00", "Setup Charge $25.00", or "Merchandise Discount $13.80". List every such row in \`extractedSummaryCharges\` with its exact printed label and printed amount.

- Include fees and charges (decoration, setup, screen, digitizing, service fees) and reductions (discounts, allowances, rebates, promotions, coupons, credits).
- Do not list the merchandise subtotal or any other subtotal, freight, shipping, handling, delivery, sales tax or any tax row, the total, amount due, balance, payments, or deposits. Freight and tax go in Parts 5, 5.5, and 5.6. A label such as "Merchandise Discount" or "Merchandise Allowance" is a discount, not a subtotal, so list it.
- Copy the label exactly as printed.
- Copy the amount exactly as printed, keeping a minus sign or parentheses when they are printed ("-$13.80", "($13.80)"). Do not add a minus sign that is not printed.
- If only a rate is printed (for example "Discount 10%") and no amount, list the row with an empty amount. Never compute an amount from a rate.
- A row printed in the line table belongs in \`extractedInvoiceLines\`, not here. Do not list a totals-block row that only restates a line already in the line table.
- For example, an invoice with Merchandise $282.50, Decoration $5.00, Sub Total $287.50, S&H $25.18, and Total $312.68 must return extractedFreightAmount "$25.18" and extractedSummaryCharges [{ label: "Decoration", amount: "$5.00" }].
- If there is no such row, return an empty array.

---

## Part 6: Supplier's Invoice Number

Read the invoice attachment and extract the supplier's invoice number as it appears on the document. Populate \`extractedSuppliersInvoiceNumber\`. Prefer letters, digits, hyphen, period, and slash. Do not use pipe \`|\`, \`>\`, or \`<\`. If no invoice number is visible or the value is ambiguous, omit the field.

---

## Part 7: Purchase Order Number

Read the invoice attachment and extract the purchase order number if one is referenced. It may be labeled as "PO Number", "Purchase Order Number", "PO#", or prefixed with "PO-". Populate \`extractedPurchaseOrderNumber\` with the value as it appears on the document. If no PO number is visible or the value is ambiguous, omit the field. Do not treat a non-numeric PO column (e.g. "PGA COACHING") as a purchase order number.

---

## Part 7.5: Memo identifiers

Extract these identifiers independently when they appear on the invoice or in a line description. Omit a field when it is not on the document. Code builds the memo from them in this order, separated by single spaces: account or customer ID, one supplier reference, service dates, then the short description (for example \`Cust 115117 Svc Prd 09/01/26 - 09/30/26 elevator phone line service\`). PGA's PO is not part of the memo. Do not copy these identifiers into \`printedSupplier.memo\`, and do not use pipe \`|\` or \`#\` labels there.

1. **Account number** (\`extractedAccountNumber\`): PGA's customer/sold-to account at this supplier. Labels: "Account Number", "Account #", "Acct #", "AC #", "Customer Account", "Sold To Number" (when that sold-to value is the billed-account id, as on Topgolf). If "Account Number" sits next to ABA/routing in an electronic payments, remit-to, ACH, or wire block, skip it — that is a bank account (Cushman pattern). Never use GL, cost center, company code, or the supplier invoice number.

2. **Supplier reference** (\`extractedSupplierReference\` and \`extractedSupplierReferenceKind\`): the single most useful supplier-side reference. Labels: "Order #" / "Order Number" (kind \`order\`), "Confirmation #" / "Conf #" (kind \`confirmation\`), "Job #" / "Job Number" / "Job No" (kind \`job\`). On a legal invoice use the file, case, or matter number instead (kind \`file\` for a file or matter number, \`case\` for a case number). When several are printed, return only the one that best identifies the work. Do not use an unlabeled Project / PRJ value. Never use PGA's PO, the supplier invoice number, or the account or customer number; if the only Order # / Job # is the PGA PO already extracted (\`PO-\` + 6 word chars), leave both fields empty.

3. **Customer ID** (\`extractedCustomerId\`): "Customer ID", **"Bill-To Customer ID"**, "Customer #", "Cust ID". If this value is the same as \`extractedAccountNumber\`, leave customer ID null and keep the account number.

4. **Service period** (\`extractedServicePeriod\`): billing/service window as shown, including inside a line description (e.g. "Service Period: 2026 - September"). Also "Billing Period", "Period Covered", "Pay Date Range", "Week Ending", or From/To. Return the dates or period only, without the label in front of them (\`09/28/2026 - 10/11/2026\`, not \`Pay Date Range 09/28/2026 - 10/11/2026\`). Keep the document wording for the dates; do not invent dates.

---

## Part 8: Payment Terms

If payment terms are printed on the invoice (e.g. "Net 30", "Net 60", "Due on Receipt"), populate \`extractedPaymentTerms\` with the text as it appears. If no payment terms are printed, return an empty string.

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

Exclude any lines that represent tax charges (e.g. "VAT", "GST", "HST", "Sales Tax") — capture the main tax in \`extractedTaxAmount\` and any additional tax row in \`extractedOtherCharges\` instead.
Exclude any lines that represent freight, shipping, handling, or delivery charges — capture those in \`extractedFreightAmount\` instead.

Rows printed only in the totals block go in \`extractedSummaryCharges\` (Part 5.7), not here.

Populate \`extractedInvoiceLines\` with all remaining line items found. If no line items can be extracted, omit the field.

---

Remember: report only what the documents show. When document roles are given, extract the header, lines, and amounts from the supplier invoice, and use supporting files only as backup context — do not extract a separate invoice from them.`;
