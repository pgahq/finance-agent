import { categoryOf, entryOutcome, type CancelAttribution, type Outcome } from './invoice_score.js';
import type { InvoiceScore } from './invoice_scores.js';
import { BASIS_LABELS, OUTCOME_LABELS, invoiceLink, percent, plural, section } from './score_digest.js';
import type { SlackBlock } from './slack.js';
import { touchCalloutBlocks, touchCount, type TouchCallout } from './score_touches.js';

const MAX_DISAGREEMENTS = 5;

/**
 * The score as Jev decided it: Jev's changes, outcome, and cancel attribution where it made them, and the official
 * values everywhere else (invoices scored before Jev ran, or where Jev could not answer). AP's own cancel label
 * always wins. The chart code reads this like any other score, so the Jev chart is drawn by the same code.
 */
export function jevScoreView(score: InvoiceScore): InvoiceScore {
  const shadow = score.jevShadow;
  if (!shadow) return score;
  const submitted = score.outcome === 'submitted_clean' || score.outcome === 'submitted_edited';
  const jevCancel = shadow.cancel && score.cancelBasis !== 'ap_label';
  return {
    ...score,
    entryDiff: shadow.entryDiff ?? score.entryDiff,
    lateDiff: shadow.lateDiff ?? score.lateDiff,
    outcome: submitted && shadow.entryOutcome ? shadow.entryOutcome : score.outcome,
    ...(jevCancel ? { cancelAttribution: shadow.cancel!.attribution, cancelBasis: shadow.cancel!.basis } : {}),
  };
}

interface Disagreement {
  score: InvoiceScore;
  weight: number;
  text: string;
}

export interface JevComparison {
  /** Invoices with a stored Jev verdict. */
  compared: number;
  outcome: { agree: number; of: number };
  touches: { same: number; of: number };
  cancels: { agree: number; of: number };
  voidOrCredit: { agree: number; of: number };
  categories: { reclassified: number; of: number };
  disagreements: Disagreement[];
}

const touches = (count: number): string => `${count} touch${count === 1 ? '' : 'es'}`;

const attributionLabel = (attribution: CancelAttribution | undefined, basis: string | undefined): string => {
  const reason = basis ? (BASIS_LABELS[basis as keyof typeof BASIS_LABELS] ?? basis.replace(/_/g, ' ')) : undefined;
  return `${attribution ?? 'unscored'}${reason ? ` (${reason})` : ''}`;
};

/** Rules versus Jev on every decision Jev made, over the scores that carry a Jev verdict. */
export function compareJev(scores: InvoiceScore[]): JevComparison {
  const comparison: JevComparison = {
    compared: 0,
    outcome: { agree: 0, of: 0 },
    touches: { same: 0, of: 0 },
    cancels: { agree: 0, of: 0 },
    voidOrCredit: { agree: 0, of: 0 },
    categories: { reclassified: 0, of: 0 },
    disagreements: [],
  };
  for (const score of scores) {
    const shadow = score.jevShadow;
    if (!shadow) continue;
    comparison.compared += 1;
    const view = jevScoreView(score);

    if (shadow.entryOutcome && score.entryDiff) {
      const ruleOutcome: Outcome = entryOutcome(score.entryDiff);
      comparison.outcome.of += 1;
      if (ruleOutcome === shadow.entryOutcome) {
        comparison.outcome.agree += 1;
      } else {
        comparison.disagreements.push({
          score,
          weight: 2,
          text: `${OUTCOME_LABELS[ruleOutcome]} by the rules, ${OUTCOME_LABELS[shadow.entryOutcome]} by Jev`,
        });
      }
    }

    if (shadow.entryDiff || shadow.lateDiff) {
      comparison.touches.of += 1;
      const rule = touchCount(score);
      const jev = touchCount(view);
      if (rule === jev) {
        comparison.touches.same += 1;
      } else {
        comparison.disagreements.push({
          score,
          weight: 1 + Math.min(Math.abs(rule - jev), 10) / 10,
          text: `${touches(rule)} by the rules, ${touches(jev)} by Jev`,
        });
      }
    }

    for (const change of [...(shadow.entryDiff ?? []), ...(shadow.lateDiff ?? [])]) {
      if (!change.jev || !change.agentOwned) continue;
      comparison.categories.of += 1;
      if (change.category !== categoryOf(change.field)) comparison.categories.reclassified += 1;
    }

    if (shadow.cancel && (score.outcome === 'canceled' || score.outcome === 'deleted')) {
      comparison.cancels.of += 1;
      if (score.cancelAttribution === shadow.cancel.attribution) {
        comparison.cancels.agree += 1;
      } else {
        comparison.disagreements.push({
          score,
          weight: 3,
          text: `cancel ${attributionLabel(score.cancelAttribution, score.cancelBasis)} by the rules, ${attributionLabel(shadow.cancel.attribution, shadow.cancel.basis)} by Jev`,
        });
      }
    }

    if (shadow.supplierVoidOrCredit && shadow.supplierVoidOrCredit.rule !== undefined) {
      comparison.voidOrCredit.of += 1;
      if (shadow.supplierVoidOrCredit.rule === shadow.supplierVoidOrCredit.jev) comparison.voidOrCredit.agree += 1;
    }
  }
  comparison.disagreements.sort((a, b) => b.weight - a.weight);
  return comparison;
}

