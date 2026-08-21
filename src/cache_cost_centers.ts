import { debug } from '@pga/logger';
import { withProcessorHandler, withQueryHandler } from './lib/handlers.js';
import { createCostCenterContent } from './lib/rag.js';
import {
  EMPTY_RELATED_LOB,
  parseRelatedLob,
  relatedLobEquals,
  type RelatedLob,
} from './lib/related_worktags.js';
import { syncDataSource } from './lib/sync.js';
import { getRelatedWorktagsForCostCenters } from './lib/workday.js';

const QUERY = `
  SELECT
    workdayID,
    name,
    code
  FROM costCenters
  WHERE inactive != true
`;

export const handler = withQueryHandler(QUERY)({
  processorFunctionName: `${process.env.AWS_STACK_NAME}-CacheCostCentersProcessor`,
  pageSize: null
});

interface CostCenterRecord {
  workdayId: string;
  name: string;
  code: string;
  relatedLob: RelatedLob;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null;
}

function parseCostCenterWqlRow(row: unknown): { workdayId: string; name: string; code: string } | null {
  if (!isRecord(row) || typeof row.workdayID !== 'string' || !row.workdayID) return null;
  return {
    workdayId: row.workdayID,
    name: typeof row.name === 'string' ? row.name : '',
    code: typeof row.code === 'string' ? row.code : '',
  };
}

function parseCostCenterMetadata(value: unknown): { name?: string; code?: string; relatedLob?: RelatedLob } {
  if (!isRecord(value)) return {};
  return {
    name: typeof value.name === 'string' ? value.name : undefined,
    code: typeof value.code === 'string' ? value.code : undefined,
    relatedLob: parseRelatedLob(value.relatedLob),
  };
}

export const processor = withProcessorHandler(async (context, costCenters, event) => {
  if (!costCenters || costCenters.length === 0) {
    debug('No cost center data received - skipping sync');
    return;
  }

  debug(`Processing ${costCenters.length} cost centers from Workday query`);

  const rows = costCenters.map(parseCostCenterWqlRow).filter((row): row is NonNullable<typeof row> => row != null);
  if (rows.length === 0) {
    debug('No valid cost center rows received - skipping sync');
    return;
  }

  let relatedByKey = new Map<string, RelatedLob>();
  try {
    relatedByKey = await getRelatedWorktagsForCostCenters(
      context,
      rows.map(row => row.workdayId)
    );
  } catch (error) {
    debug('Failed to fetch related worktags for cost centers; continuing without related LOB metadata:', error);
  }

  const items = new Map<string, CostCenterRecord>(
    rows.map(row => [
      row.workdayId,
      {
        workdayId: row.workdayId,
        name: row.name,
        code: row.code,
        relatedLob: relatedByKey.get(row.workdayId)
          ?? relatedByKey.get(row.code)
          ?? EMPTY_RELATED_LOB,
      }
    ])
  );

  await syncDataSource({
    dbConnection: context.dbConnection,
    type: 'cost_center',
    items,
    totalCount: costCenters.length,
    createContent: createCostCenterContent,
    createMetadata: (cc) => ({
      workdayId: cc.workdayId,
      name: cc.name,
      code: cc.code,
      relatedLob: cc.relatedLob,
    }),
    isUpdated: (existingMetadata, cc) => {
      const existing = parseCostCenterMetadata(existingMetadata);
      return existing.name !== cc.name
        || existing.code !== cc.code
        || !relatedLobEquals(existing.relatedLob, cc.relatedLob);
    },
    notifyLabel: 'cache_cost_centers',
    itemLabel: 'cost centers',
    pruneAbsent: true,
    sourceTotal: event?.sourceTotal,
    sourceFetchedCount: costCenters.length,
    pruneDryRun: process.env.COST_CENTER_PRUNE_DRY_RUN === 'true',
  });
}, { requireCompleteTotal: true });
