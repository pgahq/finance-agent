import { z } from 'zod';

// Unified schema for invoice enrichment — handles both supplier identification and verification
export const InvoiceEnrichmentSchema = z.object({
  supplier: z.object({
    // Identification statuses: found, not_found, ambiguous, error
    // Verification statuses: matching, different, uncertain
    status: z.enum(['found', 'not_found', 'ambiguous', 'matching', 'different', 'uncertain', 'error']).describe('The result of supplier analysis. Use found/not_found/ambiguous/error when identifying a supplier (no existing supplier). Use matching/different/uncertain when verifying an existing supplier.'),
    confidence: z.number().min(0).max(1).describe('Confidence score between 0 and 1'),

    extractedInformation: z.object({
      supplierName: z.string().nullish().describe('The supplier name as it appears on the invoice'),
      address: z.string().nullish().describe('The supplier address from the invoice'),
      phone: z.string().nullish().describe('The supplier phone number from the invoice'),
      email: z.string().nullish().describe('The supplier email address from the invoice'),
      taxId: z.string().nullish().describe('The supplier tax ID or EIN from the invoice'),
      website: z.string().nullish().describe('The supplier website from the invoice'),
      industry: z.string().nullish().describe('The supplier industry or business type if identifiable'),
      contactPerson: z.string().nullish().describe('The contact person name if mentioned on the invoice'),
      memo: z.string().nullish().describe('A terse 1-sentence summary of what the invoice is for (e.g., "Office supplies for Q1 2024", "Legal consulting services", "Monthly software subscription")')
    }).describe('All supplier information extracted from the invoice document'),

    resolvedSupplier: z.object({
      workdayId: z.string().describe('The unique Workday identifier (WID) of the supplier'),
      supplierId: z.string().describe('The human-readable Supplier ID (e.g., "SUP-12345")'),
      supplierName: z.string().describe('The name of the supplier as it appears in Workday'),
      confidence: z.number().min(0).max(1).describe('Confidence score between 0 and 1 for this match'),
      reason: z.string().describe('Detailed explanation of why this supplier was selected as the best match')
    }).nullable().describe('The supplier found in Workday. Populated when status is "found", "ambiguous", or "different"'),

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
      companyName: z.string().nullish().describe('The company name as it appears on the invoice'),
      companyId: z.string().nullish().describe('The company ID if identifiable from the invoice'),
      address: z.string().nullish().describe('The company address from the invoice'),
      phone: z.string().nullish().describe('The company phone number from the invoice'),
      email: z.string().nullish().describe('The company email address from the invoice')
    }).describe('All company (buyer/recipient) information extracted from the invoice document'),
    recommended: z.object({
      workdayId: z.string().describe('The unique Workday identifier (WID) of the recommended company'),
      companyId: z.string().describe('The human-readable Company ID'),
      companyName: z.string().describe('The name of the company as it appears in Workday'),
      confidence: z.number().min(0).max(1).describe('Confidence score between 0 and 1 for this match'),
      reason: z.string().describe('Detailed explanation of why this company is recommended instead')
    }).nullable().describe('The recommended correct company from Workday. Only populated when status is "different"'),
    reason: z.string().describe('Detailed explanation of why the company is considered matching, different, or uncertain')
  }).describe('Company verification results'),

  emailSummary: z.string().nullish().describe('A 1-4 sentence summary of the inbound email content if email context was provided. Should capture the key information from the email (sender intent, any supplier references, invoice context). Omit if no email context was provided.')
});

export type InvoiceEnrichmentResult = z.infer<typeof InvoiceEnrichmentSchema>;

export const invoiceEnrichmentPrompt = `You are an expert at matching invoices to suppliers and verifying company information in a Workday system. Your task is to analyze an invoice, identify or verify the supplier, and verify the company assignment.

You have access to two search tools:
- **findSuppliers**: Search our supplier database using semantic similarity to find relevant suppliers.
- **findCompanies**: Search our company database using semantic similarity to find relevant companies (the buyer/recipient entity on the invoice).

The invoice may include attachment files (PDFs, images, etc.) with presigned URLs that you can access to analyze the document content. These attachments often contain crucial information like supplier details, company logos, or additional context.

---

## Part 1: Supplier Analysis

Your supplier task depends on whether an existing supplier is already assigned to the invoice:

### If NO existing supplier is assigned — Identify the supplier:

1. **Extract Information**: Extract all available supplier information from the invoice and attachments, including:
   - Supplier contact details (name, address, phone, email)
   - A terse 1-sentence memo summarizing what the invoice is for (e.g., "Office supplies for Q1 2024"). If not clear, leave the memo empty.
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

1. **Extract Information**: Extract all available supplier information from the invoice and attachments, including the memo
2. **Compare with Existing Supplier**: Compare the extracted information with the existing supplier already assigned to the invoice
3. **Search Workday**: If the extracted info doesn't match, use the findSuppliers tool to find the correct supplier
4. **Make Determination**: Decide if the current supplier is correct or needs revision

**Verification Status Guidelines:**
- **status: "matching"** — The extracted supplier information matches the existing supplier. Minor variations in formatting (e.g., "ABC Corp" vs "ABC Corporation", slight address formatting differences) should be considered matching.
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
3. **Search Workday**: If the extracted company info doesn't match the existing company, use the findCompanies tool to search for a better match.
4. **Make Determination**: Decide if the current company assignment is correct or needs revision, using the same confidence/status guidelines as supplier verification.

---

## Important Guidelines:

- **Always extract supplier information** from the invoice, including the memo
- **Always extract company information** (the buyer/recipient) from the invoice when available
- **Use the findSuppliers tool** to search for potential supplier matches
- **Use the findCompanies tool** when you suspect the company might be different
- **Analyze attachments** thoroughly for supplier and company information
- **Consider multiple factors**: company name, address, phone, email, industry context
- **Be conservative with confidence scores** — only use "found" for high-confidence matches, only use "different" when you're confident AND have found a better match
- **Minor variations are acceptable**: "ABC Corp" vs "ABC Corporation" should be considered matching
- **Provide clear reasoning** for all decisions
- **Omit fields with no data**: In extracted information objects, only include fields where you actually found data. Do NOT include fields with null values — simply omit them from the response

## Email Context:

If email context is provided (emailFrom, subject, plainTextBody), you should:
1. **Use the email as additional context** for supplier identification/verification — the sender email domain or content may help
2. **Generate an emailSummary** (1-4 sentences) that captures the key information from the email, including:
   - Who sent it and why
   - Any references to the supplier, invoice, or transaction
   - Relevant context that would help AP staff understand the invoice
3. If no email context is provided, omit the emailSummary field entirely

Remember: The goal is to help AP staff make informed decisions about supplier identification, verification, and company assignment.`;
