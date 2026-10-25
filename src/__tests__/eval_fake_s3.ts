/* eslint-disable @typescript-eslint/require-await -- stubs implement async interfaces */
import { GetObjectCommand, HeadObjectCommand, ListObjectVersionsCommand } from '@aws-sdk/client-s3';
import type { ReadOnlyS3 } from '../eval/s3_documents.js';

export interface FakeVersion {
  key: string;
  versionId: string;
  lastModified: string;
  body?: string;
  contentType?: string;
  metadata?: Record<string, string>;
  isLatest?: boolean;
}

const etagOf = (version: FakeVersion) => `"etag-${version.versionId}"`;

/** An in-memory versioned bucket that answers only the read commands the evals use, and records every command. */
export function fakeS3(versions: FakeVersion[], options: { denyKeys?: string[] } = {}): ReadOnlyS3 & { commands: string[] } {
  const commands: string[] = [];
  const find = (key: string, versionId?: string) => {
    const matches = versions.filter((version) => version.key === key).sort((a, b) => b.lastModified.localeCompare(a.lastModified));
    return versionId ? matches.find((version) => version.versionId === versionId) : matches[0];
  };
  const fail = (name: string, status: number) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
  return {
    commands,
    send: async (command: unknown) => {
      const input = (command as { input: { Key?: string; VersionId?: string; Prefix?: string } }).input;
      if (command instanceof HeadObjectCommand || command instanceof GetObjectCommand) {
        commands.push(`${command.constructor.name} ${input.Key}${input.VersionId ? `?versionId=${input.VersionId}` : ''}`);
        if (options.denyKeys?.includes(input.Key ?? '')) throw fail('AccessDenied', 403);
        const version = find(input.Key ?? '', input.VersionId);
        if (!version) throw fail(command instanceof HeadObjectCommand ? 'NotFound' : 'NoSuchKey', 404);
        const body = Buffer.from(version.body ?? 'pdf');
        return {
          VersionId: version.versionId,
          ETag: etagOf(version),
          ContentType: version.contentType ?? 'application/pdf',
          ContentLength: body.length,
          LastModified: new Date(version.lastModified),
          Metadata: version.metadata,
          Body: { transformToByteArray: async () => new Uint8Array(body) },
        };
      }
      if (command instanceof ListObjectVersionsCommand) {
        commands.push(`ListObjectVersionsCommand ${input.Prefix}`);
        return {
          IsTruncated: false,
          Versions: versions
            .filter((version) => version.key.startsWith(input.Prefix ?? ''))
            .map((version) => ({ Key: version.key, VersionId: version.versionId, LastModified: new Date(version.lastModified), ETag: etagOf(version) })),
        };
      }
      throw new Error(`The evals must only read from S3; got ${(command as object).constructor.name}`);
    },
  };
}
