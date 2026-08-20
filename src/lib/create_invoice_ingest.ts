import { randomUUID } from 'node:crypto';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { debug } from '@pga/logger';
import type { InvoiceData } from './types.js';
import { getS3Config, putBinaryToS3 } from './s3.js';

export const MAX_CONCURRENT_ATTACHMENT_DOWNLOADS = 4;

export interface CreateInvoiceIngestAttachment {
  name: string;
  contentType: string;
  buffer: Buffer;
  emailContext?: InvoiceData['emailContext'];
  processorFields?: Record<string, string>;
}

export async function ingestCreateInvoiceAttachments(
  env: NodeJS.ProcessEnv,
  attachments: CreateInvoiceIngestAttachment[],
  s3Metadata: Record<string, string>,
): Promise<{ requestId: string; attachmentCount: number; totalBytes: number }> {
  const s3Config = getS3Config(env);
  const requestId = randomUUID();
  const uploadedAttachments = await Promise.all(attachments.map(async (attachment, index) => {
    const s3Key = `new-invoices/${requestId}/${index + 1}-${attachment.name}`;
    await putBinaryToS3(s3Config, s3Key, attachment.buffer, attachment.contentType, {
      'original-filename': attachment.name,
      'upload-timestamp': new Date().toISOString(),
      ...s3Metadata,
    });
    return {
      s3Key,
      fileName: attachment.name,
      contentType: attachment.contentType,
      emailContext: attachment.emailContext,
      ...attachment.processorFields,
    };
  }));

  const totalBytes = attachments.reduce((total, attachment) => total + attachment.buffer.length, 0);
  debug('Uploaded new invoice attachments to S3', {
    attachmentCount: uploadedAttachments.length,
    totalBytes,
    ...s3Metadata,
  });

  const processorFunctionName = `${env.AWS_STACK_NAME}-CreateInvoiceProcessor`;
  const lambda = new LambdaClient({ region: env.AWS_REGION });

  await Promise.all(uploadedAttachments.map((attachment) =>
    lambda.send(new InvokeCommand({
      FunctionName: processorFunctionName,
      InvocationType: 'Event',
      Payload: JSON.stringify({
        data: [attachment],
        page: 1,
        totalPages: 1,
      }),
    }))
  ));

  return {
    requestId,
    attachmentCount: uploadedAttachments.length,
    totalBytes,
  };
}
