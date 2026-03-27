import { debug } from '@pga/logger';
import { withProcessorHandler, withQueryHandler } from './lib/handlers.js';
import { createCostCenterContent } from './lib/rag.js';
import { syncDataSource } from './lib/sync.js';

const QUERY = `
  SELECT
    workdayID,
    name,
    code
  FROM costCenters
`;

export const handler = withQueryHandler(QUERY)({
  processorFunctionName: `${process.env.AWS_STACK_NAME}-CacheCostCentersProcessor`,
  pageSize: null
});

export const processor = withProcessorHandler(async (context, costCenters, _event) => {
  if (!costCenters || costCenters.length === 0) {
    debug('No cost center data received - skipping sync');
    return;
  }

  debug(`Processing ${costCenters.length} cost centers from Workday query`);

  const items = new Map(
    costCenters.map((cc: any) => [
      cc.workdayID,
      {
        workdayId: cc.workdayID,
        name: cc.name,
        code: cc.code,
      }
    ])
  );

  await syncDataSource({
    dbConnection: context.dbConnection,
    type: 'cost_center',
    items,
    totalCount: costCenters.length,
    createContent: createCostCenterContent,
    createMetadata: (cc) => ({
      workdayId: cc.workdayId,
      name: cc.name,
      code: cc.code,
    }),
    notifyLabel: 'cache_cost_centers',
    itemLabel: 'cost centers',
  });
});
