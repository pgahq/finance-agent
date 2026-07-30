import {
  buildEmailContext,
  downloadAttachment,
  fetchConversationInvoiceData,
  getIntercomConfig,
  IntercomNoAttachmentError,
  IntercomNotFoundError,
  IntercomUpstreamError,
  selectAttachment,
  type IntercomAttachment,
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

  describe('selectAttachment', () => {
    it('prefers the first PDF attachment', () => {
      const attachments: IntercomAttachment[] = [
        { name: 'photo.png', url: 'https://cdn.example/a.png', contentType: 'image/png' },
        { name: 'invoice.pdf', url: 'https://cdn.example/a.pdf', contentType: 'application/pdf' },
        { name: 'other.pdf', url: 'https://cdn.example/b.pdf', contentType: 'application/pdf' },
      ];

      expect(selectAttachment(attachments)).toEqual(attachments[1]);
    });

    it('falls back to the first attachment with a URL when no PDF exists', () => {
      const attachments: IntercomAttachment[] = [
        { name: 'photo.png', url: 'https://cdn.example/a.png', contentType: 'image/png' },
      ];

      expect(selectAttachment(attachments)).toEqual(attachments[0]);
    });

    it('returns undefined when there are no attachments', () => {
      expect(selectAttachment([])).toBeUndefined();
    });
  });

  describe('buildEmailContext', () => {
    it('maps source author email, subject, and plaintext body', () => {
      expect(buildEmailContext({
        source: {
          subject: 'Please process',
          body: 'Invoice attached',
          author: { email: 'ap@vendor.com' },
        },
      })).toEqual({
        emailFrom: 'ap@vendor.com',
        subject: 'Please process',
        plainTextBody: 'Invoice attached',
      });
    });
  });

  describe('fetchConversationInvoiceData', () => {
    const config = { accessToken: 'token', apiBaseUrl: 'https://api.intercom.io' };

    it('fetches the conversation, prefers a PDF, and maps email context', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => await Promise.resolve({
          id: '123',
          source: {
            subject: 'Invoice',
            body: 'Please process this invoice',
            author: { email: 'ap@vendor.com' },
            attachments: [
              { name: 'shot.png', url: 'https://cdn.example/shot.png', content_type: 'image/png' },
            ],
          },
          conversation_parts: {
            conversation_parts: [{
              attachments: [
                { name: 'invoice.pdf', url: 'https://cdn.example/invoice.pdf', content_type: 'application/pdf' },
              ],
            }],
          },
        }),
      }) as unknown as typeof fetch;

      await expect(fetchConversationInvoiceData(config, '123')).resolves.toEqual({
        conversationId: '123',
        attachment: {
          name: 'invoice.pdf',
          url: 'https://cdn.example/invoice.pdf',
          contentType: 'application/pdf',
        },
        emailContext: {
          emailFrom: 'ap@vendor.com',
          subject: 'Invoice',
          plainTextBody: 'Please process this invoice',
        },
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

    it('throws IntercomNoAttachmentError when no attachments have URLs', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => await Promise.resolve({
          id: '123',
          source: { subject: 'Hi', body: 'No files', author: { email: 'a@b.com' }, attachments: [] },
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
  });

  describe('downloadAttachment', () => {
    it('downloads raw binary bytes', async () => {
      const bytes = Buffer.from('pdf-bytes');
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => await Promise.resolve(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        ),
      }) as unknown as typeof fetch;

      await expect(downloadAttachment('https://cdn.example/invoice.pdf')).resolves.toEqual(bytes);
    });

    it('throws IntercomUpstreamError when the CDN returns an error', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 403,
      }) as unknown as typeof fetch;

      await expect(downloadAttachment('https://cdn.example/invoice.pdf')).rejects.toBeInstanceOf(IntercomUpstreamError);
    });
  });
});
