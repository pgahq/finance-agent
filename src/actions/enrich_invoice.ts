import { EventBridgeHandler } from 'aws-lambda';
import { loadEnv } from '@pga/lambda-env';
import { debug } from '@pga/logger';
import { getWorkdayConfig, type WorkdayConfig } from '../lib/workday.js';
import type { WorkdayQueryResultDetail } from '../wqlToEvent.js';

export const handler: EventBridgeHandler<'WorkdayQueryResult', WorkdayQueryResultDetail, void> = async (event) => {
  process.env = await loadEnv();
  debug('Event received:', JSON.stringify(event, null, 2));

  const { data, timestamp, requestId } = event.detail;
  
  debug(`Event timestamp: ${timestamp}`);
  debug(`Request ID: ${requestId}`);

  const workdayConfig = getWorkdayConfig(process.env);

  await processAction(workdayConfig, data);

  debug('Successfully processed event');
};

async function processAction(
  config: WorkdayConfig,
  invoiceData: unknown
): Promise<void> {
  debug('Enriching invoice with AI and Workday data');
  debug('Invoice data:', JSON.stringify(invoiceData, null, 2));
  
  debug(`Using Workday API: ${config.apiUrl}`);
  debug(`Tenant: ${config.tenant}`);
}

