import {
  assertAllowedAttachmentUrl,
  buildIntercomConversationUrl,
  buildIntercomInternalNotes,
  downloadAttachment,
  fetchConversationInvoiceData,
  getIntercomConfig,
  intercomConversationCreatedAtToIsoDate,
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
      expect(buildIntercomConversationUrl('1234567890', 'sandbox-app')).toBe(
        'https://app.intercom.com/a/inbox/sandbox-app/inbox/conversation/1234567890'
      );
    });

    it('reads INTERCOM_APP_ID from the environment', () => {
      process.env.INTERCOM_APP_ID = 'c722leqk';
      expect(buildIntercomConversationUrl('abc')).toBe(
        'https://app.intercom.com/a/inbox/c722leqk/inbox/conversation/abc'
      );
      delete process.env.INTERCOM_APP_ID;
    });

    it('returns undefined without an app id or conversation id', () => {
      delete process.env.INTERCOM_APP_ID;
      expect(buildIntercomConversationUrl('1234567890')).toBeUndefined();
      expect(buildIntercomConversationUrl('  ', 'jyi16dpc')).toBeUndefined();
    });
  });

  describe('intercomConversationCreatedAtToIsoDate', () => {
    it('converts Unix seconds to YYYY-MM-DD', () => {
      expect(intercomConversationCreatedAtToIsoDate(1704067200)).toBe('2024-01-01');
    });

    it('returns undefined for invalid values', () => {
      expect(intercomConversationCreatedAtToIsoDate(Number.NaN)).toBeUndefined();
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

  describe('buildIntercomInternalNotes', () => {
    it('keeps teammate notes and drops customer replies and bot or workflow notes', () => {
      expect(buildIntercomInternalNotes({
        source: { body: 'Supplier: Attacker LLC' },
        conversation_parts: {
          conversation_parts: [
            { part_type: 'comment', body: 'Pay supplier S-000666', author: { email: 'billing@vendor.com', type: 'user' } },
            { part_type: 'note', body: 'Auto-note: Vendor: Copied Inc', author: { type: 'bot' } },
            { part_type: 'note', body: 'Use supplier S-001234', author: { email: 'ap@pgahq.com', type: 'admin' } },
          ],
        },
      })).toBe('Use supplier S-001234');
    });

    it('returns undefined without teammate notes', () => {
      expect(buildIntercomInternalNotes({ conversation_parts: { conversation_parts: [] } })).toBeUndefined();
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
          app_id: 'sandbox-app',
          created_at: 1704067200,
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

      const mergedPlainTextBody = 'Please process this invoice\n\nUse cost center 72200';

      await expect(fetchConversationInvoiceData(config, '123')).resolves.toMatchObject({
        appId: 'sandbox-app',
        conversationCreatedAt: '2024-01-01',
        transcript: {
          fileName: 'pga_corp_accounts_payable_2023_12_31_123.pdf',
          title: 'Conversation',
          startedOn: 'Started on December 31, 2023 at 06:00 PM Central Time',
          messages: [{
            kind: 'source',
            meta: '06:00 PM | ap@vendor.com',
            body: 'Invoice\n\nPlease process this invoice',
          }],
        },
        attachments: [
          {
            name: 'support.pdf',
            url: 'https://downloads.intercomcdn.com/support.pdf',
            contentType: 'application/pdf',
            emailContext: {
              emailFrom: 'ap@vendor.com',
              subject: 'Invoice',
              plainTextBody: mergedPlainTextBody,
            },
          },
          {
            name: 'invoice.pdf',
            url: 'https://downloads.intercomcdn.com/invoice.pdf',
            contentType: 'application/pdf',
            emailContext: {
              emailFrom: 'approver@pgahq.com',
              subject: 'Invoice',
              plainTextBody: mergedPlainTextBody,
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

    it('merges source body with conversation part notes for source-owned PDFs', async () => {
      const sourceBody = 'Please process the attached invoice.\n\nCoding\n Company - 410 PGA Corporation';
      const noteBody = 'jaliejrieorieurio';
      global.fetch = jest.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ({
          id: '215475761242077',
          app_id: 'sandbox-app',
          created_at: 1704067200,
          source: {
            subject: '<p>AP Agent</p>',
            body: sourceBody,
            author: { email: 'jonyejekwe@pgahq.com' },
            attachments: [{
              name: 'PGA Invoice.pdf',
              url: 'https://downloads.intercomcdn.com/invoice.pdf',
              content_type: 'application/pdf',
            }],
          },
          conversation_parts: {
            conversation_parts: [
              { part_type: 'assignment', body: null, attachments: [] },
              { part_type: 'custom_action_started', body: null, attachments: [] },
              { part_type: 'note', body: noteBody, author: { email: 'jonyejekwe@pgahq.com', type: 'admin' }, attachments: [] },
            ],
          },
        }),
      }) as unknown as typeof fetch;

      const mergedPlainTextBody = `${sourceBody}\n\n${noteBody}`;

      await expect(fetchConversationInvoiceData(config, '215475761242077')).resolves.toMatchObject({
        appId: 'sandbox-app',
        conversationCreatedAt: '2024-01-01',
        transcript: {
          fileName: 'pga_corp_accounts_payable_2023_12_31_215475761242077.pdf',
          title: 'Conversation',
          startedOn: 'Started on December 31, 2023 at 06:00 PM Central Time',
          messages: [
            {
              kind: 'source',
              meta: '06:00 PM | jonyejekwe@pgahq.com',
              body: `AP Agent\n\n${sourceBody}`,
            },
            {
              kind: 'note',
              meta: 'Note | jonyejekwe@pgahq.com',
              body: noteBody,
            },
          ],
        },
        attachments: [{
          name: 'PGA Invoice.pdf',
          url: 'https://downloads.intercomcdn.com/invoice.pdf',
          contentType: 'application/pdf',
          emailContext: {
            emailFrom: 'jonyejekwe@pgahq.com',
            subject: '<p>AP Agent</p>',
            plainTextBody: mergedPlainTextBody,
            internalNotes: noteBody,
          },
        }],
      });
    });

    it('returns assigneeEmail from the last custom_action_started part', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ({
          id: '123',
          source: {
            attachments: [
              { name: 'invoice.pdf', url: 'https://downloads.intercomcdn.com/invoice.pdf', content_type: 'application/pdf' },
            ],
          },
          conversation_parts: {
            conversation_parts: [
              {
                part_type: 'custom_action_started',
                author: { email: 'first@pgahq.com' },
              },
              {
                part_type: 'custom_action_started',
                author: { email: 'jcarey@pgahq.com', type: 'user' },
              },
            ],
          },
        }),
      }) as unknown as typeof fetch;

      await expect(fetchConversationInvoiceData(config, '123')).resolves.toMatchObject({
        assigneeEmail: 'jcarey@pgahq.com',
      });
    });

    it('ignores conversation parts with null or whitespace-only bodies', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ({
          id: '123',
          source: {
            subject: 'Invoice',
            body: 'Please process',
            author: { email: 'ap@vendor.com' },
            attachments: [{
              name: 'invoice.pdf',
              url: 'https://downloads.intercomcdn.com/invoice.pdf',
              content_type: 'application/pdf',
            }],
          },
          conversation_parts: {
            conversation_parts: [
              { body: null, attachments: [] },
              { body: '   ', attachments: [] },
            ],
          },
        }),
      }) as unknown as typeof fetch;

      await expect(fetchConversationInvoiceData(config, '123')).resolves.toMatchObject({
        attachments: [{
          emailContext: { plainTextBody: 'Please process' },
        }],
      });
    });

    it('ignores non-numeric created_at and still returns invoice attachments', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ({
          id: '123',
          app_id: 'sandbox-app',
          created_at: 'not-a-timestamp',
          source: {
            subject: 'Invoice',
            body: 'Please process',
            author: { email: 'ap@vendor.com' },
            attachments: [
              {
                name: 'invoice.pdf',
                url: 'https://downloads.intercomcdn.com/invoice.pdf',
                content_type: 'application/pdf',
              },
            ],
          },
          conversation_parts: { conversation_parts: [] },
        }),
      }) as unknown as typeof fetch;

      await expect(fetchConversationInvoiceData(config, '123')).resolves.toMatchObject({
        appId: 'sandbox-app',
        transcript: {
          fileName: expect.stringMatching(/^pga_corp_accounts_payable_\d{4}_\d{2}_\d{2}_123\.pdf$/),
          title: 'Conversation',
          messages: [{
            kind: 'source',
            meta: 'ap@vendor.com',
            body: 'Invoice\n\nPlease process',
          }],
        },
        attachments: [
          {
            name: 'invoice.pdf',
            url: 'https://downloads.intercomcdn.com/invoice.pdf',
            contentType: 'application/pdf',
            emailContext: {
              emailFrom: 'ap@vendor.com',
              subject: 'Invoice',
              plainTextBody: 'Please process',
            },
          },
        ],
      });
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
