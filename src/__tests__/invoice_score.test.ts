import {
  attributeCancel,
  cancelReasonMappingFromEnv,
  classifyStatus,
  entryOutcome,
  isTerminalStatus,
  lastTenantRefresh,
  mentionsSupplierVoidOrCredit,
  tenantRefreshWeekday,
  scoreChanges,
  statusConfigFromEnv,
  type CancelReasonMapping,
} from '../lib/invoice_score.js';

const noMapping: CancelReasonMapping = { business: [], duplicate: [], agent: [], agentTags: [] };

describe('classifyStatus', () => {
  const config = statusConfigFromEnv({});

  it('sorts Workday status rows into the states the scorer acts on', () => {
    expect(classifyStatus(undefined, config)).toBe('not_found');
    expect(classifyStatus({ workdayID: 'a', invoiceStatusAsText: 'Draft' }, config)).toBe('draft');
    expect(classifyStatus({ workdayID: 'a', invoiceStatusAsText: 'In Progress' }, config)).toBe('entry');
    expect(classifyStatus({ workdayID: 'a', invoiceStatusAsText: 'Approved' }, config)).toBe('approved');
    expect(classifyStatus({ workdayID: 'a', invoiceStatusAsText: 'Denied' }, config)).toBe('denied');
    expect(classifyStatus({ workdayID: 'a', invoiceStatusAsText: 'Approved', invoiceIsPaid: '1' }, config)).toBe('paid');
    expect(classifyStatus({ workdayID: 'a', invoiceStatusAsText: 'Draft', isCanceled: true }, config)).toBe('canceled');
    expect(classifyStatus({ workdayID: 'a', invoiceStatusAsText: 'Cancelled' }, config)).toBe('canceled');
  });

  it('treats an unknown non-Draft status as entered by AP', () => {
    expect(classifyStatus({ workdayID: 'a', invoiceStatusAsText: 'Sent Back' }, config)).toBe('entry');
  });

  it('reads tenant status text overrides from the environment', () => {
    const custom = statusConfigFromEnv({ SCORE_DRAFT_STATUSES: 'Draft, Sent Back', SCORE_APPROVED_STATUSES: 'Complete' });
    expect(classifyStatus({ workdayID: 'a', invoiceStatusAsText: 'Sent Back' }, custom)).toBe('draft');
    expect(classifyStatus({ workdayID: 'a', invoiceStatusAsText: 'complete' }, custom)).toBe('approved');
  });

  it('marks approved, paid, denied, canceled, and missing invoices terminal', () => {
    expect(['approved', 'paid', 'denied', 'canceled', 'not_found'].every((s) => isTerminalStatus(s as never))).toBe(true);
    expect(isTerminalStatus('draft')).toBe(false);
    expect(isTerminalStatus('entry')).toBe(false);
  });
});

describe('scoreChanges and entryOutcome', () => {
  it('counts material changes against the agent and reports convention changes apart', () => {
    const scored = scoreChanges([
      { field: 'memo', before: 'a', after: 'b' },
      { field: 'line.costCenter', line: 0, before: 'CC1', after: 'CC2' },
    ]);
    expect(scored.map((change) => [change.field, change.category, change.agentOwned])).toEqual([
      ['memo', 'convention', true],
      ['line.costCenter', 'material', true],
    ]);
    expect(entryOutcome(scored)).toBe('submitted_edited');
    expect(entryOutcome(scoreChanges([{ field: 'memo', before: 'a', after: 'b' }]))).toBe('submitted_clean');
  });

  it('does not count an AP fix to an OCR value the enrich agent left alone', () => {
    const scored = scoreChanges(
      [
        { field: 'supplier', before: 'S-1', after: 'S-2' },
        { field: 'line.fund', line: 0, before: 'F-1', after: 'F-2' },
      ],
      ['line.fund']
    );
    expect(scored.map((change) => change.agentOwned)).toEqual([false, true]);
    expect(entryOutcome([scored[0]])).toBe('submitted_clean');
  });

  it('counts added and removed lines as agent-owned when the agent rebuilt the lines', () => {
    expect(scoreChanges([{ field: 'line.removed', line: 1 }], ['line.amount'])[0].agentOwned).toBe(true);
    expect(scoreChanges([{ field: 'line.removed', line: 1 }], ['supplier'])[0].agentOwned).toBe(false);
  });
});

describe('cancelReasonMappingFromEnv', () => {
  it('parses and lowercases the configured lists and ignores invalid JSON', () => {
    expect(cancelReasonMappingFromEnv({
      CANCEL_REASON_ATTRIBUTION: '{"business":["Supplier Voided"],"duplicate":["Duplicate"],"agentTags":["FINAGENT-agent-error"]}',
    })).toEqual({ business: ['supplier voided'], duplicate: ['duplicate'], agent: [], agentTags: ['finagent-agent-error'] });
    expect(cancelReasonMappingFromEnv({ CANCEL_REASON_ATTRIBUTION: 'not json' })).toEqual(noMapping);
    expect(cancelReasonMappingFromEnv({})).toEqual(noMapping);
  });
});

