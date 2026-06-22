import { debug } from '@pga/logger';
import { withProcessorHandler, withQueryHandler } from './lib/handlers.js';
import { createFundContent } from './lib/rag.js';
import { syncDataSource } from './lib/sync.js';

const QUERY = `
  SELECT
    referenceID1,
    workdayID
  FROM funds
  ORDER BY fund ASC
`;

export const handler = withQueryHandler(QUERY)({
  processorFunctionName: `${process.env.AWS_STACK_NAME}-CacheFundsProcessor`,
  pageSize: null
});

export const processor = withProcessorHandler(async (context, funds, _event) => {
  if (!funds || funds.length === 0) {
    debug('No fund data received - skipping sync');
    return;
  }

  debug(`Processing ${funds.length} funds from Workday query`);

  const items = new Map(
    funds.map((fund: any) => [
      fund.workdayID,
      {
        workdayId: fund.workdayID,
        referenceId: fund.referenceID1,
      }
    ])
  );

  await syncDataSource({
    dbConnection: context.dbConnection,
    type: 'fund',
    items,
    totalCount: funds.length,
    createContent: createFundContent,
    createMetadata: (fund) => ({
      workdayId: fund.workdayId,
      referenceId: fund.referenceId,
    }),
    notifyLabel: 'cache_funds',
    itemLabel: 'funds',
  });
});
