import { randomUUID } from 'node:crypto';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import loadEnv from '@pga/lambda-env';
import { debug } from '@pga/logger';
import { extractBearerToken, isAuthorizedBearer } from './lib/api_auth.js';
import { getS3Config, putBinaryToS3 } from './lib/s3.js';

interface TriggerCreateInvoiceRequest {
  fileName?: string;
  contentType?: string;
  fileContent?: string; // base64
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function jsonResponse(statusCode: number, body: Record<string, string>): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  debug('Trigger create invoice request received');
  process.env = await loadEnv();

  const expectedToken = process.env.ENRICH_INVOICE_API_TOKEN;
  if (!expectedToken) {
    debug('ENRICH_INVOICE_API_TOKEN is not configured');
    return jsonResponse(500, { message: 'Internal server error' });
  }

  const providedToken = extractBearerToken(event.headers?.authorization);
  if (!isAuthorizedBearer(providedToken ?? '', expectedToken)) {
    debug('Unauthorized create invoice trigger request', {
      hasAuthorizationHeader: Boolean(event.headers?.authorization),
    });
    return jsonResponse(401, { message: 'Unauthorized' });
  }

  let requestBody: TriggerCreateInvoiceRequest;
  try {
    requestBody = event.body ? JSON.parse(event.body) as TriggerCreateInvoiceRequest : {};
  } catch (error) {
    debug('Invalid JSON body', { error: formatError(error) });
    return jsonResponse(400, { message: 'Invalid JSON body' });
  }

  const { fileName, contentType, fileContent } = requestBody;
  if (!fileName || !contentType || !fileContent) {
    debug('Missing required fields in create invoice trigger request', {
      hasFileName: Boolean(fileName),
      hasContentType: Boolean(contentType),
      hasFileContent: Boolean(fileContent),
    });
    return jsonResponse(400, { message: 'fileName, contentType, and fileContent (base64) are required' });
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(fileContent, 'base64');
  } catch (error) {
    debug('Invalid base64 fileContent', { error: formatError(error) });
    return jsonResponse(400, { message: 'fileContent must be valid base64' });
  }

  try {
    const s3Config = getS3Config(process.env);
    const requestId = randomUUID();
    const s3Key = `new-invoices/${requestId}/${fileName}`;

    debug('Uploading new invoice attachment to S3', { s3Key, contentType, size: buffer.length });
    await putBinaryToS3(s3Config, s3Key, buffer, contentType, {
      'original-filename': fileName,
      'upload-timestamp': new Date().toISOString(),
    });

    const processorFunctionName = `${process.env.AWS_STACK_NAME}-CreateInvoiceProcessor`;
    const lambda = new LambdaClient({ region: process.env.AWS_REGION });

    const invokeResult = await lambda.send(new InvokeCommand({
      FunctionName: processorFunctionName,
      InvocationType: 'Event',
      Payload: JSON.stringify({
        data: [{ s3Key, fileName, contentType }],
        page: 1,
        totalPages: 1,
      }),
    }));

    if (invokeResult.FunctionError) {
      debug('Create invoice processor invoke error', {
        functionError: invokeResult.FunctionError,
        payload: invokeResult.Payload
          ? Buffer.from(invokeResult.Payload).toString('utf8')
          : undefined,
      });
      return jsonResponse(500, { message: 'Internal server error' });
    }

    return jsonResponse(202, {
      message: 'Invoice creation triggered',
      requestId,
    });
  } catch (error) {
    debug('Error triggering invoice creation', { error: formatError(error) });
    return jsonResponse(500, { message: 'Internal server error' });
  }
}
