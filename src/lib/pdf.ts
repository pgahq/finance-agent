import { writeFileSync, unlinkSync, mkdirSync, existsSync, readFileSync, rmSync, readdir } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { DownloadedAttachment, PresignedAttachment } from './types.js';

const execFileAsync = promisify(execFile);
const readdirAsync = promisify(readdir);

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
    
    // Ensure output directory exists
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }
    
    // Use pdftocairo directly to convert all pages at once
    const outputPrefix = join(outputDir, 'page');
    
    try {
      console.log(`Converting PDF to images using pdftocairo: ${baseFileName}`);
      
      // Call pdftocairo to convert all pages to PNGs
      await execFileAsync('/opt/bin/pdftocairo', ['-png', tempPdfPath, outputPrefix]);
      
      // Find all output PNGs (Poppler outputs page-1.png, page-2.png, ...)
      const files = await readdirAsync(outputDir);
      const pngFiles = files.filter(f => f.match(/^page-\d+\.png$/)).sort((a, b) => {
        // Sort by page number
        const aNum = parseInt(a.match(/(\d+)/)![1], 10);
        const bNum = parseInt(b.match(/(\d+)/)![1], 10);
        return aNum - bNum;
      });
      
      console.log(`Found ${pngFiles.length} pages in PDF: ${baseFileName}`);
      
      // Process each PNG file
      const processedImages: ProcessedImage[] = [];
      for (let i = 0; i < pngFiles.length; i++) {
        const file = pngFiles[i];
        const filePath = join(outputDir, file);
        const imageBuffer = readFileSync(filePath);
        
        processedImages.push({
          fileName: `${baseFileName}-page-${i + 1}.png`,
          buffer: imageBuffer,
          contentType: 'image/png',
          pageNumber: i + 1
        });
        
        // Clean up individual image file
        unlinkSync(filePath);
      }
      
      console.log(`PDF conversion completed. Processed ${processedImages.length} pages.`);
      return processedImages;
      
    } catch (error) {
      console.error(`Failed to convert PDF using pdftocairo:`, error instanceof Error ? error.message : String(error));
      throw error;
    }
    
  } finally {
    // Clean up temporary files
    try {
      if (existsSync(tempPdfPath)) {
        unlinkSync(tempPdfPath);
      }
      if (existsSync(outputDir)) {
        rmSync(outputDir, { recursive: true, force: true });
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
