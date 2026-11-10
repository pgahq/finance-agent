export interface PoLineLike {
  purchaseOrderLineId?: string | null;
  description?: string | null;
  memo?: string | null;
  quantity?: number | null;
  availableForInvoicing?: boolean;
}

const MIN_MATCH_LENGTH = 6;

export function compactText(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** A PO line ordered by amount rather than by quantity, such as a delivery, pickup, or surcharge line. */
export function isPoServiceLine(line: PoLineLike): boolean {
  return Boolean(line.purchaseOrderLineId) && !(line.quantity != null && line.quantity > 0);
}

// Spacing and punctuation differ between the invoice and the PO ("PICKUP CHARGE" and "PICK UP CHARGE"), and the
// invoice often appends a supplier code ("ENVIRONMENTAL SERVICE CHARGE [ENV/MCI]"), so one description must
// contain the other once both are reduced to letters and digits.
function descriptionsMatch(text: string, poDescription: string | null | undefined): boolean {
  const left = compactText(text);
  const right = compactText(poDescription);
  if (left.length < MIN_MATCH_LENGTH || right.length < MIN_MATCH_LENGTH) return false;
  return left.includes(right) || right.includes(left);
}

/**
 * The PO service line each description names, keyed by the description's index. A description is matched only
 * when exactly one open service line fits it and no other description fits the same line, so a generic word
 * or a repeated row never picks a line by guesswork.
 */
export function uniqueServiceLineMatches(
  descriptions: Array<string | null | undefined>,
  poLines: PoLineLike[] | undefined
): Map<number, string> {
  const matches = new Map<number, string>();
  const serviceLines = (poLines ?? []).filter(line => isPoServiceLine(line) && line.availableForInvoicing !== false);
  if (serviceLines.length === 0) return matches;
  const candidatesByIndex = descriptions.map(description =>
    description ? serviceLines.filter(line => descriptionsMatch(description, line.description)) : []
  );
  const rowsPerLine = new Map<string, number>();
  for (const candidates of candidatesByIndex) {
    if (candidates.length !== 1) continue;
    const id = candidates[0].purchaseOrderLineId as string;
    rowsPerLine.set(id, (rowsPerLine.get(id) ?? 0) + 1);
  }
  candidatesByIndex.forEach((candidates, index) => {
    if (candidates.length !== 1) return;
    const id = candidates[0].purchaseOrderLineId as string;
    if (rowsPerLine.get(id) === 1) matches.set(index, id);
  });
  return matches;
}

const GENERIC_WORDS = new Set([
  'and', 'the', 'for', 'with', 'from', 'per', 'each', 'charge', 'charges', 'service', 'services', 'fee', 'fees', 'total',
]);

function descriptiveWords(text: string | null | undefined): Set<string> {
  return new Set(
    (text ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(word => word.length >= 3 && !GENERIC_WORDS.has(word))
  );
}

/** True when the row and the PO line share a descriptive word, or when either has none to compare. */
export function sharesDescriptiveWord(rowDescription: string, poLine: PoLineLike): boolean {
  const row = descriptiveWords(rowDescription);
  const po = [...descriptiveWords(poLine.description), ...descriptiveWords(poLine.memo)];
  if (row.size === 0 || po.length === 0) return true;
  return po.some(word => row.has(word));
}
