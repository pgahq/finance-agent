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

  it('renders the shadow clustering plan as readable lines instead of JSON', async () => {
    await notifyResult('create_invoice_shadow', 'success', 2000, {
      mode: 'shadow',
      attachments: ['invoice.pdf', 'packing.pdf', 'flyer.pdf'],
      wouldCreateInvoices: 1,
      clusters: [{ invoice: 'invoice.pdf (supplier_invoice, #INV-1)', supporting: ['packing.pdf (supporting: packing_slip)'] }],
      unrelated: ['flyer.pdf (unrelated)'],
      note: 'Shadow mode: nothing was written.',
      conversationUrl: 'https://app.intercom.com/a/inbox/abc/inbox/conversation/123',
    });

    const texts = postedSlackTexts(global.fetch as jest.Mock);
    expect(texts).toContain('would create 1 invoice from 3 PDFs (shadow: nothing written)');
    expect(texts).toContain('*Invoice 1:* invoice.pdf (supplier_invoice, #INV-1)');
    expect(texts).toContain('↳ packing.pdf (supporting: packing_slip)');
    expect(texts).toContain('*Not attached:* flyer.pdf (unrelated)');
    expect(texts).toContain('Shadow mode: nothing was written.');
    expect(texts).not.toContain('"clusters"');
  });

  it('shows who triggered a failed run right after the error, not in the JSON details', async () => {
    await notifyResult('create_invoice', 'error', 1000, {
      fileName: 'invoice.pdf',
      triggeredByEmail: 'jcarey@pgahq.com',
      triggeredByName: 'Joe Carey',
    }, new Error('Create failed'));

    const body = postedSlackBody(global.fetch as jest.Mock);
    const errorIndex = body.blocks.findIndex((block) => block.text?.text === '*Error*\nCreate failed');
    expect(body.blocks[errorIndex + 1].text?.text).toBe('*Triggered by* Joe Carey (jcarey@pgahq.com)');
    const texts = postedSlackTexts(global.fetch as jest.Mock);
    expect(texts).toContain('"fileName": "invoice.pdf"');
    expect(texts).not.toContain('triggeredByEmail');
    expect(texts).not.toContain('triggeredByName');
  });

  it('shows the trigger email alone when no name was resolved', async () => {
    await notifyResult('create_invoice', 'error', 1000, {
      fileName: 'invoice.pdf',
      triggeredByEmail: 'jcarey@pgahq.com',
    }, new Error('Create failed'));

    const texts = postedSlackTexts(global.fetch as jest.Mock);
    expect(texts).toContain('*Triggered by* jcarey@pgahq.com');
    expect(texts).not.toContain('triggeredByEmail');
  });

  it('omits the trigger line when no trigger email is known', async () => {
    await notifyResult('create_invoice', 'error', 1000, {
      fileName: 'invoice.pdf',
      triggeredByName: 'Joe Carey',
    }, new Error('Create failed'));

    const texts = postedSlackTexts(global.fetch as jest.Mock);
    expect(texts).not.toContain('*Triggered by*');
    expect(texts).not.toContain('Joe Carey');
  });

  it('omits priorFailures when the error has none', async () => {
    await notifyResult('create_invoice', 'error', 1000, { fileName: 'invoice.pdf' }, new Error('Create failed'));

    const texts = postedSlackTexts(global.fetch as jest.Mock);
    expect(texts).toContain('*Error*\nCreate failed');
    expect(texts).not.toContain('*Prior submit failures*');
    expect(texts).not.toContain('*PO supplier mismatch*');
  });

  it('explains a PO supplier mismatch on the Slack error payload', async () => {
    const error = Object.assign(new Error("You can't select this supplier to invoice this purchase order."), {
      purchaseOrderSupplierMismatch: {
        purchaseOrderNumber: 'PO-414373',
        purchaseOrderSupplier: 'Club Pro Manufacturing USA',
        purchaseOrderSupplierWID: 'club-pro-wid',
        submittedSupplierWID: 'golf-gear-wid',
        invoiceSupplier: 'GOLF GEAR LTD',
      },
    });

    await notifyResult('create_invoice', 'error', 9000, { fileName: 'invoice.pdf' }, error);

    const texts = postedSlackTexts(global.fetch as jest.Mock);
    expect(texts).toContain('*PO supplier mismatch*\nPO-414373 is issued to *Club Pro Manufacturing USA*, and Workday only lets that supplier invoice it.');
    expect(texts).toContain('The invoice matched *GOLF GEAR LTD*, which does not look like the same company.');
    expect(texts).toContain('The invoice was not resubmitted with another supplier.');
  });

  it('shows a supplier switched to the PO supplier as from PO', async () => {
    await notifyResult('create_invoice', 'success', 12000, {
      invoiceWID: 'new-invoice-wid',
      supplier: { status: 'po', resolvedName: 'Club Pro Manufacturing USA', isDefault: false },
      appliedFallbacks: ['supplier from PO-414373 (Club Pro Manufacturing USA)'],
    });

    const texts = postedSlackTexts(global.fetch as jest.Mock);
    expect(texts).toContain('*Supplier* → Club Pro Manufacturing USA (from PO)');
    expect(texts).toContain('supplier from PO-414373 (Club Pro Manufacturing USA)');
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

  it('shows a PO taken from an Intercom note with its line and the invoice PO it replaced', async () => {
    await notifyResult('create_invoice', 'success', 12000, {
      invoiceWID: 'new-invoice-wid',
      invoiceNumber: 'SUPIN-465824',
      extracted: {
        purchaseOrderNumber: 'PO-413672',
        purchaseOrderSource: 'note',
        purchaseOrderLine: 7,
        invoicePurchaseOrderNumber: 'PO-411406',
      },
    });

    const texts = postedSlackTexts(global.fetch as jest.Mock);
    expect(texts).toContain('*PO #* → PO-413672 Line 7 (from Intercom note; invoice shows PO-411406)');
  });

  it('shows the email PO a note PO replaced when the invoice shows no PO', async () => {
    await notifyResult('create_invoice', 'success', 12000, {
      invoiceWID: 'new-invoice-wid',
      invoiceNumber: 'SUPIN-465824',
      extracted: {
        purchaseOrderNumber: 'PO-413672',
        purchaseOrderSource: 'note',
        emailPurchaseOrderNumber: 'PO-411406',
      },
    });

    expect(postedSlackTexts(global.fetch as jest.Mock)).toContain('*PO #* → PO-413672 (from Intercom note; email shows PO-411406)');
  });

  it('says when the PO coded the lines without linking them', async () => {
    await notifyResult('create_invoice', 'success', 12000, {
      invoiceWID: 'new-invoice-wid',
      invoiceNumber: 'SUPIN-465824',
      extracted: { purchaseOrderNumber: 'PO-411406', purchaseOrderNotLinked: true },
    });

    const texts = postedSlackTexts(global.fetch as jest.Mock);
    expect(texts).toContain('*PO #* → PO-411406 · coded from PO, not linked to PO lines');
  });

  it('shows the unchanged supplier invoice number and fallback supplier on create success', async () => {
    await notifyResult('create_invoice', 'success', 12000, {
      invoiceWID: 'new-invoice-wid',
      invoiceNumber: 'SUPIN-412727',
      supplier: { status: 'found', resolvedName: 'Safari', isDefault: false },
      extracted: { suppliersInvoiceNumber: '12345' },
      appliedFallbacks: ['default supplier'],
    });

    const texts = postedSlackTexts(global.fetch as jest.Mock);
    expect(texts).toContain('*Supplier Invoice #* → 12345');
    expect(texts).toContain('*Fallbacks Applied*\n• default supplier');
  });

  it('shows corrected tax and cleared freight on create success', async () => {
    await notifyResult('create_invoice', 'success', 12000, {
      invoiceWID: 'new-invoice-wid',
      invoiceNumber: 'SUPIN-465719',
      supplier: { status: 'found', resolvedName: 'BearCom', isDefault: false },
      extracted: { taxAmount: '510.86', freightCleared: true },
    });

    const texts = postedSlackTexts(global.fetch as jest.Mock);
    expect(texts).toContain('*Freight* → none');
    expect(texts).toContain('*Tax* → 510.86');
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

  it('keeps resend headlines when Workday returned only a WID', async () => {
    await notifyResult('create_invoice', 'success', 1000, {
      invoiceWID: 'b'.repeat(32),
      skipped: true,
      skipReason: 'No documents or messages newer than the last processing.',
    });

    const texts = postedSlackTexts(global.fetch as jest.Mock);
    expect(texts).toContain(`skipped resend for \`${'b'.repeat(32)}\` (nothing new)`);
    expect(texts).not.toContain('function ran');
  });

  it('labels a canceled invoice that was not replaced instead of saying nothing new', async () => {
    await notifyResult('create_invoice', 'success', 1000, {
      invoiceWID: 'new-invoice-wid',
      invoiceNumber: 'SUPIN-1',
      skipped: true,
      canceledNotReplaced: true,
      skipReason: 'Invoice SUPIN-1 was canceled and no newer document for it arrived, so no replacement was created.',
    });

    const texts = postedSlackTexts(global.fetch as jest.Mock);
    expect(texts).toContain('skipped resend for `SUPIN-1` (canceled; not replaced)');
    expect(texts).not.toContain('nothing new');
  });

  it('says another run is processing when a claim was already held', async () => {
    await notifyResult('create_invoice', 'success', 1000, {
      skipped: true,
      inProgressElsewhere: true,
      skipReason: 'Another run is already processing supplier invoice INV-1 for this conversation; skipped to avoid a duplicate.',
    });

    const texts = postedSlackTexts(global.fetch as jest.Mock);
    expect(texts).toContain('skipped resend (another run is processing it)');
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

  it('shows corrected tax and cleared freight on enrich success', async () => {
    await notifyEnrichmentResult({
      processingTime: 1500,
      invoiceNumber: 'SUPIN-465719',
      canModify: true,
      supplier: { status: 'matching', resolvedName: 'BearCom', isDefault: false },
      extracted: { taxAmount: '510.86', freightCleared: true },
      fallbacks: { defaultSupplier: false },
    });

    const texts = postedSlackTexts(global.fetch as jest.Mock);
    expect(texts).toContain('*Freight* → none');
    expect(texts).toContain('*Tax* → 510.86');
  });

  it('lists the closed-PO line note under Fallbacks Applied', async () => {
    const closedNote = 'PO-413898 is Closed or Pending Close; invoice lines were coded from the PO but not linked to PO lines.';
    await notifyEnrichmentResult({
      processingTime: 1500,
      invoiceNumber: 'INV-1',
      canModify: true,
      supplier: { status: 'matching', resolvedName: 'Acme', isDefault: false },
      extracted: { purchaseOrderNumber: 'PO-413898' },
      fallbacks: { defaultSupplier: false, purchaseOrderLineNotes: closedNote },
    });

    const texts = postedSlackTexts(global.fetch as jest.Mock);
    expect(texts).toContain(`*Fallbacks Applied*\n• ${closedNote}`);
  });

  it('lists the unchanged supplier invoice number and fallback supplier on enrich success', async () => {
    await notifyEnrichmentResult({
      processingTime: 1500,
      invoiceNumber: 'INV-1',
      canModify: true,
      supplier: { status: 'matching', resolvedName: 'Safari', isDefault: false },
      extracted: { suppliersInvoiceNumber: '12345' },
      fallbacks: { defaultSupplier: false },
      appliedFallbackLabels: ['default supplier'],
    });

    const texts = postedSlackTexts(global.fetch as jest.Mock);
    expect(texts).toContain('*Supplier Invoice #* → 12345');
    expect(texts).toContain('*Fallbacks Applied*\n• default supplier');
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
