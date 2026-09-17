import { debug } from '@pga/logger';
import type { DatabaseConnection } from './database.js';
import { normalizeEmployeeEmail } from './ap_agent_workers_report.js';

export interface EmployeeLookupResult {
  workdayId: string;
  name?: string;
  preferredName?: string;
}

/** Preferred Name from the AP agent workers report, else Full Legal Name. */
export function employeeDisplayName(
  employee: Pick<EmployeeLookupResult, 'name' | 'preferredName'>,
): string | undefined {
  const preferredName = employee.preferredName?.trim();
  if (preferredName) return preferredName;
  const name = employee.name?.trim();
  return name || undefined;
}

export async function getEmployeeWidByEmail(
  db: DatabaseConnection,
  email: string | undefined,
): Promise<EmployeeLookupResult | undefined> {
  const normalized = email ? normalizeEmployeeEmail(email) : '';
  if (!normalized || !normalized.includes('@')) {
    return undefined;
  }

  try {
    const results = await db.query(`
      SELECT workday_id, metadata
      FROM documents
      WHERE type = 'employee'
        AND LOWER(COALESCE(metadata->>'email', '')) = $1
        AND COALESCE((metadata->>'active')::boolean, true) = true
      LIMIT 2
    `, [normalized]) as Array<{
      workday_id: string;
      metadata?: { name?: string; preferredName?: string };
    }>;

    if (results.length === 0) {
      debug('No employee cache match for assignee email', { email: normalized });
      return undefined;
    }
    if (results.length > 1) {
      debug('Duplicate employee cache rows for assignee email; omitting assignee', {
        email: normalized,
        workdayIds: results.map((row) => row.workday_id),
      });
      return undefined;
    }

    const match = results[0];
    return {
      workdayId: match.workday_id,
      ...(match.metadata?.name ? { name: match.metadata.name } : {}),
      ...(match.metadata?.preferredName ? { preferredName: match.metadata.preferredName } : {}),
    };
  } catch (error) {
    debug('Error looking up employee by email; omitting assignee', error);
    return undefined;
  }
}
