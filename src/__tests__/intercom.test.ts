import {
  assertAllowedAttachmentUrl,
  buildIntercomConversationUrl,
  downloadAttachment,
  fetchConversationInvoiceData,
  getIntercomConfig,
  IntercomAttachmentTooLargeError,
  IntercomNoAttachmentError,
  IntercomNotFoundError,
  IntercomUpstreamError,
  MAX_ATTACHMENT_BYTES,
} from '../lib/intercom.js';

const originalFetch = global.fetch;

describe('intercom', () => {
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  describe('getIntercomConfig', () => {
    it('requires INTERCOM_ACCESS_TOKEN', () => {
      expect(() => getIntercomConfig({})).toThrow('INTERCOM_ACCESS_TOKEN is required');
    });

    it('defaults the API base URL and strips a trailing slash', () => {
      expect(getIntercomConfig({
        INTERCOM_ACCESS_TOKEN: 'token',
        INTERCOM_API_BASE_URL: 'https://api.eu.intercom.io/',
      })).toEqual({
        accessToken: 'token',
        apiBaseUrl: 'https://api.eu.intercom.io',
      });

      expect(getIntercomConfig({ INTERCOM_ACCESS_TOKEN: 'token' })).toEqual({
        accessToken: 'token',
        apiBaseUrl: 'https://api.intercom.io',
      });
    });
  });

  describe('buildIntercomConversationUrl', () => {
    it('builds an inbox permalink when an app id is provided', () => {
      expect(buildIntercomConversationUrl('1234567890', 'jyi16dpc')).toBe(
        'https://app.intercom.com/a/inbox/jyi16dpc/inbox/conversation/1234567890'
      );
    });

    it('reads INTERCOM_APP_ID from the environment', () => {
      process.env.INTERCOM_APP_ID = 'jyi16dpc';
      expect(buildIntercomConversationUrl('abc')).toBe(
        'https://app.intercom.com/a/inbox/jyi16dpc/inbox/conversation/abc'
      );
      delete process.env.INTERCOM_APP_ID;
    });

    it('returns undefined without an app id or conversation id', () => {
      delete process.env.INTERCOM_APP_ID;
      expect(buildIntercomConversationUrl('1234567890')).toBeUndefined();
      expect(buildIntercomConversationUrl('  ', 'jyi16dpc')).toBeUndefined();
    });
  });

  describe('assertAllowedAttachmentUrl', () => {
    it('allows https Intercom CDN and attachment hosts', () => {
      expect(assertAllowedAttachmentUrl('https://downloads.intercomcdn.com/i/o/file.pdf').host)
        .toBe('downloads.intercomcdn.com');
      expect(assertAllowedAttachmentUrl('https://intercomcdn.com/file.pdf').host)
        .toBe('intercomcdn.com');
      expect(assertAllowedAttachmentUrl(
        'https://pga-of-america-test-19f825af3239.intercom-attachments-5.com/file.pdf',
      ).host).toBe('pga-of-america-test-19f825af3239.intercom-attachments-5.com');
      expect(assertAllowedAttachmentUrl('https://intercom-attachments-1.com/file.pdf').host)
        .toBe('intercom-attachments-1.com');
    });

    it('rejects non-https and non-Intercom hosts', () => {
      expect(() => assertAllowedAttachmentUrl('http://downloads.intercomcdn.com/file.pdf'))
        .toThrow(IntercomUpstreamError);
      expect(() => assertAllowedAttachmentUrl('https://evil.example/file.pdf'))
        .toThrow(IntercomUpstreamError);
      expect(() => assertAllowedAttachmentUrl('https://intercomcdn.com.evil.example/file.pdf'))
        .toThrow(IntercomUpstreamError);
      expect(() => assertAllowedAttachmentUrl('https://evil.intercom-attachments-5.com.attacker.com/file.pdf'))
        .toThrow(IntercomUpstreamError);
    });
  });

  describe('fetchConversationInvoiceData', () => {
    const config = { accessToken: 'token', apiBaseUrl: 'https://api.intercom.io' };

    it('fetches the conversation, requires a PDF, sanitizes the name, and maps email context', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ({
          id: '123',
          source: {
            subject: 'Invoice',
            body: 'Please process this invoice',
            author: { email: 'ap@vendor.com' },
            attachments: [
              { name: 'shot.png', url: 'https://downloads.intercomcdn.com/shot.png', content_type: 'image/png' },
              { name: 'support.pdf', url: 'https://downloads.intercomcdn.com/support.pdf', content_type: 'application/pdf' },
            ],
          },
          conversation_parts: {
            conversation_parts: [{
              body: 'Use cost center 72200',
              author: { email: 'approver@pgahq.com' },
              attachments: [
                {
                  name: '../../nested/invoice.pdf',
                  url: 'https://downloads.intercomcdn.com/invoice.pdf',
                  content_type: 'application/pdf',
                },
              ],
            }],
          },
        }),
      }) as unknown as typeof fetch;

      await expect(fetchConversationInvoiceData(config, '123')).resolves.toEqual({
        attachments: [
          {
            name: 'support.pdf',
            url: 'https://downloads.intercomcdn.com/support.pdf',
            contentType: 'application/pdf',
            emailContext: {
              emailFrom: 'ap@vendor.com',
              subject: 'Invoice',
              plainTextBody: 'Please process this invoice',
            },
          },
          {
            name: 'invoice.pdf',
            url: 'https://downloads.intercomcdn.com/invoice.pdf',
            contentType: 'application/pdf',
            emailContext: {
              emailFrom: 'approver@pgahq.com',
              subject: 'Invoice',
              plainTextBody: 'Use cost center 72200',
            },
          },
        ],
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.intercom.io/conversations/123?display_as=plaintext',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer token',
            Accept: 'application/json',
            'Intercom-Version': '2.14',
          }),
        }),
      );
    });

    it('throws IntercomNotFoundError on 404', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        status: 404,
        ok: false,
      }) as unknown as typeof fetch;

      await expect(fetchConversationInvoiceData(config, 'missing')).rejects.toBeInstanceOf(IntercomNotFoundError);
    });

    it('throws IntercomNoAttachmentError when no PDF is present', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ({
          id: '123',
          source: {
            subject: 'Hi',
            body: 'No files',
            author: { email: 'a@b.com' },
            attachments: [
              { name: 'photo.png', url: 'https://downloads.intercomcdn.com/a.png', content_type: 'image/png' },
            ],
          },
          conversation_parts: { conversation_parts: [] },
        }),
      }) as unknown as typeof fetch;

      await expect(fetchConversationInvoiceData(config, '123')).rejects.toBeInstanceOf(IntercomNoAttachmentError);
    });

    it('throws IntercomUpstreamError on non-404 API failures', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        status: 503,
        ok: false,
      }) as unknown as typeof fetch;

      await expect(fetchConversationInvoiceData(config, '123')).rejects.toMatchObject({
        name: 'IntercomUpstreamError',
        statusCode: 503,
      });
    });

    it('rejects malformed successful responses as upstream errors', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ({ source: { attachments: {} } }),
      }) as unknown as typeof fetch;

      await expect(fetchConversationInvoiceData(config, '123'))
        .rejects.toBeInstanceOf(IntercomUpstreamError);
    });

    it('maps response JSON failures to upstream errors', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => {
          throw new SyntaxError('invalid JSON');
        },
      }) as unknown as typeof fetch;

      await expect(fetchConversationInvoiceData(config, '123'))
        .rejects.toBeInstanceOf(IntercomUpstreamError);
    });
  });

  describe('downloadAttachment', () => {
    it('downloads raw binary bytes from an allowed CDN host without following redirects', async () => {
      const bytes = Buffer.from('pdf-bytes');
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => null },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      }) as unknown as typeof fetch;

      await expect(downloadAttachment('https://downloads.intercomcdn.com/invoice.pdf')).resolves.toEqual(bytes);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://downloads.intercomcdn.com/invoice.pdf',
        { redirect: 'error' },
      );
    });

    it('surfaces redirect errors as IntercomUpstreamError', async () => {
      global.fetch = jest.fn().mockRejectedValue(new TypeError('redirect mode is set to error')) as unknown as typeof fetch;

      await expect(downloadAttachment('https://downloads.intercomcdn.com/invoice.pdf'))
        .rejects.toBeInstanceOf(IntercomUpstreamError);
    });

    it('throws when Content-Length exceeds the max size', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: { get: (name: string) => (name === 'content-length' ? String(MAX_ATTACHMENT_BYTES + 1) : null) },
        arrayBuffer: async () => new ArrayBuffer(0),
      }) as unknown as typeof fetch;

      await expect(downloadAttachment('https://downloads.intercomcdn.com/invoice.pdf'))
        .rejects.toBeInstanceOf(IntercomAttachmentTooLargeError);
    });

    it('throws IntercomUpstreamError when the CDN returns an error', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 403,
        headers: { get: () => null },
      }) as unknown as typeof fetch;

      await expect(downloadAttachment('https://downloads.intercomcdn.com/invoice.pdf'))
        .rejects.toBeInstanceOf(IntercomUpstreamError);
    });

    it('maps attachment body read failures to upstream errors', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => null },
        arrayBuffer: async () => {
          throw new Error('stream failed');
        },
      }) as unknown as typeof fetch;

      await expect(downloadAttachment('https://downloads.intercomcdn.com/invoice.pdf'))
        .rejects.toBeInstanceOf(IntercomUpstreamError);
    });
  });
});
