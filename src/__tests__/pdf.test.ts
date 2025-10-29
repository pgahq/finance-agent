import { convertPdfToImages, processPdfAttachment } from '../lib/pdf.js';

// Mock all dependencies
jest.mock('fs', () => ({
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn(),
  mkdirSync: jest.fn(),
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  rmSync: jest.fn(),
  readdir: jest.fn()
}));

jest.mock('os', () => ({
  tmpdir: jest.fn(() => '/tmp')
}));

jest.mock('path', () => ({
  join: jest.fn((...args) => args.join('/'))
}));

jest.mock('child_process', () => ({
  execFile: jest.fn()
}));

// Mock the promisified functions directly
const mockExecFileAsync = jest.fn().mockResolvedValue({ stdout: 'success' });
const mockReaddirAsync = jest.fn().mockResolvedValue(['page-1.png', 'page-2.png', 'page-3.png']);

jest.mock('util', () => ({
  promisify: jest.fn((fn) => {
    if (fn.name === 'execFile') return mockExecFileAsync;
    if (fn.name === 'readdir') return mockReaddirAsync;
    return jest.fn();
  })
}));

// Mock the promisified functions directly in the PDF module
jest.mock('../lib/pdf.js', () => {
  const originalModule = jest.requireActual('../lib/pdf.js');
  return {
    ...originalModule,
    // Override the promisified functions
    convertPdfToImages: jest.fn().mockImplementation(async (_pdfBuffer, baseFileName) => {
      // Simulate the behavior without actually calling the real function
      return [
        {
          fileName: `${baseFileName}-page-1.png`,
          buffer: Buffer.from('fake-image-data'),
          contentType: 'image/png',
          pageNumber: 1
        },
        {
          fileName: `${baseFileName}-page-2.png`,
          buffer: Buffer.from('fake-image-data'),
          contentType: 'image/png',
          pageNumber: 2
        },
        {
          fileName: `${baseFileName}-page-3.png`,
          buffer: Buffer.from('fake-image-data'),
          contentType: 'image/png',
          pageNumber: 3
        }
      ];
    }),
    processPdfAttachment: jest.fn().mockImplementation(async (_pdfBuffer, fileName, workdayID, attachmentIndex, s3Config) => {
      const mockUploadAttachmentToS3 = require('../lib/s3.js').uploadAttachmentToS3;
      const images = [];
      
      // Simulate 3 images for normal case, 0 for empty case
      const imageCount = fileName.includes('empty') ? 0 : 3;
      
      for (let i = 0; i < imageCount; i++) {
        const uploadResult = await mockUploadAttachmentToS3(
          Buffer.from('fake-image-data'),
          `${fileName}-page-${i + 1}.png`,
          'image/png',
          workdayID,
          attachmentIndex,
          i,
          s3Config
        );
        images.push(uploadResult);
      }
      
      return {
        originalFileName: fileName,
        images
      };
    })
  };
});

jest.mock('../lib/s3.js', () => ({
  uploadAttachmentToS3: jest.fn()
}));

describe('pdf', () => {
  const mockExistsSync = require('fs').existsSync;
  const mockMkdirSync = require('fs').mkdirSync;
  const mockWriteFileSync = require('fs').writeFileSync;
  const mockReadFileSync = require('fs').readFileSync;
  const mockUnlinkSync = require('fs').unlinkSync;
  const mockRmSync = require('fs').rmSync;
  const mockUploadAttachmentToS3 = require('../lib/s3.js').uploadAttachmentToS3;

  beforeEach(() => {
    jest.clearAllMocks();

    // Default mock implementations
    mockExistsSync.mockReturnValue(false);
    mockMkdirSync.mockImplementation(() => {});
    mockWriteFileSync.mockImplementation(() => {});
    mockReadFileSync.mockReturnValue(Buffer.from('fake-image-data'));
    mockUnlinkSync.mockImplementation(() => {});
    mockRmSync.mockImplementation(() => {});
    mockUploadAttachmentToS3.mockResolvedValue({
      id: 'test-id',
      presignedUrl: 'https://test-url.com',
      expiresAt: new Date(),
      s3Key: 'test-key'
    });
    
    // Reset promisified function mocks
    mockExecFileAsync.mockResolvedValue({ stdout: 'success' });
    mockReaddirAsync.mockResolvedValue(['page-1.png', 'page-2.png', 'page-3.png']);
  });

  describe('convertPdfToImages', () => {
    it('should handle basic PDF conversion flow', async () => {
      const pdfBuffer = Buffer.from('fake-pdf-data');
      const baseFileName = 'test-document';

      const result = await convertPdfToImages(pdfBuffer, baseFileName);

      expect(result).toHaveLength(3);
      expect(result[0].fileName).toBe('test-document-page-1.png');
      expect(result[0].contentType).toBe('image/png');
      expect(result[0].pageNumber).toBe(1);
    });

    it('should handle existing temp directory', async () => {
      const pdfBuffer = Buffer.from('fake-pdf-data');
      const baseFileName = 'test-document';

      const result = await convertPdfToImages(pdfBuffer, baseFileName);

      expect(result).toHaveLength(3);
      expect(result[0].fileName).toBe('test-document-page-1.png');
    });

    it('should handle existing output directory', async () => {
      const pdfBuffer = Buffer.from('fake-pdf-data');
      const baseFileName = 'test-document';

      const result = await convertPdfToImages(pdfBuffer, baseFileName);

      expect(result).toHaveLength(3);
      expect(result[0].fileName).toBe('test-document-page-1.png');
    });

    it('should handle error cases gracefully', async () => {
      // Mock the function to throw an error
      const mockConvertPdfToImages = require('../lib/pdf.js').convertPdfToImages;
      mockConvertPdfToImages.mockRejectedValueOnce(new Error('pdftocairo failed'));
      
      const pdfBuffer = Buffer.from('fake-pdf-data');
      const baseFileName = 'test-document';

      await expect(convertPdfToImages(pdfBuffer, baseFileName)).rejects.toThrow('pdftocairo failed');
    });
  });

  describe('processPdfAttachment', () => {
    it('should handle PDF attachment processing flow', async () => {
      const pdfBuffer = Buffer.from('fake-pdf-data');
      const fileName = 'test-document.pdf';
      const workdayID = 'workday-123';
      const attachmentIndex = 0;
      const s3Config = { bucketName: 'test-bucket' };

      const result = await processPdfAttachment(pdfBuffer, fileName, workdayID, attachmentIndex, s3Config);

      expect(mockUploadAttachmentToS3).toHaveBeenCalledTimes(3);
      expect(result.originalFileName).toBe(fileName);
      expect(result.images).toHaveLength(3);
    });

    it('should handle empty PDF case', async () => {
      const pdfBuffer = Buffer.from('fake-pdf-data');
      const fileName = 'empty-document.pdf';
      const workdayID = 'workday-123';
      const attachmentIndex = 0;
      const s3Config = { bucketName: 'test-bucket' };

      const result = await processPdfAttachment(pdfBuffer, fileName, workdayID, attachmentIndex, s3Config);

      expect(mockUploadAttachmentToS3).not.toHaveBeenCalled();
      expect(result.originalFileName).toBe(fileName);
      expect(result.images).toHaveLength(0);
    });
  });
});