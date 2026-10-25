import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { EvalDocumentRef } from '../lib/eval_cases.js';

/** The only S3 operations the evals use. Every one is a read; there is deliberately no way to write from here. */
export type ReadOnlyS3 = Pick<S3Client, 'send'>;

const CREATE_PREFIX = 'new-invoices/';
const ENRICH_PREFIX = 'attachments/';

function errorName(error: unknown): string {
  const record = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return `${record?.name ?? 'Error'}${record?.$metadata?.httpStatusCode ? ` (${record.$metadata.httpStatusCode})` : ''}`;
}

function isNotFound(error: unknown): boolean {
  const record = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return record?.name === 'NotFound' || record?.name === 'NoSuchKey' || record?.name === 'NoSuchVersion' || record?.$metadata?.httpStatusCode === 404;
}

function isAccessDenied(error: unknown): boolean {
  const record = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return record?.name === 'AccessDenied' || record?.name === 'Forbidden' || record?.$metadata?.httpStatusCode === 403;
}

/**
 * Pins one object with HeadObject. Without `versionId` S3 describes the current version. A missing object comes back as
 * `status: 'missing'`; so does a 403, because without s3:ListBucket on the prefix S3 answers 403 for a key that does not exist.
 */
export async function pinDocument(
  s3: ReadOnlyS3,
  bucket: string,
  key: string,
  extra: Partial<EvalDocumentRef> & { source: EvalDocumentRef['source']; versionId?: string }
): Promise<EvalDocumentRef> {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key, ...(extra.versionId ? { VersionId: extra.versionId } : {}) }));
    const attachmentId = head.Metadata?.['attachment-id'];
    const originalFileName = head.Metadata?.['original-filename'];
    return {
      ...extra,
      bucket,
      key,
      ...(head.VersionId && head.VersionId !== 'null' ? { versionId: head.VersionId } : {}),
      ...(head.ETag ? { etag: head.ETag } : {}),
      ...(head.ContentType ? { contentType: head.ContentType } : {}),
      ...(head.ContentLength != null ? { sizeBytes: head.ContentLength } : {}),
      ...(head.LastModified ? { lastModified: head.LastModified.toISOString() } : {}),
      ...(extra.source === 'attachments_prefix' ? {
        workdayAttachmentRef: {
          workdayInvoiceWid: key.split('/')[1] ?? '',
          ...(attachmentId ? { attachmentId } : {}),
          ...(originalFileName ? { originalFileName } : {}),
        },
      } : {}),
      status: head.VersionId && head.VersionId !== 'null' ? 'pinned' : 'unverified',
      ...(head.VersionId && head.VersionId !== 'null' ? {} : { note: 'The bucket returned no version ID, so these bytes are not pinned.' }),
    };
  } catch (error) {
    if (isNotFound(error) || isAccessDenied(error)) {
      return {
        ...extra,
        bucket,
        key,
        status: 'missing',
        note: isAccessDenied(error)
          ? `${errorName(error)}: no s3:GetObject${extra.versionId ? '/GetObjectVersion' : ''} on this key, or the key does not exist`
          : `${errorName(error)}: object or version no longer exists`,
      };
    }
    throw error;
  }
}

function fileNameOfKey(key: string): string {
  return key.slice(key.lastIndexOf('/') + 1);
}

/** Create-path documents: the keys the agent recorded on its write snapshot, in cluster order. */
export async function pinCreateDocuments(
  s3: ReadOnlyS3,
  bucket: string,
  keys: string[],
  kinds: string[] = []
): Promise<EvalDocumentRef[]> {
  const documents: EvalDocumentRef[] = [];
  for (const [index, key] of keys.entries()) {
    if (!key.startsWith(CREATE_PREFIX)) {
      documents.push({
        bucket,
        key,
        status: 'missing',
        source: 'snapshot',
        note: `Key is outside ${CREATE_PREFIX}; the eval role does not read it`,
      });
      continue;
    }
    documents.push(await pinDocument(s3, bucket, key, {
      source: 'snapshot',
      fileName: fileNameOfKey(key).replace(/^\d+-/, ''),
      ...(kinds[index] ? { kind: kinds[index] } : {}),
    }));
  }
  return documents;
}

