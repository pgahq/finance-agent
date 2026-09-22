export function buildWorkdayObjectDeeplink(
  workdayId?: string,
  uiBaseUrl: string | undefined = process.env.WORKDAY_UI_BASE_URL,
  tenant: string | undefined = process.env.WORKDAY_TENANT,
): string | undefined {
  const wid = workdayId?.trim();
  const base = uiBaseUrl?.trim().replace(/\/+$/, '');
  const tenantName = tenant?.trim();
  if (!wid || !base || !tenantName) return undefined;

  return `${base}/${encodeURIComponent(tenantName)}/d/inst/deeplink/${encodeURIComponent(wid)}.htmld`;
}
