/**
 * Parses rows from the Workday custom report "Worker Assignment For AP Agent".
 */

/**
 * Workday customreport2 path: `{owner}/{Report_Web_Service_Name}`.
 * Integration IDs show Custom_Report_ID with spaces; the web service name uses underscores.
 */
export const AP_AGENT_WORKERS_CUSTOM_REPORT_PATH =
  'wdw-7212/Worker_Assignment_For_AP_Agent';

export interface ApAgentWorkerRow {
  workdayId: string;
  email: string;
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

export function parseApAgentWorkerReportRow(row: unknown): ApAgentWorkerRow | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const record = row as Record<string, unknown>;

  const workdayId = readField(
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
  const emailRaw = readField(
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
  if (!workdayId || !emailRaw) return undefined;

  const activeStatus = readField(
    record,
    'Active Status',
    'Active_Status',
    'activeStatus',
    'Active',
    'Is_Active',
    'Employee_Status',
  );
  if (activeStatus && isExplicitlyInactive(activeStatus)) {
    return undefined;
  }

  const terminated = readField(record, 'Terminated', 'terminated');
  if (isTerminated(terminated)) return undefined;

  const email = normalizeEmployeeEmail(emailRaw);
  if (!email.includes('@')) return undefined;

  const name = readField(record, 'Full Legal Name', 'Full_Legal_Name', 'fullLegalName');
  const employeeId = readField(record, 'Employee ID', 'Employee_ID', 'employeeId');

  return {
    workdayId,
    email,
    ...(name ? { name } : {}),
    ...(employeeId ? { employeeId } : {}),
  };
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

/** Classifies report rows for cache sync: inactive/terminated are intentional exclusions, not fetch gaps. */
export function classifyApAgentWorkerReportEntry(entry: unknown): ApAgentWorkerReportEntryDisposition {
  if (parseApAgentWorkerReportRow(entry)) {
    return 'included';
  }
  if (!entry || typeof entry !== 'object') {
    return 'unparseable';
  }
  const record = entry as Record<string, unknown>;
  const activeStatus = readField(
    record,
    'Active Status',
    'Active_Status',
    'activeStatus',
    'Active',
    'Is_Active',
    'Employee_Status',
  );
  if (activeStatus && isExplicitlyInactive(activeStatus)) {
    return 'excluded';
  }
  const terminated = readField(record, 'Terminated', 'terminated');
  if (isTerminated(terminated)) {
    return 'excluded';
  }
  const workdayId = readField(
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
  const emailRaw = readField(
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
  if (!workdayId && !emailRaw) {
    return 'unparseable';
  }
  return 'unparseable';
}
