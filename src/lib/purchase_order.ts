const PO_NUMBER_PATTERN = /\bPO[-–\s#]+(\w{6})\b/gi;

export function normalizePurchaseOrderNumber(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const stripped = raw.trim().replace(/^[Pp][Oo][-–\s#]*/, '');
  const normalized = `PO-${stripped}`;
  return /^PO-\w{6}$/.test(normalized) ? normalized : undefined;
}

export function findPurchaseOrderNumber(
  ...texts: Array<string | null | undefined>
): string | undefined {
  for (const text of texts) {
    if (!text) continue;
    const pattern = new RegExp(PO_NUMBER_PATTERN.source, PO_NUMBER_PATTERN.flags);
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const normalized = normalizePurchaseOrderNumber(match[1] ?? match[0]);
      if (normalized) return normalized;
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
