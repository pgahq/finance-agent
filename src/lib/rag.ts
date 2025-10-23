import { debug } from '@pga/logger';
import { getDatabaseConnection, searchDocuments } from './database.js';

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

// Default configuration for RAG queries
export const DEFAULT_RAG_LIMIT = 5;
export const DEFAULT_RAG_SIMILARITY_THRESHOLD = 0.3;

// RAG query interface
export interface RAGQuery {
  query: string;
  documentType?: 'supplier' | 'invoice';
  limit?: number;
  similarityThreshold?: number;
}

// RAG result interface
export interface RAGResult {
  workday_id: string;
  type: string;
  content: string;
  metadata: Record<string, any>;
  similarity: number;
}

/**
 * Query documents using RAG (Retrieval-Augmented Generation)
 * This function can be used by other Lambda functions to retrieve relevant documents
 */
export async function queryDocuments(ragQuery: RAGQuery): Promise<RAGResult[]> {
  debug('Starting RAG document query');
  
  try {
    const {
      query,
      documentType,
      limit = DEFAULT_RAG_LIMIT,
      similarityThreshold = DEFAULT_RAG_SIMILARITY_THRESHOLD
    } = ragQuery;

    if (!query || query.trim().length === 0) {
      throw new Error('Query parameter is required and cannot be empty');
    }

    debug(`RAG Query: "${query}"`);
    debug(`Document type filter: ${documentType || 'all'}`);
    debug(`Limit: ${limit}, Similarity threshold: ${similarityThreshold}`);

    // Create embedding for the query
    const queryEmbedding = await createEmbedding(query);
    debug(`Created query embedding with ${queryEmbedding.length} dimensions`);

    // Get database connection
    const db = await getDatabaseConnection(process.env);
    
    try {
      // Use hybrid search that combines semantic similarity with exact text matching
      const results = await searchDocuments(
        db,
        queryEmbedding,
        query,
        documentType || 'supplier', // Default to supplier if no type specified
        limit
      );
      
      debug(`Found ${results.length} similar documents`);
      
      // Filter by similarity threshold and transform results
      const ragResults: RAGResult[] = results
        .filter(row => parseFloat(row.similarity) >= similarityThreshold)
        .map(row => ({
          workday_id: row.workday_id,
          type: row.type,
          content: row.content,
          metadata: row.metadata,
          similarity: parseFloat(row.similarity)
        }));

      // Log results summary
      if (ragResults.length > 0) {
        debug(`Top similarity scores: ${ragResults.map(r => r.similarity.toFixed(3)).join(', ')}`);
      } else {
        debug('No documents found above similarity threshold');
      }

      return ragResults;

    } finally {
      await db.close();
    }

  } catch (error) {
    debug(`Error in RAG document query: ${error}`);
    throw error;
  }
}

/**
 * Get context for a query by retrieving relevant documents
 * This is useful for providing context to LLMs
 */
export async function getContextForQuery(
  query: string, 
  options: {
    documentType?: 'supplier' | 'invoice';
    maxDocuments?: number;
    similarityThreshold?: number;
  } = {}
): Promise<string> {
  const {
    documentType,
    maxDocuments = 3,
    similarityThreshold = DEFAULT_RAG_SIMILARITY_THRESHOLD
  } = options;

  const results = await queryDocuments({
    query,
    documentType,
    limit: maxDocuments,
    similarityThreshold
  });

  if (results.length === 0) {
    return 'No relevant documents found.';
  }

  // Format results as context
  const context = results.map((result, index) => {
    return `Document ${index + 1} (${result.type}, similarity: ${result.similarity.toFixed(3)}):
${result.content}

Metadata: ${JSON.stringify(result.metadata)}
---`;
  }).join('\n\n');

  return context;
}

// Types and functions are already exported above