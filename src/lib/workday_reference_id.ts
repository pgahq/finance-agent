const WORKDAY_WID_PATTERN = /^[a-f0-9]{32}$/i;

export function isWorkdayWid(value: string): boolean {
  return WORKDAY_WID_PATTERN.test(value.trim());
}

function textFromWqlValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  if (value && typeof value === 'object') {
    const descriptor = (value as { descriptor?: unknown }).descriptor;
    if (typeof descriptor === 'string' && descriptor.trim()) {
      return descriptor.trim();
    }
  }

  return undefined;
}

// Company_Reference_ID is a short code such as "912". companyID / company.id is the
// 32-character Workday WID and must never be stored as the reference ID.
export function extractCompanyReferenceId(
  candidates: unknown[],
  options: { workdayId?: string; companyName?: string } = {}
): string | undefined {
  const workdayId = options.workdayId?.trim().toLowerCase();
  const companyName = options.companyName?.trim().toLowerCase();

  for (const candidate of candidates) {
    const text = textFromWqlValue(candidate);
    if (!text) continue;

    const normalized = text.toLowerCase();
    if (isWorkdayWid(text)) continue;
    if (workdayId && normalized === workdayId) continue;
    if (companyName && normalized === companyName) continue;

    return text;
  }

  return undefined;
}
