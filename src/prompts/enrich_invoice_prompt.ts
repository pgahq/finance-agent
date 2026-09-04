import { z } from 'zod';

// Unified schema for invoice enrichment — handles both supplier identification and verification
export const InvoiceEnrichmentSchema = z.object({
  supplier: z.object({
    // Identification statuses: found, not_found, ambiguous, error
    // Verification statuses: matching, different, uncertain
    status: z.enum(['found', 'not_found', 'ambiguous', 'matching', 'different', 'uncertain', 'error']).describe('The result of supplier analysis. Use found/not_found/ambiguous/error when identifying a supplier (no existing supplier). Use matching/different/uncertain when verifying an existing supplier.'),
    confidence: z.number().min(0).max(1).describe('Confidence score between 0 and 1'),

    extractedInformation: z.object({
      supplierName: z.string().nullable().describe('The supplier name as it appears on the invoice'),
      address: z.string().nullable().describe('The supplier address from the invoice'),
      phone: z.string().nullable().describe('The supplier phone number from the invoice'),
      email: z.string().nullable().describe('The supplier email address from the invoice'),
      taxId: z.string().nullable().describe('The supplier tax ID or EIN from the invoice'),
      website: z.string().nullable().describe('The supplier website from the invoice'),
      industry: z.string().nullable().describe('The supplier industry or business type if identifiable'),
      contactPerson: z.string().nullable().describe('The contact person name if mentioned on the invoice'),
      memo: z.string().nullable().describe('A terse 1-sentence summary of what the invoice is for (e.g., "Office supplies for Q1 2024", "Legal consulting services", "Monthly software subscription"). Do not prepend PO, account, job, customer ID, or service period identifiers — those are applied after extraction. Do not use pipe |, greater-than, less-than, or # labels in this sentence.')
    }).describe('All supplier information extracted from the invoice document'),

    resolvedSupplier: z.object({
      workdayId: z.string().nullable().describe('The unique Workday identifier (WID) of the supplier'),
      supplierName: z.string().describe('The name of the supplier as it appears in Workday'),
      confidence: z.number().min(0).max(1).describe('Confidence score between 0 and 1 for this match'),
      reason: z.string().describe('Detailed explanation of why this supplier was selected as the best match')
    }).nullable().describe('The supplier found in Workday. Populated when status is "found", "ambiguous", or "different". When status is "matching", populate this with the existing supplier details.'),

    potentialDuplicateSuppliers: z.array(z.object({
      workdayId: z.string().describe('The unique Workday identifier (WID) of the potential duplicate supplier'),
      supplierId: z.string().describe('The human-readable Supplier ID of the potential duplicate supplier'),
      supplierName: z.string().describe('The name of the potential duplicate supplier'),
      confidence: z.number().min(0).max(1).describe('Confidence score for this potential match'),
      reason: z.string().describe('Explanation of why this supplier is a potential match')
    })).nullable().describe('List of potential duplicate suppliers. Only populated when status is "ambiguous"'),

    recommendation: z.object({
      action: z.enum(['update_invoice', 'register_supplier', 'manual_review', 'no_action']).describe('The recommended action to take'),
      reason: z.string().describe('Detailed explanation of why this action is recommended')
    }).describe('The recommended next action based on the analysis results'),

    reason: z.string().describe('Detailed explanation of the supplier analysis decision')
  }).describe('Supplier identification or verification results'),

  companyVerification: z.object({
    status: z.enum(['matching', 'different', 'uncertain']).describe('Whether the extracted company info matches the existing company on the invoice'),
    confidence: z.number().min(0).max(1).describe('Confidence score between 0 and 1 for the company verification decision'),
    extractedInformation: z.object({
      companyName: z.string().nullable().describe('The company name as it appears on the invoice'),
      address: z.string().nullable().describe('The company address from the invoice'),
      phone: z.string().nullable().describe('The company phone number from the invoice'),
      email: z.string().nullable().describe('The company email address from the invoice')
    }).describe('All company (buyer/recipient) information extracted from the invoice document'),
    recommended: z.object({
      workdayId: z.string().nullable().describe('The unique Workday identifier (WID) of the recommended company'),
      companyName: z.string().describe('The name of the company as it appears in Workday'),
      confidence: z.number().min(0).max(1).describe('Confidence score between 0 and 1 for this match'),
      reason: z.string().describe('Detailed explanation of why this company is recommended instead')
    }).nullable().describe('The recommended correct company from Workday. Only populated when status is "different"'),
    reason: z.string().describe('Detailed explanation of why the company is considered matching, different, or uncertain')
  }).describe('Company verification results'),

  emailSummary: z.string().nullable().describe('A 1-4 sentence summary of the inbound email content if email context was provided. Should capture the key information from the email (sender intent, any supplier references, invoice context). Null if no email context was provided.'),

  extractedInvoiceDate: z.string().nullable().describe('The invoice date as shown on the document, normalized to YYYY-MM-DD. Only include this if the document clearly provides an invoice date you can read confidently. Null if no invoice date is visible or the date is ambiguous.'),

  extractedAmountDue: z.string().nullable().describe('The amount due or invoice total as read from the invoice attachment. Null if no amount could be found. The amount may be found by either a total amount, or a sum of the individual line items if a total is not explicitly stated. Should be returned as it appears on the invoice (e.g. "$8,573.40").'),

  extractedSuppliersInvoiceNumber: z.string().nullable().describe('The invoice number as it appears on the supplier\'s invoice document. Prefer letters, digits, hyphen, period, and slash. Do not use pipe |, greater-than, or less-than characters. Null if not visible or unclear.'),

  extractedFreightAmount: z.string().nullable().describe('The freight amount as read from the invoice attachment, it may also be labeled as "shipping", "handling", or "delivery" charges. Capture this here even if the invoice presents freight/shipping/handling as a line item — do NOT include those lines in extractedInvoiceLines. Null if no freight amount could be found or if it is ambiguous.'),

  extractedTaxAmount: z.string().nullable().describe('The tax amount as read from the invoice attachment, it may also be labeled as "VAT", "GST", "sales tax", or "HST". Capture this here even if the invoice presents the tax as a line item — do NOT include tax lines in extractedInvoiceLines. Null if no tax amount could be found or if it is ambiguous.'),

  extractedPurchaseOrderNumber: z.string().nullable().describe('The purchase order number as it appears on the supplier\'s invoice document. It may be labeled as "PO Number", "Purchase Order Number", "PO#", or prefixed with "PO-". Null if not visible or unclear. Do not use a free-text PO column value that is not a purchase order number (e.g. "PGA COACHING").'),

  extractedAccountNumber: z.string().nullable().describe('PGA\'s customer/sold-to account number at this supplier. Labels include "Account Number", "Account #", "Acct #", "AC #", "Customer Account", and "Sold To Number" when that sold-to value is the billed-account id. Null if not visible. Do NOT use bank, routing, ABA, ACH, or wire remittance account numbers (for example an Account Number next to an ABA Number in a FOR ELECTRONIC PAYMENTS block). Do not use GL, cost center, company code, or the supplier invoice number.'),

  extractedJobNumber: z.string().nullable().describe('Job or order number from the invoice. Labels include "Job #", "Job Number", "Job No", "Order #", and "Order Number". Order # is the same as Job #. Null if not visible. Do not use an unlabeled Project / PRJ value as the job number.'),

  extractedCustomerId: z.string().nullable().describe('Customer ID from the invoice. Labels include "Customer ID", "Bill-To Customer ID", "Customer #", and "Cust ID". Null if not visible. Distinct from account number: if the same value was already captured as extractedAccountNumber, leave this null.'),

  extractedServicePeriod: z.string().nullable().describe('Billing or service period as shown on the document, including inside a line description (e.g. "Service Period: 2026 - September"). Also "Billing Period", "Period Covered", or From/To date ranges. Keep the document wording; do not invent dates. Null if not visible.'),

  extractedPaymentTerms: z.object({
    name: z.string().describe('The payment terms as they appear on the invoice document (e.g. "Net 30", "Net 60")'),
    workdayId: z.string().nullable().describe('The Payment_Terms_ID from Workday after matching via the findPaymentTerms tool. Null if no match found.')
  }).nullable().describe('Payment terms extracted from the invoice and resolved to a Workday ID via findPaymentTerms. Null if no payment terms are visible on the document.'),

  extractedInvoiceLines: z.array(z.object({
    description: z.string().describe('Line item description as it appears on the invoice'),
    quantity: z.number().nullable().describe('Quantity for the line item. Null if not stated.'),
    unitCost: z.string().nullable().describe('Unit cost for the line item as it appears on the invoice. Null if not stated.'),
    totalPrice: z.string().nullable().describe('Total/extended price for the line item as it appears on the invoice. Null if not stated.'),
    hasDiscount: z.boolean().nullable().describe('True if the invoice document shows an explicit discount applied to this line item — e.g. a discount percentage, a discount amount, or a discount notation is visible on the line. Do NOT infer from math; only set true if there is a visible discount indicator on the invoice. Null if not determinable.')
  })).nullable().describe('Line items extracted from the invoice document. Do NOT include freight, shipping, handling, delivery, or tax lines — those belong in extractedFreightAmount / extractedTaxAmount. Null if no line items could be extracted.'),

  emailWorktags: z.object({
    event: z.object({
      extracted: z.string().nullable().describe('The event name or description as mentioned in the email'),
      workdayId: z.string().nullable().describe('The workdayId from the top result returned by findEvents (a WID used to reference the event in Workday). Populate after calling findEvents.'),
    }).nullable().describe('Event worktag resolved from email content. Null if no event was mentioned.'),
    lineOfBusiness: z.object({
      extracted: z.string().nullable().describe('The line of business name or reference as mentioned in the email'),
      referenceId: z.string().nullable().describe('The referenceId from the matched LOB in Workday (used as Organization_Reference_ID). Populate after calling findLobs.'),
    }).nullable().describe('Line of business worktag resolved from email content. Null if no LOB was mentioned.'),
    fund: z.object({
      extracted: z.string().nullable().describe('The fund name or reference as mentioned in the email'),
      referenceId: z.string().nullable().describe('The referenceId from the matched fund in Workday (used as Fund_ID). Populate after calling findFunds.'),
    }).nullable().describe('Fund worktag resolved from email content. Null if no fund was mentioned.'),
    costCenter: z.object({
      extracted: z.string().nullable().describe('The cost center code or name as mentioned in the email'),
      name: z.string().nullable().describe('The matched cost center name from Workday. Populate after calling findCostCenters.'),
      code: z.string().nullable().describe('The Cost_Center_Reference_ID from the matched cost center in Workday (e.g. "72200"). Populate after calling findCostCenters.'),
    }).nullable().describe('Cost center worktag resolved from email content. Null if no cost center was mentioned.'),
    spendCategory: z.object({
      extracted: z.string().nullable().describe('The spend category name or reference as mentioned in the email'),
      name: z.string().nullable().describe('The matched spend category name from Workday. Populate after calling findSpendCategories.'),
      referenceId: z.string().nullable().describe('The referenceId from the matched spend category in Workday. Populate after calling findSpendCategories.'),
    }).nullable().describe('Spend category worktag resolved from email content. Null if no spend category was mentioned.'),
    company: z.object({
      extracted: z.string().nullable().describe('The company name or Company_Reference_ID as mentioned in the email coding'),
      name: z.string().nullable().describe('The matched company name from Workday. Populate after resolveReferenceCode or findCompanies.'),
      workdayId: z.string().nullable().describe('The Workday WID of the matched company. Populate from resolveReferenceCode or findCompanies metadata.'),
      referenceId: z.string().nullable().describe('The Company_Reference_ID of the matched company (e.g. "912"). Populate from resolveReferenceCode or findCompanies metadata.'),
    }).nullable().describe('Company resolved from email coding. Null if the email did not identify a company. This is the invoice header company, not a line worktag.'),
  }).nullable().describe('Worktags extracted from email content and resolved via RAG lookup. Null if no email context was provided or no worktags were found.'),

});

