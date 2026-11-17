import { debug } from '@pga/logger';
import { embed, gateway, tool } from 'ai';
import { z } from 'zod';
import { includeCompaniesMatchingBillToAddress, tagCompaniesByAddress } from './company_address_match.js';
import { rankCostCenterSearchResults } from './cost_center_match.js';
import { isExactPaymentTermsMatch, paymentTermsNameOf, rankPaymentTermsSearchResults } from './payment_terms_match.js';
import { parseCompanySearchQuery } from './company_search_query.js';
import { parseRelatedLob } from './related_worktags.js';
import { getDatabaseConnection, getDocumentsByType, searchDocuments } from './database.js';
import { textFromWqlValue } from './workday_reference_id.js';
import { gatewayProviderPin } from './models.js';
import { supplierRecordFromDocument } from './supplier_match.js';
export type { DocumentType } from './database.js';

// Must stay text-embedding-3-small (1536 dimensions): stored vectors and the pgvector index depend on it.
const EMBEDDING_MODEL_ID = 'openai/text-embedding-3-small';
export const embeddingModel = gateway.embeddingModel(EMBEDDING_MODEL_ID);

export async function createEmbedding(text: string): Promise<number[]> {
  const { embedding } = await embed({ model: embeddingModel, value: text, providerOptions: gatewayProviderPin(EMBEDDING_MODEL_ID) });
  return embedding;
}

// Create document content for suppliers
export function createSupplierContent(supplier: any): string {
  const content = [
    `Company Name: ${supplier.supplierName}`,
    supplier.supplierId ? `Supplier ID: ${supplier.supplierId}` : null,
    supplier.allAlternateNames?.length > 0 ? `Alternate Names: ${supplier.allAlternateNames.join(', ')}` : null,
    supplier.allPhoneNumbers?.length > 0 ? `Phone: ${supplier.allPhoneNumbers.join(', ')}` : null,
    supplier.allEmailAddresses?.length > 0 ? `Email: ${supplier.allEmailAddresses.join(', ')}` : null,
    supplier.allAddresses?.length > 0 ? `Address: ${supplier.allAddresses.join(', ')}` : null,
    `Status: ${supplier.supplierStatus}`
  ].filter(Boolean).join('\n');

  return content;
}

export function createEmployeeContent(employee: {
  name?: string;
  preferredName?: string;
  email: string;
  employeeId?: string;
  active: boolean;
}): string {
  return [
    employee.name ? `Name: ${employee.name}` : null,
    employee.preferredName ? `Preferred Name: ${employee.preferredName}` : null,
    `Email: ${employee.email}`,
    employee.employeeId ? `Employee ID: ${employee.employeeId}` : null,
    `Active: ${employee.active ? 'Yes' : 'No'}`,
  ].filter(Boolean).join('\n');
}

export function createCompanyContent(company: any): string {
  const addressPrimary = textFromWqlValue(company.addressPrimary);
  const publicAddresses = Array.isArray(company.publicAddresses)
    ? (company.publicAddresses as unknown[])
      .map((value) => textFromWqlValue(value))
      .filter((value): value is string => Boolean(value))
    : [];
  const rawAliases = Array.isArray(company.financeAgentAliases)
    ? (company.financeAgentAliases as unknown[])
    : [];
  const financeAgentAliases = rawAliases.filter((alias): alias is string => (
    typeof alias === 'string' && Boolean(alias.trim())
  ));
  const content = [
    `Company Name: ${company.companyName}`,
    company.companyReferenceId ? `Company Reference ID: ${company.companyReferenceId}` : null,
    ...financeAgentAliases.map((alias: string) => `Finance Agent Alias: ${alias}`),
    addressPrimary ? `Primary Address: ${addressPrimary}` : null,
    publicAddresses.length > 0 ? `Public Addresses: ${publicAddresses.join(', ')}` : null,
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
// No real Workday org's payment-terms catalog approaches this size (a few dozen terms is typical), so this
// is never the active constraint in normal operation — rankPaymentTermsSearchResults below always reranks
// the whole real catalog before the result is truncated to the caller's requested limit. It still bounds
// worst-case query/transfer/sort/log cost if the cache were ever corrupted into many rows for one type,
// unlike requesting an unbounded (e.g. Number.MAX_SAFE_INTEGER) SQL limit.
const PAYMENT_TERMS_CANDIDATE_POOL = 1000;

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

    const db = await getDatabaseConnection(process.env);

    const isPaymentTerms = documentType === 'payment_terms';
    // A fixed pool, not Math.max(limit, ...): the caller's limit never raises the SQL side for payment
    // terms, so this is a genuine upper bound, not just a floor. Ranking and truncation to the caller's
    // limit both happen afterward in JS regardless of how many rows searchDocuments returns.
    const sqlLimit = isPaymentTerms ? PAYMENT_TERMS_CANDIDATE_POOL : limit;

    // Use hybrid search that combines semantic similarity with exact text matching
    const results = await searchDocuments(
      db,
      queryEmbedding,
      query,
      documentType || 'supplier', // Default to supplier if no type specified
      sqlLimit
    );

    const scored: RAGResult[] = results.map(row => ({
      workday_id: row.workday_id,
      type: row.type,
      content: row.content,
      metadata: row.metadata,
      similarity: parseFloat(row.similarity)
    }));

    let ragResults: RAGResult[];
    if (isPaymentTerms) {
      // Rank the whole pool before the threshold filters anything out: an exact plain-term match is kept
      // regardless of similarity, since the printed text and the catalog can diverge in wording (e.g.
      // "30 NET" vs. "Net 30") without that meaning the term is a weak match.
      ragResults = rankPaymentTermsSearchResults(scored, query)
        .filter(result => isExactPaymentTermsMatch(query, paymentTermsNameOf(result)) || result.similarity >= similarityThreshold)
        .slice(0, limit);
    } else {
      ragResults = scored.filter(result => result.similarity >= similarityThreshold);
      if (documentType === 'cost_center') {
        ragResults = rankCostCenterSearchResults(ragResults, query);
      }
    }

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
  - Supplier IDs (e.g., "S-001234")
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
    const records = results.map(result => supplierRecordFromDocument(result));
    debug('Find Suppliers Tool results:', records.map((record, index) => ({
      workdayId: results[index].workday_id,
      supplierId: record.supplierId,
      supplierName: record.supplierName,
      alternateNames: record.alternateNames,
      similarity: results[index].similarity.toFixed(3),
    })));

    return {
      success: true,
      results: results.map((result, index) => ({
        workdayId: result.workday_id,
        type: result.type,
        supplier: records[index],
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

  Each result includes relatedLob (default and allowed Line of Business ids for that cost center). When the email also mentions a Line of Business, do not call findLobs against the full LOB catalog. Keep the mentioned LOB when it is in relatedLob default/allowed ids; otherwise use the related default, then unique allowed.

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
        relatedLob: parseRelatedLob(result.metadata?.relatedLob) ?? null,
        similarity: result.similarity
      }))
    };
  }
});

