import {
  classifyApAgentWorkerReportEntry,
  normalizeEmployeeEmail,
  parseApAgentWorkerReport,
  parseApAgentWorkerReportRow,
} from '../lib/ap_agent_workers_report.js';
import { resolveCustomActionStarterEmail } from '../lib/intercom.js';

describe('ap_agent_workers_report', () => {
  it('parses a report row with standard column names', () => {
    expect(parseApAgentWorkerReportRow({
      'Workday ID': 'cab0b1d2505a01c2514ea9134d2886ce',
      'Primary Work - Email': 'jcarey@pgahq.com',
      'Full Legal Name': 'Joseph A Carey Jr.',
      'Employee ID': 'PGA000001',
      'Active Status': 'Yes',
      Terminated: '',
    })).toEqual({
      workdayId: 'cab0b1d2505a01c2514ea9134d2886ce',
      email: 'jcarey@pgahq.com',
      name: 'Joseph A Carey Jr.',
      employeeId: 'PGA000001',
    });
  });

  it('classifies inactive rows as intentional exclusions', () => {
    expect(classifyApAgentWorkerReportEntry({
      'Workday ID': 'wid-inactive',
      'Primary Work - Email': 'inactive@pgahq.com',
      'Active Status': 'No',
    })).toBe('excluded');
    expect(classifyApAgentWorkerReportEntry({
      'Active Status': 'Yes',
    })).toBe('unparseable');
  });

  it('skips inactive and terminated rows', () => {
    expect(parseApAgentWorkerReportRow({
      'Workday ID': 'wid-inactive',
      'Primary Work - Email': 'inactive@pgahq.com',
      'Active Status': 'No',
    })).toBeUndefined();

    expect(parseApAgentWorkerReportRow({
      'Workday ID': 'wid-terminated',
      'Primary Work - Email': 'terminated@pgahq.com',
      'Active Status': 'Yes',
      Terminated: 'Yes',
    })).toBeUndefined();
  });

  it('parses numeric and boolean active status values', () => {
    expect(parseApAgentWorkerReportRow({
      Workday_ID: 'wid-1',
      Primary_Work_Email: 'one@pgahq.com',
      Active_Status: 1,
    })).toEqual({
      workdayId: 'wid-1',
      email: 'one@pgahq.com',
    });

    expect(parseApAgentWorkerReportRow({
      Workday_ID: 'wid-2',
      Primary_Work_Email: 'two@pgahq.com',
      Active: true,
    })).toEqual({
      workdayId: 'wid-2',
      email: 'two@pgahq.com',
    });
  });

  it('includes rows when active status is absent or not a known inactive value', () => {
    expect(parseApAgentWorkerReportRow({
      Workday_ID: 'wid-leave',
      Primary_Work_Email: 'leave@pgahq.com',
      Active_Status: 'On Leave',
    })).toEqual({
      workdayId: 'wid-leave',
      email: 'leave@pgahq.com',
    });
  });

  it('parses work email and WID from nonstandard column names', () => {
    expect(parseApAgentWorkerReportRow({
      CF_LRV_Worker_WID: 'cab0b1d2505a01c2514ea9134d2886ce',
      businessEmail: 'ap@pgahq.com',
    })).toEqual({
      workdayId: 'cab0b1d2505a01c2514ea9134d2886ce',
      email: 'ap@pgahq.com',
    });
  });

  it('parses Report_Entry payloads', () => {
    const rows = parseApAgentWorkerReport({
      Report_Entry: [
        {
          Workday_ID: 'abc123',
          'Primary_Work_-_Email': 'ap@pgahq.com',
          Active_Status: 'Yes',
        },
      ],
    });
    expect(rows).toEqual([{
      workdayId: 'abc123',
      email: 'ap@pgahq.com',
    }]);
  });

  it('normalizes email for lookup', () => {
    expect(normalizeEmployeeEmail('  Joe@PGAHQ.com ')).toBe('joe@pgahq.com');
  });
});

describe('resolveCustomActionStarterEmail', () => {
  it('uses the last custom_action_started author email regardless of author type', () => {
    const email = resolveCustomActionStarterEmail({
      conversation_parts: {
        conversation_parts: [
          {
            part_type: 'custom_action_started',
            author: { email: 'first@pgahq.com', type: 'admin' },
          },
          {
            part_type: 'comment',
            author: { email: 'noise@pgahq.com' },
          },
          {
            part_type: 'custom_action_started',
            author: { email: 'jcarey@pgahq.com', type: 'bot' },
          },
        ],
      },
    });
    expect(email).toBe('jcarey@pgahq.com');
  });

  it('returns undefined when no custom_action_started part has an email', () => {
    expect(resolveCustomActionStarterEmail({
      conversation_parts: {
        conversation_parts: [{ part_type: 'comment', author: { email: 'a@b.com' } }],
      },
    })).toBeUndefined();
  });
});
