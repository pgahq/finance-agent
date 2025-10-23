import loadEnv from '@pga/lambda-env';
import { debug } from '@pga/logger';
import { queryDocuments, RAGQuery, RAGResult, DEFAULT_RAG_LIMIT, DEFAULT_RAG_SIMILARITY_THRESHOLD } from './lib/rag.js';

// Query interface (alias for RAGQuery)
export interface QueryRequest extends RAGQuery {}

// Query result interface (alias for RAGResult)
export interface QueryResult extends RAGResult {}

// Main handler function with environment setup
export async function handler(event: { data: QueryRequest }): Promise<QueryResult[]> {
  // Setup environment to unwrap SSM parameters
  process.env = await loadEnv();
  
  debug('Starting document query handler');
  
  try {
    // Apply defaults for configurable parameters
    const queryRequest: RAGQuery = {
      query: event.data.query,
      documentType: event.data.documentType,
      limit: event.data.limit ?? DEFAULT_RAG_LIMIT,
      similarityThreshold: event.data.similarityThreshold ?? DEFAULT_RAG_SIMILARITY_THRESHOLD
    };

    debug(`Querying documents with: "${queryRequest.query}"`);
    debug(`Document type filter: ${queryRequest.documentType || 'all'}`);
    debug(`Limit: ${queryRequest.limit}, Similarity threshold: ${queryRequest.similarityThreshold}`);

    // Use the RAG utility function
    const results = await queryDocuments(queryRequest);
    
    debug(`Found ${results.length} similar documents`);
    
    // Log results summary
    if (results.length > 0) {
      debug(`Top similarity scores: ${results.map(r => r.similarity.toFixed(3)).join(', ')}`);
    } else {
      debug('No documents found above similarity threshold');
    }

    return results;

  } catch (error) {
    debug(`Error in document query handler: ${error}`);
    throw error;
  }
}

// Types are already exported above