export const findCompaniesTool = tool({
  description: `Search for companies using semantic similarity and exact text matching.

  This tool is optimized for finding companies by:
  - Company names (e.g., "PGA JR. LEAGUE", "PGA of America", "Acme Corp")
  - Finance Agent aliases stored on the company (exact billed nicknames such as "PGA of America" for company 310)
  - Company Reference IDs (e.g., "912")
  - Company Workday IDs (WIDs)

  Pass the billed company name or ID in query. A billed name may be the legal companyName or a Finance Agent alias, not only the legal name. Pass the bill-to street address in address when it is visible on the invoice. Do not put street, city, state, or ZIP in query — those tokens are stripped before search. Name search uses embedding similarity (plus exact companyName / Company_Reference_ID / Finance Agent alias). Street is compared independently against the full company cache and tagged unique, shared, or none — it does not reorder name results. Cache companies on that street that name search missed are appended so both signals are visible. Do not prefer address over name or name over address.

  Examples: query "PGA of America" with address "1916 PGA Parkway, Frisco, TX 75033"`,
  inputSchema: z.object({
    query: z.string().describe('Billed company name or ID only (omit street, city, state, and ZIP)'),
    address: z.string().optional().describe('Bill-to street address from the invoice. Tagged independently of name rank; not embedded.'),
    limit: z.number().min(1).max(500).optional().describe('Maximum number of results to return (default: 100)'),
    similarityThreshold: z.number().min(0).max(1).optional().describe('Minimum similarity score (0-1, default: 0.3)')
  }),
  execute: async ({ query, address, limit, similarityThreshold }) => {
    const parsed = parseCompanySearchQuery(query);
    const nameQuery = parsed.nameQuery;
    const billToAddress = address?.trim() || parsed.billToAddress;
    if (!nameQuery) {
      debug(`Find Companies Tool: skipped search; query was only an address: "${query}"`);
      return {
        success: true,
        results: [],
        addressMatch: 'none',
        message: 'Query was only a street address. Search again with the billed company name or Company_Reference_ID.'
      };
    }
    if (nameQuery !== query.replace(/\s+/g, ' ').trim()) {
      debug(`Find Companies Tool: searching "${nameQuery}" (address omitted from "${query}")`);
    }

    const resultLimit = limit ?? DEFAULT_RAG_LIMIT;
    let companyCacheFailed = false;
    const [results, cachedCompanies] = await Promise.all([
      queryDocuments({
        query: nameQuery,
        documentType: 'company',
        limit: resultLimit,
        similarityThreshold
      }),
      billToAddress
        ? getDatabaseConnection(process.env).then((db) => getDocumentsByType(db, 'company')).catch((error) => {
            debug('Find Companies Tool: company cache list failed; tagging name hits only', error);
            companyCacheFailed = true;
            return [];
          })
        : Promise.resolve([]),
    ]);

    const tagged = companyCacheFailed
      ? tagCompaniesByAddress(results, billToAddress)
      : includeCompaniesMatchingBillToAddress(
          results,
          cachedCompanies.map((document) => ({
            workday_id: document.workday_id,
            type: 'company' as const,
            content: document.content ?? '',
            metadata: document.metadata,
          })),
          billToAddress
        );
    debug(`Find Companies Tool: Found ${tagged.results.length} companies (addressMatch=${tagged.addressMatch})`);

    return {
      success: true,
      addressMatch: tagged.addressMatch,
      ...(companyCacheFailed
        ? { message: 'Company cache list failed; cache-only street extras omitted. Name hits tagged from in-list addresses.' }
        : {}),
      results: tagged.results.map(result => {
        const similarity = 'similarity' in result ? result.similarity : undefined;
        return {
          workdayId: result.workday_id,
          type: result.type,
          content: result.content,
          metadata: result.metadata,
          ...(typeof similarity === 'number' ? { similarity } : {}),
          addressMatch: result.addressMatch
        };
      })
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

  Use this only when the email mentions a Line of Business and does not also identify a cost center. If a cost center is already resolved, do not search the full catalog. Keep the mentioned LOB when it is in that cost center's related set; otherwise use related default or unique allowed.

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
