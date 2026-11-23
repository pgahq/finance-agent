import type { ScoredChange } from '../lib/invoice_score.js';
import type { InvoiceScore } from '../lib/invoice_scores.js';
import { buildJevReplyBlocks, compareJev, jevScoreView } from '../lib/jev_digest.js';
import { touchCount, type TouchCallout } from '../lib/score_touches.js';

const costCenter = (category: ScoredChange['category'], extra: Partial<ScoredChange> = {}): ScoredChange => ({
  field: 'line.costCenter', line: 0, before: 'CC1', after: 'CC2', category, agentOwned: true, ...extra,
});

const score = (overrides: Partial<InvoiceScore> = {}): InvoiceScore => ({
  workdayInvoiceWid: `wid-${Math.random()}`,
  terminal: false,
  entryReadAt: new Date('2026-10-08T12:00:00Z'),
  outcome: 'submitted_edited',
  entryDiff: [costCenter('material')],
  ...overrides,
});

describe('jevScoreView', () => {
  it('returns a score with no Jev verdict untouched', () => {
    const plain = score();
    expect(jevScoreView(plain)).toBe(plain);
  });

  it('swaps in Jev\'s diffs and entry outcome for an invoice AP submitted', () => {
    const view = jevScoreView(score({ jevShadow: { model: 'm', entryDiff: [], entryOutcome: 'submitted_clean', lateDiff: [costCenter('convention')] } }));
    expect(view.entryDiff).toEqual([]);
    expect(view.outcome).toBe('submitted_clean');
    expect(view.lateDiff).toHaveLength(1);
  });

  it('leaves the outcome of a canceled or denied invoice alone', () => {
    const view = jevScoreView(score({ outcome: 'canceled', cancelAttribution: 'agent', cancelBasis: 'wrong_document', jevShadow: { model: 'm', entryOutcome: 'submitted_clean' } }));
    expect(view.outcome).toBe('canceled');
  });

  it('uses Jev\'s cancel attribution unless AP labeled the cancel', () => {
    const jevShadow = { model: 'm', cancel: { attribution: 'business' as const, basis: 'jev' as const, confidence: 0.9 } };
    expect(jevScoreView(score({ outcome: 'canceled', cancelAttribution: 'unattributed', cancelBasis: 'no_signal', jevShadow }))).toEqual(
      expect.objectContaining({ cancelAttribution: 'business', cancelBasis: 'jev' })
    );
    expect(jevScoreView(score({ outcome: 'canceled', cancelAttribution: 'agent', cancelBasis: 'ap_label', jevShadow }))).toEqual(
      expect.objectContaining({ cancelAttribution: 'agent', cancelBasis: 'ap_label' })
    );
  });
});

describe('compareJev', () => {
  it('counts agreement per decision over the invoices that have a Jev verdict', () => {
    const comparison = compareJev([
      score(),
      score({ jevShadow: { model: 'm', entryDiff: [costCenter('material')], entryOutcome: 'submitted_edited' } }),
      score({ jevShadow: { model: 'm', entryDiff: [costCenter('convention', { jev: { probability: 0.1, staticCategory: 'material' } })], entryOutcome: 'submitted_clean' } }),
      score({
        outcome: 'canceled', entryDiff: undefined, cancelAttribution: 'unattributed', cancelBasis: 'no_signal',
        jevShadow: { model: 'm', cancel: { attribution: 'business', basis: 'jev', confidence: 0.9 }, supplierVoidOrCredit: { jev: true, probability: 0.9, rule: false } },
      }),
    ]);
    expect(comparison.compared).toBe(3);
    expect(comparison.outcome).toEqual({ agree: 1, of: 2 });
    expect(comparison.touches).toEqual({ same: 2, of: 2 });
    expect(comparison.cancels).toEqual({ agree: 0, of: 1 });
    expect(comparison.voidOrCredit).toEqual({ agree: 0, of: 1 });
    expect(comparison.categories).toEqual({ reclassified: 1, of: 1 });
    expect(comparison.disagreements.map((item) => item.text)).toEqual([
      expect.stringContaining('cancel unattributed (no signal) by the rules, business (Jev judgment) by Jev'),
      expect.stringContaining('by the rules'),
    ]);
  });

  it('counts only cancels Jev judged, and names AP\'s label as AP rather than the rules', () => {
    const fact = score({
      outcome: 'canceled', entryDiff: undefined, cancelAttribution: 'business', cancelBasis: 'business_reason',
      jevShadow: { model: 'm', cancel: { attribution: 'business', basis: 'business_reason' } },
    });
    const labeled = score({
      outcome: 'canceled', entryDiff: undefined, cancelAttribution: 'agent', cancelBasis: 'ap_label',
      jevShadow: { model: 'm', cancel: { attribution: 'business', basis: 'jev', confidence: 0.9 } },
    });
    const comparison = compareJev([fact, labeled]);
    expect(comparison.cancels).toEqual({ agree: 0, of: 1 });
    expect(comparison.disagreements.map((item) => item.text)).toEqual([
      'cancel agent (AP label) by AP, business (Jev judgment) by Jev',
    ]);
  });

  it('counts a touch difference when Jev pairs lines differently', () => {
    const disagreement = score({ entryDiff: [costCenter('material'), costCenter('material', { line: 1 })], jevShadow: { model: 'm', entryDiff: [costCenter('material')], entryOutcome: 'submitted_edited' } });
    const comparison = compareJev([disagreement]);
    expect(touchCount(disagreement)).toBe(2);
    expect(touchCount(jevScoreView(disagreement))).toBe(1);
    expect(comparison.touches).toEqual({ same: 0, of: 1 });
    expect(comparison.disagreements[0].text).toBe('2 touches by the rules, 1 touch by Jev');
  });

  it('is empty when nothing carries a verdict', () => {
    expect(compareJev([score(), score()]).compared).toBe(0);
  });
});

