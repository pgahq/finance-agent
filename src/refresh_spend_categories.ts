import { debug } from '@pga/logger';
import { deleteAllDocumentsByType } from './lib/database.js';
import { notifyResult } from './lib/slack.js';
import { withHandler, withQueryHandler, type ProcessingContext } from './lib/handlers.js';

const QUERY = `
  SELECT referenceID1, workdayID
  FROM spendCategories
  ORDER BY spendCategoryObject ASC
`;

export const handler = withHandler(async (context: ProcessingContext, _event) => {
  const startTime = Date.now();
  debug('Starting full spend category refresh - deleting all existing spend categories');

  try {
    debug('Deleting all existing spend categories from database...');
    const deletedCount = await deleteAllDocumentsByType(context.dbConnection, 'spend_category');
    debug(`Deleted ${deletedCount} existing spend categories`);

    const refreshHandler = withQueryHandler(QUERY)({
      processorFunctionName: `${process.env.AWS_STACK_NAME}-CacheSpendCategoriesProcessor`,
      pageSize: null
    });

    debug('Executing refresh handler...');
    await refreshHandler();

    const processingTime = Date.now() - startTime;
    debug('Refresh complete');

    await notifyResult(
      'refresh_spend_categories',
      'success',
      processingTime,
      { processingTime },
      undefined,
      'spend categories refreshed'
    );
  } catch (error) {
    const processingTime = Date.now() - startTime;
    debug('Error during refresh:', error);

    await notifyResult(
      'refresh_spend_categories',
      'error',
      processingTime,
      { processingTime: `${processingTime}ms` },
      error
    );

    throw error;
  }
});
