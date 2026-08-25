import { debug } from '@pga/logger';
import { bulkDeleteDocuments, bulkInsertDocuments, bulkUpdateDocuments, getDocumentsByType } from './database.js';
import type { DatabaseConnection, DocumentType } from './database.js';
import { createEmbedding } from './rag.js';
import { notifyResult } from './slack.js';

const BATCH_SIZE = 50;
const ABSENT_ID_SAMPLE_LIMIT = 50;

export interface SyncDataSourceOptions<T> {
  dbConnection: DatabaseConnection;
  type: DocumentType;
  /** workdayId → transformed item */
  items: Map<string, T>;
  /** Total count before any pre-filtering, used in the Slack notification summary */
  totalCount: number;
  createContent: (item: T) => string;
  createMetadata: (item: T) => Record<string, any>;
  /** When provided, existing items are checked for updates. Omit for insert-only sources. */
  isUpdated?: (existingMetadata: any, item: T) => boolean;
  /**
   * Delete existing documents of this type whose workdayId is not in `items`.
   * Requires `sourceTotal` to equal `sourceFetchedCount` (Workday `total` matches
   * the raw fetched array length, not Map size after duplicate IDs are dropped).
   * Skipped when `items` is empty. Do not enable for windowed sources such as events.
   */
  pruneAbsent?: boolean;
  /** Workday-reported row count for the query that produced the snapshot. Required to prune. */
  sourceTotal?: number;
  /** Length of the raw fetched array before Map dedupe. Required to prune. */
  sourceFetchedCount?: number;
  /** Log absent IDs and Slack stats without deleting. */
  pruneDryRun?: boolean;
  /** e.g. 'cache_suppliers' */
  notifyLabel: string;
  /** e.g. 'suppliers' — used in debug messages and Slack summary */
  itemLabel: string;
}

function pruneSkipReason(options: {
  pruneAbsent?: boolean;
  itemsSize: number;
  sourceTotal?: number;
  sourceFetchedCount?: number;
}): string | undefined {
  if (!options.pruneAbsent) return undefined;
  if (options.itemsSize === 0) return 'empty snapshot';
  if (typeof options.sourceTotal !== 'number' || !Number.isFinite(options.sourceTotal)) {
    return 'missing source total';
  }
  if (typeof options.sourceFetchedCount !== 'number' || !Number.isFinite(options.sourceFetchedCount)) {
    return 'missing fetched count';
  }
  if (options.sourceFetchedCount !== options.sourceTotal) {
    return `incomplete snapshot: fetched ${options.sourceFetchedCount} of ${options.sourceTotal}`;
  }
  return undefined;
}

type SyncDocument = {
  workdayId: string;
  type: DocumentType;
  content: string;
  metadata: Record<string, any>;
  embedding?: number[];
};

async function processBatch<T>(
  workdayIds: string[],
  itemMap: Map<string, T>,
  type: DocumentType,
  createContent: (item: T) => string,
  createMetadata: (item: T) => Record<string, any>,
  itemLabel: string,
  existingById?: Map<string, { content?: string | null }>
): Promise<{ documents: SyncDocument[]; errors: number }> {
  const documents: SyncDocument[] = [];
  let errors = 0;

  for (const workdayId of workdayIds) {
    try {
      const item = itemMap.get(workdayId)!;
      const content = createContent(item);
      const metadata = createMetadata(item);
      const existingContent = existingById?.get(workdayId)?.content;
      const document: SyncDocument = { workdayId, type, content, metadata };
      if (existingContent !== content) {
        document.embedding = await createEmbedding(content);
      }
      documents.push(document);
    } catch (error) {
      debug(`Error preparing ${itemLabel} ${workdayId}:`, error);
      errors++;
    }
  }

  return { documents, errors };
}

