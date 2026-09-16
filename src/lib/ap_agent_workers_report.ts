/**
 * Parses rows from the Workday custom report "Worker Assignment For AP Agent".
 */

/**
 * Workday customreport2 path: `{owner}/{Report_Web_Service_Name}`.
 * Integration IDs show Custom_Report_ID with spaces; the web service name uses underscores.
 */
export const AP_AGENT_WORKERS_CUSTOM_REPORT_PATH =
  'wdw-7212/Worker_Assignment_For_AP_Agent';

/** Column names returned by customreport2 for Worker_Assignment_For_AP_Agent (sandbox). */
export const AP_AGENT_WORKERS_REPORT_COLUMNS = {
  activeStatus: 'Active_Status',
  employeeId: 'Employee_ID',
  fullLegalName: 'Full_Legal_Name',
  primaryWorkEmail: 'Primary_Work_-_Email',
  workdayId: 'Workday_ID',
} as const;

export interface ApAgentWorkerRow {
  workdayId: string;
  email: string;
  /** From Workday `Active_Status` (and termination flags when present). */
  active: boolean;
  name?: string;
  employeeId?: string;
}

function normalizeHeaderKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

function cellValue(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = cellValue(item);
      if (parsed) return parsed;
    }
    return undefined;
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const descriptor = record.descriptor ?? record.Descriptor;
    if (typeof descriptor === 'string' && descriptor.trim()) {
      return descriptor.trim();
    }
    const text = record['#text'] ?? record._value ?? record.value;
    if (typeof text === 'string' && text.trim()) {
      return text.trim();
    }
    const id = record.id ?? record.$value ?? record.WID ?? record.wid;
    if (typeof id === 'string' && id.trim()) {
      return id.trim();
    }
  }
  return undefined;
}

function readField(row: Record<string, unknown>, ...headerHints: string[]): string | undefined {
  const normalizedHints = new Set(headerHints.map(normalizeHeaderKey));
  for (const [key, value] of Object.entries(row)) {
    if (normalizedHints.has(normalizeHeaderKey(key))) {
      return cellValue(value);
    }
  }
  return undefined;
}

function looksLikeWorkdayWid(value: string): boolean {
  const trimmed = value.trim();
  return /^[a-f0-9]{32}$/i.test(trimmed) || (trimmed.length >= 20 && /^[a-f0-9]+$/i.test(trimmed));
}

function readWorkdayIdFromRecord(record: Record<string, unknown>): string | undefined {
  const direct = readField(
    record,
    'Workday ID',
    'Workday_ID',
    'WorkdayID',
    'workdayId',
    'Worker_WID',
    'Employee_WID',
    'worker',
    'Worker',
  );
  if (direct && looksLikeWorkdayWid(direct)) {
    return direct;
  }

  for (const [key, value] of Object.entries(record)) {
    const normalizedKey = normalizeHeaderKey(key);
    if (
      normalizedKey === 'wid'
      || normalizedKey.endsWith('workdayid')
      || (normalizedKey.includes('workday') && normalizedKey.includes('id'))
      || (normalizedKey.includes('worker') && normalizedKey.includes('wid'))
      || normalizedKey === 'worker'
      || normalizedKey === 'employee'
    ) {
      const candidate = cellValue(value);
      if (candidate && looksLikeWorkdayWid(candidate)) {
        return candidate;
      }
    }
  }

  for (const value of Object.values(record)) {
    const candidate = cellValue(value);
    if (candidate && looksLikeWorkdayWid(candidate)) {
      return candidate;
    }
  }

  return direct;
}

function readEmailFromRecord(record: Record<string, unknown>): string | undefined {
  const direct = readField(
    record,
    'Primary Work - Email',
    'Primary_Work_-_Email',
    'Primary_Work_Email',
    'Primary Work Email',
    'email_PrimaryWork',
    'PrimaryWorkEmail',
    'PrimaryEmail',
    'Email',
  );
  if (direct && direct.includes('@')) {
    return direct;
  }

  let fallbackEmail: string | undefined;
  for (const [key, value] of Object.entries(record)) {
    const normalizedKey = normalizeHeaderKey(key);
    if (!normalizedKey.includes('email')) {
      continue;
    }
    const candidate = cellValue(value);
    if (!candidate || !candidate.includes('@')) {
      continue;
    }
    if (normalizedKey.includes('primary') || normalizedKey.includes('work')) {
      return candidate;
    }
    fallbackEmail = fallbackEmail ?? candidate;
  }

  if (fallbackEmail) {
    return fallbackEmail;
  }

  for (const value of Object.values(record)) {
    const candidate = cellValue(value);
    if (candidate && candidate.includes('@')) {
      return candidate;
    }
  }

  return undefined;
}

function isExplicitlyInactive(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === 'no'
    || normalized === 'n'
    || normalized === 'false'
    || normalized === '0'
    || normalized === 'inactive'
    || normalized.startsWith('inactive ')
    || normalized.startsWith('terminated')
  );
}

