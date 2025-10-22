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

  // Data is already the array from executeQuery
  const suppliers = data as any[];

  // Check if we have data results
  if (!suppliers || suppliers.length === 0) {
    debug('No supplier data received - skipping cache update');
    return;
  }

  debug(`Processing ${suppliers.length} suppliers from Workday query`);

  // Filter to Active suppliers only
  const activeSuppliers = suppliers.filter((supplier: any) => supplier.supplierStatus.descriptor === 'Active');
  debug(`Filtered to ${activeSuppliers.length} Active suppliers (${((activeSuppliers.length / suppliers.length) * 100).toFixed(1)}% of total)`);

  // Transform the data to simplified format
  const simplifiedSuppliers: CachedSupplier[] = activeSuppliers.map((supplier: any) => {
      const simplified: any = {
        supplierId: supplier.supplier.id,
        supplierName: supplier.supplier.descriptor
      };

      // Only include non-empty arrays
      if (supplier.allPhoneNumbers?.length > 0) {
        simplified.allPhoneNumbers = supplier.allPhoneNumbers.map((p: any) => p.descriptor);
      }
      if (supplier.allEmailAddresses?.length > 0) {
        simplified.allEmailAddresses = supplier.allEmailAddresses.map((e: any) => e.descriptor);
      }
      if (supplier.allAddresses?.length > 0) {
        simplified.allAddresses = supplier.allAddresses.map((a: any) => a.descriptor);
      }

      return simplified;
    });

  // Store in S3 with simple key structure
  const cacheKey = 'cache/suppliers.json';
  const cacheData: SupplierCacheData = {
    cachedAt: new Date().toISOString(),
    totalCount: simplifiedSuppliers.length,
    suppliers: simplifiedSuppliers
  };
  await putJsonToS3(s3Config, cacheKey, cacheData);

  debug(`Successfully cached ${simplifiedSuppliers.length} Active suppliers to S3: ${cacheKey}`);
}

export const handler = withBulkHandler(QUERY)(processAction);
