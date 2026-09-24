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
    delete process.env.WORKDAY_UI_BASE_URL;
    delete process.env.WORKDAY_TENANT;
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.WORKDAY_UI_BASE_URL;
    delete process.env.WORKDAY_TENANT;
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
    expect(texts).not.toContain('*Full error*');
  });

  it('omits priorFailures when the error has none', async () => {
    await notifyResult('create_invoice', 'error', 1000, { fileName: 'invoice.pdf' }, new Error('Create failed'));

    const texts = postedSlackTexts(global.fetch as jest.Mock);
    expect(texts).toContain('*Error*\nCreate failed');
    expect(texts).not.toContain('*Prior submit failures*');
  });

  it('renders create success as Changes, not a JSON dump', async () => {
    await notifyResult('create_invoice', 'success', 12000, {
      invoiceWID: 'new-invoice-wid',
      invoiceNumber: 'SUPIN-412727',
      conversationId: '1234567890',
      conversationUrl: 'https://app.intercom.com/a/inbox/c722leqk/inbox/conversation/1234567890',
      attachment: { fileName: 'Invoices -1-.PDF', contentType: 'application/pdf', sizeBytes: 33915, includedInline: true },
      supplier: { status: 'found', resolvedName: 'ACUSHNET COMPANY', isDefault: false },
      company: {
        status: 'different',
        appliedFrom: 'recommended',
        appliedName: 'PGA Foundation Inc',
        appliedId: 'company-wid',
        recommendedName: 'PGA Foundation Inc',
      },
      extracted: { invoiceDate: '2026-08-21', amountDue: '$448.92' },
      assigneeName: 'Joe Carey',
      assigneeEmail: 'jcarey@pgahq.com',
      assigneeWorkdayId: 'wid-jcarey',
      lineCount: 3,
      priorFailures: [
        { attempt: 1, message: "Enter a Supplier's Invoice Number that isn't already in use..." },
      ],
    });

    const texts = postedSlackTexts(global.fetch as jest.Mock);
    expect(texts).toContain('created `SUPIN-412727`');
    expect(texts).toContain('*Workday Invoice* → `SUPIN-412727`');
    expect(texts).toContain('*Changes*');
    expect(texts).toContain('*Supplier* → ACUSHNET COMPANY (identified)');
    expect(texts).toContain('*Company* → PGA Foundation Inc (recommended)');
    expect(texts).toContain('*Invoice Date* → 2026-08-21');
    expect(texts).toContain('*Amount Due* → $448.92');
    expect(texts).toContain('*Assignee* → Joe Carey (jcarey@pgahq.com)');
    expect(texts).toContain('*Prior submit failures*');
    expect(texts).toContain("Attempt 1: Enter a Supplier's Invoice Number that isn't already in use...");
    expect(texts).toContain('"invoiceNumber": "SUPIN-412727"');
    expect(texts).toContain('"invoiceWID": "new-invoice-wid"');
    expect(texts).toContain('"fileName": "Invoices -1-.PDF"');
    expect(texts).toContain('"conversationId": "1234567890"');
    expect(texts).not.toContain('"resolvedName"');
    expect(texts).not.toContain('conversationUrl');
  });

  it('lists clustered files and unrelated docs on create success', async () => {
    await notifyResult('create_invoice', 'success', 12000, {
      invoiceWID: 'new-invoice-wid',
      invoiceNumber: 'SUPIN-412727',
      attachment: { fileName: 'invoice.pdf', contentType: 'application/pdf', sizeBytes: 100, includedInline: true },
      attachments: [
        { fileName: 'invoice.pdf', kind: 'supplier_invoice' },
        { fileName: 'packing-slip.pdf', kind: 'supporting' },
      ],
      unrelatedAttachments: ['other.pdf'],
    });

    const texts = postedSlackTexts(global.fetch as jest.Mock);
    expect(texts).toContain('"fileName": "invoice.pdf"');
    expect(texts).toContain('invoice.pdf (supplier_invoice)');
    expect(texts).toContain('packing-slip.pdf (supporting)');
    expect(texts).toContain('"unrelatedAttachments"');
  });

  it('announces resend updates with an updated headline', async () => {
    await notifyResult('create_invoice', 'success', 12000, {
      invoiceWID: 'new-invoice-wid',
      invoiceNumber: 'SUPIN-412727',
      updated: true,
      attachment: { fileName: 'v2.pdf', contentType: 'application/pdf', sizeBytes: 100, includedInline: true },
    });

    const texts = postedSlackTexts(global.fetch as jest.Mock);
    expect(texts).toContain('updated `SUPIN-412727`');
    expect(texts).not.toContain('created `SUPIN-412727`');
  });

  it('renders resend skips with the skip reason', async () => {
    await notifyResult('create_invoice', 'success', 12000, {
      invoiceWID: 'new-invoice-wid',
      invoiceNumber: 'SUPIN-412727',
      skipped: true,
      skipReason: 'No documents newer than the last processing of SUPIN-412727.',
      attachment: { fileName: 'v2.pdf', contentType: 'application/pdf', sizeBytes: 100, includedInline: true },
    });

    const texts = postedSlackTexts(global.fetch as jest.Mock);
    expect(texts).toContain('skipped resend for `SUPIN-412727`');
    expect(texts).not.toContain('created `SUPIN-412727`');
    expect(texts).toContain('*Skipped*');
    expect(texts).toContain('No documents newer than the last processing of SUPIN-412727.');
    expect(texts).toContain('"skipped": true');
  });

  it('flags resends that need manual review in the headline instead of saying created', async () => {
    await notifyResult('create_invoice', 'success', 12000, {
      invoiceWID: 'new-invoice-wid',
      invoiceNumber: 'SUPIN-412727',
      skipped: true,
      needsManualReview: true,
      skipReason: 'Invoice SUPIN-412727 is Approved (paid); re-sent documents need manual review.',
    });

    const texts = postedSlackTexts(global.fetch as jest.Mock);
    expect(texts).toContain('needs manual review for `SUPIN-412727`');
    expect(texts).not.toContain('created `SUPIN-412727`');
    expect(texts).toContain('re-sent documents need manual review.');
  });

  it('names the canceled invoice a new create replaces', async () => {
    await notifyResult('create_invoice', 'success', 12000, {
      invoiceWID: 'new-invoice-wid',
      invoiceNumber: 'SUPIN-412728',
      replacesCanceledInvoice: 'SUPIN-412727',
    });

    const texts = postedSlackTexts(global.fetch as jest.Mock);
    expect(texts).toContain('created `SUPIN-412728`');
    expect(texts).toContain('"replacesCanceledInvoice": "SUPIN-412727"');
  });

  it('surfaces registry sync failures on create success', async () => {
    await notifyResult('create_invoice', 'success', 12000, {
      invoiceWID: 'new-invoice-wid',
      invoiceNumber: 'SUPIN-412727',
      registrySync: 'failed',
      attachment: { fileName: 'invoice.pdf', contentType: 'application/pdf', sizeBytes: 100, includedInline: true },
    });

    const texts = postedSlackTexts(global.fetch as jest.Mock);
    expect(texts).toContain('"registrySync": "failed"');
  });

  it('omits the Workday invoice number on create when Invoice_Number is missing', async () => {
    await notifyResult('create_invoice', 'success', 12000, {
      invoiceWID: 'new-invoice-wid',
      supplier: { status: 'found', resolvedName: 'ACUSHNET COMPANY', isDefault: false },
    });

    const texts = postedSlackTexts(global.fetch as jest.Mock);
    expect(texts).toContain('function ran *successfully* in 12.00s');
    expect(texts).not.toContain('created `');
    expect(texts).not.toContain('Workday Invoice');
    expect(texts).not.toContain('"invoiceNumber"');
    expect(texts).toContain('"invoiceWID": "new-invoice-wid"');
  });

  it('truncates stacked prior submit failures on create success', async () => {
    await notifyResult('create_invoice', 'success', 12000, {
      invoiceWID: 'new-invoice-wid',
      priorFailures: [1, 2, 3].map((attempt) => ({
        attempt,
        message: 'x'.repeat(1000),
      })),
    });

    const priorBlock = postedSlackBody(global.fetch as jest.Mock).blocks.find((block) =>
      block.text?.text?.startsWith('*Prior submit failures*')
    );
    expect(priorBlock?.text?.text?.length).toBeLessThanOrEqual(2900);
    expect(priorBlock?.text?.text?.endsWith('…')).toBe(true);
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

  it('links the created invoice in implementation Workday', async () => {
    process.env.WORKDAY_UI_BASE_URL = 'https://impl.workday.com';
    process.env.WORKDAY_TENANT = 'pgahq';

    await notifyResult('create_invoice', 'success', 1000, {
      invoiceWID: 'a1b2c3d4e5f678901234567890abcdef',
      invoiceNumber: 'SUPIN-412727',
    });

    const texts = postedSlackTexts(global.fetch as jest.Mock);
    const implUrl = 'https://impl.workday.com/pgahq/d/inst/deeplink/a1b2c3d4e5f678901234567890abcdef.htmld';
    expect(texts).toContain(`*Workday Invoice* → <${implUrl}|SUPIN-412727>`);
    expect(texts).toContain(`<${implUrl}|View in Workday>`);
    expect(texts).not.toContain('www.myworkday.com');
  });

  it('links the created invoice in production Workday', async () => {
    process.env.WORKDAY_UI_BASE_URL = 'https://www.myworkday.com';
    process.env.WORKDAY_TENANT = 'pgahq';

    await notifyResult('create_invoice', 'success', 1000, {
      invoiceWID: 'a1b2c3d4e5f678901234567890abcdef',
      invoiceNumber: 'SUPIN-412727',
    });

    const texts = postedSlackTexts(global.fetch as jest.Mock);
    const prodUrl = 'https://www.myworkday.com/pgahq/d/inst/deeplink/a1b2c3d4e5f678901234567890abcdef.htmld';
    expect(texts).toContain(`*Workday Invoice* → <${prodUrl}|SUPIN-412727>`);
    expect(texts).toContain(`<${prodUrl}|View in Workday>`);
    expect(texts).not.toContain('impl.workday.com');
  });

  it('adds a Workday footer link when Invoice_Number is missing', async () => {
    process.env.WORKDAY_UI_BASE_URL = 'https://impl.workday.com';
    process.env.WORKDAY_TENANT = 'pgahq';

    await notifyResult('create_invoice', 'success', 1000, {
      invoiceWID: 'a1b2c3d4e5f678901234567890abcdef',
    });

    const texts = postedSlackTexts(global.fetch as jest.Mock);
    expect(texts).not.toContain('Workday Invoice');
    expect(texts).toContain(
      '<https://impl.workday.com/pgahq/d/inst/deeplink/a1b2c3d4e5f678901234567890abcdef.htmld|View in Workday>'
    );
  });

  it('adds a Workday footer link on enrich errors that have a WID', async () => {
    process.env.WORKDAY_UI_BASE_URL = 'https://www.myworkday.com';
    process.env.WORKDAY_TENANT = 'pgahq';

    await notifyResult(
      'enrich_invoice',
      'error',
      1000,
      { workdayId: 'a1b2c3d4e5f678901234567890abcdef' },
      new Error('Enrich failed')
    );

    const texts = postedSlackTexts(global.fetch as jest.Mock);
    expect(texts).toContain(
      '<https://www.myworkday.com/pgahq/d/inst/deeplink/a1b2c3d4e5f678901234567890abcdef.htmld|View in Workday>'
    );
  });

  it('omits the Workday link when the UI base URL is not configured', async () => {
    await notifyResult('create_invoice', 'success', 1000, {
      invoiceWID: 'a1b2c3d4e5f678901234567890abcdef',
      invoiceNumber: 'SUPIN-412727',
    });

    const texts = postedSlackTexts(global.fetch as jest.Mock);
    expect(texts).toContain('*Workday Invoice* → `SUPIN-412727`');
    expect(texts).not.toContain('View in Workday');
    expect(texts).not.toContain('d/inst/deeplink');
  });
});

