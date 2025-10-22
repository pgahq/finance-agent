import { Handler } from 'aws-lambda';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import loadEnv from '@pga/lambda-env';
import { debug, error } from '@pga/logger';
import { getWorkdayConfig, executeWorkdayQuery } from './lib/workday.js';
import type { ScheduleEvent } from './lib/types.js';

const eventBridgeClient = new EventBridgeClient({});

export const handler: Handler<ScheduleEvent> = async (event, context) => {
  process.env = await loadEnv();
  debug('Event received:', JSON.stringify(event, null, 2));
  
  const { action, query, bulk = false } = event;
  const eventBusName = process.env.EVENT_BUS_NAME;

  if (!eventBusName) {
    throw new Error('EVENT_BUS_NAME environment variable is not set');
  }

  try {
    const workdayConfig = getWorkdayConfig(process.env);
    
    debug(`Executing Workday query: ${query}`);
    debug(`Action: ${action}`);
    debug(`Bulk processing: ${bulk}`);

    const queryResponse = await executeWorkdayQuery(workdayConfig, query);
    
    // Handle object with data array
    if (!queryResponse || typeof queryResponse !== 'object' || !('data' in queryResponse) || !Array.isArray((queryResponse as any).data)) {
      throw new Error('Expected query response format: {total: number, data: array}');
    }
    
    const queryResults = (queryResponse as any).data;
    debug(`Query returned ${(queryResponse as any).total} total results, processing ${queryResults.length} records`);
    
    debug(`Processing ${queryResults.length} results`);

    if (bulk) {
      // Send all results as a single event for bulk processing
      const entry = {
        Source: 'finance.agent.wql',
        DetailType: 'WorkdayQueryResult',
        Detail: JSON.stringify({
          action,
          data: queryResults, // Send all results as single payload
          timestamp: new Date().toISOString(),
          requestId: context.awsRequestId,
        }),
        EventBusName: eventBusName,
      };

      await eventBridgeClient.send(
        new PutEventsCommand({ Entries: [entry] })
      );

      return {
        statusCode: 200,
        body: JSON.stringify({
          message: `Successfully published bulk event with ${queryResults.length} results`,
          action,
          query,
        }),
      };
    } else {
      // Send individual events for each result
      const entries = queryResults.map((result: any) => ({
        Source: 'finance.agent.wql',
        DetailType: 'WorkdayQueryResult',
        Detail: JSON.stringify({
          action,
          data: result,
          timestamp: new Date().toISOString(),
          requestId: context.awsRequestId,
        }),
        EventBusName: eventBusName,
      }));

      if (entries.length > 0) {
        const batchSize = 10;
        for (let i = 0; i < entries.length; i += batchSize) {
          const batch = entries.slice(i, i + batchSize);
          await eventBridgeClient.send(
            new PutEventsCommand({ Entries: batch })
          );
        }
      }

      return {
        statusCode: 200,
        body: JSON.stringify({
          message: `Successfully published ${queryResults.length} events`,
          action,
          query,
        }),
      };
    }
  } catch (err) {
    error('Error processing query:', err);
    throw err;
  }
};

