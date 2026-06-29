import { debug } from '@pga/logger';
import { tool } from 'ai';
import { z } from 'zod';
import { getDatabaseConnection, searchDocuments } from './database.js';
import { getEmbeddingRequestConfig } from './eval_model.js';
export type { DocumentType } from './database.js';

// Create embedding for text using OpenAI
export async function createEmbedding(text: string): Promise<number[]> {
  const { url, apiKey, model } = getEmbeddingRequestConfig();

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
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
    supplier.allAlternateNames?.length > 0 ? `Alternate Names: ${supplier.allAlternateNames.join(', ')}` : null,
    supplier.allPhoneNumbers?.length > 0 ? `Phone: ${supplier.allPhoneNumbers.join(', ')}` : null,
    supplier.allEmailAddresses?.length > 0 ? `Email: ${supplier.allEmailAddresses.join(', ')}` : null,
    supplier.allAddresses?.length > 0 ? `Address: ${supplier.allAddresses.join(', ')}` : null,
    `Status: ${supplier.supplierStatus}`
  ].filter(Boolean).join('\n');

  return content;
}

export function createCompanyContent(company: any): string {
  const content = [
    `Company Name: ${company.companyName}`,
    `Primary Address: ${company.addressPrimary}`,
    company.publicAddresses?.length > 0 ? `Public Addresses: ${company.publicAddresses.join(', ')}` : null,
    company.emailAddresses?.length > 0 ? `Email Addresses: ${company.emailAddresses.join(', ')}` : null,
    company.phoneNumbers?.length > 0 ? `Phone Numbers: ${company.phoneNumbers.join(', ')}` : null,
  ].filter(Boolean).join('\n');

  return content;
}


export function createCostCenterContent(costCenter: any): string {
  const content = [
    `Cost Center Name: ${costCenter.name}`,
    `Cost Center Code: ${costCenter.code}`,
  ].filter(Boolean).join('\n');

  return content;
}

export function createPaymentTermsContent(paymentTerms: any): string {
  return `Payment Terms: ${paymentTerms.name}`;
}

export function createEventContent(event: any): string {
  return `Event Name: ${event.name}`;
}

export function createFundContent(fund: any): string {
  return `Fund Reference ID: ${fund.referenceId}`;
}

export function createLobContent(lob: any): string {
  return [
    `LOB Name: ${lob.name}`,
    lob.referenceId ? `Reference ID: ${lob.referenceId}` : null,
  ].filter(Boolean).join('\n');
}

export function createSpendCategoryContent(sc: any): string {
  return [
    `Spend Category: ${sc.name}`,
    sc.referenceId ? `Reference ID: ${sc.referenceId}` : null,
  ].filter(Boolean).join('\n');
}

// Default configuration for RAG queries
export const DEFAULT_RAG_LIMIT = 100;
export const DEFAULT_RAG_SIMILARITY_THRESHOLD = 0.3;

// RAG query interface
export interface RAGQuery {
  query: string;
  documentType?: 'supplier' | 'invoice' | 'company' | 'cost_center' | 'payment_terms' | 'event' | 'lob' | 'fund' | 'spend_category';
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

    // Create embedding for the query
    const queryEmbedding = await createEmbedding(query);

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

