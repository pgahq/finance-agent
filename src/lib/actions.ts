/**
 * Action Factory - Creates standardized action handlers with currying
 */

import loadEnv from '@pga/lambda-env';
import { debug } from '@pga/logger';
import { getS3Config, type S3Config } from './s3.js';
import { getWorkdayConfig, getWorkdaySoapConfig, executeWorkdayQuery, type WorkdayConfig } from './workday.js';
import type { WorkdaySoapConfig } from './types.js';
import { getDatabaseConnection, type DatabaseConnection } from './database.js';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

export interface ProcessingContext {
  workdayConfig: WorkdayConfig;
  workdaySoapConfig: WorkdaySoapConfig;
  s3Config: S3Config;
  dbConnection: DatabaseConnection;
}

async function setupContext(): Promise<ProcessingContext> {
  process.env = await loadEnv();
  
  return {
    workdayConfig: getWorkdayConfig(process.env),
    workdaySoapConfig: getWorkdaySoapConfig(process.env),
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

export const withBulkHandler = <T = unknown>(query: string) =>
  (processAction: (context: ProcessingContext, data: T) => Promise<void>) =>
    async () => {
      const context = await setupContext();
      
      debug(`Executing bulk query: ${query}`);
      const data = await executeQuery(context, query);
      
      debug(`Processing ${data.length} results in bulk`);
      await processAction(context, data as T);
    };

export const withBatchHandler = (query: string) =>
  (processorFunctionName: string) =>
    async () => {
      const context = await setupContext();
      
      debug(`Executing query for batch processing: ${query}`);
      const results = await executeQuery(context, query);
      
      debug(`Query returned ${results.length} results, invoking processors in parallel`);
      
      const lambda = new LambdaClient({ region: process.env.AWS_REGION });
      const invocations = results.map(result => 
        lambda.send(new InvokeCommand({
          FunctionName: processorFunctionName,
          InvocationType: 'Event',
          Payload: JSON.stringify({ data: result })
        }))
      );
      
      await Promise.all(invocations);
      debug(`Successfully invoked ${results.length} parallel processing tasks`);
    };

export const withRecordHandler = <T = unknown>(
  processAction: (context: ProcessingContext, data: T) => Promise<void>
) => async (event: { data: any }) => {
  const context = await setupContext();
  
  debug(`Processing individual record with ID: ${event.data?.workdayID || 'unknown'}`);
  await processAction(context, event.data as T);
};