function isTerminated(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'yes' || normalized === 'y' || normalized === 'true' || normalized === 'terminated') {
    return true;
  }
  // Termination dates and free-text statuses are not boolean terminated flags.
  if (/^\d{4}-\d{2}-\d{2}/.test(normalized)) {
    return false;
  }
  return normalized.startsWith('terminated');
}

export function normalizeEmployeeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Maps Workday `Active_Status` (and optional terminated flag) to `metadata.active`. */
export function parseEmployeeActiveFromReportFields(
  activeStatus: string | undefined,
  terminated?: string | undefined,
): boolean {
  if (terminated && isTerminated(terminated)) {
    return false;
  }
  if (!activeStatus) {
    return true;
  }
  if (isExplicitlyInactive(activeStatus)) {
    return false;
  }
  const normalized = activeStatus.trim().toLowerCase();
  if (
    normalized === 'yes'
    || normalized === 'y'
    || normalized === 'true'
    || normalized === '1'
    || normalized === 'active'
    || normalized.startsWith('active ')
  ) {
    return true;
  }
  return true;
}

function readKnownReportField(
  record: Record<string, unknown>,
  column: keyof typeof AP_AGENT_WORKERS_REPORT_COLUMNS,
): string | undefined {
  const key = AP_AGENT_WORKERS_REPORT_COLUMNS[column];
  return cellValue(record[key]);
}

/** Distinct Active_Status values (cap 20) for CloudWatch when tuning filters. */
export function sampleApAgentWorkerActiveStatusValues(entries: unknown[], limit = 20): string[] {
  const values = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const status = readKnownReportField(entry as Record<string, unknown>, 'activeStatus');
    if (status) values.add(status);
    if (values.size >= limit) break;
  }
  return [...values].sort((left, right) => left.localeCompare(right));
}

export function parseApAgentWorkerReportRow(row: unknown): ApAgentWorkerRow | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const record = row as Record<string, unknown>;

  const workdayId = readKnownReportField(record, 'workdayId') ?? readWorkdayIdFromRecord(record);
  const emailRaw = readKnownReportField(record, 'primaryWorkEmail') ?? readEmailFromRecord(record);
  if (!workdayId || !emailRaw) return undefined;

  const activeStatus = readKnownReportField(record, 'activeStatus')
    ?? readField(
      record,
      'Active Status',
      'Active_Status',
      'activeStatus',
      'Active',
      'Is_Active',
      'Employee_Status',
    );
  const terminated = readField(record, 'Terminated', 'terminated');
  const active = parseEmployeeActiveFromReportFields(activeStatus, terminated);

  const email = normalizeEmployeeEmail(emailRaw);
  if (!email.includes('@')) return undefined;

  const name = readKnownReportField(record, 'fullLegalName')
    ?? readField(record, 'Full Legal Name', 'Full_Legal_Name', 'fullLegalName');
  const employeeId = readKnownReportField(record, 'employeeId')
    ?? readField(record, 'Employee ID', 'Employee_ID', 'employeeId');

  return {
    workdayId,
    email,
    active,
    ...(name ? { name } : {}),
    ...(employeeId ? { employeeId } : {}),
  };
}

/** Sorted unique JSON field names across all report rows (for CloudWatch column mapping). */
export function listApAgentWorkerReportColumnNames(entries: unknown[]): string[] {
  const names = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    for (const key of Object.keys(entry as object)) {
      names.add(key);
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

export function extractApAgentWorkerReportEntries(payload: unknown): unknown[] {
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;

  const reportEntry = record.Report_Entry ?? record.report_Entry ?? record.report_entry;
  if (Array.isArray(reportEntry)) return reportEntry;
  if (reportEntry && typeof reportEntry === 'object') return [reportEntry];

  if (Array.isArray(payload)) return payload;

  const data = record.data;
  if (Array.isArray(data)) return data;

  return [];
}

export function parseApAgentWorkerReport(payload: unknown): ApAgentWorkerRow[] {
  const entries = extractApAgentWorkerReportEntries(payload);
  const parsed: ApAgentWorkerRow[] = [];
  for (const entry of entries) {
    const row = parseApAgentWorkerReportRow(entry);
    if (row) parsed.push(row);
  }
  return parsed;
}

export type ApAgentWorkerReportEntryDisposition = 'included' | 'excluded' | 'unparseable';

/** Classifies report rows for cache sync (inactive rows are included with `active: false`). */
export function classifyApAgentWorkerReportEntry(entry: unknown): ApAgentWorkerReportEntryDisposition {
  if (parseApAgentWorkerReportRow(entry)) {
    return 'included';
  }
  if (!entry || typeof entry !== 'object') {
    return 'unparseable';
  }
  const record = entry as Record<string, unknown>;
  const workdayId = readKnownReportField(record, 'workdayId') ?? readWorkdayIdFromRecord(record);
  const emailRaw = readKnownReportField(record, 'primaryWorkEmail') ?? readEmailFromRecord(record);
  if (!workdayId && !emailRaw) {
    return 'unparseable';
  }
  return 'unparseable';
}

/** First report row for debug logging when column mapping fails in production. */
export function sampleApAgentWorkerReportRow(payload: unknown): unknown {
  const entries = extractApAgentWorkerReportEntries(payload);
  return entries[0];
}
