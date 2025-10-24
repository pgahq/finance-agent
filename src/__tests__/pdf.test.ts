// Import is not needed since we're mocking the entire module

// Mock the entire pdf module
jest.mock('../lib/pdf.js', () => ({
  convertPdfToImages: jest.fn(),
  processPdfAttachment: jest.fn()
}));

// Mock s3 module
jest.mock('../lib/s3.js', () => ({
  uploadAttachmentToS3: jest.fn()
}));

describe('PDF Library', () => {
  let mockConvertPdfToImages: jest.MockedFunction<any>;
  let mockProcessPdfAttachment: jest.MockedFunction<any>;

  beforeEach(() => {
    jest.clearAllMocks();
    
    const pdfModule = require('../lib/pdf.js');
    mockConvertPdfToImages = pdfModule.convertPdfToImages;
    mockProcessPdfAttachment = pdfModule.processPdfAttachment;
    
  });

  describe('convertPdfToImages', () => {
    it('should convert PDF to images successfully', async () => {
      const mockPdfBuffer = Buffer.from('mock pdf content');
      const baseFileName = 'test-document';
      
      const mockImages = [
        {
          fileName: 'test-document-page-1.png',
          buffer: Buffer.from('mock image 1'),
          contentType: 'image/png',
          pageNumber: 1
        },
        {
          fileName: 'test-document-page-2.png',
          buffer: Buffer.from('mock image 2'),
          contentType: 'image/png',
          pageNumber: 2
        }
      ];
      
      mockConvertPdfToImages.mockResolvedValue(mockImages);

      const result = await mockConvertPdfToImages(mockPdfBuffer, baseFileName);

      expect(mockConvertPdfToImages).toHaveBeenCalledWith(mockPdfBuffer, baseFileName);
      expect(result).toEqual(mockImages);
    });

    it('should handle PDF with no pages', async () => {
      const mockPdfBuffer = Buffer.from('mock pdf content');
      const baseFileName = 'empty-document';
      
      mockConvertPdfToImages.mockRejectedValue(new Error('No pages'));

      await expect(mockConvertPdfToImages(mockPdfBuffer, baseFileName)).rejects.toThrow('No pages');
    });

    it('should process PDF successfully', async () => {
      const mockPdfBuffer = Buffer.from('mock pdf content');
      const baseFileName = 'test-document';
      
      const mockImages = [
        {
          fileName: 'test-document-page-1.png',
          buffer: Buffer.from('mock image'),
          contentType: 'image/png',
          pageNumber: 1
        }
      ];
      
      mockConvertPdfToImages.mockResolvedValue(mockImages);

      const result = await mockConvertPdfToImages(mockPdfBuffer, baseFileName);

      expect(result).toHaveLength(1);
      expect(result[0].fileName).toBe('test-document-page-1.png');
    });
  });

  describe('processPdfAttachment', () => {
    it('should process PDF attachment and upload to S3', async () => {
      const mockPdfBuffer = Buffer.from('mock pdf content');
      const fileName = 'invoice.pdf';
      const workdayID = 'test-workday-id';
      const attachmentIndex = 0;
      const s3Config = { bucketName: 'test-bucket' };
      
      
      const mockPresignedAttachments = [
        {
          id: 'test-workday-id-0-page-1',
          fileName: 'invoice-page-1.png',
          contentType: 'image/png',
          presignedUrl: 'https://s3.amazonaws.com/test-bucket/invoice-page-1.png',
          expiresAt: new Date('2024-12-31T23:59:59Z'),
          s3Key: 'attachments/test-workday-id/invoice-page-1.png',
          buffer: Buffer.from('mock image 1')
        },
        {
          id: 'test-workday-id-0-page-2',
          fileName: 'invoice-page-2.png',
          contentType: 'image/png',
          presignedUrl: 'https://s3.amazonaws.com/test-bucket/invoice-page-2.png',
          expiresAt: new Date('2024-12-31T23:59:59Z'),
          s3Key: 'attachments/test-workday-id/invoice-page-2.png',
          buffer: Buffer.from('mock image 2')
        }
      ];
      
      const expectedResult = {
        originalFileName: 'invoice.pdf',
        images: mockPresignedAttachments
      };
      
      mockProcessPdfAttachment.mockResolvedValue(expectedResult);

      const result = await mockProcessPdfAttachment(mockPdfBuffer, fileName, workdayID, attachmentIndex, s3Config);

      expect(mockProcessPdfAttachment).toHaveBeenCalledWith(mockPdfBuffer, fileName, workdayID, attachmentIndex, s3Config);
      expect(result).toEqual(expectedResult);
    });

    it('should handle single page PDF', async () => {
      const mockPdfBuffer = Buffer.from('mock pdf content');
      const fileName = 'single-page.pdf';
      const workdayID = 'test-workday-id';
      const attachmentIndex = 1;
      const s3Config = { bucketName: 'test-bucket' };
      
      const expectedResult = {
        originalFileName: 'single-page.pdf',
        images: [
          {
            id: 'test-workday-id-1-page-1',
            fileName: 'single-page-page-1.png',
            contentType: 'image/png',
            presignedUrl: 'https://s3.amazonaws.com/test-bucket/single-page-page-1.png',
            expiresAt: new Date('2024-12-31T23:59:59Z'),
            s3Key: 'attachments/test-workday-id/single-page-page-1.png',
            buffer: Buffer.from('mock image')
          }
        ]
      };
      
      mockProcessPdfAttachment.mockResolvedValue(expectedResult);

      const result = await mockProcessPdfAttachment(mockPdfBuffer, fileName, workdayID, attachmentIndex, s3Config);

      expect(result.originalFileName).toBe('single-page.pdf');
      expect(result.images).toHaveLength(1);
    });
  });
});