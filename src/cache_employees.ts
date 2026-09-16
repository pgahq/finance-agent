import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { debug } from '@pga/logger';
import {
  AP_AGENT_WORKERS_CUSTOM_REPORT_PATH,
  classifyApAgentWorkerReportEntry,
  extractApAgentWorkerReportEntries,
  listApAgentWorkerReportColumnNames,
  parseApAgentWorkerReport,
  sampleApAgentWorkerActiveStatusValues,
} from './lib/ap_agent_workers_report.js';
import { withHandler, type ProcessingContext } from './lib/handlers.js';
import { createEmployeeContent } from './lib/rag.js';
import { syncDataSource } from './lib/sync.js';
import { executeWorkdayCustomReport } from './lib/workday.js';

async function syncEmployeesFromReport(context: ProcessingContext): Promise<void> {
  const payload = await executeWorkdayCustomReport(
    context.workdayConfig,
    AP_AGENT_WORKERS_CUSTOM_REPORT_PATH,
  );
  const reportEntries = extractApAgentWorkerReportEntries(payload);
  const reportColumns = listApAgentWorkerReportColumnNames(reportEntries);

  debug('AP agent workers report columns', {
    reportEntryCount: reportEntries.length,
    columnCount: reportColumns.length,
    columns: reportColumns,
    activeStatusSample: sampleApAgentWorkerActiveStatusValues(reportEntries),
  });

  if (reportEntries.length === 0) {
    debug('AP agent workers report returned no entries - skipping sync without prune');
    return;
  }

  const workers = parseApAgentWorkerReport(payload);
  const dispositions = reportEntries.map(classifyApAgentWorkerReportEntry);
  const excludedEntryCount = dispositions.filter((d) => d === 'excluded').length;
  const unparseableEntryCount = dispositions.filter((d) => d === 'unparseable').length;

  if (workers.length === 0) {
    const sample = reportEntries[0];
    debug('AP agent workers report produced no parseable workers - skipping sync without prune', {
      reportEntryCount: reportEntries.length,
      excludedEntryCount,
      unparseableEntryCount,
      sampleKeys: sample && typeof sample === 'object' ? Object.keys(sample as object) : [],
      sampleRow: sample,
    });
    return;
  }

  if (unparseableEntryCount > 0) {
    debug('Ignoring unparseable AP agent worker report rows', { unparseableEntryCount });
  }

  debug(`Processing ${workers.length} AP agent workers from Workday report`, {
    reportEntryCount: reportEntries.length,
    excludedEntryCount,
    unparseableEntryCount,
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

  const sourceTotal = workers.length;
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
