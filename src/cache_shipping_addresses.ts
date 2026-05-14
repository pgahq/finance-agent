import { debug } from '@pga/logger';
import { withProcessorHandler, withQueryHandler } from './lib/handlers.js';
import { createShippingAddressContent } from './lib/rag.js';
import { syncDataSource } from './lib/sync.js';

/**
 * WQL: indexed locations with company context (typical ship-to / deliver-to targets).
 * If your tenant uses a different indexed view for ship-to addresses, adjust FROM/fields
 * in Workday’s WQL editor and update this query and the processor mapping below.
 */
const QUERY = `
  SELECT
    location,
    company,
    addressPrimary,
    lastUpdatedDateTime
  FROM locations
`;

function refId(value: { id?: string } | null | undefined): string | undefined {
  return value?.id;
}

function refDescriptor(value: { descriptor?: string } | null | undefined): string | undefined {
  return value?.descriptor;
}

export const handler = withQueryHandler(QUERY)({
  processorFunctionName: `${process.env.AWS_STACK_NAME}-CacheShippingAddressesProcessor`,
  pageSize: null
});

export const processor = withProcessorHandler(async (context, rows, _event) => {
  if (!rows || rows.length === 0) {
    debug('No shipping address / location data received - skipping sync');
    return;
  }

  debug(`Processing ${rows.length} rows from Workday WQL (shipping addresses cache)`);

  const items = new Map<string, {
    workdayId: string;
    locationName?: string;
    companyName?: string;
    addressPrimary?: string;
    lastUpdatedDateTime?: string;
  }>();

  for (const row of rows as any[]) {
    const locationId = refId(row.location);
    const workdayId = locationId;
    if (!workdayId) {
      debug('Skipping row without location.id');
      continue;
    }

    items.set(workdayId, {
      workdayId,
      locationName: refDescriptor(row.location),
      companyName: refDescriptor(row.company),
      addressPrimary: typeof row.addressPrimary === 'string' ? row.addressPrimary : refDescriptor(row.addressPrimary),
      lastUpdatedDateTime: row.lastUpdatedDateTime,
    });
  }

  await syncDataSource({
    dbConnection: context.dbConnection,
    type: 'shipping_address',
    items,
    totalCount: rows.length,
    createContent: createShippingAddressContent,
    createMetadata: (item) => ({
      workdayId: item.workdayId,
      locationName: item.locationName,
      companyName: item.companyName,
      lastUpdatedDateTime: item.lastUpdatedDateTime,
    }),
    isUpdated: (existingMetadata, item) =>
      existingMetadata?.lastUpdatedDateTime !== item.lastUpdatedDateTime,
    notifyLabel: 'cache_shipping_addresses',
    itemLabel: 'shipping addresses',
  });
});
