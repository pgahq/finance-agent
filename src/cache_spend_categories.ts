import { debug } from '@pga/logger';
import { withProcessorHandler, withQueryHandler } from './lib/handlers.js';
import { createSpendCategoryContent } from './lib/rag.js';
import { syncDataSource } from './lib/sync.js';

const QUERY = `
  SELECT spendCategoryObject, referenceID1, workdayID
  FROM spendCategories
  ORDER BY spendCategoryObject ASC
`;

export const handler = withQueryHandler(QUERY)({
  processorFunctionName: `${process.env.AWS_STACK_NAME}-CacheSpendCategoriesProcessor`,
  pageSize: null
});

export const processor = withProcessorHandler(async (context, spendCategories, _event) => {
  if (!spendCategories || spendCategories.length === 0) {
    debug('No spend category data received - skipping sync');
    return;
  }

  debug(`Processing ${spendCategories.length} spend categories from Workday query`);

  const items = new Map(
    spendCategories.map((sc: any) => [
      sc.workdayID,
      {
        workdayId: sc.workdayID,
        name: sc.spendCategoryObject,
        referenceId: sc.referenceID1,
      }
    ])
  );

  await syncDataSource({
    dbConnection: context.dbConnection,
    type: 'spend_category',
    items,
    totalCount: spendCategories.length,
    createContent: createSpendCategoryContent,
    createMetadata: (sc) => ({
      workdayId: sc.workdayId,
      name: sc.name,
      referenceId: sc.referenceId,
    }),
    notifyLabel: 'cache_spend_categories',
    itemLabel: 'spend categories',
  });
});
