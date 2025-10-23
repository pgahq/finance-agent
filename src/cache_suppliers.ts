import { withBulkHandler } from './lib/actions.js';
import { debug } from '@pga/logger';
import { createSupplierContent, createEmbedding } from './lib/rag.js';
import { bulkInsertDocuments, bulkUpdateDocuments, bulkDeleteDocuments, getDocumentsByType } from './lib/database.js';

const QUERY = `
  SELECT 
    supplier, 
    lastUpdatedDateTime, 
    supplierStatus, 
    allPhoneNumbers, 
    allEmailAddresses, 
    allAddresses 
  FROM suppliers1 (dataSourceFilter = defaultFilter)
`;

async function processAction({ data, dbConnection }: { data: unknown; dbConnection: any }): Promise<void> {
  debug('Starting incremental supplier sync');

  // Data is already the array from executeQuery
  const suppliers = data as any[];

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
  const existingSuppliers = await getDocumentsByType(dbConnection, 'supplier');
  const existingSupplierMap = new Map(
    existingSuppliers.map(s => [s.workday_id, s])
  );

  // Create maps for efficient lookups
  const workdaySupplierMap = new Map(
    activeSuppliers.map((supplier: any) => [
      supplier.supplier.id,
      {
        supplierId: supplier.supplier.id,
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
          : undefined
      }
    ])
  );

  // Identify changes
  const newSuppliers: string[] = [];
  const updatedSuppliers: string[] = [];
  const unchangedSuppliers: string[] = [];
  const deletedSuppliers: string[] = [];

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

  // Check for deleted suppliers (in DB but not in Workday)
  for (const [supplierId] of existingSupplierMap) {
    if (!workdaySupplierMap.has(supplierId)) {
      deletedSuppliers.push(supplierId);
    }
  }

  debug(`Sync analysis: ${newSuppliers.length} new, ${updatedSuppliers.length} updated, ${unchangedSuppliers.length} unchanged, ${deletedSuppliers.length} deleted`);

  // Process changes using bulk operations
  let successCount = 0;
  let errorCount = 0;

  try {
    // Step 1: Bulk delete removed suppliers
    if (deletedSuppliers.length > 0) {
      debug(`Bulk deleting ${deletedSuppliers.length} removed suppliers...`);
      const deletedCount = await bulkDeleteDocuments(dbConnection, deletedSuppliers, 'supplier');
      successCount += deletedCount;
      debug(`Deleted ${deletedCount} suppliers`);
    }

    // Step 2: Prepare new suppliers for bulk insert in batches of 50
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
              supplierId: supplier.supplierId,
              supplierName: supplier.supplierName,
              workdayId: supplier.supplierId,
              lastUpdatedDateTime: supplier.lastUpdatedDateTime
            };
            
            const embedding = await createEmbedding(content);
            newSupplierDocuments.push({
              workdayId: supplier.supplierId,
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
          await bulkInsertDocuments(dbConnection, newSupplierDocuments);
          successCount += newSupplierDocuments.length;
        }
        
        debug(`Batch ${batchIndex + 1}/${totalBatches} complete: ${newSupplierDocuments.length} suppliers inserted (${Math.round(((batchIndex + 1) / totalBatches) * 100)}% complete)`);
      }
    }

    // Step 3: Prepare updated suppliers for bulk update in batches of 50
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
              supplierId: supplier.supplierId,
              supplierName: supplier.supplierName,
              workdayId: supplier.supplierId,
              lastUpdatedDateTime: supplier.lastUpdatedDateTime
            };
            
            const embedding = await createEmbedding(content);
            updatedSupplierDocuments.push({
              workdayId: supplier.supplierId,
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
          await bulkUpdateDocuments(dbConnection, updatedSupplierDocuments);
          successCount += updatedSupplierDocuments.length;
        }
        
        debug(`Update batch ${batchIndex + 1}/${totalBatches} complete: ${updatedSupplierDocuments.length} suppliers updated (${Math.round(((batchIndex + 1) / totalBatches) * 100)}% complete)`);
      }
    }

    debug(`Bulk sync complete: ${successCount} operations successful, ${errorCount} errors`);
    debug(`Skipped ${unchangedSuppliers.length} unchanged suppliers`);
    
  } catch (error) {
    debug('Error during bulk sync operations:', error);
    throw error;
  }
}

export const handler = withBulkHandler(QUERY)(processAction);
