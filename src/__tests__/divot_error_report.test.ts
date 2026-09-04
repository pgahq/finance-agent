import { debug } from '@pga/logger';
import {
  reportError,
  signDivotErrorReportBody,
} from '../lib/divot_error_report.js';

jest.mock('@pga/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
}));

const originalFetch = global.fetch;

function postedRequest(fetchMock: jest.Mock, callIndex = 0): { url: string; body: string; signature: string } {
  const [url, options] = fetchMock.mock.calls[callIndex] as [string, { body: string; headers: Record<string, string> }];
  return {
    url,
    body: options.body,
    signature: options.headers['X-Divot-Signature'],
  };
}

function postedPayload(fetchMock: jest.Mock, callIndex = 0): {
  service: string;
  awsAccountId: string;
  error: { name: string; message: string };
  context: { functionName: string };
} {
  return JSON.parse(postedRequest(fetchMock, callIndex).body) as {
    service: string;
    awsAccountId: string;
    error: { name: string; message: string };
    context: { functionName: string };
  };
}

describe('divot error report', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.DIVOT_ERRORS_URL;
    delete process.env.DIVOT_SECRET;
    delete process.env.ERROR_REPORTING_WEBHOOK_SECRET;
    delete process.env.AWS_ACCOUNT_ID;
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    delete process.env.DIVOT_SLACK_CHANNEL;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('no-ops when the URL or secret is missing', async () => {
    global.fetch = jest.fn();
    process.env.DIVOT_ERRORS_URL = 'http://localhost:3000/api/errors';

    await reportError(new Error('boom'));

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('no-ops when DIVOT_ERRORS_URL is unset even if the secret is present', async () => {
    global.fetch = jest.fn();
    process.env.DIVOT_SECRET = 'shared-secret';

    await reportError(new Error('boom'));

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('no-ops when DIVOT_ERRORS_URL is blank', async () => {
    global.fetch = jest.fn();
    process.env.DIVOT_ERRORS_URL = '  ';
    process.env.DIVOT_SECRET = 'shared-secret';

    await reportError(new Error('boom'));

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('POSTs a signed finance-agent payload and swallows HTTP failures', async () => {
    process.env.DIVOT_ERRORS_URL = 'http://localhost:3000/api/errors';
    process.env.DIVOT_SECRET = 'shared-secret';
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'CreateInvoiceProcessor';
    global.fetch = jest.fn().mockRejectedValue(new Error('network down'));

    await expect(reportError(new Error('invoice failed'))).resolves.toBeUndefined();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const posted = postedRequest(global.fetch as jest.Mock);
    expect(posted.url).toBe('http://localhost:3000/api/errors');
    expect(posted.signature).toBe(signDivotErrorReportBody(posted.body, 'shared-secret'));
    const parsed = postedPayload(global.fetch as jest.Mock);
    expect(parsed.service).toBe('finance-agent');
    expect(parsed.awsAccountId).toBe('000000000000');
    expect(parsed.error.name).toBe('Error');
    expect(parsed.error.message).toBe('invoice failed');
    expect(parsed.context.functionName).toBe('CreateInvoiceProcessor');
    expect(parsed).not.toHaveProperty('slackChannel');
    expect(debug).toHaveBeenCalled();
  });

  it('omits slackChannel when unset so Divot skips Slack', async () => {
    process.env.DIVOT_ERRORS_URL = 'http://localhost:3000/api/errors';
    process.env.DIVOT_SECRET = 'shared-secret';
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 202 });

    await reportError(new Error('boom'));

    expect(postedPayload(global.fetch as jest.Mock)).not.toHaveProperty('slackChannel');
  });

  it('passes slackChannel from the call, overriding DIVOT_SLACK_CHANNEL', async () => {
    process.env.DIVOT_ERRORS_URL = 'http://localhost:3000/api/errors';
    process.env.DIVOT_SECRET = 'shared-secret';
    process.env.DIVOT_SLACK_CHANNEL = '#from-env';
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 202 });

    await reportError(new Error('boom'), {
      functionName: 'create_invoice',
      slackChannel: '#notify-finance-agent-dev',
    });

    const parsed = postedPayload(global.fetch as jest.Mock) as {
      slackChannel?: string;
      context: { functionName: string; slackChannel?: string };
    };
    expect(parsed.slackChannel).toBe('#notify-finance-agent-dev');
    expect(parsed.context.functionName).toBe('create_invoice');
    expect(parsed.context.slackChannel).toBeUndefined();
  });

  it('uses DIVOT_SLACK_CHANNEL when the call omits slackChannel', async () => {
    process.env.DIVOT_ERRORS_URL = 'http://localhost:3000/api/errors';
    process.env.DIVOT_SECRET = 'shared-secret';
    process.env.DIVOT_SLACK_CHANNEL = '#notify-finance-agent-dev';
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 202 });

    await reportError(new Error('boom'));

    expect((postedPayload(global.fetch as jest.Mock) as { slackChannel?: string }).slackChannel).toBe(
      '#notify-finance-agent-dev'
    );
  });

  it('uses ERROR_REPORTING_WEBHOOK_SECRET when DIVOT_SECRET is unset', async () => {
    process.env.DIVOT_ERRORS_URL = 'http://localhost:3000/api/errors';
    process.env.ERROR_REPORTING_WEBHOOK_SECRET = 'alias-secret';
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 202 });

    await reportError(new Error('boom'), { functionName: 'local-probe' });

    const posted = postedRequest(global.fetch as jest.Mock);
    expect(posted.signature).toBe(signDivotErrorReportBody(posted.body, 'alias-secret'));
    const parsed = postedPayload(global.fetch as jest.Mock);
    expect(parsed.awsAccountId).toBe('000000000000');
    expect(parsed.service).toBe('finance-agent');
  });
});
