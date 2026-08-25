const PO_NUMBER_PATTERN = /\bPO[-\s]?(\w{6})\b/i;

export function normalizePurchaseOrderNumber(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const stripped = raw.trim().replace(/^[Pp][Oo]-?/, '');
  const normalized = `PO-${stripped}`;
  return /^PO-\w{6}$/.test(normalized) ? normalized : undefined;
}

export function findPurchaseOrderNumber(
  ...texts: Array<string | null | undefined>
): string | undefined {
  for (const text of texts) {
    if (!text) continue;
    const match = text.match(PO_NUMBER_PATTERN);
    if (match) {
      return normalizePurchaseOrderNumber(match[0]);
    }
  }
  return undefined;
}

export interface PurchaseOrderEnrichmentContext {
  documentNumber: string;
  company?: {
    workdayId: string;
    name: string;
  };
  lines: Array<{
    lineOrder: number;
    purchaseOrderLineId: string;
    description?: string;
    memo?: string;
  }>;
}
