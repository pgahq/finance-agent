import { withQueryHandler, withProcessorHandler } from './lib/handlers.js';
import { debug } from '@pga/logger';
import { createSupplierContent, createEmbedding } from './lib/rag.js';
import { bulkInsertDocuments, bulkUpdateDocuments, getDocumentsByType } from './lib/database.js';
import { notifyResult } from './lib/slack.js';

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

// Query function - scheduled daily
export const handler = withQueryHandler(QUERY)({
  processorFunctionName: 'CacheSuppliersProcessor',
  pageSize: null // Processor executes query directly
});

// Processor function - invoked by query function or refresh
export const processor = withProcessorHandler(async (context, suppliers, _event) => {
  const startTime = Date.now();
  
  debug('Starting incremental supplier sync');

  try {
    // Check if we have data results
    if (!suppliers || suppliers.length === 0) {
      debug('No supplier data received - skipping sync');
      return;
    }

    debug(`Processing ${suppliers.length} suppliers from Workday query`);

    // Filter to Active suppliers only
    const activeSuppliers = suppliers.filter((supplier: any) => supplier.supplierStatus.descriptor === 'Active');
    debug(`Filtered to ${activeSuppliers.length} Active suppliers (${((activeSuppliers.length / suppliers.length) * 100).toFixed(1)}% of total)`);

    // Get existing suppliers from database
    debug('Fetching existing suppliers from database...');
    const existingSuppliers = await getDocumentsByType(context.dbConnection, 'supplier');
    const existingSupplierMap = new Map(
      existingSuppliers.map(s => [s.workday_id, s])
    );

    // Create maps for efficient lookups
    const workdaySupplierMap = new Map(
      activeSuppliers.map((supplier: any) => [
        supplier.supplier.id,
        {
          workdayId: supplier.supplier.id,
          supplierId: supplier.supplierID || supplier.supplier.id,
          supplierName: supplier.supplier.descriptor,
          lastUpdatedDateTime: supplier.lastUpdatedDateTime,
          allPhoneNumbers: supplier.allPhoneNumbers?.length > 0 
            ? supplier.allPhoneNumbers.map((p: any) => p.descriptor) 
            : undefined,
          allEmailAddresses: supplier.allEmailAddresses?.length > 0 
            ? supplier.allEmailAddresses.map((e: any) => e.descriptor) 
            : undefined,
          allAddresses: supplier.allAddresses?.length > 0 
            ? supplier.allAddresses.map((a: any) => a.descriptor) 
            : undefined,
          allAlternateNames: supplier.payeeAlternateNames?.length > 0 
            ? supplier.payeeAlternateNames.map((n: any) => n.descriptor) 
            : undefined
        }
      ])
    );

    // Identify changes
    const newSuppliers: string[] = [];
    const updatedSuppliers: string[] = [];
    const unchangedSuppliers: string[] = [];

    // Check each Workday supplier
    for (const [supplierId, workdaySupplier] of workdaySupplierMap) {
      const existingSupplier = existingSupplierMap.get(supplierId);
      
      if (!existingSupplier) {
        newSuppliers.push(supplierId);
      } else {
        const existingLastUpdated = existingSupplier.metadata?.lastUpdatedDateTime;
        if (existingLastUpdated !== workdaySupplier.lastUpdatedDateTime) {
          updatedSuppliers.push(supplierId);
        } else {
          unchangedSuppliers.push(supplierId);
        }
      }
    }

    debug(`Sync analysis: ${newSuppliers.length} new, ${updatedSuppliers.length} updated, ${unchangedSuppliers.length} unchanged`);

    // Process changes using bulk operations
    let successCount = 0;
    let errorCount = 0;

    // Step 1: Prepare new suppliers for bulk insert in batches of 50
    if (newSuppliers.length > 0) {
      debug(`Preparing ${newSuppliers.length} new suppliers for bulk insert in batches of 50...`);
      
      const batchSize = 50;
      const totalBatches = Math.ceil(newSuppliers.length / batchSize);
      
      for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
        const startIndex = batchIndex * batchSize;
        const endIndex = Math.min(startIndex + batchSize, newSuppliers.length);
        const batchSuppliers = newSuppliers.slice(startIndex, endIndex);
        
        const newSupplierDocuments = [];
        
        for (const supplierId of batchSuppliers) {
          try {
            const supplier = workdaySupplierMap.get(supplierId)!;
            const content = createSupplierContent(supplier);
            const metadata = {
              workdayId: supplier.workdayId,
              supplierId: supplier.supplierId,
              supplierName: supplier.supplierName,
              lastUpdatedDateTime: supplier.lastUpdatedDateTime
            };
            
            const embedding = await createEmbedding(content);
            newSupplierDocuments.push({
              workdayId: supplier.workdayId,
              type: 'supplier' as const,
              content,
              metadata,
              embedding
            });
          } catch (error) {
            debug(`Error preparing supplier ${supplierId} for insert:`, error);
            errorCount++;
          }
        }
        
        if (newSupplierDocuments.length > 0) {
          await bulkInsertDocuments(context.dbConnection, newSupplierDocuments);
          successCount += newSupplierDocuments.length;
        }
        
        debug(`Batch ${batchIndex + 1}/${totalBatches} complete: ${newSupplierDocuments.length} suppliers inserted (${Math.round(((batchIndex + 1) / totalBatches) * 100)}% complete)`);
      }
    }

    // Step 2: Prepare updated suppliers for bulk update in batches of 50
    if (updatedSuppliers.length > 0) {
      debug(`Preparing ${updatedSuppliers.length} updated suppliers for bulk update in batches of 50...`);
      
      const batchSize = 50;
      const totalBatches = Math.ceil(updatedSuppliers.length / batchSize);
      
      for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
        const startIndex = batchIndex * batchSize;
        const endIndex = Math.min(startIndex + batchSize, updatedSuppliers.length);
        const batchSuppliers = updatedSuppliers.slice(startIndex, endIndex);
        
        const updatedSupplierDocuments = [];
        
        for (const supplierId of batchSuppliers) {
          try {
            const supplier = workdaySupplierMap.get(supplierId)!;
            const content = createSupplierContent(supplier);
            const metadata = {
              workdayId: supplier.workdayId,
              supplierId: supplier.supplierId,
              supplierName: supplier.supplierName,
              lastUpdatedDateTime: supplier.lastUpdatedDateTime
            };
            
            const embedding = await createEmbedding(content);
            updatedSupplierDocuments.push({
              workdayId: supplier.workdayId,
              type: 'supplier' as const,
              content,
              metadata,
              embedding
            });
          } catch (error) {
            debug(`Error preparing supplier ${supplierId} for update:`, error);
            errorCount++;
          }
        }
        
        if (updatedSupplierDocuments.length > 0) {
          await bulkUpdateDocuments(context.dbConnection, updatedSupplierDocuments);
          successCount += updatedSupplierDocuments.length;
        }
        
        debug(`Update batch ${batchIndex + 1}/${totalBatches} complete: ${updatedSupplierDocuments.length} suppliers updated (${Math.round(((batchIndex + 1) / totalBatches) * 100)}% complete)`);
      }
    }

    const processingTime = Date.now() - startTime;
    debug(`Bulk sync complete: ${successCount} operations successful, ${errorCount} errors`);
    debug(`Skipped ${unchangedSuppliers.length} unchanged suppliers`);
    
    // Send Slack notification
    const status = errorCount > 0 ? 'error' : 'success';
    const details = {
      syncStats: {
        total: suppliers.length,
        new: newSuppliers.length,
        updated: updatedSuppliers.length,
        unchanged: unchangedSuppliers.length,
        errors: errorCount,
        processingTime
      }
    };

    await notifyResult(
      'cache_suppliers',
      status,
      processingTime,
      details,
      undefined,
      `${suppliers.length} suppliers`
    );
    
  } catch (error) {
    const processingTime = Date.now() - startTime;
    debug('Error during bulk sync operations:', error);
    
    // Send error notification to Slack
    await notifyResult(
      'cache_suppliers',
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

