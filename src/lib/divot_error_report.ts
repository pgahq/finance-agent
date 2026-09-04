import { createHmac } from 'node:crypto';
import { debug } from '@pga/logger';

export const DIVOT_ERROR_REPORT_SERVICE = 'finance-agent';
const SIGNATURE_HEADER = 'X-Divot-Signature';

export type DivotErrorReportContext = {
  functionName?: string;
  slackChannel?: string;
  [key: string]: unknown;
};

export type DivotErrorReportPayload = {
  service: string;
  awsAccountId: string;
  error: {
    name: string;
    message: string;
    stack?: string;
  };
  context?: {
    functionName?: string;
    [key: string]: unknown;
  };
  slackChannel?: string;
};

function webhookSecret(): string | undefined {
  const secret = process.env.DIVOT_SECRET?.trim() || process.env.ERROR_REPORTING_WEBHOOK_SECRET?.trim();
  return secret ? secret : undefined;
}

function errorsUrl(): string | undefined {
  const url = process.env.DIVOT_ERRORS_URL?.trim();
  return url ? url : undefined;
}

function awsAccountId(): string {
  return process.env.AWS_ACCOUNT_ID?.trim() || '000000000000';
}

function slackChannelFrom(context?: DivotErrorReportContext): string | undefined {
  const fromCall = typeof context?.slackChannel === 'string' ? context.slackChannel.trim() : '';
  if (fromCall) {
    return fromCall;
  }
  const fromEnv = process.env.DIVOT_SLACK_CHANNEL?.trim();
  return fromEnv ? fromEnv : undefined;
}

export function errorFieldsFromUnknown(error: unknown): DivotErrorReportPayload['error'] {
  if (error instanceof Error) {
    return {
      name: error.name || 'Error',
      message: error.message || 'Unknown error',
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }

  return {
    name: 'Error',
    message: String(error),
  };
}

export function signDivotErrorReportBody(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export function buildDivotErrorReportPayload(
  error: unknown,
  context?: DivotErrorReportContext
): DivotErrorReportPayload {
  const functionName = context?.functionName || process.env.AWS_LAMBDA_FUNCTION_NAME;
  const slackChannel = slackChannelFrom(context);
  const restContext = { ...context };
  delete restContext.slackChannel;

  const payload: DivotErrorReportPayload = {
    service: DIVOT_ERROR_REPORT_SERVICE,
    awsAccountId: awsAccountId(),
    error: errorFieldsFromUnknown(error),
    context: {
      ...restContext,
      ...(functionName ? { functionName } : {}),
    },
  };

  if (slackChannel) {
    payload.slackChannel = slackChannel;
  }

  return payload;
}

export async function reportError(
  error: unknown,
  context?: DivotErrorReportContext
): Promise<void> {
  try {
    const url = errorsUrl();
    const secret = webhookSecret();
    if (!url || !secret) {
      debug('Divot error reporting skipped: DIVOT_ERRORS_URL or DIVOT_SECRET is not set');
      return;
    }

    const payload = buildDivotErrorReportPayload(error, context);
    const body = JSON.stringify(payload);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [SIGNATURE_HEADER]: signDivotErrorReportBody(body, secret),
      },
      body,
    });

    if (!response.ok) {
      throw new Error(`Divot error report failed: ${response.status} ${response.statusText}`);
    }
  } catch (reportFailure) {
    debug('Error sending Divot error report:', reportFailure);
  }
}