describe('attributeCancel', () => {
  const mapping: CancelReasonMapping = {
    business: ['supplier voided'],
    duplicate: ['duplicate'],
    agent: [],
    agentTags: ['finagent-agent-error'],
  };

  it('lets an AP label override every rule', () => {
    expect(attributeCancel({ apLabel: 'business', replacement: { workdayInvoiceWid: 'x' } }, mapping))
      .toEqual({ attribution: 'business', basis: 'ap_label' });
  });

  it('uses the configured cancel reasons and agent tag', () => {
    expect(attributeCancel({ cancelReason: 'Supplier Voided' }, mapping)).toEqual({ attribution: 'business', basis: 'business_reason' });
    expect(attributeCancel({ cancelReason: 'Duplicate' }, mapping)).toEqual({ attribution: 'agent', basis: 'duplicate_reason' });
    expect(attributeCancel({ workQueueTags: ['FINAGENT-agent-error'] }, mapping)).toEqual({ attribution: 'agent', basis: 'agent_tag' });
  });

  it('attributes AP-keyed replacements, duplicates, and wrong documents to the agent', () => {
    expect(attributeCancel({ replacement: { workdayInvoiceWid: 'x' } }, mapping).basis).toBe('replacement');
    expect(attributeCancel({ duplicate: { workdayInvoiceWid: 'x' } }, mapping).basis).toBe('duplicate');
    expect(attributeCancel({ primaryAttachmentKind: 'supporting' }, mapping)).toEqual({ attribution: 'agent', basis: 'wrong_document' });
    expect(attributeCancel({ clusteringMode: 'off', agentInvoicesInConversation: 3 }, mapping))
      .toEqual({ attribution: 'agent', basis: 'per_pdf_without_clustering' });
    expect(attributeCancel({ clusteringMode: 'on', agentInvoicesInConversation: 3 }, mapping).basis).toBe('no_signal');
  });

  it('attributes a supplier void or credit to the business', () => {
    expect(attributeCancel({ supplierVoidOrCreditInThread: true }, mapping))
      .toEqual({ attribution: 'business', basis: 'supplier_void_or_credit' });
  });

  it('keeps an early Draft cancel unattributed because timing alone is not proof', () => {
    expect(attributeCancel({ canceledWhileDraft: true, hoursFromLastAgentWrite: 4 }, mapping))
      .toEqual({ attribution: 'unattributed', basis: 'early_draft_cancel' });
    expect(attributeCancel({ canceledWhileDraft: true, hoursFromLastAgentWrite: 200 }, mapping).basis).toBe('no_signal');
    expect(attributeCancel({ canceledWhileDraft: true, hoursFromLastAgentWrite: 4, apEditedBeforeCancel: true }, mapping).basis)
      .toBe('no_signal');
  });

  it('does not treat an unmapped reason as proof either way', () => {
    expect(attributeCancel({ cancelReason: 'Other' }, noMapping)).toEqual({ attribution: 'unattributed', basis: 'no_signal' });
  });
});

describe('tenant refresh', () => {
  it('reads the refresh weekday and ignores none or invalid values', () => {
    expect(tenantRefreshWeekday({ SCORE_TENANT_REFRESH_WEEKDAY: '6' })).toBe(6);
    expect(tenantRefreshWeekday({ SCORE_TENANT_REFRESH_WEEKDAY: 'none' })).toBeUndefined();
    expect(tenantRefreshWeekday({ SCORE_TENANT_REFRESH_WEEKDAY: '7' })).toBeUndefined();
    expect(tenantRefreshWeekday({})).toBeUndefined();
  });

  it('finds the start of the most recent refresh day', () => {
    expect(lastTenantRefresh(new Date('2026-10-05T14:00:00Z'), 6)).toEqual(new Date('2026-10-03T00:00:00Z'));
    expect(lastTenantRefresh(new Date('2026-10-03T18:00:00Z'), 6)).toEqual(new Date('2026-10-03T00:00:00Z'));
    expect(lastTenantRefresh(new Date('2026-10-02T23:59:00Z'), 6)).toEqual(new Date('2026-09-26T00:00:00Z'));
  });
});

describe('mentionsSupplierVoidOrCredit', () => {
  it('finds a void or credit notice after the agent write and ignores older messages', () => {
    expect(mentionsSupplierVoidOrCredit([{ createdAt: 200, body: 'Please disregard this invoice, we issued a credit memo.' }], 100)).toBe(true);
    expect(mentionsSupplierVoidOrCredit([{ createdAt: 50, body: 'This invoice was voided.' }], 100)).toBe(false);
    expect(mentionsSupplierVoidOrCredit([{ createdAt: 200, body: 'Attached is the invoice for September.' }], 100)).toBe(false);
  });
});
