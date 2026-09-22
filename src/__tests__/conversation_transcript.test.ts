import {
  buildConversationTranscript,
  renderConversationTranscriptPdf,
  type ConversationTranscriptInput,
} from '../lib/conversation_transcript.js';

const sampleConversation: ConversationTranscriptInput = {
  id: '215476033237026',
  created_at: 1790013750,
  title: 'Invoice E54219 from Safari Solutions',
  custom_attributes: { Brand: 'PGA Corp Accounts Payable' },
  source: {
    subject: '<p>Invoice E54219 from Safari Solutions</p>',
    body: 'Safari Telecom, LLC Invoice Due:Wed, 10/21/2026 E54219 Amount Due: $489.08 Thank you for partnering with Safari Solutions.',
    author: { email: 'accounting@safari-solutions.com', name: null },
  },
  conversation_parts: {
    conversation_parts: [
      { part_type: 'default_assignment', body: null, created_at: 1790013750, author: { name: 'PGA Support' } },
      { part_type: 'assignment', body: null, created_at: 1790013755, author: { name: 'PGA Support' } },
      {
        part_type: 'comment',
        body: 'Thank you for contacting the Corporate Accounts Payable Team.',
        created_at: 1790013756,
        author: { name: 'PGA Support', email: 'operator+jyi16dpc@intercom.io' },
      },
      { part_type: 'custom_action_started', body: null, created_at: 1790018852, author: { name: 'Lauren Schilling' } },
      { part_type: 'custom_action_finished', body: null, created_at: 1790018856, author: { name: 'Lauren Schilling' } },
      {
        part_type: 'note',
        body: 'SUPIN-460853 submitted',
        created_at: 1790022411,
        author: { name: 'Lauren Schilling', email: 'lschilling@pgahq.com' },
      },
      { part_type: 'close', body: null, created_at: 1790022415, author: { name: 'Lauren Schilling' } },
      { part_type: 'note', body: '   ', created_at: 1790022500, author: { name: 'Lauren Schilling' } },
    ],
  },
};

