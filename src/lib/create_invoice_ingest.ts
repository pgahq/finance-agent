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
  processorFields?: Record<string, string | number>;
}

/**
 * Report-only shadow record: sent after the per-attachment invokes, best-effort, marked `shadow: true`,
 * so the processor can classify and cluster every attachment without creating anything.
 */
export interface CreateInvoiceShadowInvoke {
  sharedFields: Record<string, string | number>;
}

export interface CreateInvoiceSharedFile {
  fileName: string;
  contentType: string;
  buffer: Buffer;
  payloadField: string;
}

export async function ingestCreateInvoiceAttachments(
  env: NodeJS.ProcessEnv,
  attachments: CreateInvoiceIngestAttachment[],
  s3Metadata: Record<string, string>,
  sharedFile?: CreateInvoiceSharedFile,
  shadowInvoke?: CreateInvoiceShadowInvoke,
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

  let sharedPayload: Record<string, { s3Key: string; fileName: string }> = {};
  if (sharedFile) {
    const s3Key = `new-invoices/${requestId}/${sharedFile.fileName}`;
    await putBinaryToS3(s3Config, s3Key, sharedFile.buffer, sharedFile.contentType, {
      'original-filename': sharedFile.fileName,
      'upload-timestamp': new Date().toISOString(),
      ...s3Metadata,
    });
    sharedPayload = {
      [sharedFile.payloadField]: { s3Key, fileName: sharedFile.fileName },
    };
  }
  const processorRecords = uploadedAttachments.map((attachment) => ({
    ...attachment,
    ...sharedPayload,
  }));

  const totalBytes = attachments.reduce((total, attachment) => total + attachment.buffer.length, 0)
    + (sharedFile?.buffer.length ?? 0);
  debug('Uploaded new invoice attachments to S3', {
    attachmentCount: uploadedAttachments.length,
    ...(sharedFile ? { transcriptFileName: sharedFile.fileName } : {}),
    totalBytes,
    ...s3Metadata,
  });

  const processorFunctionName = `${env.AWS_STACK_NAME}-CreateInvoiceProcessor`;
  const lambda = new LambdaClient({ region: env.AWS_REGION });

  await Promise.all(processorRecords.map((attachment) =>
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

  // Shadow reporting is best-effort and must never block the real per-attachment invoices above.
  if (shadowInvoke) {
    try {
      await lambda.send(new InvokeCommand({
        FunctionName: processorFunctionName,
        InvocationType: 'Event',
        Payload: JSON.stringify({
          data: [{ shadow: true, ...shadowInvoke.sharedFields, attachments: uploadedAttachments }],
          page: 1,
          totalPages: 1,
        }),
      }));
    } catch (error) {
      debug('Failed to invoke shadow attachment clustering', { error, ...s3Metadata });
    }
  }

  return {
    requestId,
    attachmentCount: uploadedAttachments.length,
    totalBytes,
  };
}
