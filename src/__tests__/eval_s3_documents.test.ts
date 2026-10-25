/* eslint-disable @typescript-eslint/require-await -- stubs implement async interfaces */
import { fakeS3 } from './eval_fake_s3.js';
import { pinCreateDocuments, pinDocument, pinEnrichDocuments, readPinnedDocument } from '../eval/s3_documents.js';

describe('pinCreateDocuments', () => {
  it('records bucket, key, version ID, and ETag for each key the snapshot holds', async () => {
    const s3 = fakeS3([
      { key: 'new-invoices/r1/0-invoice.pdf', versionId: 'v1', lastModified: '2026-10-13T14:00:00Z' },
      { key: 'new-invoices/r1/1-backup.pdf', versionId: 'v2', lastModified: '2026-10-13T14:00:01Z' },
    ]);
    const documents = await pinCreateDocuments(s3, 'finance-agent-1', ['new-invoices/r1/0-invoice.pdf', 'new-invoices/r1/1-backup.pdf'], ['supplier_invoice', 'supporting']);
    expect(documents).toEqual([
      expect.objectContaining({ bucket: 'finance-agent-1', key: 'new-invoices/r1/0-invoice.pdf', versionId: 'v1', etag: '"etag-v1"', status: 'pinned', source: 'snapshot', fileName: 'invoice.pdf', kind: 'supplier_invoice', contentType: 'application/pdf' }),
      expect.objectContaining({ key: 'new-invoices/r1/1-backup.pdf', versionId: 'v2', kind: 'supporting' }),
    ]);
    expect(s3.commands.every((command) => command.startsWith('HeadObjectCommand'))).toBe(true);
  });

  it('marks a missing key missing and a key outside new-invoices unreadable without calling S3', async () => {
    const s3 = fakeS3([]);
    const documents = await pinCreateDocuments(s3, 'b', ['new-invoices/gone/0-a.pdf', 'attachments/x/y.pdf']);
    expect(documents.map((document) => document.status)).toEqual(['missing', 'missing']);
    expect(documents[0].note).toContain('no longer exists');
    expect(documents[1].note).toContain('outside new-invoices/');
    expect(s3.commands).toEqual(['HeadObjectCommand new-invoices/gone/0-a.pdf']);
  });

  it('reads a 403 as missing, because S3 answers 403 for an absent key without ListBucket', async () => {
    const s3 = fakeS3([], { denyKeys: ['new-invoices/r/0-a.pdf'] });
    const [document] = await pinCreateDocuments(s3, 'b', ['new-invoices/r/0-a.pdf']);
    expect(document.status).toBe('missing');
    expect(document.note).toContain('AccessDenied');
  });
});

describe('pinEnrichDocuments', () => {
  const wid = 'a'.repeat(32);
  const writtenAt = new Date('2026-10-13T15:00:00Z');

  it('lists the attachments prefix and pins, per file name, the newest version written before the agent write', async () => {
    const s3 = fakeS3([
      { key: `attachments/${wid}/inv.pdf`, versionId: 'old', lastModified: '2026-10-13T14:00:00Z', metadata: { 'attachment-id': `${wid}-0`, 'original-filename': 'inv.pdf' } },
      { key: `attachments/${wid}/inv.pdf`, versionId: 'reenrich', lastModified: '2026-10-15T09:00:00Z', metadata: { 'attachment-id': `${wid}-0` } },
      { key: `attachments/${wid}/backup.pdf`, versionId: 'b1', lastModified: '2026-10-13T14:00:02Z', metadata: { 'attachment-id': `${wid}-1`, 'original-filename': 'backup.pdf' } },
      { key: `attachments/${wid}/added-later.pdf`, versionId: 'late', lastModified: '2026-10-14T00:00:00Z' },
      { key: `attachments/${'b'.repeat(32)}/other.pdf`, versionId: 'x', lastModified: '2026-10-13T14:00:00Z' },
    ]);
    const documents = await pinEnrichDocuments(s3, 'finance-agent-1', wid, writtenAt);
    expect(documents.map((document) => [document.key, document.versionId, document.status])).toEqual([
      [`attachments/${wid}/added-later.pdf`, undefined, 'missing'],
      [`attachments/${wid}/backup.pdf`, 'b1', 'pinned'],
      [`attachments/${wid}/inv.pdf`, 'old', 'pinned'],
    ]);
    const inv = documents.find((document) => document.key.endsWith('inv.pdf'))!;
    expect(inv.workdayAttachmentRef).toEqual({ workdayInvoiceWid: wid, attachmentId: `${wid}-0`, originalFileName: 'inv.pdf' });
    expect(inv.source).toBe('attachments_prefix');
    expect(documents[0].note).toContain('written after the agent wrote this invoice');
    expect(s3.commands[0]).toBe(`ListObjectVersionsCommand attachments/${wid}/`);
  });

  it('returns nothing when the prefix is empty', async () => {
    expect(await pinEnrichDocuments(fakeS3([]), 'b', wid, writtenAt)).toEqual([]);
  });
});

describe('readPinnedDocument', () => {
  const versions = [{ key: 'new-invoices/r/0-a.pdf', versionId: 'v1', lastModified: '2026-10-13T14:00:00Z', body: 'hello' }];

  it('reads the pinned version by ID', async () => {
    const s3 = fakeS3(versions);
    const [ref] = await pinCreateDocuments(s3, 'b', ['new-invoices/r/0-a.pdf']);
    const loaded = await readPinnedDocument(s3, ref);
    expect(loaded.buffer.toString()).toBe('hello');
    expect(s3.commands.at(-1)).toBe('GetObjectCommand new-invoices/r/0-a.pdf?versionId=v1');
  });

  it('refuses a version whose ETag changed', async () => {
    const s3 = fakeS3(versions);
    const [ref] = await pinCreateDocuments(s3, 'b', ['new-invoices/r/0-a.pdf']);
    await expect(readPinnedDocument(s3, { ...ref, etag: '"different"' })).rejects.toThrow('expected "different"');
  });

  it('refuses a document that is not pinned', async () => {
    await expect(readPinnedDocument(fakeS3([]), { bucket: 'b', key: 'k', status: 'missing', source: 'snapshot', note: 'gone' })).rejects.toThrow('is missing: gone');
  });
});

describe('pinDocument', () => {
  it('flags an unversioned bucket, where the bytes cannot be pinned', async () => {
    const s3 = { send: async () => ({ VersionId: 'null', ETag: '"e"', ContentType: 'application/pdf' }) };
    const document = await pinDocument(s3 as never, 'b', 'new-invoices/r/0-a.pdf', { source: 'snapshot' });
    expect(document.status).toBe('unverified');
    expect(document.versionId).toBeUndefined();
  });

  it('rethrows an unexpected failure', async () => {
    const s3 = { send: async () => { throw Object.assign(new Error('boom'), { name: 'InternalError', $metadata: { httpStatusCode: 500 } }); } };
    await expect(pinDocument(s3 as never, 'b', 'k', { source: 'snapshot' })).rejects.toThrow('boom');
  });
});
