import loadEnv from '@pga/lambda-env';
import { debug } from '@pga/logger';
import { getS3Config, putJsonToS3, type S3Config } from '../lib/s3.js';
import type { CachedSupplier, SupplierCacheData, WorkdayQueryResultDetail } from '../lib/types.js';

export const handler = async (event: { detail: WorkdayQueryResultDetail }) => {
  process.env = await loadEnv();
  debug('Cache suppliers event received:', JSON.stringify(event, null, 2));

  const { data, timestamp, requestId } = event.detail;
  
  debug(`Event timestamp: ${timestamp}`);
  debug(`Request ID: ${requestId}`);

  const s3Config = getS3Config(process.env as Record<string, string>);

  await processAction(s3Config, data);

  debug('Successfully cached suppliers data');
};


async function processAction(
  s3Config: S3Config,
  suppliersData: unknown
): Promise<void> {
  debug('Processing and caching supplier data');
  debug('Raw suppliers data received:', JSON.stringify(suppliersData, null, 2));

  // Cast the data to expected structure (new format with total and data array)
  const response = suppliersData as {
    total: number;
    data: Array<{
      supplier: {
        descriptor: string;
        id: string;
      };
      lastUpdatedDateTime: string;
      supplierStatus: {
        descriptor: string;
        id: string;
      };
      allPhoneNumbers?: Array<{
        descriptor: string;
        id: string;
      }>;
      allEmailAddresses?: Array<{
        descriptor: string;
        id: string;
      }>;
      allAddresses?: Array<{
        descriptor: string;
        id: string;
      }>;
    }>;
  };

  // Extract the data array from the response
  const suppliers = response?.data;
  debug('Response structure:', JSON.stringify(response, null, 2));
  debug('Suppliers array:', JSON.stringify(suppliers, null, 2));

  // Check if we have data results
  if (!suppliers || suppliers.length === 0) {
    debug('No supplier data received - skipping cache update');
    return;
  }

  debug(`Processing ${suppliers.length} suppliers from Workday query (total available: ${response.total})`);

  // Transform the data to simplified format
  const simplifiedSuppliers: CachedSupplier[] = suppliers.map(supplier => ({
    supplierId: supplier.supplier.id,
    supplierName: supplier.supplier.descriptor,
    lastUpdatedDateTime: supplier.lastUpdatedDateTime,
    supplierStatus: supplier.supplierStatus.descriptor,
    allPhoneNumbers: supplier.allPhoneNumbers?.map(p => p.descriptor) || [],
    allEmailAddresses: supplier.allEmailAddresses?.map(e => e.descriptor) || [],
    allAddresses: supplier.allAddresses?.map(a => a.descriptor) || []
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