      // Consolidated RAG results log
      if (ragResults.length > 0) {
        debug(`RAG Query: "${query}"`);
        debug(`Query executed successfully, returned ${results.length} rows`);
        debug(`Top similarity scores: ${ragResults.map(r => r.similarity.toFixed(3)).join(', ')}`);

        // Show excerpt of first few results
        const excerpt = ragResults.slice(0, 3).map(r => ({
          workday_id: r.workday_id,
          type: r.type,
          similarity: r.similarity.toFixed(3),
          contentPreview: r.content.substring(0, 100) + '...'
        }));
        debug(`First few results:`, excerpt);
      } else {
        debug(`RAG Query: "${query}" - No documents found above similarity threshold`);
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


// AI Tools for use with Vercel AI SDK
export const findSuppliersTool = tool({
  description: `Search for suppliers using semantic similarity and exact text matching. 
  
  This tool is optimized for finding suppliers by:
  - Company names (e.g., "Acme Corp", "Microsoft")
  - Alternate names or DBA names (e.g., "Doing Business As" names)
  - Partial company names (e.g., "Acme", "Micro")
  - Addresses or parts of addresses (e.g., "123 Main St", "New York", "NY 10001")
  - Email addresses (e.g., "contact@acme.com", "support@microsoft.com")
  - Phone numbers (e.g., "555-123-4567", "(555) 123-4567")
  - Business descriptions or industries (e.g., "software company", "construction")
  
  Examples: "suppliers in New York", "Acme Corporation", "contact@acme.com", "555-123-4567"`,
  inputSchema: z.object({
    query: z.string().describe('Search query for suppliers (company name, address, email, phone, or description)'),
    limit: z.number().min(1).max(500).optional().describe('Maximum number of results to return (default: 100)'),
    similarityThreshold: z.number().min(0).max(1).optional().describe('Minimum similarity score (0-1, default: 0.3)')
  }),
  execute: async ({ query, limit, similarityThreshold }) => {
    const results = await queryDocuments({
      query,
      documentType: 'supplier',
      limit,
      similarityThreshold
    });

    debug(`Find Suppliers Tool: Found ${results.length} suppliers`);

    return {
      success: true,
      results: results.map(result => ({
        workdayId: result.workday_id,
        type: result.type,
        content: result.content,
        metadata: result.metadata,
        similarity: result.similarity
      }))
    };
  }
});

export const findCostCentersTool = tool({
  description: `Search for cost centers using semantic similarity and exact text matching.

  Use this tool to look up cost centers by:
  - Cost center name (e.g., "Marketing Communications", "Engineering")
  - Cost center code (e.g., "72200")
  - Partial name or code

  Examples: "72200", "Marketing", "Engineering Operations"`,
  inputSchema: z.object({
    query: z.string().describe('Search query for cost centers (name or code)'),
    limit: z.number().min(1).max(500).optional().describe('Maximum number of results to return (default: 100)'),
    similarityThreshold: z.number().min(0).max(1).optional().describe('Minimum similarity score (0-1, default: 0.3)')
  }),
  execute: async ({ query, limit, similarityThreshold }) => {
    const results = await queryDocuments({
      query,
      documentType: 'cost_center',
      limit,
      similarityThreshold
    });

    debug(`Find Cost Centers Tool: Found ${results.length} cost centers`);

    return {
      success: true,
      results: results.map(result => ({
        workdayId: result.workday_id,
        type: result.type,
        content: result.content,
        metadata: result.metadata,
        similarity: result.similarity
      }))
    };
  }
});

export const findCompaniesTool = tool({
  description: `Search for companies using semantic similarity and exact text matching.

  This tool is optimized for finding companies by:
  - Company names (e.g., "Acme Corp", "Microsoft")
  - Company IDs (Workday IDs)

  Examples: "Acme Corporation", "Global Modern Services"`,
  inputSchema: z.object({
    query: z.string().describe('Search query for companies (company name or ID)'),
    limit: z.number().min(1).max(500).optional().describe('Maximum number of results to return (default: 100)'),
    similarityThreshold: z.number().min(0).max(1).optional().describe('Minimum similarity score (0-1, default: 0.3)')
  }),
  execute: async ({ query, limit, similarityThreshold }) => {
    const results = await queryDocuments({
      query,
      documentType: 'company',
      limit,
      similarityThreshold
    });

    debug(`Find Companies Tool: Found ${results.length} companies`);

    return {
      success: true,
      results: results.map(result => ({
        workdayId: result.workday_id,
        type: result.type,
        content: result.content,
        metadata: result.metadata,
        similarity: result.similarity
      }))
    };
  }
});

export const findEventsTool = tool({
  description: `Search for events using semantic similarity and exact text matching.

  Use this tool to look up events (tournaments, championships, conferences, etc.) by name when mentioned in an email.

  Examples: "2026 PGA Championship", "Masters Tournament", "Ryder Cup"`,
  inputSchema: z.object({
    query: z.string().describe('Event name or description from the email'),
    limit: z.number().min(1).max(50).optional().describe('Maximum number of results to return (default: 100)'),
    similarityThreshold: z.number().min(0).max(1).optional().describe('Minimum similarity score (0-1, default: 0.3)')
  }),
  execute: async ({ query, limit, similarityThreshold }) => {
    const results = await queryDocuments({
      query,
      documentType: 'event',
      limit,
      similarityThreshold
    });

    debug(`Find Events Tool: Found ${results.length} events`);

    return {
      success: true,
      results: results.map(result => ({
        workdayId: result.workday_id,
        content: result.content,
        metadata: result.metadata,
        similarity: result.similarity
      }))
    };
  }
});

export const findLobsTool = tool({
  description: `Search for lines of business (LOBs) using semantic similarity and exact text matching.

  Use this tool to look up lines of business by name or reference ID when mentioned in an email.

  Examples: "Golf", "Technology Services", "Media"`,
  inputSchema: z.object({
    query: z.string().describe('Line of business name or reference from the email'),
    limit: z.number().min(1).max(50).optional().describe('Maximum number of results to return (default: 100)'),
    similarityThreshold: z.number().min(0).max(1).optional().describe('Minimum similarity score (0-1, default: 0.3)')
  }),
  execute: async ({ query, limit, similarityThreshold }) => {
    const results = await queryDocuments({
      query,
      documentType: 'lob',
      limit,
      similarityThreshold
    });

    debug(`Find LOBs Tool: Found ${results.length} LOBs`);

    return {
      success: true,
      results: results.map(result => ({
        workdayId: result.workday_id,
        content: result.content,
        metadata: result.metadata,
        similarity: result.similarity
      }))
    };
  }
});

export const findFundsTool = tool({
  description: `Search for funds using semantic similarity and exact text matching.

  Use this tool to look up funds by reference ID or name when mentioned in an email.

  Examples: "FD-001", "Operating Fund", "Capital Fund"`,
  inputSchema: z.object({
    query: z.string().describe('Fund reference ID or name from the email'),
    limit: z.number().min(1).max(50).optional().describe('Maximum number of results to return (default: 100)'),
    similarityThreshold: z.number().min(0).max(1).optional().describe('Minimum similarity score (0-1, default: 0.3)')
  }),
  execute: async ({ query, limit, similarityThreshold }) => {
    const results = await queryDocuments({
      query,
      documentType: 'fund',
      limit,
      similarityThreshold
    });

    debug(`Find Funds Tool: Found ${results.length} funds`);

    return {
      success: true,
      results: results.map(result => ({
        workdayId: result.workday_id,
        content: result.content,
        metadata: result.metadata,
        similarity: result.similarity
      }))
    };
  }
});

export const findSpendCategoriesTool = tool({
  description: `Search for spend categories using semantic similarity and exact text matching.

  Use this tool to look up spend categories by name or reference ID when mentioned in an email.
  These are typically prefaced with "spend category:", "spend cat:", or "SC:" in the email.

  Examples: "Office Supplies", "Professional Services", "Travel"`,
  inputSchema: z.object({
    query: z.string().describe('Spend category name or reference from the email'),
    limit: z.number().min(1).max(50).optional().describe('Maximum number of results to return (default: 100)'),
    similarityThreshold: z.number().min(0).max(1).optional().describe('Minimum similarity score (0-1, default: 0.3)')
  }),
  execute: async ({ query, limit, similarityThreshold }) => {
    const results = await queryDocuments({
      query,
      documentType: 'spend_category',
      limit,
      similarityThreshold
    });

    debug(`Find Spend Categories Tool: Found ${results.length} spend categories`);

    return {
      success: true,
      results: results.map(result => ({
        workdayId: result.workday_id,
        content: result.content,
        metadata: result.metadata,
        similarity: result.similarity
      }))
    };
  }
});

export const findPaymentTermsTool = tool({
  description: `Search for payment terms using semantic similarity.

  Use this tool to match payment terms extracted from an invoice (e.g. "Net 30", "Net 60", "Due on Receipt") against the payment terms configured in Workday.

  Examples: "Net 30", "net30", "NET 60", "Due on receipt"`,
  inputSchema: z.object({
    query: z.string().describe('Payment terms text extracted from the invoice'),
    limit: z.number().min(1).max(50).optional().describe('Maximum number of results to return (default: 100)'),
    similarityThreshold: z.number().min(0).max(1).optional().describe('Minimum similarity score (0-1, default: 0.3)')
  }),
  execute: async ({ query, limit, similarityThreshold }) => {
    const results = await queryDocuments({
      query,
      documentType: 'payment_terms',
      limit,
      similarityThreshold
    });

    debug(`Find Payment Terms Tool: Found ${results.length} matches`);

    return {
      success: true,
      results: results.map(result => ({
        workdayId: result.workday_id,
        content: result.content,
        metadata: result.metadata,
        similarity: result.similarity
      }))
    };
  }
});
