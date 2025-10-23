import { debug } from '@pga/logger';

// Document types
export type DocumentType = 'supplier' | 'invoice';

// Create embedding for text using OpenAI
export async function createEmbedding(text: string): Promise<number[]> {  
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'MISSING_KEY';
  
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI Embeddings API error: ${response.status} ${errorText}`);
  }

  const data = await response.json() as { data: Array<{ embedding: number[] }> };
  return data.data[0].embedding;
}

// Create document content for suppliers
export function createSupplierContent(supplier: any): string {
  const content = [
    `Company Name: ${supplier.supplierName}`,
    supplier.allPhoneNumbers?.length > 0 ? `Phone: ${supplier.allPhoneNumbers.join(', ')}` : null,
    supplier.allEmailAddresses?.length > 0 ? `Email: ${supplier.allEmailAddresses.join(', ')}` : null,
    supplier.allAddresses?.length > 0 ? `Address: ${supplier.allAddresses.join(', ')}` : null,
    `Status: ${supplier.supplierStatus}`
  ].filter(Boolean).join('\n');
  
  return content;
}

// Create document content for invoices
export function createInvoiceContent(invoice: any): string {
  const content = [
    `Invoice Number: ${invoice.invoiceNumber}`,
    `Company: ${invoice.companyName}`,
    invoice.supplierName ? `Supplier: ${invoice.supplierName}` : null,
    invoice.amount ? `Amount: $${invoice.amount}` : null,
    invoice.date ? `Date: ${invoice.date}` : null,
    invoice.description ? `Description: ${invoice.description}` : null
  ].filter(Boolean).join('\n');
  
  return content;
}

// Search for similar documents
export async function searchSimilarDocuments(
  query: string,
  documentType: DocumentType,
  _limit: number = 5
): Promise<any[]> {
  debug(`Searching for similar ${documentType} documents with query: ${query.substring(0, 100)}...`);
  
  // TODO: Implement database query with vector similarity search
  // This will be implemented once we have the database connection set up
  debug('Vector similarity search not yet implemented - returning empty results');
  
  return [];
}

// Create embedding for a document and return it
export async function createDocumentEmbedding(
  content: string
): Promise<number[]> {
  return await createEmbedding(content);
}