function line(label: string, agree: number, of: number, noun: string): string | undefined {
  return of ? `• ${label}: ${agree} of ${of} ${noun}` : undefined;
}

export interface JevReplyInput {
  /** The official callout and the same callout built from `jevScoreView` scores. */
  ruleCallout: TouchCallout;
  jevCallout: TouchCallout;
  /** Scores in the post's period; only those with a Jev verdict are compared. */
  scores: InvoiceScore[];
}

/**
 * The thread reply under an audit post while Jev runs in shadow: the Jev-scored touch lead drawn by the same
 * `touchCalloutBlocks` as the official post, then how Jev and the rules differ. The post above stays the official score.
 */
export function buildJevReplyBlocks({ ruleCallout, jevCallout, scores }: JevReplyInput): SlackBlock[] {
  const comparison = compareJev(scores);
  const blocks: SlackBlock[] = [
    section('*Jev-scored · shadow*\nThe same scoring as the post above, with Jev making the calls the rules make. The post above is the official score.'),
    ...touchCalloutBlocks(jevCallout),
  ];

  const lines = [
    jevCallout.current.total && ruleCallout.current.total
      ? `• Zero-touch share: ${percent(jevCallout.current.counts[0] / jevCallout.current.total)} by Jev, ${percent(ruleCallout.current.counts[0] / ruleCallout.current.total)} by the rules`
      : undefined,
    line('Outcome (clean or edited)', comparison.outcome.agree, comparison.outcome.of, 'agree'),
    line('Touch count', comparison.touches.same, comparison.touches.of, 'the same'),
    line('Cancels', comparison.cancels.agree, comparison.cancels.of, 'agree'),
    line('Supplier void or credit', comparison.voidOrCredit.agree, comparison.voidOrCredit.of, 'agree'),
    comparison.categories.of
      ? `• Material vs convention: ${comparison.categories.reclassified} of ${plural(comparison.categories.of, 'change')} reclassified`
      : undefined,
  ].filter((value): value is string => Boolean(value));

  if (!comparison.compared) {
    blocks.push(section('*Jev vs rules* · no invoice in this period has a Jev verdict yet.'));
    return blocks;
  }
  const disagreements = comparison.disagreements
    .slice(0, MAX_DISAGREEMENTS)
    .map((item) => `• ${invoiceLink(item.score)}: ${item.text}`);
  blocks.push(section(`*Jev vs rules* · ${plural(comparison.compared, 'invoice')} compared\n${lines.join('\n')}`));
  if (disagreements.length) {
    const more = comparison.disagreements.length - disagreements.length;
    blocks.push(section(`*Largest disagreements*\n${disagreements.join('\n')}${more > 0 ? `\n…and ${more} more` : ''}`));
  }
  return blocks;
}
