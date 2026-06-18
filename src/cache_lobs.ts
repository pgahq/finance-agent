import { debug } from '@pga/logger';
import { withProcessorHandler, withQueryHandler } from './lib/handlers.js';
import { createLobContent } from './lib/rag.js';
import { syncDataSource } from './lib/sync.js';

const QUERY = `
  SELECT
    name,
    referenceID1,
    workdayID
  FROM customOrganizations
  WHERE type1 IN (cab0b1d2505a01ed9c314be25b273d32)
    AND inactive != true
  ORDER BY type1 ASC, organization ASC
`;

export const handler = withQueryHandler(QUERY)({
  processorFunctionName: `${process.env.AWS_STACK_NAME}-CacheLobsProcessor`,
  pageSize: null
});

export const processor = withProcessorHandler(async (context, lobs, _event) => {
  if (!lobs || lobs.length === 0) {
    debug('No LOB data received - skipping sync');
    return;
  }

  debug(`Processing ${lobs.length} LOBs from Workday query`);

  const items = new Map(
    lobs.map((lob: any) => [
      lob.workdayID,
      {
        workdayId: lob.workdayID,
        name: lob.name,
        referenceId: lob.referenceID1,
      }
    ])
  );

  await syncDataSource({
    dbConnection: context.dbConnection,
    type: 'lob',
    items,
    totalCount: lobs.length,
    createContent: createLobContent,
    createMetadata: (lob) => ({
      workdayId: lob.workdayId,
      name: lob.name,
      referenceId: lob.referenceId,
    }),
    notifyLabel: 'cache_lobs',
    itemLabel: 'LOBs',
  });
});