interface ObjectVersionSummary {
  Key?: string;
  VersionId?: string;
  LastModified?: Date;
}

/**
 * Enrich-path documents. The enrich snapshot does not record keys, and every enrich run overwrites
 * `attachments/{workdayInvoiceWid}/{fileName}`, so list the versions under that prefix and take, for each file name,
 * the newest version written at or before the agent's write. Versions written later belong to a re-enrich and may
 * hold different bytes. A file whose only versions are newer comes back missing.
 */
export async function pinEnrichDocuments(
  s3: ReadOnlyS3,
  bucket: string,
  workdayInvoiceWid: string,
  agentWrittenAt: Date
): Promise<EvalDocumentRef[]> {
  const prefix = `${ENRICH_PREFIX}${workdayInvoiceWid}/`;
  const versions: ObjectVersionSummary[] = [];
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  for (;;) {
    const page = await s3.send(new ListObjectVersionsCommand({
      Bucket: bucket,
      Prefix: prefix,
      ...(keyMarker ? { KeyMarker: keyMarker } : {}),
      ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
    }));
    versions.push(...(page.Versions ?? []));
    if (!page.IsTruncated) break;
    keyMarker = page.NextKeyMarker;
    versionIdMarker = page.NextVersionIdMarker;
    if (!keyMarker && !versionIdMarker) break;
  }

  const byKey = new Map<string, ObjectVersionSummary[]>();
  for (const version of versions) {
    if (!version.Key || !version.VersionId) continue;
    byKey.set(version.Key, [...(byKey.get(version.Key) ?? []), version]);
  }

  const documents: EvalDocumentRef[] = [];
  for (const [key, keyVersions] of [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const eligible = keyVersions
      .filter((version) => version.LastModified && version.LastModified.getTime() <= agentWrittenAt.getTime())
      .sort((a, b) => b.LastModified!.getTime() - a.LastModified!.getTime());
    const fileName = fileNameOfKey(key);
    const chosen = eligible[0];
    if (!chosen) {
      if (keyVersions.every((version) => version.LastModified && version.LastModified.getTime() > agentWrittenAt.getTime())) {
        documents.push({
          bucket,
          key,
          fileName,
          status: 'missing',
          source: 'attachments_prefix',
          note: 'Every remaining version was written after the agent wrote this invoice (a re-enrich replaced the one it read, and that version expired).',
        });
      }
      continue;
    }
    documents.push(await pinDocument(s3, bucket, key, { source: 'attachments_prefix', fileName, versionId: chosen.VersionId }));
  }
  return documents;
}

export interface LoadedDocument {
  buffer: Buffer;
  contentType: string;
  etag?: string;
}

/** Reads the pinned version. Throws when the object is gone or its ETag no longer matches the one in the case. */
export async function readPinnedDocument(s3: ReadOnlyS3, ref: EvalDocumentRef): Promise<LoadedDocument> {
  if (ref.status !== 'pinned') {
    throw new Error(`Document ${ref.key} is ${ref.status}${ref.note ? `: ${ref.note}` : ''}`);
  }
  const response = await s3.send(new GetObjectCommand({ Bucket: ref.bucket, Key: ref.key, VersionId: ref.versionId }));
  if (ref.etag && response.ETag && response.ETag !== ref.etag) {
    throw new Error(`Document ${ref.key} version ${ref.versionId} has ETag ${response.ETag}, expected ${ref.etag}`);
  }
  const bytes = await response.Body?.transformToByteArray();
  return {
    buffer: Buffer.from(bytes ?? []),
    contentType: ref.contentType ?? response.ContentType ?? 'application/octet-stream',
    ...(response.ETag ? { etag: response.ETag } : {}),
  };
}
