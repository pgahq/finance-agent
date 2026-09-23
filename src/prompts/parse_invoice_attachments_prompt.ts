import { z } from 'zod';

export const InvoiceAttachmentKindSchema = z.enum(['supplier_invoice', 'supporting', 'unrelated']);
export type InvoiceAttachmentKind = z.infer<typeof InvoiceAttachmentKindSchema>;

export const SupportingDocumentKindSchema = z.enum([
  'packing_slip',
  'w9',
  'statement',
  'terms',
  'correspondence',
  'other',
]);
export type SupportingDocumentKind = z.infer<typeof SupportingDocumentKindSchema>;

export const ParsedInvoiceAttachmentSchema = z.object({
  fileNumber: z.number().int().describe('The number of this file in the input list (1-based). File names can repeat, so this is the join key.'),
  fileName: z.string().describe('fileName from the input list, copied exactly.'),
  kind: InvoiceAttachmentKindSchema.describe(
    'supplier_invoice: demands payment with an invoice number and total. supporting: belongs alongside an invoice but is not itself an invoice (packing slip, W-9, statement, contract, email, shipping confirmation). unrelated: belongs to a different transaction or is not AP backup at all.'
  ),
  supportingKind: SupportingDocumentKindSchema.nullable().describe('Only when kind is supporting. Null otherwise.'),
  supplierName: z.string().nullable().describe('Supplier/vendor name as shown on this document. Null if not visible.'),
  invoiceNumber: z.string().nullable().describe('Supplier invoice number as shown on this document. Null if not visible or ambiguous.'),
  purchaseOrderNumber: z.string().nullable().describe('Purchase order number as shown on this document. Null if not visible.'),
  invoiceDate: z.string().nullable().describe('Invoice/document date as shown, normalized to YYYY-MM-DD when readable. Null if not visible.'),
  amountDue: z.string().nullable().describe('Total/amount due as shown on this document. Null if not visible.'),
  confidence: z.number().min(0).max(1).describe('Confidence in kind for this document.'),
  reason: z.string().describe('One sentence explaining the kind decision.'),
});

export type ParsedInvoiceAttachmentResult = z.infer<typeof ParsedInvoiceAttachmentSchema>;

export const InvoiceAttachmentParseSchema = z.object({
  documents: z.array(ParsedInvoiceAttachmentSchema).describe('One entry per input file, in input order.'),
});

export type InvoiceAttachmentParseResult = z.infer<typeof InvoiceAttachmentParseSchema>;

export const parseInvoiceAttachmentsPrompt = `You classify AP email attachments before supplier-invoice processing. Each input file is a PDF sent to AP — some are invoices, some are backup for an invoice, some belong to a different transaction.

For every file, return kind:

- supplier_invoice: the document demands payment and reads as a bill — it has an invoice number and an amount due/total (labels like Invoice, Invoice Number, Amount Due, Total Due, Balance Due). Credit memos that carry an invoice-style number and total also count as supplier_invoice.
- supporting: backup that belongs alongside an invoice but is not itself a bill — packing slip, delivery receipt, W-9, account statement, contract or terms, quote, shipping confirmation, or correspondence about the invoice. It may reference an invoice number, PO, supplier, or amount. Set supportingKind to the closest value.
- unrelated: not AP backup for any invoice in this batch — a different transaction, marketing, or a file you cannot relate to an invoice.

Also extract clustering keys from each document as shown: supplierName, invoiceNumber, purchaseOrderNumber, invoiceDate (YYYY-MM-DD when readable), amountDue. Use null when a key is not on the document — do not copy keys across files.

Rules:
- Classify each file from its own content only.
- Return exactly one entry per input file. Set fileNumber to that file's number in the input list; two files may share a name (for example a corrected resend), so never merge entries by name.
- Packing slips, W-9s, statements, quotes, contracts, and shipping confirmations are supporting, never supplier_invoice — even when they show an order number or amount.
- A file is unrelated only when it has no invoice number, PO, supplier, or amount linking it to an invoice in this batch.
- Confidence below 0.5 means the kind is a guess — still pick the best kind and say why in reason.`;
