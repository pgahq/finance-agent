import * as dotenv from 'dotenv';
import { signDivotErrorReportBody } from './lib/divot_error_report.js';

dotenv.config();

type ProbeMode = 'first' | 'coalesce' | 'bad-hmac' | 'unknown-service';

function parseMode(argv: string[]): ProbeMode {
  if (argv.includes('--coalesce')) {
    return 'coalesce';
  }
  if (argv.includes('--bad-hmac')) {
    return 'bad-hmac';
  }
  if (argv.includes('--unknown-service')) {
    return 'unknown-service';
  }
  return 'first';
}

function requiredSecret(): string {
  const secret = process.env.DIVOT_SECRET?.trim() || process.env.ERROR_REPORTING_WEBHOOK_SECRET?.trim();
  if (!secret) {
    throw new Error('Set DIVOT_SECRET (or ERROR_REPORTING_WEBHOOK_SECRET) to the shared webhook secret');
  }
  return secret;
}

function errorsUrl(): string {
  return process.env.DIVOT_ERRORS_URL?.trim() || 'http://localhost:3000/api/errors';
}

function probePayload(service: string, message: string) {
  const slackChannel = process.env.DIVOT_SLACK_CHANNEL?.trim();
  return {
    service,
    awsAccountId: '000000000000',
    error: {
      name: 'Error',
      message,
    },
    context: { functionName: 'local-probe' },
    ...(slackChannel ? { slackChannel } : {}),
  };
}

async function postError(options: {
  service: string;
  message: string;
  signature?: string;
}): Promise<{ status: number; body: unknown }> {
  const url = errorsUrl();
  const secret = requiredSecret();
  const payload = probePayload(options.service, options.message);
  const body = JSON.stringify(payload);
  const signature = options.signature ?? signDivotErrorReportBody(body, secret);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Divot-Signature': signature,
    },
    body,
  });

  let parsed: unknown = await response.text();
  try {
    parsed = JSON.parse(String(parsed));
  } catch {
    // keep text
  }

  return { status: response.status, body: parsed };
}

function assertStatus(actual: number, expected: number, body: unknown) {
  console.log(JSON.stringify({ status: actual, body }, null, 2));
  if (actual !== expected) {
    throw new Error(`Expected HTTP ${expected}, got ${actual}`);
  }
}

async function main() {
  const mode = parseMode(process.argv.slice(2));
  const message = process.env.ERROR_REPORT_PROBE_MESSAGE || `local probe boom ${Date.now()}`;

  if (mode === 'bad-hmac') {
    const result = await postError({
      service: 'finance-agent',
      message,
      signature: 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
    });
    assertStatus(result.status, 401, result.body);
    return;
  }

  if (mode === 'unknown-service') {
    const result = await postError({
      service: 'not-a-service',
      message,
    });
    assertStatus(result.status, 422, result.body);
    return;
  }

  if (mode === 'coalesce') {
    const first = await postError({ service: 'finance-agent', message });
    assertStatus(first.status, 202, first.body);
    const firstBody = first.body as { claimed?: boolean; coalesced?: boolean };
    if (firstBody.claimed !== true || firstBody.coalesced !== false) {
      throw new Error('Expected first POST to be claimed');
    }

    const second = await postError({ service: 'finance-agent', message });
    assertStatus(second.status, 202, second.body);
    const secondBody = second.body as { claimed?: boolean; coalesced?: boolean; groupId?: string };
    if (secondBody.claimed !== false || secondBody.coalesced !== true) {
      throw new Error('Expected second POST to be coalesced');
    }
    if (secondBody.groupId !== (first.body as { groupId?: string }).groupId) {
      throw new Error('Expected coalesced POST to reuse the same groupId');
    }
    return;
  }

  const result = await postError({ service: 'finance-agent', message });
  assertStatus(result.status, 202, result.body);
  const body = result.body as { claimed?: boolean; coalesced?: boolean };
  if (body.claimed !== true || body.coalesced !== false) {
    throw new Error('Expected first POST to be claimed');
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
