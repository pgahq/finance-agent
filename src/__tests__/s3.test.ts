import { getS3Config, putBinaryToS3, getPresignedUrl, uploadAttachmentToS3 } from '../lib/s3.js';

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

  describe('putBinaryToS3', () => {
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
