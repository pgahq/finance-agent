/**
 * Action Factory - Creates standardized action handlers with currying
 */

import loadEnv from '@pga/lambda-env';
import { debug } from '@pga/logger';
import { getS3Config, type S3Config } from './s3.js';
import { getWorkdayConfig, executeWorkdayQuery, type WorkdayConfig } from './workday.js';
import { getDatabaseConnection, type DatabaseConnection } from './database.js';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

async function setupEnvironment(): Promise<{
  workdayConfig: WorkdayConfig;
  s3Config: S3Config;
  dbConnection: DatabaseConnection;
}> {
  process.env = await loadEnv();
  
  return {
    workdayConfig: getWorkdayConfig(process.env),
    s3Config: getS3Config(process.env),
    dbConnection: await getDatabaseConnection(process.env)
  };
}

const executeQuery = async (workdayConfig: WorkdayConfig, query: string) => {
  const queryResponse = await executeWorkdayQuery(workdayConfig, query);
  
  if (!queryResponse?.data || !Array.isArray(queryResponse.data)) {
    throw new Error('Expected query response format: {total: number, data: array}');
  }
  
  return queryResponse.data;
};

export const withBulkHandler = <T = unknown>(query: string) =>
  (processAction: (params: { workdayConfig: WorkdayConfig; s3Config: S3Config; dbConnection: DatabaseConnection; data: T }) => Promise<void>) =>
    async () => {
      const { workdayConfig, s3Config, dbConnection } = await setupEnvironment();
      
      debug(`Executing bulk query: ${query}`);
      const data = await executeQuery(workdayConfig, query);
      
      debug(`Processing ${data.length} results in bulk`);
      await processAction({ workdayConfig, s3Config, dbConnection: dbConnection!, data: data as T });
    };

export const withBatchHandler = (query: string) =>
  (processorFunctionName: string) =>
    async () => {
      const { workdayConfig } = await setupEnvironment();
      
      debug(`Executing query for batch processing: ${query}`);
      const results = await executeQuery(workdayConfig, query);
      
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
  processAction: (params: { workdayConfig: WorkdayConfig; s3Config: S3Config; dbConnection: DatabaseConnection; data: T }) => Promise<void>
) => async (event: { data: any }) => {
  const { workdayConfig, s3Config, dbConnection } = await setupEnvironment();
  
  debug(`Processing individual record with ID: ${event.data?.workdayID || 'unknown'}`);
  await processAction({ workdayConfig, s3Config, dbConnection, data: event.data as T });
};