describe('buildConversationTranscript', () => {
  it('includes the source email and comment or note parts, and names the file from the Central start date', () => {
    const transcript = buildConversationTranscript(sampleConversation, {
      conversationId: '215476033237026',
    });

    expect(transcript.fileName).toBe('pga_corp_accounts_payable_2026_09_21_215476033237026.pdf');
    expect(transcript.title).toBe('Conversation with PGA Corp Accounts Payable');
    expect(transcript.startedOn).toBe('Started on September 21, 2026 at 01:02 PM Central Time');
    expect(transcript.messages).toEqual([
      {
        kind: 'source',
        meta: '01:02 PM | accounting@safari-solutions.com',
        body: 'Invoice E54219 from Safari Solutions\n\nSafari Telecom, LLC Invoice Due:Wed, 10/21/2026 E54219 Amount Due: $489.08 Thank you for partnering with Safari Solutions.',
      },
      {
        kind: 'comment',
        meta: '01:02 PM | PGA Support',
        body: 'Thank you for contacting the Corporate Accounts Payable Team.',
      },
      {
        kind: 'note',
        meta: '03:26 PM | Note | Lauren Schilling',
        body: 'SUPIN-460853 submitted',
      },
    ]);
  });

  it('includes the date on a comment or note from a later day', () => {
    const transcript = buildConversationTranscript({
      ...sampleConversation,
      conversation_parts: {
        conversation_parts: [{
          part_type: 'note',
          body: 'Follow up tomorrow',
          created_at: 1790100150,
          author: { name: 'Lauren Schilling' },
        }],
      },
    }, { conversationId: '215476033237026' });

    expect(transcript.messages[1]).toEqual({
      kind: 'note',
      meta: 'September 22, 2026 at 01:02 PM | Note | Lauren Schilling',
      body: 'Follow up tomorrow',
    });
  });

  it('uses the current Central date in the file name when created_at is missing', () => {
    const transcript = buildConversationTranscript({}, {
      conversationId: '99',
      now: new Date('2026-09-22T15:00:00Z'),
    });

    expect(transcript.fileName).toBe('pga_corp_accounts_payable_2026_09_22_99.pdf');
    expect(transcript.title).toBe('Conversation');
    expect(transcript.startedOn).toBeUndefined();
    expect(transcript.messages).toEqual([]);
  });

  it('keeps angle-bracket addresses, urls, and tokens while stripping HTML tags', () => {
    const transcript = buildConversationTranscript({
      created_at: 1790013750,
      source: {
        subject: '<p>Invoice <E54219></p>',
        body: 'Send to <accounting@safari-solutions.com> <a@vendor.com> <i@vendor.com> <b@pgahq.com> <p@example.com> <pre@example.com> <br@example.com> via <https://vendor.example/inv>\nAmount < 500 > remaining\nLine<br>break<p class="x">Next</p>Done',
        author: { email: 'accounting@safari-solutions.com' },
      },
    }, { conversationId: '215476033237026' });

    expect(transcript.messages[0].body).toBe([
      'Invoice <E54219>',
      '',
      'Send to <accounting@safari-solutions.com> <a@vendor.com> <i@vendor.com> <b@pgahq.com> <p@example.com> <pre@example.com> <br@example.com> via <https://vendor.example/inv>',
      'Amount < 500 > remaining',
      'Line',
      'break',
      'Next',
      'Done',
    ].join('\n'));
  });

  it('falls back to the conversation title when brand is missing', () => {
    const transcript = buildConversationTranscript({
      title: 'Invoice E54219 from Safari Solutions',
      source: { body: 'Please pay', author: { name: 'Safari' } },
    }, { conversationId: '215476033237026', now: new Date('2026-09-21T18:02:30Z') });

    expect(transcript.title).toBe('Invoice E54219 from Safari Solutions');
    expect(transcript.messages[0].meta).toBe('Safari');
  });

  it('keeps a long unclosed tag prefix', () => {
    const body = '<b'.repeat(20000);
    const started = Date.now();
    const transcript = buildConversationTranscript({
      source: { body, author: { email: 'ap@vendor.com' } },
    }, { conversationId: '1', now: new Date('2026-09-21T18:02:30Z') });

    expect(Date.now() - started).toBeLessThan(200);
    expect(transcript.messages[0].body.startsWith('<b<b')).toBe(true);
  });
});

describe('renderConversationTranscriptPdf', () => {
  it('renders a PDF that contains the source email, comment, and note', async () => {
    const transcript = buildConversationTranscript(sampleConversation, {
      conversationId: '215476033237026',
    });
    const pdf = await renderConversationTranscriptPdf(transcript, { compress: false });
    const encoded = pdf.toString('latin1');
    const text = [...encoded.matchAll(/<([0-9A-Fa-f]+)>/g)]
      .map((match) => Buffer.from(match[1], 'hex').toString('latin1'))
      .join('');

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(text).toContain('Conversation with PGA Corp Accounts Payable');
    expect(text).toContain('accounting@safari-solutions.com');
    expect(text).toContain('Thank you for contacting the Corporate Accounts Payable Team.');
    expect(text).toContain('SUPIN-460853 submitted');
  });

  it('replaces characters Helvetica cannot encode', async () => {
    const pdf = await renderConversationTranscriptPdf({
      fileName: 'x.pdf',
      title: 'Conversation',
      messages: [{ kind: 'note', meta: 'Note', body: 'Paid thanks 😀 北京' }],
    }, { compress: false });
    const text = [...pdf.toString('latin1').matchAll(/<([0-9A-Fa-f]+)>/g)]
      .map((match) => Buffer.from(match[1], 'hex').toString('latin1'))
      .join('');

    expect(text).toContain('Paid thanks ? ??');
    expect(text).not.toContain('北京');
  });
});
