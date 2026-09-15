import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { debug } from '@pga/logger';
import { parseApAgentWorkerReport } from './lib/ap_agent_workers_report.js';
import { withHandler, type ProcessingContext } from './lib/handlers.js';
import { createEmployeeContent } from './lib/rag.js';
import { syncDataSource } from './lib/sync.js';
import { executeWorkdayCustomReport, getApAgentWorkersReportPath } from './lib/workday.js';

async function syncEmployeesFromReport(context: ProcessingContext): Promise<void> {
  const reportPath = getApAgentWorkersReportPath(process.env);
  const payload = await executeWorkdayCustomReport(context.workdayConfig, reportPath);
  const workers = parseApAgentWorkerReport(payload);

  if (workers.length === 0) {
    debug('No AP agent worker rows parsed from report - skipping sync');
    return;
  }

  debug(`Processing ${workers.length} AP agent workers from Workday report`);

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

  const sourceFetchedCount = workers.length;

  await syncDataSource({
    dbConnection: context.dbConnection,
    type: 'employee',
    items,
    totalCount: sourceFetchedCount,
    createContent: createEmployeeContent,
    createMetadata: (employee) => ({
      email: employee.email,
      ...(employee.name ? { name: employee.name } : {}),
      ...(employee.employeeId ? { employeeId: employee.employeeId } : {}),
    }),
    pruneAbsent: true,
    sourceTotal: sourceFetchedCount,
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
