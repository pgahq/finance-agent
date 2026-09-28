import { debug } from '@pga/logger';
import { withProcessorHandler, withQueryHandler } from './lib/handlers.js';
import { getDocumentsByType } from './lib/database.js';
import { createSupplierContent } from './lib/rag.js';
import { syncDataSource } from './lib/sync.js';
import { isWorkdayWid, textFromWqlValue } from './lib/workday_reference_id.js';

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

function supplierIdFromWql(value: unknown): string | undefined {
  const text = textFromWqlValue(value);
  return text && !isWorkdayWid(text) ? text : undefined;
}

// Processor function - invoked by query function or refresh
export const processor = withProcessorHandler(async (context, suppliers, _event) => {
  if (!suppliers || suppliers.length === 0) {
    debug('No supplier data received - skipping sync');
    return;
  }

  debug(`Processing ${suppliers.length} suppliers from Workday query`);

  const activeSuppliers = suppliers.filter((supplier: any) => supplier.supplierStatus.descriptor === 'Active');
  debug(`Filtered to ${activeSuppliers.length} Active suppliers (${((activeSuppliers.length / suppliers.length) * 100).toFixed(1)}% of total)`);

  const existing = await getDocumentsByType(context.dbConnection, 'supplier');
  const storedSupplierIds = new Map(
    existing
      .filter((document) => typeof document.metadata?.supplierId === 'string' && document.metadata.supplierId)
      .map((document) => [document.workday_id, document.metadata.supplierId as string])
  );

  const items = new Map(
    activeSuppliers.map((supplier: any) => [
      supplier.supplier.id,
      {
        workdayId: supplier.supplier.id,
        supplierName: supplier.supplier.descriptor,
        supplierId: supplierIdFromWql(supplier.supplierID) ?? storedSupplierIds.get(supplier.supplier.id),
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
      supplierName: supplier.supplierName,
      ...(supplier.supplierId ? { supplierId: supplier.supplierId } : {}),
      lastUpdatedDateTime: supplier.lastUpdatedDateTime,
    }),
    isUpdated: (
      existingMetadata: { lastUpdatedDateTime?: string; supplierId?: string } | undefined,
      supplier
    ) =>
      existingMetadata?.lastUpdatedDateTime !== supplier.lastUpdatedDateTime
      || existingMetadata?.supplierId !== supplier.supplierId,
    notifyLabel: 'cache_suppliers',
    itemLabel: 'suppliers',
  });
});
