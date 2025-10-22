import { withBulkHandler } from './lib/actions.js';
import { debug } from '@pga/logger';
import { putJsonToS3, type S3Config } from './lib/s3.js';
import type { CachedSupplier, SupplierCacheData } from './lib/types.js';

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

async function processAction({ s3Config, data }: { s3Config: S3Config; data: unknown }): Promise<void> {
  debug('Processing and caching supplier data');
  debug('Raw suppliers data received:', JSON.stringify(data, null, 2));

  // Data is already the array from executeQuery
  const suppliers = data as any[];
  debug('Suppliers array:', JSON.stringify(suppliers, null, 2));

  // Check if we have data results
  if (!suppliers || suppliers.length === 0) {
    debug('No supplier data received - skipping cache update');
    return;
  }

  debug(`Processing ${suppliers.length} suppliers from Workday query`);

  // Transform the data to simplified format
  const simplifiedSuppliers: CachedSupplier[] = suppliers.map((supplier: any) => ({
    supplierId: supplier.supplier.id,
    supplierName: supplier.supplier.descriptor,
    lastUpdatedDateTime: supplier.lastUpdatedDateTime,
    supplierStatus: supplier.supplierStatus.descriptor,
    allPhoneNumbers: supplier.allPhoneNumbers?.map((p: any) => p.descriptor) || [],
    allEmailAddresses: supplier.allEmailAddresses?.map((e: any) => e.descriptor) || [],
    allAddresses: supplier.allAddresses?.map((a: any) => a.descriptor) || []
  }));

  // Store in S3 with simple key structure
  const cacheKey = 'cache/suppliers.json';
  const cacheData: SupplierCacheData = {
    cachedAt: new Date().toISOString(),
    totalCount: simplifiedSuppliers.length,
    suppliers: simplifiedSuppliers
  };
  await putJsonToS3(s3Config, cacheKey, cacheData);

  debug(`Successfully cached ${simplifiedSuppliers.length} suppliers to S3: ${cacheKey}`);
}

export const handler = withBulkHandler(QUERY)(processAction);
