import {
  classifyApAgentWorkerReportEntry,
  listApAgentWorkerReportColumnNames,
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

  it('lists unique column names across report rows', () => {
    expect(listApAgentWorkerReportColumnNames([
      { Workday_ID: 'a', 'Primary Work - Email': 'a@pgahq.com' },
      { Employee_ID: 'PGA1', Terminated: '' },
    ])).toEqual([
      'Employee_ID',
      'Primary Work - Email',
      'Terminated',
      'Workday_ID',
    ]);
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

  it('parses Report_Entry payloads with sandbox column names', () => {
    const rows = parseApAgentWorkerReport({
      Report_Entry: [
        {
          Workday_ID: 'abc123def456abc123def456abc123de',
          Primary_Work_-_Email: 'ap@pgahq.com',
          Active_Status: 'Yes',
          Full_Legal_Name: 'AP Agent',
          Employee_ID: 'PGA000001',
        },
      ],
    });
    expect(rows).toEqual([{
      workdayId: 'abc123def456abc123def456abc123de',
      email: 'ap@pgahq.com',
      name: 'AP Agent',
      employeeId: 'PGA000001',
    }]);
  });

  it('parses array-wrapped Workday custom report field values', () => {
    expect(parseApAgentWorkerReportRow({
      Workday_ID: ['cab0b1d2505a01c2514ea9134d2886ce'],
      Primary_Work_-_Email: ['jcarey@pgahq.com'],
      Active_Status: ['Yes'],
    })).toMatchObject({
      workdayId: 'cab0b1d2505a01c2514ea9134d2886ce',
      email: 'jcarey@pgahq.com',
    });
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
