import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { debug } from '@pga/logger';
import {
  extractApAgentWorkerReportEntries,
  parseApAgentWorkerReport,
} from './lib/ap_agent_workers_report.js';
import { withHandler, type ProcessingContext } from './lib/handlers.js';
import { createEmployeeContent } from './lib/rag.js';
import { syncDataSource } from './lib/sync.js';
import { executeWorkdayCustomReport } from './lib/workday.js';

function tryGetApAgentWorkersReportPath(env: NodeJS.ProcessEnv): string | undefined {
  const reportPath = env.WORKDAY_AP_AGENT_WORKERS_REPORT_PATH?.trim();
  return reportPath || undefined;
}

async function syncEmployeesFromReport(context: ProcessingContext): Promise<void> {
  const reportPath = tryGetApAgentWorkersReportPath(process.env);
  if (!reportPath) {
    debug('WORKDAY_AP_AGENT_WORKERS_REPORT_PATH unset - skipping employee cache sync');
    return;
  }

  const payload = await executeWorkdayCustomReport(context.workdayConfig, reportPath);
  const reportEntries = extractApAgentWorkerReportEntries(payload);
  const workers = parseApAgentWorkerReport(payload);

  if (reportEntries.length === 0) {
    debug('AP agent workers report returned no entries - skipping sync without prune');
    return;
  }

  if (workers.length === 0) {
    debug('AP agent workers report had entries but none parsed - skipping sync without prune', {
      reportEntryCount: reportEntries.length,
    });
    return;
  }

  debug(`Processing ${workers.length} AP agent workers from Workday report`, {
    reportEntryCount: reportEntries.length,
  });

  const items = new Map(
    workers.map((worker) => [
      worker.workdayId,
      {
        workdayId: worker.workdayId,
        email: worker.email,
        name: worker.name,
        employeeId: worker.employeeId,
      },
    ])
  );

  const sourceTotal = reportEntries.length;
  const sourceFetchedCount = workers.length;

  await syncDataSource({
    dbConnection: context.dbConnection,
    type: 'employee',
    items,
    totalCount: workers.length,
    createContent: createEmployeeContent,
    createMetadata: (employee) => ({
      email: employee.email,
      ...(employee.name ? { name: employee.name } : {}),
      ...(employee.employeeId ? { employeeId: employee.employeeId } : {}),
    }),
    pruneAbsent: true,
    sourceTotal,
    sourceFetchedCount,
    notifyLabel: 'cache_employees',
    itemLabel: 'employees',
  });
}

export const processor = withHandler(async (context) => {
  await syncEmployeesFromReport(context);
});

export const handler = withHandler(async () => {
  const processorFunctionName = `${process.env.AWS_STACK_NAME}-CacheEmployeesProcessor`;
  debug(`Invoking ${processorFunctionName} for AP agent workers report`);

  const lambda = new LambdaClient({ region: process.env.AWS_REGION });
  await lambda.send(new InvokeCommand({
    FunctionName: processorFunctionName,
    InvocationType: 'Event',
    Payload: '{}',
  }));
});
