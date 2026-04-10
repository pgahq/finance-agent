import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { debug } from '@pga/logger';
import type { DownloadedAttachment, PresignedAttachment } from './types.js';

const s3Client = new S3Client({});

export interface S3Config {
  bucketName: string;
}

export function getS3Config(env: NodeJS.ProcessEnv): S3Config {
  const bucketName = env.S3_BUCKET_NAME;
  if (!bucketName) {
    throw new Error('S3_BUCKET_NAME environment variable is required');
  }
  
  return {
    bucketName
  };
}


export async function putBinaryToS3(
  config: S3Config,
  key: string,
  buffer: Buffer,
  contentType: string,
  metadata?: Record<string, string>
): Promise<void> {
  try {
    const command = new PutObjectCommand({
      Bucket: config.bucketName,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      Metadata: metadata
    });
    
    await s3Client.send(command);
  } catch (error: any) {
    debug(`Error putting binary file to S3: ${error.message}`);
    throw error;
  }
}

export async function getPresignedUrl(
  config: S3Config,
  key: string,
  expiresIn: number = 3600 // 1 hour default
): Promise<string> {
  try {
    const command = new GetObjectCommand({
      Bucket: config.bucketName,
      Key: key
    });
    
    const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn });
    
    return presignedUrl;
  } catch (error: any) {
    debug(`Error generating presigned URL: ${error.message}`);
    throw error;
  }
}

export async function putJsonToS3(config: S3Config, key: string, data: unknown): Promise<void> {
  const command = new PutObjectCommand({
    Bucket: config.bucketName,
    Key: key,
    Body: JSON.stringify(data),
    ContentType: 'application/json'
  });
  await s3Client.send(command);
}

export async function getJsonFromS3<T>(config: S3Config, key: string): Promise<T | null> {
  try {
    const command = new GetObjectCommand({ Bucket: config.bucketName, Key: key });
    const response = await s3Client.send(command);
    const body = await response.Body?.transformToString();
    return body ? JSON.parse(body) as T : null;
  } catch (error: any) {
    if (error.name === 'NoSuchKey') return null;
    throw error;
  }
}

export async function uploadAttachmentToS3(
  config: S3Config,
  attachment: DownloadedAttachment,
  workdayID: string
): Promise<PresignedAttachment> {
  try {
    // Create S3 key for the attachment
    const s3Key = `attachments/${workdayID}/${attachment.fileName}`;
    
    // Upload binary file to S3
    await putBinaryToS3(
      config,
      s3Key,
      attachment.buffer,
      attachment.contentType,
      {
        'workday-id': workdayID,
        'attachment-id': attachment.id,
        'original-filename': attachment.fileName,
        'upload-timestamp': new Date().toISOString()
      }
    );
    
    // Generate presigned URL (1 hour expiration)
    const presignedUrl = await getPresignedUrl(config, s3Key, 3600);
    
    return {
      id: attachment.id,
      fileName: attachment.fileName,
      contentType: attachment.contentType,
      presignedUrl,
      expiresAt: new Date(Date.now() + 3600 * 1000), // 1 hour from now
      s3Key
    };
  } catch (error: any) {
    debug(`Error uploading attachment to S3: ${error.message}`);
    throw error;
  }
}
