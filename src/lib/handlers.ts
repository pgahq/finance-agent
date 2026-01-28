/**
 * Handler Factory - Creates standardized query and processor handlers
 */

import loadEnv from '@pga/lambda-env';
import { debug } from '@pga/logger';
import { getS3Config, type S3Config } from './s3.js';
import { getWorkdayConfig, executeWorkdayQuery, type WorkdayConfig } from './workday.js';
import { getDatabaseConnection, type DatabaseConnection } from './database.js';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

export interface ProcessingContext {
  workdayConfig: WorkdayConfig;
  s3Config: S3Config;
  dbConnection: DatabaseConnection;
}

async function setupContext(): Promise<ProcessingContext> {
  process.env = await loadEnv();

  return {
    workdayConfig: getWorkdayConfig(process.env),
    s3Config: getS3Config(process.env),
    dbConnection: await getDatabaseConnection(process.env)
  };
}

const executeQuery = async (context: ProcessingContext, query: string) => {
  const queryResponse = await executeWorkdayQuery(context.workdayConfig, query);
  
  if (!queryResponse?.data || !Array.isArray(queryResponse.data)) {
    throw new Error('Expected query response format: {total: number, data: array}');
  }
  
  return queryResponse.data;
};

/**
 * General Handler - Provides context setup for any handler function
 * 
 * @param handlerFunction - The function that handles the request with context
 * @returns A handler function with environment setup
 */
export const withHandler = (
  handlerFunction: (context: ProcessingContext, event?: any) => Promise<void>
) => async (event: any = {}) => {
  const context = await setupContext();
  await handlerFunction(context, event);
};

/**
 * Query Handler - Executes Workday queries and distributes results to processors
 * 
 * @param query - The Workday query string to execute
 * @returns A function that takes configuration and returns a handler
 */
export const withQueryHandler = (query: string | ((context: ProcessingContext) => Promise<string>)) =>
  (config: { processorFunctionName: string; pageSize?: number | null }) =>
    async (_event: any = {}) => {
      const context = await setupContext();
      const resolvedQuery = typeof query === 'function' ? await query(context) : query;

      if (config.pageSize === null) {
        // Don't execute query - let processor handle it
        debug(`Invoking ${config.processorFunctionName} to execute query directly`);

        const lambda = new LambdaClient({ region: process.env.AWS_REGION });
        await lambda.send(new InvokeCommand({
          FunctionName: config.processorFunctionName,
          InvocationType: 'Event',
          Payload: JSON.stringify({
            query: resolvedQuery,
            // No data payload
          })
        }));
      } else {
        // Execute query and paginate
        debug(`Executing query and paginating with pageSize: ${config.pageSize}`);
        const allData = await executeQuery(context, resolvedQuery);

        const pageSize = config.pageSize || allData.length;
        const totalPages = Math.ceil(allData.length / pageSize);

        const lambda = new LambdaClient({ region: process.env.AWS_REGION });

        for (let page = 0; page < totalPages; page++) {
          const startIndex = page * pageSize;
          const endIndex = Math.min(startIndex + pageSize, allData.length);
          const pageData = allData.slice(startIndex, endIndex);

          await lambda.send(new InvokeCommand({
            FunctionName: config.processorFunctionName,
            InvocationType: 'Event',
            Payload: JSON.stringify({
              data: pageData,
              page: page + 1,
              totalPages
            })
          }));
        }
      }
    };

/**
 * Processor Handler - Processes data from query handlers or direct invocation
 * 
 * @param processAction - The function that processes the data
 * @returns A handler function that can process data
 */
export const withProcessorHandler = <T = unknown>(
  processAction: (context: ProcessingContext, data: T[], event?: any) => Promise<void>
) => async (event: any = {}) => {
  const context = await setupContext();
  
  if (event.query) {
    // pageSize: null case - processor executes query itself
    debug(`Executing query directly: ${event.query}`);
    const data = await executeQuery(context, event.query);
    await processAction(context, data as T[], event);
  } else {
    // pageSize: number case - data comes in payload
    debug(`Processing ${event.data?.length || 0} records from payload`);
    await processAction(context, event.data as T[], event);
  }
};
