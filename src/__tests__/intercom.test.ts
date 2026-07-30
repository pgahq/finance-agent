import {
  assertAllowedAttachmentUrl,
  buildEmailContext,
  downloadAttachment,
  fetchConversationInvoiceData,
  getIntercomConfig,
  IntercomAttachmentTooLargeError,
  IntercomNoAttachmentError,
  IntercomNotFoundError,
  IntercomUpstreamError,
  MAX_ATTACHMENT_BYTES,
  sanitizeFileName,
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
    it('returns the first PDF attachment', () => {
      const attachments: IntercomAttachment[] = [
        { name: 'photo.png', url: 'https://downloads.intercomcdn.com/a.png', contentType: 'image/png' },
        { name: 'invoice.pdf', url: 'https://downloads.intercomcdn.com/a.pdf', contentType: 'application/pdf' },
        { name: 'other.pdf', url: 'https://downloads.intercomcdn.com/b.pdf', contentType: 'application/pdf' },
      ];

      expect(selectAttachment(attachments)).toEqual(attachments[1]);
    });

    it('returns undefined when no PDF exists', () => {
      const attachments: IntercomAttachment[] = [
        { name: 'photo.png', url: 'https://downloads.intercomcdn.com/a.png', contentType: 'image/png' },
      ];

      expect(selectAttachment(attachments)).toBeUndefined();
    });
  });

  describe('sanitizeFileName', () => {
    it('strips path separators and traversal segments', () => {
      expect(sanitizeFileName('../../etc/passwd.pdf')).toBe('passwd.pdf');
      expect(sanitizeFileName('folder\\nested\\invoice.pdf')).toBe('invoice.pdf');
      expect(sanitizeFileName('')).toBe('attachment.pdf');
    });
  });

  describe('assertAllowedAttachmentUrl', () => {
    it('allows https Intercom CDN hosts', () => {
      expect(assertAllowedAttachmentUrl('https://downloads.intercomcdn.com/i/o/file.pdf').host)
        .toBe('downloads.intercomcdn.com');
      expect(assertAllowedAttachmentUrl('https://intercomcdn.com/file.pdf').host)
        .toBe('intercomcdn.com');
    });

    it('rejects non-https and non-Intercom hosts', () => {
      expect(() => assertAllowedAttachmentUrl('http://downloads.intercomcdn.com/file.pdf'))
        .toThrow(IntercomUpstreamError);
      expect(() => assertAllowedAttachmentUrl('https://evil.example/file.pdf'))
        .toThrow(IntercomUpstreamError);
      expect(() => assertAllowedAttachmentUrl('https://intercomcdn.com.evil.example/file.pdf'))
        .toThrow(IntercomUpstreamError);
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

    it('fetches the conversation, requires a PDF, sanitizes the name, and maps email context', async () => {
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
              { name: 'shot.png', url: 'https://downloads.intercomcdn.com/shot.png', content_type: 'image/png' },
            ],
          },
          conversation_parts: {
            conversation_parts: [{
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
        conversationId: '123',
        attachment: {
          name: 'invoice.pdf',
          url: 'https://downloads.intercomcdn.com/invoice.pdf',
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

    it('throws IntercomNoAttachmentError when no PDF is present', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => await Promise.resolve({
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
  });

  describe('downloadAttachment', () => {
    it('downloads raw binary bytes from an allowed CDN host', async () => {
      const bytes = Buffer.from('pdf-bytes');
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => null },
        arrayBuffer: async () => await Promise.resolve(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        ),
      }) as unknown as typeof fetch;

      await expect(downloadAttachment('https://downloads.intercomcdn.com/invoice.pdf')).resolves.toEqual(bytes);
    });

    it('rejects disallowed hosts before fetching', async () => {
      global.fetch = jest.fn() as unknown as typeof fetch;

      await expect(downloadAttachment('https://evil.example/invoice.pdf')).rejects.toBeInstanceOf(IntercomUpstreamError);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('throws when Content-Length exceeds the max size', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: { get: (name: string) => (name === 'content-length' ? String(MAX_ATTACHMENT_BYTES + 1) : null) },
        arrayBuffer: async () => await Promise.resolve(new ArrayBuffer(0)),
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
  });
});
