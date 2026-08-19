import {
  assertAllowedGmailUrl,
  getAddonEnvironment,
  getGmailConfig,
  GmailAttachmentTooLargeError,
  GmailNoAttachmentError,
  GmailNotFoundError,
  GmailUpstreamError,
  downloadGmailAttachments,
  fetchGmailMessageInvoiceData,
  getSupplierInvoiceLabelState,
  labelStateFromIds,
  nextProcessorLabelState,
  setSupplierInvoiceLabel,
  supplierInvoiceLabelNames,
} from '../lib/gmail.js';

const mockGetAccessToken = jest.fn();
const mockSendSecret = jest.fn();

jest.mock('google-auth-library', () => ({
  JWT: jest.fn().mockImplementation(() => ({
    getAccessToken: (...args: unknown[]) => mockGetAccessToken(...args),
  })),
}));

jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn().mockImplementation(() => ({
    send: (...args: unknown[]) => mockSendSecret(...args),
  })),
  GetSecretValueCommand: jest.fn().mockImplementation((input: unknown) => input),
}));

const originalFetch = global.fetch;
const gmailConfig = {
  accessToken: 'ya29.test',
  userEmail: 'ap@pgahq.com',
  environment: 'sandbox' as const,
  apiBaseUrl: 'https://gmail.googleapis.com',
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    json: () => Promise.resolve(body),
  };
}

