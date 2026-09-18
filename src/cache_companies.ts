import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { debug } from '@pga/logger';
import { withHandler, type ProcessingContext } from './lib/handlers.js';
import { createCompanyContent } from './lib/rag.js';
import { notifyResult } from './lib/slack.js';
import { syncDataSource } from './lib/sync.js';
import { getAllWorkdayCompanies, type WorkdayCompany } from './lib/workday.js';

async function syncCompaniesFromWorkday(context: ProcessingContext): Promise<void> {
  let companies: WorkdayCompany[];
  try {
    companies = await getAllWorkdayCompanies(context);
  } catch (error) {
    const lambdaName = process.env.AWS_LAMBDA_FUNCTION_NAME || 'cache_companies';
    await notifyResult(lambdaName, 'error', undefined, undefined, error);
    throw error;
  }

  if (companies.length === 0) {
    debug('No company data received from Workday - skipping sync');
    return;
  }

  debug(`Processing ${companies.length} companies from Get_Workday_Companies`);

  const items = new Map(
    companies.map((company) => [
      company.workdayId,
      company,
    ])
  );

  await syncDataSource({
    dbConnection: context.dbConnection,
    type: 'company',
    items,
    totalCount: companies.length,
    createContent: createCompanyContent,
    createMetadata: (company) => ({
      workdayId: company.workdayId,
      companyName: company.companyName,
      companyReferenceId: company.companyReferenceId,
      addressPrimary: company.addressPrimary,
      publicAddresses: company.publicAddresses,
      financeAgentAliases: company.financeAgentAliases,
    }),
    isUpdated: (existingMetadata: {
      companyReferenceId?: string;
      companyName?: string;
      addressPrimary?: string;
      publicAddresses?: string[];
      financeAgentAliases?: string[];
    } | undefined, company) =>
      existingMetadata?.companyReferenceId !== company.companyReferenceId
      || existingMetadata?.companyName !== company.companyName
      || existingMetadata?.addressPrimary !== company.addressPrimary
      || JSON.stringify(existingMetadata?.publicAddresses ?? null) !== JSON.stringify(company.publicAddresses ?? null)
      || JSON.stringify(existingMetadata?.financeAgentAliases ?? []) !== JSON.stringify(company.financeAgentAliases),
    notifyLabel: 'cache_companies',
    itemLabel: 'companies',
  });
}

export const processor = withHandler(async (context) => {
  await syncCompaniesFromWorkday(context);
});

export const handler = withHandler(async () => {
  const processorFunctionName = `${process.env.AWS_STACK_NAME}-CacheCompaniesProcessor`;
  debug(`Invoking ${processorFunctionName} for Get_Workday_Companies`);

  const lambda = new LambdaClient({ region: process.env.AWS_REGION });
  await lambda.send(new InvokeCommand({
    FunctionName: processorFunctionName,
    InvocationType: 'Event',
    Payload: '{}',
  }));
});
