import { Handler } from 'aws-lambda';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import loadEnv from '@pga/lambda-env';
import { debug, error } from '@pga/logger';
import { getWorkdayConfig, executeWorkdayQuery } from './lib/workday.js';

interface ScheduleEvent {
  action: string;
  query: string;
}

export interface WorkdayQueryResultDetail {
  action: string;
  data: unknown;
  timestamp: string;
  requestId: string;
}

const eventBridgeClient = new EventBridgeClient({});

export const handler: Handler<ScheduleEvent> = async (event, context) => {
  process.env = await loadEnv();
  debug('Event received:', JSON.stringify(event, null, 2));
  
  const { action, query } = event;
  const eventBusName = process.env.EVENT_BUS_NAME;

  if (!eventBusName) {
    throw new Error('EVENT_BUS_NAME environment variable is not set');
  }

  try {
    const workdayConfig = getWorkdayConfig(process.env);
    
    debug(`Executing Workday query: ${query}`);
    debug(`Action: ${action}`);

    const queryResults = await executeWorkdayQuery(workdayConfig, query);
    
    debug(`Query returned ${queryResults.length} results`);

    const entries = queryResults.map((result) => ({
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
  } catch (err) {
    error('Error processing query:', err);
    throw err;
  }
};

