import { Handler } from 'aws-lambda';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import loadEnv from '@pga/lambda-env';
import { debug, error } from '@pga/logger';
import { getWorkdayConfig, executeWorkdayQuery } from './lib/workday.js';
import type { ScheduleEvent } from './lib/types.js';

// Valid action functions
const VALID_FUNCTIONS = [
  'CacheSuppliersAction',
  'EnrichInvoiceSupplierAction',
] as const;

// Validate that the action is a known function name
function validateActionFunction(action: string): boolean {
  return VALID_FUNCTIONS.includes(action as any);
}

export const handler: Handler<ScheduleEvent> = async (event, context) => {
  process.env = await loadEnv();
  
  const { action, query, bulk = false } = event;

  try {
    const workdayConfig = getWorkdayConfig(process.env);
    
    debug(`Executing Workday query: ${query}`);

    const queryResponse = await executeWorkdayQuery(workdayConfig, query);
    
    // Handle object with data array
    if (!queryResponse || typeof queryResponse !== 'object' || !('data' in queryResponse) || !Array.isArray((queryResponse as any).data)) {
      throw new Error('Expected query response format: {total: number, data: array}');
    }
    
    const queryResults = (queryResponse as any).data;
    debug(`Query returned ${(queryResponse as any).total} total results, processing ${queryResults.length} records`);

    // Validate the action
    if (!validateActionFunction(action)) {
      throw new Error(`Invalid action: ${action}. Must be one of: ${VALID_FUNCTIONS.join(', ')}`);
    }

    // Prepare data for processing
    const dataToProcess = bulk ? [queryResults] : queryResults.map((result: any) => [result]);
    
    debug(`Processing ${queryResults.length} results as ${bulk ? 'bulk' : 'individual'} invocations to ${action}`);
    
    // Create Lambda client once
    const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' });
    
    // Create invocations for all data chunks
    const invocations = dataToProcess.map(async (dataChunk: any) => {
      const payload = {
        action,
        data: dataChunk,
        timestamp: new Date().toISOString(),
        requestId: context.awsRequestId,
      };
      
      const invokeCommand = new InvokeCommand({
        FunctionName: action,
        InvocationType: 'Event', // Async invocation
        Payload: JSON.stringify({
          detail: payload
        })
      });
      
      return lambdaClient.send(invokeCommand);
    });
    
    // Execute all invocations in parallel
    await Promise.all(invocations);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: bulk 
          ? `Successfully invoked ${action} with ${queryResults.length} results`
          : `Successfully invoked ${action} ${queryResults.length} times`,
        action,
        query,
      }),
    };
  } catch (err) {
    error('Error processing query:', err);
    throw err;
  }
};