describe('gmail', () => {
  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  describe('getAddonEnvironment', () => {
    it('defaults to sandbox unless ADDON_ENVIRONMENT is production', () => {
      expect(getAddonEnvironment({})).toBe('sandbox');
      expect(getAddonEnvironment({ ADDON_ENVIRONMENT: 'sandbox' })).toBe('sandbox');
      expect(getAddonEnvironment({ ADDON_ENVIRONMENT: 'production' })).toBe('production');
    });
  });

  describe('supplier invoice labels', () => {
    it('uses distinct nested names for sandbox and production', () => {
      expect(supplierInvoiceLabelNames('sandbox')).toEqual({
        processing: 'Supplier invoice (sandbox)/Processing',
        success: 'Supplier invoice (sandbox)/Success',
        failure: 'Supplier invoice (sandbox)/Failure',
        partial: 'Supplier invoice (sandbox)/Partial',
      });
      expect(supplierInvoiceLabelNames('production')).toEqual({
        processing: 'Supplier invoice/Processing',
        success: 'Supplier invoice/Success',
        failure: 'Supplier invoice/Failure',
        partial: 'Supplier invoice/Partial',
      });
    });

    it('maps exclusive processor outcomes including partial', () => {
      expect(nextProcessorLabelState(null, 'success')).toBe('success');
      expect(nextProcessorLabelState('processing', 'success')).toBe('success');
      expect(nextProcessorLabelState('failure', 'success')).toBe('partial');
      expect(nextProcessorLabelState('success', 'failure')).toBe('partial');
      expect(nextProcessorLabelState(null, 'failure')).toBe('failure');
      expect(nextProcessorLabelState('partial', 'success')).toBe('partial');
    });

    it('reads the current exclusive label from message label ids', () => {
      const nameById = new Map([
        ['Label_1', 'Supplier invoice (sandbox)/Processing'],
        ['INBOX', 'INBOX'],
      ]);
      expect(labelStateFromIds('sandbox', ['INBOX', 'Label_1'], nameById)).toBe('processing');
      expect(labelStateFromIds('production', ['Label_1'], nameById)).toBeNull();
    });
  });

  describe('assertAllowedGmailUrl', () => {
    it('allows the Gmail API host over https', () => {
      expect(assertAllowedGmailUrl('https://gmail.googleapis.com/gmail/v1/users/me/messages/abc').host)
        .toBe('gmail.googleapis.com');
    });

    it('rejects non-https and non-Gmail hosts', () => {
      expect(() => assertAllowedGmailUrl('http://gmail.googleapis.com/gmail/v1/users/me/messages/abc'))
        .toThrow(GmailUpstreamError);
      expect(() => assertAllowedGmailUrl('https://evil.example/gmail/v1/users/me/messages/abc'))
        .toThrow(GmailUpstreamError);
      expect(() => assertAllowedGmailUrl('https://gmail.googleapis.com.evil.example/gmail/v1/users/me/messages/abc'))
        .toThrow(GmailUpstreamError);
    });
  });

  describe('getGmailConfig', () => {
    it('requires the Secrets Manager id and user email', async () => {
      await expect(getGmailConfig({}, 'ap@pgahq.com')).rejects.toThrow('GMAIL_SERVICE_ACCOUNT_SECRET_ARN is required');
      await expect(getGmailConfig({ GMAIL_SERVICE_ACCOUNT_SECRET_ARN: 'finance-agent/gmail-service-account' }, ''))
        .rejects.toThrow('userEmail is required');
    });

    it('loads the service account JSON and impersonates the user', async () => {
      mockSendSecret.mockResolvedValue({
        SecretString: JSON.stringify({
          client_email: 'gmail-bot@project.iam.gserviceaccount.com',
          private_key: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n',
        }),
      });
      mockGetAccessToken.mockResolvedValue({ token: 'ya29.access' });

      await expect(getGmailConfig({
        GMAIL_SERVICE_ACCOUNT_SECRET_ARN: 'finance-agent/gmail-service-account',
        ADDON_ENVIRONMENT: 'production',
      }, 'ap@pgahq.com')).resolves.toEqual({
        accessToken: 'ya29.access',
        userEmail: 'ap@pgahq.com',
        environment: 'production',
        apiBaseUrl: 'https://gmail.googleapis.com',
      });
      expect(mockSendSecret).toHaveBeenCalled();
    });
  });

  describe('fetchGmailMessageInvoiceData', () => {
    it('collects PDF attachments and email context', async () => {
      global.fetch = jest.fn().mockResolvedValue(jsonResponse(200, {
        id: 'msg-1',
        labelIds: ['INBOX'],
        payload: {
          mimeType: 'multipart/mixed',
          headers: [
            { name: 'From', value: 'ap@vendor.com' },
            { name: 'Subject', value: 'Please process' },
          ],
          parts: [
            {
              mimeType: 'text/plain',
              body: { data: Buffer.from('Invoice attached').toString('base64url') },
            },
            {
              mimeType: 'application/pdf',
              filename: '../../invoice.pdf',
              body: { attachmentId: 'att-1', size: 12 },
            },
          ],
        },
      })) as unknown as typeof fetch;

      await expect(fetchGmailMessageInvoiceData(gmailConfig, 'msg-1')).resolves.toEqual({
        attachments: [{
          name: 'invoice.pdf',
          contentType: 'application/pdf',
          emailContext: {
            emailFrom: 'ap@vendor.com',
            subject: 'Please process',
            plainTextBody: 'Invoice attached',
          },
          attachmentId: 'att-1',
          inlineData: undefined,
        }],
        emailContext: {
          emailFrom: 'ap@vendor.com',
          subject: 'Please process',
          plainTextBody: 'Invoice attached',
        },
        labelIds: ['INBOX'],
      });
    });

    it('throws when the message is missing or has no PDF', async () => {
      global.fetch = jest.fn().mockResolvedValue(jsonResponse(404, {})) as unknown as typeof fetch;
      await expect(fetchGmailMessageInvoiceData(gmailConfig, 'missing')).rejects.toThrow(GmailNotFoundError);

      global.fetch = jest.fn().mockResolvedValue(jsonResponse(200, {
        id: 'msg-1',
        payload: { mimeType: 'text/plain', headers: [], parts: [] },
      })) as unknown as typeof fetch;
      await expect(fetchGmailMessageInvoiceData(gmailConfig, 'msg-1')).rejects.toThrow(GmailNoAttachmentError);
    });
  });

  describe('downloadGmailAttachments', () => {
    it('decodes inline PDF bytes and rejects oversized attachments', async () => {
      const small = Buffer.from('pdf-bytes');
      await expect(downloadGmailAttachments(gmailConfig, 'msg-1', [{
        name: 'invoice.pdf',
        contentType: 'application/pdf',
        emailContext: {},
        inlineData: small.toString('base64url'),
      }])).resolves.toEqual([small]);

      const tooLarge = Buffer.alloc(20 * 1024 * 1024 + 1, 1);
      await expect(downloadGmailAttachments(gmailConfig, 'msg-1', [{
        name: 'invoice.pdf',
        contentType: 'application/pdf',
        emailContext: {},
        inlineData: tooLarge.toString('base64url'),
      }])).rejects.toThrow(GmailAttachmentTooLargeError);
    });
  });

  describe('setSupplierInvoiceLabel', () => {
    it('creates parent and child labels then keeps them exclusive', async () => {
      global.fetch = jest.fn((url: string | URL, init?: RequestInit) => {
        const href = String(url);
        const method = init?.method ?? 'GET';
        if (href.endsWith('/gmail/v1/users/me/labels') && method === 'GET') {
          return Promise.resolve(jsonResponse(200, { labels: [] }));
        }
        if (href.endsWith('/gmail/v1/users/me/labels') && method === 'POST') {
          const body = JSON.parse(String(init?.body)) as { name: string };
          return Promise.resolve(jsonResponse(200, {
            id: body.name.includes('Processing') ? 'Label_proc' : 'Label_parent',
            name: body.name,
          }));
        }
        if (href.includes('/messages/msg-1/modify')) {
          return Promise.resolve(jsonResponse(200, {}));
        }
        return Promise.reject(new Error(`unexpected fetch ${method} ${href}`));
      }) as unknown as typeof fetch;

      await setSupplierInvoiceLabel(gmailConfig, 'msg-1', 'processing');

      const postBodies = (global.fetch as jest.Mock<Promise<unknown>, [string | URL, RequestInit?]>).mock.calls
        .map(([, init]) => init)
        .filter((init): init is RequestInit => Boolean(init?.method === 'POST' && init.body))
        .map((init) => JSON.parse(String(init.body)) as Record<string, unknown>);
      expect(postBodies[0]).toEqual(expect.objectContaining({ name: 'Supplier invoice (sandbox)' }));
      expect(postBodies[1]).toEqual(expect.objectContaining({
        name: 'Supplier invoice (sandbox)/Processing',
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
      }));
      expect(postBodies[2]).toEqual({
        addLabelIds: ['Label_proc'],
        removeLabelIds: [],
      });
    });
  });

  describe('getSupplierInvoiceLabelState', () => {
    it('returns null when none of the exclusive labels are present', async () => {
      global.fetch = jest.fn((url: string | URL) => {
        const href = String(url);
        if (href.includes('/messages/msg-1')) {
          return Promise.resolve(jsonResponse(200, { id: 'msg-1', labelIds: ['INBOX'] }));
        }
        return Promise.resolve(jsonResponse(200, { labels: [{ id: 'INBOX', name: 'INBOX' }] }));
      }) as unknown as typeof fetch;

      await expect(getSupplierInvoiceLabelState(gmailConfig, 'msg-1')).resolves.toBeNull();
    });
  });
});