export async function syncDataSource<T>(options: SyncDataSourceOptions<T>): Promise<void> {
  const {
    dbConnection,
    type,
    items,
    totalCount,
    createContent,
    createMetadata,
    isUpdated,
    pruneAbsent,
    sourceTotal,
    sourceFetchedCount,
    pruneDryRun,
    notifyLabel,
    itemLabel,
  } = options;

  const startTime = Date.now();

  try {
    const existingDocs = await getDocumentsByType(dbConnection, type);
    const existingMap = new Map(existingDocs.map(d => [d.workday_id, d]));

    const newIds: string[] = [];
    const updatedIds: string[] = [];
    const unchangedIds: string[] = [];

    for (const [workdayId, item] of items) {
      const existing = existingMap.get(workdayId);
      if (!existing) {
        newIds.push(workdayId);
      } else if (isUpdated && isUpdated(existing.metadata, item)) {
        updatedIds.push(workdayId);
      } else {
        unchangedIds.push(workdayId);
      }
    }

    const staleIds = pruneAbsent && items.size > 0
      ? existingDocs.map(doc => doc.workday_id).filter(workdayId => !items.has(workdayId))
      : [];
    const absentSample = staleIds.slice(0, ABSENT_ID_SAMPLE_LIMIT);
    const pruneSkipped = pruneSkipReason({
      pruneAbsent,
      itemsSize: items.size,
      sourceTotal,
      sourceFetchedCount,
    });

    debug(`Sync analysis: ${newIds.length} new, ${updatedIds.length} updated, ${unchangedIds.length} unchanged, ${staleIds.length} absent`);

    let successCount = 0;
    let errorCount = 0;

    if (newIds.length > 0) {
      debug(`Preparing ${newIds.length} new ${itemLabel} for bulk insert in batches of ${BATCH_SIZE}...`);
      const totalBatches = Math.ceil(newIds.length / BATCH_SIZE);

      for (let i = 0; i < totalBatches; i++) {
        const batch = newIds.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
        const { documents, errors } = await processBatch(batch, items, type, createContent, createMetadata, itemLabel);
        const inserted = documents.filter((doc): doc is SyncDocument & { embedding: number[] } => Array.isArray(doc.embedding));
        if (inserted.length > 0) {
          await bulkInsertDocuments(dbConnection, inserted);
          successCount += inserted.length;
        }
        errorCount += errors;
        debug(`Insert batch ${i + 1}/${totalBatches} complete: ${documents.length} ${itemLabel} inserted (${Math.round(((i + 1) / totalBatches) * 100)}% complete)`);
      }
    }

    if (updatedIds.length > 0) {
      debug(`Preparing ${updatedIds.length} updated ${itemLabel} for bulk update in batches of ${BATCH_SIZE}...`);
      const totalBatches = Math.ceil(updatedIds.length / BATCH_SIZE);

      for (let i = 0; i < totalBatches; i++) {
        const batch = updatedIds.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
        const { documents, errors } = await processBatch(
          batch,
          items,
          type,
          createContent,
          createMetadata,
          itemLabel,
          existingMap
        );
        if (documents.length > 0) {
          await bulkUpdateDocuments(dbConnection, documents);
          successCount += documents.length;
        }
        errorCount += errors;
        debug(`Update batch ${i + 1}/${totalBatches} complete: ${documents.length} ${itemLabel} updated (${Math.round(((i + 1) / totalBatches) * 100)}% complete)`);
      }
    }

    let deletedCount = 0;
    if (staleIds.length > 0) {
      debug(
        `${pruneSkipped ? 'Would prune' : pruneDryRun ? 'Dry-run prune' : 'Pruning'} ${staleIds.length} ${itemLabel} absent from the current snapshot`,
        absentSample
      );
      if (pruneSkipped) {
        debug(`Skipping prune: ${pruneSkipped}`);
      } else if (pruneDryRun) {
        debug(`Dry-run prune: ${staleIds.length} ${itemLabel} not deleted`);
      } else {
        deletedCount = await bulkDeleteDocuments(dbConnection, staleIds, type);
        successCount += deletedCount;
      }
    }

    const processingTime = Date.now() - startTime;
    debug(`Bulk sync complete: ${successCount} operations successful, ${errorCount} errors`);
    debug(`Skipped ${unchangedIds.length} unchanged ${itemLabel}`);

    await notifyResult(
      notifyLabel,
      errorCount > 0 ? 'error' : 'success',
      processingTime,
      {
        syncStats: {
          total: totalCount,
          new: newIds.length,
          updated: updatedIds.length,
          unchanged: unchangedIds.length,
          ...(pruneAbsent ? {
            deleted: deletedCount,
            absent: staleIds.length,
            ...(absentSample.length > 0 ? { absentIds: absentSample } : {}),
            ...(pruneSkipped ? { pruneSkipped } : {}),
            ...(pruneDryRun && !pruneSkipped ? { dryRun: true } : {}),
          } : {}),
          errors: errorCount,
          processingTime,
        }
      },
      undefined,
      `${totalCount} ${itemLabel}`
    );
  } catch (error) {
    const processingTime = Date.now() - startTime;
    debug(`Error during ${itemLabel} bulk sync:`, error);

    await notifyResult(
      notifyLabel,
      'error',
      processingTime,
      { processingTime: `${processingTime}ms` },
      error
    );

    throw error;
  }
}
