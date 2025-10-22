import { Handler } from 'aws-lambda';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import loadEnv from '@pga/lambda-env';
import { debug, error } from '@pga/logger';
import { getWorkdayConfig, executeWorkdayQuery } from './lib/workday.js';
import { getFunctionArn, isValidAction, getValidActions } from './lib/actions.js';
import type { ScheduleEvent } from './lib/types.js';

export const handler: Handler<ScheduleEvent> = async (event, context) => {
  process.env = await loadEnv();
  
  const { action, query, bulk = false } = event;

  try {
    const workdayConfig = getWorkdayConfig(process.env);
    
    debug(`Executing Workday query: ${query}`);

    const queryResponse = await executeWorkdayQuery(workdayConfig, query);
    
    if (!queryResponse || typeof queryResponse !== 'object' || !('data' in queryResponse) || !Array.isArray((queryResponse as any).data)) {
      throw new Error('Expected query response format: {total: number, data: array}');
    }
    
    const queryResults = (queryResponse as any).data;
    debug(`Query returned ${(queryResponse as any).total} total results, processing ${queryResults.length} records`);

    if (!isValidAction(action)) {
      throw new Error(`Invalid action: ${action}. Must be one of: ${getValidActions().join(', ')}`);
    }

    const functionArn = getFunctionArn(action);
    
    // Create Lambda client once
    const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' });
    
    if (bulk) {
      // Bulk processing: single invocation with all data
      debug(`Processing ${queryResults.length} results as single bulk invocation to ${action}`);
      
      const payload = {
        action,
        data: queryResults,
        timestamp: new Date().toISOString(),
        requestId: context.awsRequestId,
      };
      
      const invokeCommand = new InvokeCommand({
        FunctionName: functionArn,
        InvocationType: 'RequestResponse', // Sync for bulk
        Payload: JSON.stringify({
          detail: payload
        })
      });
      
      debug(`Invoking Lambda function: ${functionArn} (${action}) with ${queryResults.length} records`);
      
      await lambdaClient.send(invokeCommand);
    } else {
      // Individual processing: multiple invocations
      debug(`Processing ${queryResults.length} results as individual invocations to ${action}`);
      
      const invocations = queryResults.map(async (result: any) => {
        const payload = {
          action,
          data: [result],
          timestamp: new Date().toISOString(),
          requestId: context.awsRequestId,
        };
        
        const invokeCommand = new InvokeCommand({
          FunctionName: functionArn,
          InvocationType: 'Event', // Async for individual
          Payload: JSON.stringify({
            detail: payload
          })
        });
        
        return lambdaClient.send(invokeCommand);
      });
      
      // Execute all invocations in parallel
      await Promise.all(invocations);
    }

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

