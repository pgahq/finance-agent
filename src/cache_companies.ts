import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { debug } from '@pga/logger';
import { getDocumentsByType } from './lib/database.js';
import { withHandler, type ProcessingContext } from './lib/handlers.js';
import { createCompanyContent } from './lib/rag.js';
import { notifyResult } from './lib/slack.js';
import { syncDataSource } from './lib/sync.js';
import { getAllWorkdayCompanies, type WorkdayCompany } from './lib/workday.js';

function companyHasFormattedAddress(company: WorkdayCompany): boolean {
  return Boolean(company.addressPrimary?.trim())
    || Boolean(company.publicAddresses?.some((value) => value.trim()));
}

function sameAliasSet(left: string[] | undefined, right: string[]): boolean {
  const normalize = (values: string[]) => (
    [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))].sort()
  );
  return JSON.stringify(normalize(left ?? [])) === JSON.stringify(normalize(right));
}

function preserveExistingAddresses(
  company: WorkdayCompany,
  existingMetadata: {
    addressPrimary?: string;
    publicAddresses?: string[];
  } | undefined
): WorkdayCompany {
  if (companyHasFormattedAddress(company) || !existingMetadata) return company;
  const addressPrimary = typeof existingMetadata.addressPrimary === 'string'
    ? existingMetadata.addressPrimary
    : undefined;
  const publicAddresses = Array.isArray(existingMetadata.publicAddresses)
    ? existingMetadata.publicAddresses.filter((value): value is string => (
      typeof value === 'string' && Boolean(value.trim())
    ))
    : undefined;
  if (!addressPrimary && (!publicAddresses || publicAddresses.length === 0)) return company;
  return {
    ...company,
    addressPrimary: addressPrimary ?? company.addressPrimary,
    publicAddresses: publicAddresses && publicAddresses.length > 0
      ? publicAddresses
      : company.publicAddresses,
  };
}

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

  const existing = await getDocumentsByType(context.dbConnection, 'company');
  const existingById = new Map(existing.map((document) => [document.workday_id, document.metadata]));
  const items = new Map(
    companies.map((company) => {
      const merged = preserveExistingAddresses(company, existingById.get(company.workdayId));
      return [merged.workdayId, merged];
    })
  );

  debug(`Processing ${items.size} companies from Get_Workday_Companies`);

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
      || !sameAliasSet(existingMetadata?.financeAgentAliases, company.financeAgentAliases),
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
