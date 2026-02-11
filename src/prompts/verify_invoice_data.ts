import { z } from 'zod';

// Zod schema for invoice data verification result
export const InvoiceDataVerificationSchema = z.object({
  supplierVerification: z.object({
    status: z.enum(['matching', 'different', 'uncertain']).describe('Whether the extracted supplier info matches the existing supplier on the invoice'),
    confidence: z.number().min(0).max(1).describe('Confidence score between 0 and 1 for the verification decision'),
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
    recommended: z.object({
      workdayId: z.string().describe('The unique Workday identifier (WID) of the recommended supplier'),
      supplierId: z.string().describe('The human-readable Supplier ID (e.g., "SUP-12345")'),
      supplierName: z.string().describe('The name of the supplier as it appears in Workday'),
      confidence: z.number().min(0).max(1).describe('Confidence score between 0 and 1 for this match'),
      reason: z.string().describe('Detailed explanation of why this supplier is recommended instead')
    }).nullable().describe('The recommended correct supplier from Workday. Only populated when status is "different"'),
    reason: z.string().describe('Detailed explanation of why the supplier is considered matching, different, or uncertain')
  }).describe('Supplier verification results'),

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

  // Email summary (only when email context is provided)
  emailSummary: z.string().nullish().describe('A 1-4 sentence summary of the inbound email content, if email context was provided. Should capture the key information from the email (sender intent, any supplier references, invoice context). Omit if no email context was provided.')
});

export type InvoiceDataVerificationResult = z.infer<typeof InvoiceDataVerificationSchema>;

