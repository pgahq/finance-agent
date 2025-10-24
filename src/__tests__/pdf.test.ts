import { convertPdfToImages, processPdfAttachment } from '../lib/pdf.js';
import { writeFileSync, unlinkSync, mkdirSync, existsSync, readFileSync } from 'fs';

// Mock fs and path modules
jest.mock('fs', () => ({
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn(),
  mkdirSync: jest.fn(),
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
}));

jest.mock('path', () => ({
  join: jest.fn((...args) => args.join('/'))
}));

jest.mock('os', () => ({
  tmpdir: jest.fn(() => '/tmp')
}));

// Mock node-pdftocairo
jest.mock('node-pdftocairo', () => ({
  convert: jest.fn()
}));

// Mock s3 module
jest.mock('../lib/s3.js', () => ({
  uploadAttachmentToS3: jest.fn()
}));

describe('PDF Library', () => {
  let mockWriteFileSync: jest.MockedFunction<typeof writeFileSync>;
  let mockUnlinkSync: jest.MockedFunction<typeof unlinkSync>;
  let mockMkdirSync: jest.MockedFunction<typeof mkdirSync>;
  let mockExistsSync: jest.MockedFunction<typeof existsSync>;
  let mockReadFileSync: jest.MockedFunction<typeof readFileSync>;
  let mockPdftocairoConvert: jest.MockedFunction<any>;
  let mockUploadAttachmentToS3: jest.MockedFunction<any>;

  beforeEach(() => {
    jest.clearAllMocks();
    
    mockWriteFileSync = writeFileSync as jest.MockedFunction<typeof writeFileSync>;
    mockUnlinkSync = unlinkSync as jest.MockedFunction<typeof unlinkSync>;
    mockMkdirSync = mkdirSync as jest.MockedFunction<typeof mkdirSync>;
    mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
    mockReadFileSync = readFileSync as jest.MockedFunction<typeof readFileSync>;
    
    const pdftocairoModule = require('node-pdftocairo');
    mockPdftocairoConvert = pdftocairoModule.convert;
    
    const s3Module = require('../lib/s3.js');
    mockUploadAttachmentToS3 = s3Module.uploadAttachmentToS3;
  });

  describe('convertPdfToImages', () => {
    it('should convert PDF to images successfully', async () => {
      const mockPdfBuffer = Buffer.from('mock pdf content');
      const baseFileName = 'test-document';
      
      // Mock file system operations
      mockExistsSync.mockReturnValue(false);
      
      // Mock node-pdftocairo convert - simulate 2 pages
      let callCount = 0;
      mockPdftocairoConvert.mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          return Promise.resolve('/tmp/pdf-processing/test-document/page-1.png');
        } else {
          return Promise.reject(new Error('No more pages'));
        }
      });
      
      // Mock file existence checks
      mockExistsSync.mockImplementation((path) => {
        const pathStr = String(path);
        if (pathStr.includes('page-1.png') || pathStr.includes('page-2.png')) {
          return true;
        }
        return false;
      });
      
      // Mock image file reading
      mockReadFileSync
        .mockReturnValueOnce(Buffer.from('mock image 1'))
        .mockReturnValueOnce(Buffer.from('mock image 2'));

      const result = await convertPdfToImages(mockPdfBuffer, baseFileName);

      expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/pdf-processing', { recursive: true });
      expect(mockWriteFileSync).toHaveBeenCalledWith('/tmp/pdf-processing/test-document.pdf', mockPdfBuffer);
      expect(mockPdftocairoConvert).toHaveBeenCalledTimes(3); // 2 successful + 1 failure
      expect(mockPdftocairoConvert).toHaveBeenCalledWith(
        '/tmp/pdf-processing/test-document.pdf',
        '/tmp/pdf-processing/test-document/page-1.png',
        {
          format: 'png',
          firstPage: 1,
          lastPage: 1,
          resolution: 150
        }
      );
      
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        fileName: 'test-document-page-1.png',
        buffer: Buffer.from('mock image 1'),
        contentType: 'image/png',
        pageNumber: 1
      });
      expect(result[1]).toEqual({
        fileName: 'test-document-page-2.png',
        buffer: Buffer.from('mock image 2'),
        contentType: 'image/png',
        pageNumber: 2
      });
    });

    it('should handle PDF with no pages', async () => {
      const mockPdfBuffer = Buffer.from('mock pdf content');
      const baseFileName = 'empty-document';
      
      mockExistsSync.mockReturnValue(false);
      mockPdftocairoConvert.mockRejectedValue(new Error('No pages'));

      const result = await convertPdfToImages(mockPdfBuffer, baseFileName);

      expect(result).toHaveLength(0);
    });

    it('should process PDF successfully', async () => {
      const mockPdfBuffer = Buffer.from('mock pdf content');
      const baseFileName = 'test-document';
      
      mockExistsSync.mockImplementation((path) => {
        const pathStr = String(path);
        if (pathStr.includes('page-1.png')) {
          return true;
        }
        return false;
      });
      mockPdftocairoConvert.mockResolvedValueOnce('/tmp/pdf-processing/test-document/page-1.png')
        .mockRejectedValueOnce(new Error('No more pages'));
      mockReadFileSync.mockReturnValue(Buffer.from('mock image'));

      const result = await convertPdfToImages(mockPdfBuffer, baseFileName);

      expect(result).toHaveLength(1);
      expect(result[0].fileName).toBe('test-document-page-1.png');
    });

    it('should handle cleanup errors gracefully', async () => {
      const mockPdfBuffer = Buffer.from('mock pdf content');
      const baseFileName = 'test-document';
      
      mockExistsSync.mockImplementation((path) => {
        const pathStr = String(path);
        if (pathStr.includes('page-1.png')) {
          return true;
        }
        return false;
      });
      mockPdftocairoConvert.mockResolvedValueOnce('/tmp/pdf-processing/test-document/page-1.png')
        .mockRejectedValueOnce(new Error('No more pages'));
      mockReadFileSync.mockReturnValue(Buffer.from('mock image'));
      
      // Mock cleanup to succeed
      mockUnlinkSync.mockReturnValue(undefined);

      const result = await convertPdfToImages(mockPdfBuffer, baseFileName);
      
      expect(result).toHaveLength(1);
    });
  });

  describe('processPdfAttachment', () => {
    it('should process PDF attachment and upload to S3', async () => {
      const mockPdfBuffer = Buffer.from('mock pdf content');
      const fileName = 'invoice.pdf';
      const workdayID = 'test-workday-id';
      const attachmentIndex = 0;
      const s3Config = { bucketName: 'test-bucket' };
      
      // Mock PDF conversion
      mockExistsSync.mockImplementation((path) => {
        const pathStr = String(path);
        if (pathStr.includes('page-1.png') || pathStr.includes('page-2.png')) {
          return true;
        }
        return false;
      });
      let callCount = 0;
      mockPdftocairoConvert.mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          return Promise.resolve('/tmp/pdf-processing/invoice/page-1.png');
        } else {
          return Promise.reject(new Error('No more pages'));
        }
      });
      mockReadFileSync
        .mockReturnValueOnce(Buffer.from('mock image 1'))
        .mockReturnValueOnce(Buffer.from('mock image 2'));

      // Mock S3 upload
      mockUploadAttachmentToS3
        .mockResolvedValueOnce({
          id: 'test-workday-id-0-page-1',
          fileName: 'invoice-page-1.png',
          contentType: 'image/png',
          presignedUrl: 'https://s3.amazonaws.com/test-bucket/invoice-page-1.png',
          expiresAt: new Date('2024-12-31T23:59:59Z'),
          s3Key: 'attachments/test-workday-id/invoice-page-1.png'
        })
        .mockResolvedValueOnce({
          id: 'test-workday-id-0-page-2',
          fileName: 'invoice-page-2.png',
          contentType: 'image/png',
          presignedUrl: 'https://s3.amazonaws.com/test-bucket/invoice-page-2.png',
          expiresAt: new Date('2024-12-31T23:59:59Z'),
          s3Key: 'attachments/test-workday-id/invoice-page-2.png'
        });

      const result = await processPdfAttachment(mockPdfBuffer, fileName, workdayID, attachmentIndex, s3Config);

      expect(result.originalFileName).toBe('invoice.pdf');
      expect(result.images).toHaveLength(2);
      expect(result.images[0]).toEqual({
        id: 'test-workday-id-0-page-1',
        fileName: 'invoice-page-1.png',
        contentType: 'image/png',
        presignedUrl: 'https://s3.amazonaws.com/test-bucket/invoice-page-1.png',
        expiresAt: new Date('2024-12-31T23:59:59Z'),
        s3Key: 'attachments/test-workday-id/invoice-page-1.png',
        buffer: Buffer.from('mock image 1')
      });
    });

    it('should handle single page PDF', async () => {
      const mockPdfBuffer = Buffer.from('mock pdf content');
      const fileName = 'single-page.pdf';
      const workdayID = 'test-workday-id';
      const attachmentIndex = 1;
      const s3Config = { bucketName: 'test-bucket' };
      
      mockExistsSync.mockImplementation((path) => {
        const pathStr = String(path);
        if (pathStr.includes('page-1.png')) {
          return true;
        }
        return false;
      });
      mockPdftocairoConvert.mockResolvedValueOnce('/tmp/pdf-processing/single-page/page-1.png')
        .mockRejectedValueOnce(new Error('No more pages'));
      mockReadFileSync.mockReturnValue(Buffer.from('mock image'));
      
      mockUploadAttachmentToS3.mockResolvedValue({
        id: 'test-workday-id-1-page-1',
        fileName: 'single-page-page-1.png',
        contentType: 'image/png',
        presignedUrl: 'https://s3.amazonaws.com/test-bucket/single-page-page-1.png',
        expiresAt: new Date('2024-12-31T23:59:59Z'),
        s3Key: 'attachments/test-workday-id/single-page-page-1.png'
      });

      const result = await processPdfAttachment(mockPdfBuffer, fileName, workdayID, attachmentIndex, s3Config);

      expect(result.originalFileName).toBe('single-page.pdf');
      expect(result.images).toHaveLength(1);
      expect(mockUploadAttachmentToS3).toHaveBeenCalledTimes(1);
    });
  });
});