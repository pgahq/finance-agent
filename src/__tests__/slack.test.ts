import { notifyResult } from '../lib/slack.js';

jest.mock('@pga/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
}));

const originalFetch = global.fetch;

interface SlackWebhookBody {
  blocks: Array<{
    type: string;
    elements?: Array<{ text: string }>;
  }>;
}

interface SlackErrorPayload {
  error: {
    message?: string;
    priorFailures?: Array<{ attempt: number; fallback?: string; message: string }>;
  };
}

function postedSlackErrorPayload(fetchMock: jest.Mock): SlackErrorPayload {
  const [, options] = fetchMock.mock.calls[0] as [string, { body: string }];
  const body = JSON.parse(options.body) as SlackWebhookBody;
  const detailsJson = body.blocks[1]?.elements?.[0]?.text
    ?.replace(/^```/, '')
    .replace(/```$/, '') ?? '{}';
  return JSON.parse(detailsJson) as SlackErrorPayload;
}

describe('notifyResult', () => {
  beforeEach(() => {
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.test/services/test';
    delete process.env.AWS_REGION;
    delete process.env.AWS_LAMBDA_LOG_GROUP_NAME;
    delete process.env.AWS_LAMBDA_LOG_STREAM_NAME;
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.SLACK_WEBHOOK_URL;
    jest.restoreAllMocks();
  });

  it('includes priorFailures on the Slack error payload', async () => {
    const error = Object.assign(new Error("You can't select this supplier to invoice this purchase order."), {
      priorFailures: [
        { attempt: 1, message: "Enter a Supplier's Invoice Number that isn't already in use..." },
        { attempt: 2, fallback: 'default supplier', message: "You can't select this supplier to invoice this purchase order." },
      ],
    });

    await notifyResult('create_invoice', 'error', 72000, { fileName: 'invoice.pdf' }, error);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const payload = postedSlackErrorPayload(global.fetch as jest.Mock);
    expect(payload.error.priorFailures).toEqual([
      { attempt: 1, message: "Enter a Supplier's Invoice Number that isn't already in use..." },
      { attempt: 2, fallback: 'default supplier', message: "You can't select this supplier to invoice this purchase order." },
    ]);
    expect(payload.error.message).toBe("You can't select this supplier to invoice this purchase order.");
  });

  it('omits priorFailures when the error has none', async () => {
    await notifyResult('create_invoice', 'error', 1000, { fileName: 'invoice.pdf' }, new Error('Create failed'));

    const payload = postedSlackErrorPayload(global.fetch as jest.Mock);
    expect(payload.error).not.toHaveProperty('priorFailures');
  });
});