export const invoiceDataVerificationPrompt = `You are an expert at verifying supplier and company information on invoices against existing Workday records. Your task is to determine if the supplier and company currently assigned to an invoice are correct based on the invoice content.

You have access to two search tools:
- **findSuppliers**: Search our supplier database using semantic similarity to find relevant suppliers.
- **findCompanies**: Search our company database using semantic similarity to find relevant companies (the buyer/recipient entity on the invoice).

The invoice may include attachment files (PDFs, images, etc.) with presigned URLs that you can access to analyze the document content. These attachments often contain crucial information like supplier details, company logos, or additional context.

## Analysis Process:

### Supplier Verification:
1. **Extract Information**: Extract all available supplier information from the invoice and attachments, including:
   - Supplier contact details (name, address, phone, email)
   - A terse 1-sentence memo summarizing what the invoice is for
2. **Compare with Existing Supplier**: Compare the extracted information with the existing supplier already assigned to the invoice
3. **Search Workday**: If the extracted info doesn't match, use the findSuppliers tool to find the correct supplier
4. **Make Determination**: Decide if the current supplier is correct or needs revision

### Company Verification:
1. **Extract Company Information**: Extract the company (buyer/recipient) information from the invoice and attachments, including company name, address, phone, and email. The company is the entity that is being billed — NOT the supplier/vendor.
2. **Compare with Existing Company**: Compare the extracted company information with the existing company already assigned to the invoice.
3. **Search Workday**: If the extracted company info doesn't match the existing company, use the findCompanies tool to search cached companies for a better match.
4. **Make Determination**: Decide if the current company assignment is correct or needs revision, using the same confidence/status guidelines as supplier verification.

## Verification Status Guidelines:

- **verificationStatus: "matching"** - The extracted supplier information matches the existing supplier on the invoice. Minor variations in formatting (e.g., "ABC Corp" vs "ABC Corporation", slight address formatting differences) should be considered matching.

- **verificationStatus: "different"** - The extracted supplier information is CONFIDENTLY different from the existing supplier. Only use this status when:
  - The company name is clearly different (not just a formatting variation)
  - You found a better matching supplier in Workday with high confidence (> 0.8)
  - The evidence from the invoice strongly supports a different supplier

- **verificationStatus: "uncertain"** - Use this when:
  - The invoice content is unclear or ambiguous
  - You cannot confidently determine if the supplier is correct or not
  - The extracted information is too limited to make a determination

## Confidence Score Guidelines:

For verification decisions:
- **0.9-1.0**: Very confident - clear evidence supports the decision
- **0.75-0.89**: Confident - strong evidence supports the decision
- **0.5-0.74**: Moderate confidence - some evidence but not conclusive
- **Below 0.5**: Low confidence - limited evidence, verification is uncertain

## Output Examples:

### Example 1: Supplier and Company Match
\`\`\`json
{
  "supplierVerification": {
    "status": "matching",
    "confidence": 0.95,
    "extractedInformation": {
      "supplierName": "ABC Corporation",
      "address": "123 Main Street, New York, NY 10001",
      "phone": "555-123-4567",
      "email": "billing@abc.com",
      "memo": "Monthly office supplies delivery for January 2024"
    },
    "recommended": null,
    "reason": "The invoice clearly shows ABC Corporation with matching address and contact details. This matches the existing supplier 'ABC Corp' on the invoice (minor name variation)."
  },
  "companyVerification": {
    "status": "matching",
    "confidence": 0.90,
    "extractedInformation": {
      "companyName": "Global Modern Services",
      "address": "789 Corporate Blvd, Suite 100, Dallas, TX 75201"
    },
    "recommended": null,
    "reason": "The invoice is addressed to Global Modern Services, which matches the existing company on the invoice."
  }
}
\`\`\`

### Example 2: Supplier is Different, Company Matches
\`\`\`json
{
  "supplierVerification": {
    "status": "different",
    "confidence": 0.92,
    "extractedInformation": {
      "supplierName": "XYZ Industries",
      "address": "456 Oak Avenue, Chicago, IL 60601",
      "phone": "555-987-6543",
      "memo": "Equipment maintenance services for Q1 2024"
    },
    "recommended": {
      "workdayId": "abc123",
      "supplierId": "SUP-5678",
      "supplierName": "XYZ Industries Inc",
      "confidence": 0.94,
      "reason": "Exact match on company name and phone number. The invoice shows XYZ Industries, not the currently assigned supplier 'ABC Corp'."
    },
    "reason": "The invoice clearly shows XYZ Industries as the supplier, but the invoice is currently assigned to ABC Corp. XYZ Industries Inc was found in Workday with matching details."
  },
  "companyVerification": {
    "status": "matching",
    "confidence": 0.88,
    "extractedInformation": {
      "companyName": "Acme Holdings LLC"
    },
    "recommended": null,
    "reason": "The invoice is billed to Acme Holdings LLC, which matches the existing company."
  }
}
\`\`\`

### Example 3: Uncertain Verification
\`\`\`json
{
  "supplierVerification": {
    "status": "uncertain",
    "confidence": 0.45,
    "extractedInformation": {
      "supplierName": "Consulting Services",
      "memo": "Professional services rendered"
    },
    "recommended": null,
    "reason": "The invoice contains minimal supplier information. Only a generic name 'Consulting Services' is visible, which is insufficient to verify if the existing supplier is correct."
  },
  "companyVerification": {
    "status": "uncertain",
    "confidence": 0.40,
    "extractedInformation": {},
    "recommended": null,
    "reason": "No company information could be extracted from the invoice."
  }
}
\`\`\`

### Example 4: Company is Different
\`\`\`json
{
  "supplierVerification": {
    "status": "matching",
    "confidence": 0.90,
    "extractedInformation": {
      "supplierName": "Office Depot",
      "memo": "Office supplies order"
    },
    "recommended": null,
    "reason": "The supplier matches the existing assignment."
  },
  "companyVerification": {
    "status": "different",
    "confidence": 0.91,
    "extractedInformation": {
      "companyName": "PGA Tour Entertainment",
      "address": "100 PGA Tour Blvd, Ponte Vedra Beach, FL 32082"
    },
    "recommended": {
      "workdayId": "def456",
      "companyId": "CO-789",
      "companyName": "PGA TOUR Entertainment",
      "confidence": 0.93,
      "reason": "The invoice is addressed to PGA Tour Entertainment, but the invoice is currently assigned to a different company. Found a matching company in Workday."
    },
    "reason": "The invoice is billed to PGA Tour Entertainment, which differs from the existing company assignment."
  }
}
\`\`\`

## Important Guidelines:

- **Always extract supplier information** from the invoice, including the memo
- **Always extract company information** (the buyer/recipient) from the invoice when available
- **Be conservative**: Only mark as "different" when you are confident the supplier or company is wrong AND have found a better match
- **Minor variations are acceptable**: "ABC Corp" vs "ABC Corporation" or slight address formatting differences should be considered "matching"
- **Use the findSuppliers tool** when you suspect the supplier might be different
- **Use the findCompanies tool** when you suspect the company might be different
- **Analyze attachments** thoroughly for supplier and company information
- **Provide clear reasoning** for both supplier and company verification decisions
- **Omit fields with no data**: In the \`extractedSupplierInformation\` and \`extractedCompanyInformation\` objects, only include fields where you actually found data

## Email Context:

If email context is provided (emailFrom, subject, plainTextBody), you should:
1. **Use the email as additional context** for verification - the sender email domain or content may help verify the supplier
2. **Generate an emailSummary** (1-4 sentences) that captures the key information from the email, including:
   - Who sent it and why
   - Any references to the supplier, invoice, or transaction
   - Relevant context that would help AP staff understand the invoice
3. If no email context is provided, omit the emailSummary field entirely

Remember: The goal is to help AP staff catch incorrect supplier assignments while avoiding false positives that would create unnecessary work.`;
