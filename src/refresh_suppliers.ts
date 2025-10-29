import { debug } from '@pga/logger';
import { deleteAllDocumentsByType } from './lib/database.js';
import { executeWorkdayQuery } from './lib/workday.js';
import { notifyResult } from './lib/slack.js';
import { withQueryHandler, withHandler, type ProcessingContext } from './lib/handlers.js';

const QUERY = `
  SELECT 
    supplier, 
    supplierID,
    lastUpdatedDateTime, 
    supplierStatus, 
    allPhoneNumbers, 
    allEmailAddresses, 
    allAddresses,
    payeeAlternateNames
  FROM suppliers1 (dataSourceFilter = defaultFilter)
`;

const PAGE_SIZE = 500; // Process suppliers in batches to avoid timeouts

export const handler = withHandler(async (context: ProcessingContext, _event) => {
  const startTime = Date.now();
  debug('Starting full supplier refresh - deleting all existing suppliers');
  
  try {
    // Step 1: Delete all existing suppliers
    debug('Deleting all existing suppliers from database...');
    const deletedCount = await deleteAllDocumentsByType(context.dbConnection, 'supplier');
    debug(`Deleted ${deletedCount} existing suppliers`);
    
    // Step 2: Get total count from Workday
    debug('Getting total supplier count from Workday...');
    const totalResult = await executeWorkdayQuery(context.workdayConfig, QUERY);
    const totalSuppliers = totalResult.total || 0;
    
    if (totalSuppliers === 0) {
      debug('No suppliers found in Workday');
      await notifyResult(
        'refresh_suppliers',
        'success',
        Date.now() - startTime,
        { message: 'No suppliers found in Workday' }
      );
      return;
    }
    
    debug(`Found ${totalSuppliers} total suppliers in Workday`);
    
    // Step 3: Create internal query handler with pagination
    const totalPages = Math.ceil(totalSuppliers / PAGE_SIZE);
    debug(`Will process ${totalSuppliers} suppliers in ${totalPages} batches of ${PAGE_SIZE} each`);
    
    // Create internal query handler that invokes CacheSuppliersProcessor
    const refreshHandler = withQueryHandler(QUERY)({
      processorFunctionName: 'CacheSuppliersProcessor',
      pageSize: PAGE_SIZE
    });
    
    // Step 4: Execute the refresh handler
    debug('Executing refresh handler with pagination...');
    await refreshHandler();
    
    const processingTime = Date.now() - startTime;
    debug(`Refresh complete: ${totalSuppliers} suppliers processed in ${totalPages} batches`);
    
    // Send Slack notification
    await notifyResult(
      'refresh_suppliers',
      'success',
      processingTime,
      {
        refreshStats: {
          totalSuppliers,
          totalPages,
          pageSize: PAGE_SIZE,
          processingTime
        }
      },
      undefined,
      `${totalPages} cache batches processed`
    );
    
  } catch (error) {
    const processingTime = Date.now() - startTime;
    debug('Error during refresh:', error);
    
    // Send error notification to Slack
    await notifyResult(
      'refresh_suppliers',
      'error',
      processingTime,
      {
        processingTime: `${processingTime}ms`
      },
      error
    );
    
    throw error;
  }
});

