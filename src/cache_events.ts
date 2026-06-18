import { debug } from '@pga/logger';
import { withProcessorHandler, withQueryHandler } from './lib/handlers.js';
import { createEventContent } from './lib/rag.js';
import { syncDataSource } from './lib/sync.js';

const buildQuery = async () => {
  const date = new Date();
  date.setMonth(date.getMonth() - 18);
  const dateStr = date.toISOString().split('T')[0];
  return `SELECT name, workdayID FROM customOrganizations WHERE type1 IN (cab0b1d2505a016ad8c131e25b273532) AND cf_CFLRVEventDate >= '${dateStr}' ORDER BY type1 ASC, organization ASC`;
};

export const handler = withQueryHandler(buildQuery)({
  processorFunctionName: `${process.env.AWS_STACK_NAME}-CacheEventsProcessor`,
  pageSize: null
});

export const processor = withProcessorHandler(async (context, events, _event) => {
  if (!events || events.length === 0) {
    debug('No event data received - skipping sync');
    return;
  }

  debug(`Processing ${events.length} events from Workday query`);

  const items = new Map(
    events.map((event: any) => [
      event.workdayID,
      {
        workdayId: event.workdayID,
        name: event.name,
      }
    ])
  );

  await syncDataSource({
    dbConnection: context.dbConnection,
    type: 'event',
    items,
    totalCount: events.length,
    createContent: createEventContent,
    createMetadata: (event) => ({
      workdayId: event.workdayId,
      name: event.name,
    }),
    notifyLabel: 'cache_events',
    itemLabel: 'events',
  });
});
