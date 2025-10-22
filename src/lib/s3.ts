import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { debug } from '@pga/logger';

const s3Client = new S3Client({});

export interface S3Config {
  bucketName: string;
}

export function getS3Config(env: Record<string, string>): S3Config {
  const bucketName = env.S3_BUCKET_NAME;
  if (!bucketName) {
    throw new Error('S3_BUCKET_NAME environment variable is required');
  }
  
  return {
    bucketName
  };
}

export async function getJsonFromS3<T>(
  config: S3Config,
  key: string
): Promise<T | null> {
  try {
    debug(`Getting JSON from S3: s3://${config.bucketName}/${key}`);
    
    const command = new GetObjectCommand({
      Bucket: config.bucketName,
      Key: key
    });
    
    const response = await s3Client.send(command);
    
    if (!response.Body) {
      debug(`No body found in S3 object: ${key}`);
      return null;
    }
    
    const body = await response.Body.transformToString();
    const jsonData = JSON.parse(body);
    
    debug(`Successfully retrieved JSON from S3: ${key}`);
    return jsonData as T;
  } catch (error: any) {
    if (error.name === 'NoSuchKey') {
      debug(`S3 object not found: ${key}`);
      return null;
    }
    
    debug(`Error getting JSON from S3: ${error.message}`);
    throw error;
  }
}

export async function putJsonToS3<T>(
  config: S3Config,
  key: string,
  data: T
): Promise<void> {
  try {
    debug(`Putting JSON to S3: s3://${config.bucketName}/${key}`);
    
    const jsonString = JSON.stringify(data, null, 2);
    
    const command = new PutObjectCommand({
      Bucket: config.bucketName,
      Key: key,
      Body: jsonString,
      ContentType: 'application/json'
    });
    
    await s3Client.send(command);
    
    debug(`Successfully stored JSON in S3: ${key}`);
  } catch (error: any) {
    debug(`Error putting JSON to S3: ${error.message}`);
    throw error;
  }
}
