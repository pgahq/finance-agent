import { validateHeaderValue } from 'node:http';
import {
  decodeS3MetadataValue,
  encodeS3MetadataValue,
  getS3Config,
  putBinaryToS3,
  getPresignedUrl,
  uploadAttachmentToS3,
  getBinaryFromS3
} from '../lib/s3.js';

// Mock AWS SDK
jest.mock('@aws-sdk/client-s3', () => {
  const mockSend = jest.fn();
  return {
    S3Client: jest.fn().mockImplementation(() => ({
      send: mockSend
    })),
    GetObjectCommand: jest.fn(),
    PutObjectCommand: jest.fn(),
    __mockSend: mockSend
  };
});

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn()
}));

describe('S3 Library', () => {
  let mockSend: jest.MockedFunction<any>;
  let mockGetSignedUrl: jest.MockedFunction<any>;

  beforeEach(() => {
    jest.clearAllMocks();
    
    const s3Module = require('@aws-sdk/client-s3');
    mockSend = s3Module.__mockSend;
    
    const presignerModule = require('@aws-sdk/s3-request-presigner');
    mockGetSignedUrl = presignerModule.getSignedUrl;
  });

  describe('getS3Config', () => {
    it('should return S3 configuration from environment', () => {
      const env = {
        S3_BUCKET_NAME: 'test-bucket',
        AWS_REGION: 'us-east-1'
      };

      const config = getS3Config(env);

      expect(config).toEqual({
        bucketName: 'test-bucket'
      });
    });

    it('should throw error when S3_BUCKET_NAME is missing', () => {
      const env = {};

      expect(() => getS3Config(env)).toThrow('S3_BUCKET_NAME environment variable is required');
    });
  });

  const NON_ASCII_NAMES = [
    ['curly apostrophe', 'Maple Ridge\u2019s Invoice.pdf'],
    ['accents', 'Caf\u00e9 R\u00e9sum\u00e9 Invoice.pdf'],
    ['emoji', 'Invoice \u{1F4C4}.pdf'],
    ['CJK', '\u8bf7\u6b3e\u5355 \u4e00\u6708.pdf'],
    ['literal percent', '100% Paid %41.pdf']
  ] as const;

  describe('encodeS3MetadataValue / decodeS3MetadataValue', () => {
    it.each(NON_ASCII_NAMES)('encodes %s to printable ASCII and round-trips', (_label, name) => {
      const encoded = encodeS3MetadataValue(name);

      expect(encoded).toMatch(/^[\x20-\x7E]*$/);
      expect(() => validateHeaderValue('x-amz-meta-original-filename', encoded)).not.toThrow();
      expect(decodeS3MetadataValue(encoded)).toBe(name);
    });

    it('leaves printable ASCII untouched', () => {
      expect(encodeS3MetadataValue('My Invoice (1).pdf')).toBe('My Invoice (1).pdf');
      expect(encodeS3MetadataValue('2026-11-24T19:06:26.167Z')).toBe('2026-11-24T19:06:26.167Z');
    });

    it('escapes only percent signs and non-printable or non-ASCII characters', () => {
      expect(encodeS3MetadataValue('50%')).toBe('50%25');
      expect(encodeS3MetadataValue('a\tb\nc')).toBe('a%09b%0Ac');
      expect(encodeS3MetadataValue('\u2019')).toBe('%E2%80%99');
    });

    it('replaces a lone surrogate instead of throwing', () => {
      expect(encodeS3MetadataValue('bad\uD83Dname')).toBe('bad%EF%BF%BDname');
    });

    it('truncates at a code point boundary and never splits an escape', () => {
      const encoded = encodeS3MetadataValue('\u{1F4C4}'.repeat(200));

      expect(encoded.length).toBeLessThanOrEqual(1000);
      expect(encoded.length).toBe(996);
      expect(decodeS3MetadataValue(encoded)).toBe('\u{1F4C4}'.repeat(83));
      expect(encodeS3MetadataValue('a'.repeat(1500))).toHaveLength(1000);
    });

    it('decodes a legacy unencoded value and tolerates a malformed escape', () => {
      expect(decodeS3MetadataValue('legacy invoice.pdf')).toBe('legacy invoice.pdf');
      expect(decodeS3MetadataValue('bad %zz escape.pdf')).toBe('bad %zz escape.pdf');
    });
  });

  describe('putBinaryToS3', () => {
    it.each(NON_ASCII_NAMES)('sends header-safe metadata for a %s file name', async (_label, name) => {
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      mockSend.mockResolvedValue({});

      await putBinaryToS3(
        { bucketName: 'test-bucket' },
        `new-invoices/request-1/1-${name}`,
        Buffer.from('test content'),
        'application/pdf',
        { 'original-filename': name, 'intercom-conversation-id': '1234567890' }
      );

      const input = PutObjectCommand.mock.calls[0][0];
      expect(input.Key).toBe(`new-invoices/request-1/1-${name}`);
      expect(input.Metadata['intercom-conversation-id']).toBe('1234567890');
      expect(() => validateHeaderValue('x-amz-meta-original-filename', input.Metadata['original-filename'])).not.toThrow();
      expect(decodeS3MetadataValue(input.Metadata['original-filename'])).toBe(name);
    });

    it('sends no metadata when none is given', async () => {
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      mockSend.mockResolvedValue({});

      await putBinaryToS3({ bucketName: 'test-bucket' }, 'k.pdf', Buffer.from('x'), 'application/pdf');

      expect(PutObjectCommand.mock.calls[0][0].Metadata).toBeUndefined();
    });

    it('should upload binary data to S3 successfully', async () => {
      const config = { bucketName: 'test-bucket' };
      const key = 'test-file.pdf';
      const buffer = Buffer.from('test content');
      const contentType = 'application/pdf';

      mockSend.mockResolvedValue({});

      await putBinaryToS3(config, key, buffer, contentType);

      expect(mockSend).toHaveBeenCalledWith(expect.any(Object));
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('should handle S3 upload errors', async () => {
      const config = { bucketName: 'test-bucket' };
      const key = 'test-file.pdf';
      const buffer = Buffer.from('test content');
      const contentType = 'application/pdf';

      mockSend.mockRejectedValue(new Error('S3 upload failed'));

      await expect(putBinaryToS3(config, key, buffer, contentType)).rejects.toThrow('S3 upload failed');
    });
  });

  describe('getBinaryFromS3', () => {
    it('should download an object from S3 as a Buffer', async () => {
      const config = { bucketName: 'test-bucket' };
      const key = 'new-invoices/req-1/invoice.pdf';
      const bytes = new Uint8Array([1, 2, 3, 4]);

      mockSend.mockResolvedValue({
        Body: { transformToByteArray: jest.fn().mockResolvedValue(bytes) }
      });

      const result = await getBinaryFromS3(config, key);

      expect(mockSend).toHaveBeenCalledWith(expect.any(Object));
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result).toEqual(Buffer.from(bytes));
    });

    it('should return an empty Buffer when the response has no Body', async () => {
      const config = { bucketName: 'test-bucket' };
      const key = 'new-invoices/req-1/invoice.pdf';

      mockSend.mockResolvedValue({});

      const result = await getBinaryFromS3(config, key);

      expect(result).toEqual(Buffer.from([]));
    });

    it('should propagate S3 download errors', async () => {
      const config = { bucketName: 'test-bucket' };
      const key = 'new-invoices/req-1/invoice.pdf';

      mockSend.mockRejectedValue(new Error('Download failed'));

      await expect(getBinaryFromS3(config, key)).rejects.toThrow('Download failed');
    });
  });

  describe('getPresignedUrl', () => {
    it('should generate presigned URL successfully', async () => {
      const config = { bucketName: 'test-bucket' };
      const s3Key = 'attachments/test-file.pdf';
      const expiresIn = 3600;

      mockGetSignedUrl.mockResolvedValue('https://s3.amazonaws.com/test-bucket/attachments/test-file.pdf?signature=abc123');

      const result = await getPresignedUrl(config, s3Key, expiresIn);

      expect(mockGetSignedUrl).toHaveBeenCalledWith(
        expect.anything(), // S3Client
        expect.anything(), // GetObjectCommand
        { expiresIn: 3600 }
      );
      expect(result).toBe('https://s3.amazonaws.com/test-bucket/attachments/test-file.pdf?signature=abc123');
    });

    it('should handle presigned URL generation errors', async () => {
      const config = { bucketName: 'test-bucket' };
      const s3Key = 'attachments/test-file.pdf';
      const expiresIn = 3600;

      mockGetSignedUrl.mockRejectedValue(new Error('URL generation failed'));

      await expect(getPresignedUrl(config, s3Key, expiresIn)).rejects.toThrow('URL generation failed');
    });
  });

  describe('uploadAttachmentToS3', () => {
    it('should upload attachment and return presigned URL', async () => {
      const s3Config = { bucketName: 'test-bucket' };
      const downloadedAttachment = {
        id: 'test-id',
        fileName: 'test-file.pdf',
        contentType: 'application/pdf',
        buffer: Buffer.from('test content'),
        size: 12
      };
      const workdayID = 'workday-123';

      mockSend.mockResolvedValue({});
      mockGetSignedUrl.mockResolvedValue('https://s3.amazonaws.com/test-bucket/attachments/workday-123/test-file.pdf?signature=abc123');

      const result = await uploadAttachmentToS3(s3Config, downloadedAttachment, workdayID);

      expect(mockSend).toHaveBeenCalledWith(expect.any(Object));
      expect(mockGetSignedUrl).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Object),
        { expiresIn: 3600 }
      );
      
      expect(result).toEqual({
        id: 'test-id',
        fileName: 'test-file.pdf',
        contentType: 'application/pdf',
        presignedUrl: 'https://s3.amazonaws.com/test-bucket/attachments/workday-123/test-file.pdf?signature=abc123',
        expiresAt: expect.any(Date),
        s3Key: expect.stringContaining('attachments/workday-123/')
      });
    });

    it('uploads an attachment whose file name has non-ASCII characters', async () => {
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      const fileName = 'Maple Ridge\u2019s Invoice.pdf';
      mockSend.mockResolvedValue({});
      mockGetSignedUrl.mockResolvedValue('https://s3.amazonaws.com/test-bucket/signed');

      const result = await uploadAttachmentToS3(
        { bucketName: 'test-bucket' },
        { id: 'test-id', fileName, contentType: 'application/pdf', buffer: Buffer.from('x'), size: 1 },
        'workday-123'
      );

      const metadata = PutObjectCommand.mock.calls[0][0].Metadata;
      expect(() => validateHeaderValue('x-amz-meta-original-filename', metadata['original-filename'])).not.toThrow();
      expect(decodeS3MetadataValue(metadata['original-filename'])).toBe(fileName);
      expect(result.fileName).toBe(fileName);
    });

    it('should handle upload errors', async () => {
      const s3Config = { bucketName: 'test-bucket' };
      const downloadedAttachment = {
        id: 'test-id',
        fileName: 'test-file.pdf',
        contentType: 'application/pdf',
        buffer: Buffer.from('test content'),
        size: 12
      };
      const workdayID = 'workday-123';

      mockSend.mockRejectedValue(new Error('Upload failed'));

      await expect(uploadAttachmentToS3(s3Config, downloadedAttachment, workdayID)).rejects.toThrow('Upload failed');
    });

    it('should handle presigned URL generation errors', async () => {
      const s3Config = { bucketName: 'test-bucket' };
      const downloadedAttachment = {
        id: 'test-id',
        fileName: 'test-file.pdf',
        contentType: 'application/pdf',
        buffer: Buffer.from('test content'),
        size: 12
      };
      const workdayID = 'workday-123';

      mockSend.mockResolvedValue({});
      mockGetSignedUrl.mockRejectedValue(new Error('URL generation failed'));

      await expect(uploadAttachmentToS3(s3Config, downloadedAttachment, workdayID)).rejects.toThrow('URL generation failed');
    });
  });
});
