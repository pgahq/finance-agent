import { withQueryHandler, withProcessorHandler } from './lib/handlers.js';
import { debug } from '@pga/logger';
import { createSupplierContent } from './lib/rag.js';
import { syncDataSource } from './lib/sync.js';

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
  processorFunctionName: `${process.env.AWS_STACK_NAME}-CacheSuppliersProcessor`,
  pageSize: null // Processor executes query directly
});

// Processor function - invoked by query function or refresh
export const processor = withProcessorHandler(async (context, suppliers, _event) => {
  if (!suppliers || suppliers.length === 0) {
    debug('No supplier data received - skipping sync');
    return;
  }

  debug(`Processing ${suppliers.length} suppliers from Workday query`);

  const activeSuppliers = suppliers.filter((supplier: any) => supplier.supplierStatus.descriptor === 'Active');
  debug(`Filtered to ${activeSuppliers.length} Active suppliers (${((activeSuppliers.length / suppliers.length) * 100).toFixed(1)}% of total)`);

  const items = new Map(
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
          : undefined,
      }
    ])
  );

  await syncDataSource({
    dbConnection: context.dbConnection,
    type: 'supplier',
    items,
    totalCount: suppliers.length,
    createContent: createSupplierContent,
    createMetadata: (supplier) => ({
      workdayId: supplier.workdayId,
      supplierId: supplier.supplierId,
      supplierName: supplier.supplierName,
      lastUpdatedDateTime: supplier.lastUpdatedDateTime,
    }),
    isUpdated: (existingMetadata, supplier) =>
      existingMetadata?.lastUpdatedDateTime !== supplier.lastUpdatedDateTime,
    notifyLabel: 'cache_suppliers',
    itemLabel: 'suppliers',
  });
});