describe('buildJevReplyBlocks', () => {
  const period = (counts: number[], name = 'today') => ({ name, total: counts.reduce((sum, value) => sum + value, 0), counts, start: new Date('2026-10-08T05:00:00Z'), end: new Date('2026-10-09T05:00:00Z') });
  const callout = (zero: number, more: number): TouchCallout => ({
    periodName: 'today',
    previousName: 'yesterday',
    current: period([zero, more]),
    previous: period([0, 0], 'yesterday'),
    trend: [],
  } as unknown as TouchCallout);
  const text = (blocks: ReturnType<typeof buildJevReplyBlocks>) =>
    blocks.map((block) => JSON.stringify(block)).join('\n');

  it('labels the reply as shadow, leads with the Jev touch callout, and lists the biggest disagreements with links', () => {
    const scores = Array.from({ length: 7 }, (_, index) => score({
      workdayInvoiceWid: `wid-${index}`,
      workdayInvoiceNumber: `SUPIN-${index}`,
      jevShadow: { model: 'm', entryDiff: [], entryOutcome: 'submitted_clean' },
    }));
    const blocks = buildJevReplyBlocks({ ruleCallout: callout(0, 7), jevCallout: callout(7, 0), scores });
    const out = text(blocks);
    expect(out).toContain('Jev-scored');
    expect(out).toContain('7 invoices compared');
    expect(out).toContain('Zero-touch share: 100% by Jev, 0% by the rules');
    expect(out).toContain('Largest disagreements');
    expect(out).toContain('and 9 more');
    expect(out.match(/SUPIN-\d/g)!.length).toBeLessThanOrEqual(10);
  });

  it('shows material vs convention examples with before and after values in both directions', () => {
    const scores = [
      score({
        workdayInvoiceWid: 'wid-a',
        workdayInvoiceNumber: 'SUPIN-A',
        jevShadow: {
          model: 'm',
          entryDiff: [costCenter('convention', { before: 'CC-1200 Marketing', after: 'CC-1200', jev: { probability: 0.1, staticCategory: 'material' } })],
          entryOutcome: 'submitted_clean',
        },
      }),
      score({
        workdayInvoiceWid: 'wid-b',
        workdayInvoiceNumber: 'SUPIN-B',
        entryDiff: [{ field: 'suppliersInvoiceNumber', before: 'INV-0O42', after: 'INV-0042', category: 'convention', agentOwned: true }],
        jevShadow: {
          model: 'm',
          entryDiff: [{ field: 'suppliersInvoiceNumber', before: 'INV-0O42', after: 'INV-0042', category: 'material', agentOwned: true, jev: { probability: 0.95, staticCategory: 'convention' } }],
          entryOutcome: 'submitted_edited',
        },
      }),
    ];
    const out = text(buildJevReplyBlocks({ ruleCallout: callout(0, 2), jevCallout: callout(0, 2), scores }));
    expect(out).toContain('Material vs convention: examples');
    expect(out).toContain('Rules: material (counts against the agent). Jev: convention');
    expect(out).toContain('Cost center (line 1): `CC-1200 Marketing` → `CC-1200` · Jev 90% sure it was AP preference');
    expect(out).toContain('Rules: convention (ignored). Jev: material');
    expect(out).toContain('Supplier invoice number: `INV-0O42` → `INV-0042` · Jev 95% sure it was an agent error');
  });

  it('caps examples per direction and says how many more there are', () => {
    const scores = Array.from({ length: 5 }, (_, index) => score({
      workdayInvoiceWid: `wid-${index}`,
      jevShadow: { model: 'm', entryDiff: [costCenter('convention', { jev: { probability: 0.1 + index / 100, staticCategory: 'material' } })], entryOutcome: 'submitted_clean' },
    }));
    const out = text(buildJevReplyBlocks({ ruleCallout: callout(0, 5), jevCallout: callout(5, 0), scores }));
    expect(out.match(/sure it was AP preference/g)).toHaveLength(3);
    expect(out).toContain('…and 2 more');
  });

  it('ranks each direction by how far Jev leaned toward the side it picked', () => {
    const scores = [0.75, 0.2, 0.5].map((probability, index) => score({
      workdayInvoiceWid: `wid-${index}`,
      workdayInvoiceNumber: `SUPIN-${index}`,
      jevShadow: { model: 'm', entryDiff: [costCenter('convention', { jev: { probability, staticCategory: 'material' } })], entryOutcome: 'submitted_clean' },
    }));
    const out = text(buildJevReplyBlocks({ ruleCallout: callout(0, 3), jevCallout: callout(3, 0), scores }));
    const order = [...out.matchAll(/SUPIN-(\d).*?Jev (\d+)% sure/g)].map((match) => `${match[1]}:${match[2]}`);
    expect(order).toEqual(['1:80', '2:50', '0:25']);
  });

  it('omits the examples when Jev reclassified nothing', () => {
    const scores = [score({ jevShadow: { model: 'm', entryDiff: [costCenter('material')], entryOutcome: 'submitted_edited' } })];
    expect(text(buildJevReplyBlocks({ ruleCallout: callout(0, 1), jevCallout: callout(0, 1), scores }))).not.toContain('Material vs convention: examples');
  });

  it('says no invoice has a verdict yet when none does', () => {
    const out = text(buildJevReplyBlocks({ ruleCallout: callout(1, 0), jevCallout: callout(1, 0), scores: [score()] }));
    expect(out).toContain('no invoice in this period has a Jev verdict yet');
  });
});