export type InvoiceEnrichmentResult = z.infer<typeof InvoiceEnrichmentSchema>;

export const invoiceEnrichmentPrompt = `You are an expert at matching invoices to suppliers and verifying company information in a Workday system. Your task is to analyze an invoice, identify or verify the supplier, and verify the company assignment.

You have access to nine search tools:
- **findSuppliers**: Search our supplier database using semantic similarity to find relevant suppliers.
- **findCompanies**: Search our company database using semantic similarity to find relevant companies (the buyer/recipient entity on the invoice). Call it with the billed company name or Company_Reference_ID only — never concatenate street, city, state, or ZIP into the query.
- **findPaymentTerms**: Search our payment terms database to match payment terms from the invoice against Workday payment terms.
- **findCostCenters**: Search our cost center database by name or code to look up available cost centers in Workday.
- **findEvents**: Search our events database by name to look up events (tournaments, championships, conferences) in Workday.
- **findLobs**: Search our lines of business database by name or reference to look up LOBs in Workday.
- **findFunds**: Search our funds database by reference ID or name to look up funds in Workday.
- **findSpendCategories**: Search our spend categories database by name or reference to look up spend categories in Workday.
- **resolveReferenceCode**: Look up a short code (e.g. "912", "72200") across cached companies, cost centers, funds, LOBs, and spend categories. Exact metadata matches win; otherwise use \`topMatch.type\` as the object-type hint. Do not copy an inexact match (confidence below 1.0) into company workdayId or referenceId. Use this before assuming a bare number is a cost center.

The invoice may include attachment files (PDFs, images, etc.) with presigned URLs that you can access to analyze the document content. These attachments often contain crucial information like supplier details, company logos, or additional context.

---

## Part 1: Supplier Analysis

Your supplier task depends on whether an existing supplier is already assigned to the invoice:

### If NO existing supplier is assigned — Identify the supplier:

1. **Extract Information**: Extract all available supplier information from the invoice and attachments, including:
   - Supplier contact details (name, address, phone, email)
   - A terse 1-sentence memo summarizing what the invoice is for (e.g., "Office supplies for Q1 2024"). If not clear, leave the memo empty. Do not prepend PO, account, job, customer ID, or service period identifiers — those are applied after extraction.
2. **Search Workday**: Use the findSuppliers tool to search for matching suppliers
3. **Analyze Results**: Determine the best match and identify any potential duplicates
4. **Make Recommendation**: Suggest the appropriate action based on your findings

**Identification Status Guidelines:**
- **status: "found"** — Exactly one high-confidence match (confidence > 0.8)
- **status: "ambiguous"** — Multiple potential matches that are reasonably close in confidence (e.g., two suppliers both scoring 0.75+)
- **status: "not_found"** — No suppliers match the invoice information
- **status: "error"** — Error in processing

**Identification Confidence Score Guidelines:**
- **0.95-1.0**: Exact match on company name + exact match on 2+ contact fields (address, phone, email)
- **0.85-0.94**: Exact match on company name + exact match on 1 contact field
- **0.75-0.84**: Very similar company name (minor variations) + at least 1 matching contact field
- **0.65-0.74**: Similar company name + partial address/location match
- **0.50-0.64**: Company name similarity only, no other matching fields
- **Below 0.50**: Weak or speculative match

**Key principle**: Multiple matching data points should yield HIGH confidence. If you match on company name + phone + address, confidence should be 0.9+, not 0.7.

**Duplicate Detection Criteria:**

Only include suppliers in \`potentialDuplicateSuppliers\` if they meet STRICT similarity criteria:

**Strong Potential Duplicates (confidence 0.8-1.0):**
- Exact or very similar company name (e.g., "ABC Corp" vs "ABC Corporation") + matching contact field(s)
- Same phone number or email + similar company name
- Same exact address + similar company name

**Moderate Potential Duplicates (confidence 0.65-0.79):**
- Similar company name with minor variations (e.g., "ABC Inc" vs "ABC LLC") + same city/state
- Similar name + partial address match (same street or zip code)

**DO NOT include matches based solely on:**
- Same business type/industry without name similarity
- Same state without other matching criteria
- Generic business categories (e.g., "golf club" vs "country club" without name similarity)
- Low confidence matches (< 0.65)

### If an existing supplier IS assigned — Verify the supplier:

1. **Extract Information**: Extract all available supplier information from the invoice and attachments, including a terse 1-sentence memo. Do not prepend PO, account, job, customer ID, or service period identifiers — those are applied after extraction.
2. **Compare with Existing Supplier**: Compare the extracted information with the existing supplier already assigned to the invoice
3. **Search Workday**: If the extracted info doesn't match, use the findSuppliers tool to find the correct supplier
4. **Make Determination**: Decide if the current supplier is correct or needs revision

**Verification Status Guidelines:**
- **status: "matching"** — The extracted supplier information matches the existing supplier. Minor variations in formatting (e.g., "ABC Corp" vs "ABC Corporation", slight address formatting differences) should be considered matching. Populate \`resolvedSupplier\` with the existing supplier details.
- **status: "different"** — The extracted supplier information is CONFIDENTLY different from the existing supplier. Only use this when the company name is clearly different, you found a better match in Workday with high confidence (> 0.8), and the evidence strongly supports a different supplier.
- **status: "uncertain"** — The invoice content is unclear or ambiguous, you cannot confidently determine correctness, or extracted information is too limited.

**Verification Confidence Score Guidelines:**
- **0.9-1.0**: Very confident — clear evidence supports the decision
- **0.75-0.89**: Confident — strong evidence supports the decision
- **0.5-0.74**: Moderate confidence — some evidence but not conclusive
- **Below 0.5**: Low confidence — limited evidence, verification is uncertain

---

## Part 2: Company Verification

Always verify the company (buyer/recipient) assignment:

1. **Extract Company Information**: Extract the company (buyer/recipient) information from the invoice and attachments, including company name, address, phone, and email. The company is the entity that is being billed — NOT the supplier/vendor.
2. **Compare with Existing Company**: Compare the extracted company information with the existing company already assigned to the invoice.
3. **Search Workday**: If the extracted company info doesn't match the existing company, use the findCompanies tool with the billed company name or Company_Reference_ID only. Keep street, city, state, and ZIP in extractedInformation and compare them after you have name candidates — do not put the bill-to address in the search query.
4. **Email coding may identify the company**: AP coding emails often include a Company_Reference_ID (a short code such as "912") alongside cost center, event, LOB, and spend category lines. If a bare code appears in the email, call **resolveReferenceCode** before treating it as a cost center. Populate company workdayId and referenceId only from an exact match (confidence 1.0) or findCompanies. Recommend that company when it differs from the existing assignment.
5. **Purchase order context**: If a matching Workday purchase order is provided, treat its company as a strong billed-entity signal when email coding does not identify a company. Short-form names on the invoice (e.g. "PGA of America") that refer to the same organization as the PO company should be treated as matching. Prefer the PO company over a company guessed from the invoice PDF, including similarly named section, chapter, or affiliate companies. Still populate \`extractedPurchaseOrderNumber\` from the document.
6. **Make Determination**: Decide if the current company assignment is correct or needs revision, using the same confidence/status guidelines as supplier verification. Email-coded company IDs take priority over the purchase order company and over guessing from the invoice PDF.

---

## Important Guidelines:

- **Always extract supplier information** from the invoice, including the memo (description only; identifiers are applied in code)
- **Always extract company information** (the buyer/recipient) from the invoice when available
- **Use the findSuppliers tool** to search for potential supplier matches
- **Use the findCompanies tool** when you suspect the company might be different. Search by billed name or ID only; never concatenate the bill-to address into the query.
- **Analyze attachments** thoroughly for supplier and company information
- **Consider multiple factors**: company name, address, phone, email, industry context
- **Be conservative with confidence scores** — only use "found" for high-confidence matches, only use "different" when you're confident AND have found a better match
- **Minor variations are acceptable**: "ABC Corp" vs "ABC Corporation" should be considered matching
- **Provide clear reasoning** for all decisions
- **Omit fields with no data**: In extracted information objects, only include fields where you actually found data. Do NOT include fields with null values — simply omit them from the response
- **Exclusively use plain text in the notes field** — do not use markdown formatting, emojis, or special characters. The notes should be a terse summary of the analysis findings.

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

Read the invoice attachment and extract the freight amount. It may be labeled as "Freight", "Shipping", "Handling", "Shipping & Handling", "Delivery", or similar. Populate \`extractedFreightAmount\` with this value (e.g. "$150.00"). If the invoice presents freight/shipping/handling as a line item rather than a summary field, still capture it here — do NOT include it in \`extractedInvoiceLines\`. If no freight amount can be found or if it is ambiguous, omit the field.

---

## Part 5.5: Tax Amount

Read the invoice attachment and extract the tax amount. It may be labeled as "Tax", "VAT", "GST", "HST", "Sales Tax", or similar. Populate \`extractedTaxAmount\` with this value (e.g. "$45.00"). If the invoice presents the tax as a line item rather than a summary field, still capture it here — do NOT include it in \`extractedInvoiceLines\`. If no tax amount can be found or if it is ambiguous, omit the field.

---

## Part 6: Supplier's Invoice Number

Read the invoice attachment and extract the supplier's invoice number as it appears on the document. Populate \`extractedSuppliersInvoiceNumber\`. Prefer letters, digits, hyphen, period, and slash. Do not use pipe \`|\`, \`>\`, or \`<\`. If no invoice number is visible or the value is ambiguous, omit the field.

---

## Part 7: Purchase Order Number

Read the invoice attachment and extract the purchase order number if one is referenced. It may be labeled as "PO Number", "Purchase Order Number", "PO#", or prefixed with "PO-". Populate \`extractedPurchaseOrderNumber\` with the value as it appears on the document. If no PO number is visible or the value is ambiguous, omit the field. Do not treat a non-numeric PO column (e.g. "PGA COACHING") as a purchase order number.

---

## Part 7.5: Memo identifiers

Extract these identifiers independently when they appear on the invoice or in a line description. Omit a field when it is not on the document. Code joins values with a period, in check-print order (account, customer ID, job/order, PO, service period, then the memo sentence). Do not copy these identifiers into \`extractedInformation.memo\`, and do not use pipe \`|\` or \`#\` labels there.

1. **Account number** (\`extractedAccountNumber\`): PGA's customer/sold-to account at this supplier. Labels: "Account Number", "Account #", "Acct #", "AC #", "Customer Account", "Sold To Number" (when that sold-to value is the billed-account id, as on Topgolf). If "Account Number" sits next to ABA/routing in an electronic payments, remit-to, ACH, or wire block, skip it — that is a bank account (Cushman pattern). Never use GL, cost center, company code, or the supplier invoice number.

2. **Job number** (\`extractedJobNumber\`): "Job #", "Job Number", "Job No", **"Order #" / "Order Number"** (Order # is the same as Job #). Do not use an unlabeled Project / PRJ value as the job number. If Order # / Job # is the same PGA PO already extracted (\`PO-\` + 6 word chars), leave job number null.

3. **Customer ID** (\`extractedCustomerId\`): "Customer ID", **"Bill-To Customer ID"**, "Customer #", "Cust ID". If this value is the same as \`extractedAccountNumber\`, leave customer ID null and keep the account number.

4. **Service period** (\`extractedServicePeriod\`): billing/service window as shown, including inside a line description (e.g. "Service Period: 2026 - September"). Also "Billing Period", "Period Covered", or From/To. Keep the document wording; do not invent dates.

---

## Part 8: Payment Terms

If payment terms are visible on the invoice (e.g. "Net 30", "Net 60", "Due on Receipt"):

1. Extract the payment terms text as it appears on the document.
2. Use the **findPaymentTerms** tool to find the best matching Workday payment terms entry.
3. Populate \`extractedPaymentTerms\` with the extracted name and the resolved \`workdayId\` (the Payment_Terms_ID from the best match). If no match is found via the tool, set \`workdayId\` to null.

If no payment terms are visible on the document, omit \`extractedPaymentTerms\` entirely.

---

## Part 9: Invoice Lines

Extract the individual line items from the invoice document:

1. For each line item, extract:
   - **Description**: The item description or service name as it appears on the invoice
   - **Quantity**: The quantity ordered/delivered (if stated)
   - **Unit Cost**: The price per unit (if stated)
   - **Total Price**: The total/extended price for the line (if stated)

Exclude any lines that represent tax charges (e.g. "VAT", "GST", "HST", "Sales Tax") — capture those in \`extractedTaxAmount\` instead.
Exclude any lines that represent freight, shipping, handling, or delivery charges — capture those in \`extractedFreightAmount\` instead.

Populate \`extractedInvoiceLines\` with all remaining line items found. If no line items can be extracted, omit the field.

---

## Part 10: Email Worktag Extraction

If email context is provided, scan the email body for any contextual mentions of companies, cost centers, events, lines of business (LOBs), funds, or spend categories that could be suggested as invoice coding. These are suggestions — you do not need strict prefixes or labels, just reasonable signals from the email content. Line worktags take priority over any worktags derived from the purchase order — PO values are used only as a fallback when email worktags are absent. A company code in the email selects the invoice header company; it is not a line worktag.

**CRITICAL**: The "extracted" field is the only field that should contain text from the email. All other fields (codes, referenceIds, names used as IDs) MUST come from the find tool or resolveReferenceCode results. Never write an email string directly into an ID field. If lookup returns no results, set the ID field to null.

0. **Bare codes**: If the email contains a short standalone code (digits like "912" or "72200", or a prefixed ID), call **resolveReferenceCode** with that code first. Use \`topMatch.type\` (highest-confidence object) to decide whether it is a company, cost center, fund, LOB, or spend category. Exact metadata hits are confidence 1.0. If there is no exact hit, use the ranked similar match as a type hint only — do not copy its workdayId or referenceId into emailWorktags.company. Do not default numeric codes to cost center.

1. **Cost Centers**: Look for any mention of a cost center, department, or team that might correspond to a Workday cost center — whether prefaced with "CC:", "cost center:", or referenced contextually (e.g., "charge this to Marketing", "72200"). If found:
   - Call **findCostCenters** with the cost center name or code to resolve it in Workday
   - Populate emailWorktags.costCenter.extracted with what you found in the email
   - Populate emailWorktags.costCenter.name with the matched cost center name from the top result's metadata
   - Populate emailWorktags.costCenter.code with the matched cost center's code (Cost_Center_Reference_ID) from the top result's metadata
   - If no match is found, set emailWorktags.costCenter.name and emailWorktags.costCenter.code to null

2. **Events**: Look for any mention of an event, occasion, tournament, conference, or activity that might correspond to a Workday event (e.g., "2026 PGA Championship", "Q3 Sales Summit"). You do not need an explicit "Event:" label — use context to infer whether something is likely a Workday event. If found:
   - Call **findEvents** with the event name to resolve it in Workday
   - Populate emailWorktags.event.extracted with what you found in the email
   - Populate emailWorktags.event.workdayId with the workdayId from the top result (this WID is used to reference the event in Workday)
   - If no match is found, set emailWorktags.event.workdayId to null

3. **Lines of Business**: Look for any mention of a line of business, business unit, or LOB — whether explicit (e.g., "Golf LOB") or contextual (e.g., the email concerns golf-related services). If found:
   - Call **findLobs** with the LOB name to resolve it in Workday
   - Populate emailWorktags.lineOfBusiness.extracted with what you found in the email
   - Populate emailWorktags.lineOfBusiness.referenceId with the matched LOB's referenceId from the top result's metadata (this is the value used as the Organization_Reference_ID worktag)
   - If no match is found, set emailWorktags.lineOfBusiness.referenceId to null

4. **Funds**: Look for any mention of a fund, fund code, or funding source — whether labeled explicitly (e.g., "FD-001") or referenced contextually (e.g., "Operating Fund"). If found:
   - Call **findFunds** with the fund name or reference to resolve it in Workday
   - Populate emailWorktags.fund.extracted with what you found in the email
   - Populate emailWorktags.fund.referenceId with the matched fund's referenceId from the top result's metadata (this is the value used as the Fund_ID worktag)
   - If no match is found, set emailWorktags.fund.referenceId to null

5. **Spend Categories**: Look for any mention of a category of expense or type of spend — whether prefaced with "SC:", "spend category:", "spend cat:", or referenced in any other form (e.g., "SC - Advertising and Promotion", "this is for office supplies"). If found:
   - Call **findSpendCategories** with the spend category name or reference to resolve it in Workday
   - Populate emailWorktags.spendCategory.extracted with what you found in the email
   - Populate emailWorktags.spendCategory.name with the matched spend category name from the top result's metadata
   - Populate emailWorktags.spendCategory.referenceId with the matched spend category's referenceId from the top result's metadata
   - If no match is found, set emailWorktags.spendCategory.name and emailWorktags.spendCategory.referenceId to null

6. **Company**: Look for a company name or Company_Reference_ID in the coding email. A bare numeric code at the start of a coding block is often the company, not a cost center. If found:
   - Call **resolveReferenceCode** (preferred for short codes) or **findCompanies**
   - Populate emailWorktags.company.extracted with what you found in the email
   - Populate emailWorktags.company.name, workdayId, and referenceId only from an exact resolveReferenceCode match (confidence 1.0) or from findCompanies. If topMatch is similar but not exact, leave workdayId and referenceId null
   - If no match is found, set emailWorktags.company.name, workdayId, and referenceId to null
   - If the resolved company differs from the existing company assignment, also recommend it in companyVerification

7. If no email context is provided, or none of the above were mentioned, omit emailWorktags entirely.

---

## Email Context:

If email context is provided (emailFrom, subject, plainTextBody), you should:
1. **Use the email as additional context** for supplier identification/verification — the sender email domain or content may help
2. **Generate an emailSummary** (1-4 sentences) that captures the key information from the email, including:
   - Who sent it and why
   - Any references to the supplier, invoice, or transaction
   - Relevant context that would help AP staff understand the invoice
3. Look for content in the email that refers to invoice coding, including company, and try to extract that information. Use resolveReferenceCode for short codes.
4. If no email context is provided, omit the emailSummary field entirely

Remember: The goal is to help AP staff make informed decisions about supplier identification, verification, and company assignment.`;
