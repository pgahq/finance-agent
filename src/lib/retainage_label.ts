const RETAINAGE_LABEL_WORDS = new Set(['retainage', 'retention', 'retained']);
// A release, a service named retention, the G702 "Total Earned Less Retainage" (line 6) and "Balance to Finish, including
// retainage" (line 9) rows, and a deposit retained are not retainage held.
const RETAINAGE_NOT_HELD_WORDS = new Set(['release', 'released', 'service', 'services', 'balance', 'finish', 'earned', 'including', 'deposit']);

/** Whether the row is labeled as a holdback and not as a release of one or another G702 line that mentions retainage. */
export function isRetainageHeldLabel(label: string | null | undefined): boolean {
  const tokens = (label ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.some(token => RETAINAGE_LABEL_WORDS.has(token)) && !tokens.some(token => RETAINAGE_NOT_HELD_WORDS.has(token));
}
