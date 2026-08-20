import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { handler } from '../gmail_addon.js';
import { GmailAddonUnauthorizedError } from '../lib/gmail_addon_auth.js';
import { supplierInvoiceAddonCopy } from '../lib/gmail_addon_copy.js';

const mockVerifyGmailAddonOidc = jest.fn();
const mockEmailFromUserIdToken = jest.fn();
const mockGetGmailConfig = jest.fn();
const mockGetSupplierInvoiceLabelState = jest.fn();
const mockRunCreateInvoiceFromGmail = jest.fn();

jest.mock('@pga/lambda-env', () => ({
  __esModule: true,
  default: jest.fn().mockResolvedValue({
    GMAIL_ADDON_OAUTH_CLIENT_ID: 'oauth-client-id',
    GMAIL_ADDON_SERVICE_ACCOUNT_EMAIL: 'addon@gserviceaccount.com',
    GMAIL_SERVICE_ACCOUNT_SECRET_ARN: 'finance-agent/gmail-service-account',
    ADDON_ENVIRONMENT: 'sandbox',
  }),
}));

jest.mock('@pga/logger', () => ({
  debug: jest.fn(),
}));

jest.mock('../lib/gmail_addon_auth.js', () => {
  const actual = jest.requireActual('../lib/gmail_addon_auth.js') as typeof import('../lib/gmail_addon_auth.js');
  return {
    ...actual,
    verifyGmailAddonOidc: (...args: unknown[]) => mockVerifyGmailAddonOidc(...args),
    emailFromUserIdToken: (...args: unknown[]) => mockEmailFromUserIdToken(...args),
  };
});

jest.mock('../lib/gmail.js', () => {
  const actual = jest.requireActual('../lib/gmail.js') as typeof import('../lib/gmail.js');
  return {
    ...actual,
    getGmailConfig: (...args: unknown[]) => mockGetGmailConfig(...args),
    getSupplierInvoiceLabelState: (...args: unknown[]) => mockGetSupplierInvoiceLabelState(...args),
  };
});

jest.mock('../trigger_create_invoice_gmail.js', () => ({
  runCreateInvoiceFromGmail: (...args: unknown[]) => mockRunCreateInvoiceFromGmail(...args),
}));

function buildEvent(body: Record<string, unknown> = {}, overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /gmail-addon',
    rawPath: '/gmail-addon',
    rawQueryString: '',
    headers: {
      authorization: 'Bearer system-id-token',
      'content-type': 'application/json',
    },
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      domainName: 'example.execute-api.us-east-1.amazonaws.com',
      domainPrefix: 'example',
      http: {
        method: 'POST',
        path: '/gmail-addon',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'jest',
      },
      requestId: 'request-id',
      routeKey: 'POST /gmail-addon',
      stage: '$default',
      time: '09/Jun/2026:00:00:00 +0000',
      timeEpoch: 0,
    },
    isBase64Encoded: false,
    body: JSON.stringify(body),
    ...overrides,
  };
}

const addonAuth = {
  userIdToken: 'user-id-token',
  userOAuthToken: 'ya29.user',
};

function parseCard(response: unknown) {
  const result = response as { statusCode: number; body: string };
  return {
    statusCode: result.statusCode,
    body: JSON.parse(result.body) as {
      action: {
        notification?: { text: string };
        navigations: Array<{
          pushCard?: { header: { title: string }; sections: Array<{ widgets: unknown[] }> };
          updateCard?: { header: { title: string }; sections: Array<{ widgets: unknown[] }> };
        }>;
      };
    },
  };
}

function widgetText(card: { sections: Array<{ widgets: unknown[] }> }): string[] {
  return card.sections[0].widgets.flatMap((widget) => {
    if (typeof widget === 'object' && widget && 'textParagraph' in widget) {
      const paragraph = widget as { textParagraph: { text: string } };
      return [paragraph.textParagraph.text];
    }
    return [];
  });
}

function buttonLabels(card: { sections: Array<{ widgets: unknown[] }> }): string[] {
  return card.sections[0].widgets.flatMap((widget) => {
    if (typeof widget === 'object' && widget && 'buttonList' in widget) {
      const list = widget as { buttonList: { buttons: Array<{ text: string }> } };
      return list.buttonList.buttons.map((button) => button.text);
    }
    return [];
  });
}

