import { debug } from '@pga/logger';
import type { DatabaseConnection } from './database.js';
import { normalizeEmployeeEmail } from './ap_agent_workers_report.js';

export interface EmployeeLookupResult {
  workdayId: string;
  name?: string;
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
    `, [normalized]) as Array<{ workday_id: string; metadata?: { name?: string } }>;

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
    };
  } catch (error) {
    debug('Error looking up employee by email; omitting assignee', error);
    return undefined;
  }
}
