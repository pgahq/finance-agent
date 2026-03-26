import { debug } from '@pga/logger';
import { bulkInsertDocuments, bulkUpdateDocuments, getDocumentsByType } from './database.js';
import type { DatabaseConnection, DocumentType } from './database.js';
import { createEmbedding } from './rag.js';
import { notifyResult } from './slack.js';

const BATCH_SIZE = 50;

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
  /** e.g. 'cache_suppliers' */
  notifyLabel: string;
  /** e.g. 'suppliers' — used in debug messages and Slack summary */
  itemLabel: string;
}

async function processBatch<T>(
  workdayIds: string[],
  itemMap: Map<string, T>,
  type: DocumentType,
  createContent: (item: T) => string,
  createMetadata: (item: T) => Record<string, any>,
  itemLabel: string
): Promise<{ documents: Array<{ workdayId: string; type: DocumentType; content: string; metadata: Record<string, any>; embedding: number[] }>; errors: number }> {
  const documents = [];
  let errors = 0;

  for (const workdayId of workdayIds) {
    try {
      const item = itemMap.get(workdayId)!;
      const content = createContent(item);
      const metadata = createMetadata(item);
      const embedding = await createEmbedding(content);
      documents.push({ workdayId, type, content, metadata, embedding });
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

    debug(`Sync analysis: ${newIds.length} new, ${updatedIds.length} updated, ${unchangedIds.length} unchanged`);

    let successCount = 0;
    let errorCount = 0;

    if (newIds.length > 0) {
      debug(`Preparing ${newIds.length} new ${itemLabel} for bulk insert in batches of ${BATCH_SIZE}...`);
      const totalBatches = Math.ceil(newIds.length / BATCH_SIZE);

      for (let i = 0; i < totalBatches; i++) {
        const batch = newIds.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
        const { documents, errors } = await processBatch(batch, items, type, createContent, createMetadata, itemLabel);
        if (documents.length > 0) {
          await bulkInsertDocuments(dbConnection, documents);
          successCount += documents.length;
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
        const { documents, errors } = await processBatch(batch, items, type, createContent, createMetadata, itemLabel);
        if (documents.length > 0) {
          await bulkUpdateDocuments(dbConnection, documents);
          successCount += documents.length;
        }
        errorCount += errors;
        debug(`Update batch ${i + 1}/${totalBatches} complete: ${documents.length} ${itemLabel} updated (${Math.round(((i + 1) / totalBatches) * 100)}% complete)`);
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
