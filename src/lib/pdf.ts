import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import pdf from 'pdf-poppler';
import type { DownloadedAttachment, PresignedAttachment } from './types.js';

export interface ProcessedImage {
  fileName: string;
  buffer: Buffer;
  contentType: string;
  pageNumber: number;
}

export interface ProcessedPdfAttachment {
  originalFileName: string;
  images: PresignedAttachment[];
}

export async function convertPdfToImages(pdfBuffer: Buffer, baseFileName: string): Promise<ProcessedImage[]> {
  const tempDir = join(tmpdir(), 'pdf-processing');
  
  // Ensure temp directory exists
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true });
  }
  
  const tempPdfPath = join(tempDir, `${baseFileName}.pdf`);
  const outputDir = join(tempDir, baseFileName);
  
  try {
    // Write PDF buffer to temporary file
    writeFileSync(tempPdfPath, pdfBuffer);
    
    // Convert PDF to images
    const options = {
      format: 'png',
      out_dir: outputDir,
      out_prefix: 'page',
      page: null // Convert all pages
    };
    
    const result = await pdf.convert(tempPdfPath, options);
    
    // Read generated images
    const processedImages: ProcessedImage[] = [];
    
    if (result && result.length > 0) {
      for (let i = 0; i < result.length; i++) {
        const imagePath = result[i];
        const imageBuffer = require('fs').readFileSync(imagePath);
        
        processedImages.push({
          fileName: `${baseFileName}-page-${i + 1}.png`,
          buffer: imageBuffer,
          contentType: 'image/png',
          pageNumber: i + 1
        });
        
        // Clean up individual image file
        unlinkSync(imagePath);
      }
    }
    
    return processedImages;
    
  } finally {
    // Clean up temporary files
    try {
      if (existsSync(tempPdfPath)) {
        unlinkSync(tempPdfPath);
      }
      if (existsSync(outputDir)) {
        require('fs').rmSync(outputDir, { recursive: true, force: true });
      }
    } catch (error) {
      console.warn('Failed to clean up temporary files:', error);
    }
  }
}

export async function processPdfAttachment(
  pdfBuffer: Buffer,
  fileName: string,
  workdayID: string,
  attachmentIndex: number,
  s3Config: { bucketName: string }
): Promise<ProcessedPdfAttachment> {
  const baseFileName = fileName.replace('.pdf', '');
  const processedImages = await convertPdfToImages(pdfBuffer, baseFileName);
  
  const { uploadAttachmentToS3 } = await import('./s3.js');
  const uploadedImages: PresignedAttachment[] = [];
  
  for (const image of processedImages) {
    const downloadedAttachment: DownloadedAttachment = {
      id: `${workdayID}-${attachmentIndex}-page-${image.pageNumber}`,
      fileName: image.fileName,
      contentType: image.contentType,
      buffer: image.buffer,
      size: image.buffer.length
    };

    const presignedAttachment = await uploadAttachmentToS3(s3Config, downloadedAttachment, workdayID);
    
    uploadedImages.push({
      id: presignedAttachment.id,
      fileName: image.fileName,
      contentType: image.contentType,
      presignedUrl: presignedAttachment.presignedUrl,
      expiresAt: presignedAttachment.expiresAt,
      s3Key: presignedAttachment.s3Key,
      buffer: image.buffer
    });
  }
  
  return {
    originalFileName: fileName,
    images: uploadedImages
  };
}