describe('gmail_addon handler', () => {
  it('uses distinct card titles for sandbox and production', () => {
    expect(supplierInvoiceAddonCopy('sandbox').cardTitle).toBe('Workday supplier invoice (sandbox)');
    expect(supplierInvoiceAddonCopy('production').cardTitle).toBe('Workday supplier invoice');
  });
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyGmailAddonOidc.mockResolvedValue(undefined);
    mockEmailFromUserIdToken.mockResolvedValue('ap@pgahq.com');
    mockGetGmailConfig.mockResolvedValue({
      accessToken: 'ya29.test',
      userEmail: 'ap@pgahq.com',
      environment: 'sandbox',
      apiBaseUrl: 'https://gmail.googleapis.com',
    });
    mockGetSupplierInvoiceLabelState.mockResolvedValue(null);
  });

  it('returns 401 when OIDC verification fails', async () => {
    mockVerifyGmailAddonOidc.mockRejectedValue(new GmailAddonUnauthorizedError());
    const response = await handler(buildEvent());
    expect(response).toEqual({
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'error', message: 'Unauthorized' }),
    });
  });

  it('shows homepage copy when no message is open', async () => {
    const parsed = parseCard(await handler(buildEvent({})));
    const card = parsed.body.action.navigations[0].pushCard;
    expect(parsed.statusCode).toBe(200);
    expect(mockVerifyGmailAddonOidc).toHaveBeenCalledWith(
      'Bearer system-id-token',
      {
        endpointUrl: 'https://example.execute-api.us-east-1.amazonaws.com/gmail-addon',
        serviceAccountEmail: 'addon@gserviceaccount.com',
      },
    );
    expect(card?.header.title).toBe('Workday supplier invoice (sandbox)');
    expect(widgetText(card!)).toContain(
      'Open a supplier email with a PDF to create a Workday supplier invoice in the sandbox.',
    );
    expect(buttonLabels(card!)).toEqual([]);
  });

  it('shows Create supplier invoice when the message is unlabeled', async () => {
    const parsed = parseCard(await handler(buildEvent({
      authorizationEventObject: addonAuth,
      gmail: { messageId: 'msg-1' },
    })));
    const card = parsed.body.action.navigations[0].pushCard;
    expect(buttonLabels(card!)).toEqual(['Create supplier invoice']);
    expect(mockGetGmailConfig).toHaveBeenCalledWith(expect.anything(), 'ap@pgahq.com', 'ya29.user');
    expect(mockRunCreateInvoiceFromGmail).not.toHaveBeenCalled();
  });

  it('hides Create and shows Create again when the message is already labeled', async () => {
    mockGetSupplierInvoiceLabelState.mockResolvedValue('success');
    const parsed = parseCard(await handler(buildEvent({
      authorizationEventObject: addonAuth,
      gmail: { messageId: 'msg-1' },
    })));
    const card = parsed.body.action.navigations[0].pushCard;
    expect(widgetText(card!)).toContain('Supplier invoice created in the Workday sandbox.');
    expect(buttonLabels(card!)).toEqual(['Create supplier invoice again']);
  });

  it('pushes a confirmation card before force-creating again', async () => {
    const parsed = parseCard(await handler(buildEvent({
      authorizationEventObject: addonAuth,
      commonEventObject: { parameters: { addonAction: 'confirm' } },
      gmail: { messageId: 'msg-1' },
    })));
    const card = parsed.body.action.navigations[0].updateCard;
    expect(widgetText(card!)).toContain('This may create another Workday supplier invoice in the sandbox.');
    expect(buttonLabels(card!)).toEqual(['Create supplier invoice again', 'Cancel']);
    expect(mockRunCreateInvoiceFromGmail).not.toHaveBeenCalled();
  });

  it('creates with force=false and shows a processing toast', async () => {
    mockRunCreateInvoiceFromGmail.mockResolvedValue({
      statusCode: 202,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'accepted', message: 'Supplier invoice creation triggered' }),
    });
    const parsed = parseCard(await handler(buildEvent({
      authorizationEventObject: addonAuth,
      commonEventObject: { parameters: { addonAction: 'create' } },
      gmail: { messageId: 'msg-1' },
    })));
    expect(mockRunCreateInvoiceFromGmail).toHaveBeenCalledWith({
      gmailMessageId: 'msg-1',
      userEmail: 'ap@pgahq.com',
      force: false,
      gmailAccessToken: 'ya29.user',
    });
    const card = parsed.body.action.navigations[0].updateCard;
    expect(parsed.body.action.notification?.text).toBe('Supplier invoice creation started (sandbox).');
    expect(widgetText(card!)).toContain('Supplier invoice processing in the Workday sandbox.');
  });

  it('creates with force=true after confirm', async () => {
    mockRunCreateInvoiceFromGmail.mockResolvedValue({
      statusCode: 202,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'accepted' }),
    });
    await handler(buildEvent({
      authorizationEventObject: addonAuth,
      commonEventObject: { parameters: { addonAction: 'createAgain' } },
      gmail: { messageId: 'msg-1' },
    }));
    expect(mockRunCreateInvoiceFromGmail).toHaveBeenCalledWith({
      gmailMessageId: 'msg-1',
      userEmail: 'ap@pgahq.com',
      force: true,
      gmailAccessToken: 'ya29.user',
    });
  });

  it('asks the user to reinstall when the add-on event has no user OAuth token', async () => {
    const parsed = parseCard(await handler(buildEvent({
      authorizationEventObject: { userIdToken: 'user-id-token' },
      gmail: { messageId: 'msg-1' },
    })));
    const card = parsed.body.action.navigations[0].pushCard;
    expect(widgetText(card!)).toContain(
      'Unable to access this Gmail message. Reinstall the add-on and grant permission to modify messages.',
    );
    expect(mockGetGmailConfig).not.toHaveBeenCalled();
    expect(mockRunCreateInvoiceFromGmail).not.toHaveBeenCalled();
  });
});