describe('notifyEnrichmentResult', () => {
  beforeEach(() => {
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.test/services/test';
    delete process.env.AWS_REGION;
    delete process.env.AWS_LAMBDA_LOG_GROUP_NAME;
    delete process.env.AWS_LAMBDA_LOG_STREAM_NAME;
    delete process.env.WORKDAY_UI_BASE_URL;
    delete process.env.WORKDAY_TENANT;
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.WORKDAY_UI_BASE_URL;
    delete process.env.WORKDAY_TENANT;
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
    expect(texts.join('\n')).toContain('*Workday Invoice* → `INV-1`');
  });

  it('omits the Workday invoice number when Invoice_Number is missing', async () => {
    await notifyEnrichmentResult({
      processingTime: 1500,
      canModify: true,
      supplier: { status: 'matching', resolvedName: 'Acme', isDefault: false },
      extracted: {},
      fallbacks: { defaultSupplier: false },
    });

    const texts = postedSlackTexts(global.fetch as jest.Mock);
    expect(texts).toContain('processed in 1.50s');
    expect(texts).not.toContain('Workday Invoice');
    expect(texts).not.toContain('Unknown');
  });

  it('truncates stacked prior submit failures on enrich success', async () => {
    await notifyEnrichmentResult({
      processingTime: 1500,
      invoiceNumber: 'INV-1',
      canModify: true,
      supplier: { status: 'matching', resolvedName: 'Acme', isDefault: false },
      extracted: {},
      fallbacks: { defaultSupplier: false },
      priorFailures: [1, 2, 3].map((attempt) => ({
        attempt,
        message: 'x'.repeat(1000),
      })),
    });

    const priorBlock = postedSlackBody(global.fetch as jest.Mock).blocks.find((block) =>
      block.text?.text?.startsWith('*Prior submit failures*')
    );
    expect(priorBlock?.text?.text?.length).toBeLessThanOrEqual(2900);
    expect(priorBlock?.text?.text?.endsWith('…')).toBe(true);
  });

  it('links the enriched invoice in implementation Workday', async () => {
    process.env.WORKDAY_UI_BASE_URL = 'https://impl.workday.com';
    process.env.WORKDAY_TENANT = 'pgahq';

    await notifyEnrichmentResult({
      processingTime: 1500,
      invoiceNumber: 'INV-1',
      invoiceWID: 'a1b2c3d4e5f678901234567890abcdef',
      canModify: true,
      supplier: { status: 'matching', resolvedName: 'Acme', isDefault: false },
      extracted: {},
      fallbacks: { defaultSupplier: false },
    });

    const texts = postedSlackTexts(global.fetch as jest.Mock);
    const implUrl = 'https://impl.workday.com/pgahq/d/inst/deeplink/a1b2c3d4e5f678901234567890abcdef.htmld';
    expect(texts).toContain(`*Workday Invoice* → <${implUrl}|INV-1>`);
    expect(texts).toContain(`<${implUrl}|View in Workday>`);
  });

  it('adds a Workday footer link when enrichment has a WID but no Invoice_Number', async () => {
    process.env.WORKDAY_UI_BASE_URL = 'https://www.myworkday.com';
    process.env.WORKDAY_TENANT = 'pgahq';

    await notifyEnrichmentResult({
      processingTime: 1500,
      invoiceWID: 'a1b2c3d4e5f678901234567890abcdef',
      canModify: true,
      supplier: { status: 'matching', resolvedName: 'Acme', isDefault: false },
      extracted: {},
      fallbacks: { defaultSupplier: false },
    });

    const texts = postedSlackTexts(global.fetch as jest.Mock);
    expect(texts).not.toContain('Workday Invoice');
    expect(texts).toContain(
      '<https://www.myworkday.com/pgahq/d/inst/deeplink/a1b2c3d4e5f678901234567890abcdef.htmld|View in Workday>'
    );
  });
});
