import { notifyEnrichmentResult, notifyResult } from '../lib/slack.js';

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
    text?: { text: string };
    elements?: Array<{ text: string }>;
  }>;
}

function postedSlackBody(fetchMock: jest.Mock, callIndex = 0): SlackWebhookBody {
  const [, options] = fetchMock.mock.calls[callIndex] as [string, { body: string }];
  return JSON.parse(options.body) as SlackWebhookBody;
}

function postedSlackTexts(fetchMock: jest.Mock): string {
  const body = postedSlackBody(fetchMock);
  return body.blocks.flatMap((block) => [
    ...(block.text?.text ? [block.text.text] : []),
    ...(block.elements?.map((element) => element.text) ?? []),
  ]).join('\n');
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
    const texts = postedSlackTexts(global.fetch as jest.Mock);
    expect(texts).toContain("*Error*\nYou can't select this supplier to invoice this purchase order.");
    expect(texts).toContain('*Prior submit failures*');
    expect(texts).toContain("Attempt 1: Enter a Supplier's Invoice Number that isn't already in use...");
    expect(texts).toContain("Attempt 2 (default supplier): You can't select this supplier to invoice this purchase order.");
    expect(texts).toContain('"fileName": "invoice.pdf"');
    expect(texts).not.toContain('"stack"');
    expect(texts).not.toContain('faultcode:');
  });

  it('omits priorFailures when the error has none', async () => {
    await notifyResult('create_invoice', 'error', 1000, { fileName: 'invoice.pdf' }, new Error('Create failed'));

    const texts = postedSlackTexts(global.fetch as jest.Mock);
    expect(texts).toContain('*Error*\nCreate failed');
    expect(texts).not.toContain('*Prior submit failures*');
  });

  it('includes priorFailures on the Slack success payload', async () => {
    await notifyResult('create_invoice', 'success', 12000, {
      invoiceWID: 'new-invoice-wid',
      priorFailures: [
        { attempt: 1, message: "Enter a Supplier's Invoice Number that isn't already in use..." },
      ],
    });

    const detailsJson = postedSlackBody(global.fetch as jest.Mock).blocks[1]?.elements?.[0]?.text
      ?.replace(/^```/, '')
      .replace(/```$/, '') ?? '{}';
    expect(JSON.parse(detailsJson)).toEqual(expect.objectContaining({
      invoiceWID: 'new-invoice-wid',
      priorFailures: [
        { attempt: 1, message: "Enter a Supplier's Invoice Number that isn't already in use..." },
      ],
    }));
  });

  it('adds an Intercom conversation link next to CloudWatch logs', async () => {
    process.env.AWS_REGION = 'us-east-1';
    process.env.AWS_LAMBDA_LOG_GROUP_NAME = '/aws/lambda/create-invoice';
    process.env.AWS_LAMBDA_LOG_STREAM_NAME = '2026/01/01/[$LATEST]abc';

    await notifyResult(
      'create_invoice',
      'error',
      1000,
      {
        fileName: 'invoice.pdf',
        conversationId: '1234567890',
        conversationUrl: 'https://app.intercom.com/a/inbox/jyi16dpc/inbox/conversation/1234567890',
      },
      new Error('Create failed')
    );

    const links = postedSlackBody(global.fetch as jest.Mock).blocks.at(-1)?.elements?.[0]?.text;
    expect(links).toContain('<https://app.intercom.com/a/inbox/jyi16dpc/inbox/conversation/1234567890|View Intercom conversation>');
    expect(links).toContain('View CloudWatch logs');
  });

  it('omits the Intercom link when no conversation URL is provided', async () => {
    await notifyResult('create_invoice', 'success', 1000, { invoiceWID: 'new-invoice-wid' });

    const body = postedSlackBody(global.fetch as jest.Mock);
    const texts = body.blocks.flatMap((block) => block.elements?.map((element) => element.text) ?? []);
    expect(texts.join('\n')).not.toContain('View Intercom conversation');
  });

  it('prints remaining error details besides conversationUrl', async () => {
    await notifyResult(
      'enrich_invoice',
      'error',
      1000,
      {
        workdayId: 'invoice-wid',
        fileName: 'invoice.pdf',
        note: 'Workday returned "The task submitted is not authorized"; not retrying this Lambda invocation.',
        conversationUrl: 'https://app.intercom.com/a/inbox/jyi16dpc/inbox/conversation/123',
      },
      new Error('Create failed')
    );

    const texts = postedSlackTexts(global.fetch as jest.Mock);
    expect(texts).toContain('"workdayId": "invoice-wid"');
    expect(texts).toContain('"fileName": "invoice.pdf"');
    expect(texts).toContain('not retrying this Lambda invocation');
    expect(texts).not.toContain('conversationUrl');
  });
});

describe('notifyEnrichmentResult', () => {
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

  it('includes prior submit failures on a successful enrichment message', async () => {
    await notifyEnrichmentResult({
      processingTime: 1500,
      invoiceNumber: 'INV-1',
      canModify: true,
      supplier: { status: 'matching', resolvedName: 'Acme', isDefault: false },
      extracted: {},
      fallbacks: { defaultSupplier: false },
      priorFailures: [
        { attempt: 1, message: 'The invoice date must be the first day of the month.' },
      ],
    });

    const body = postedSlackBody(global.fetch as jest.Mock);
    const texts = body.blocks.flatMap((block) => [
      ...(block.text?.text ? [block.text.text] : []),
      ...(block.elements?.map((element) => element.text) ?? []),
    ]);
    expect(texts.join('\n')).toContain('*Prior submit failures*');
    expect(texts.join('\n')).toContain('Attempt 1: The invoice date must be the first day of the month.');
  });
});
