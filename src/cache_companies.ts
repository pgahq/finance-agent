import { debug } from '@pga/logger';
import { withProcessorHandler, withQueryHandler } from './lib/handlers.js';
import { createCompanyContent } from './lib/rag.js';
import { syncDataSource } from './lib/sync.js';
import { extractCompanyReferenceId, textFromWqlValue } from './lib/workday_reference_id.js';

function wqlDescriptors(values: unknown[] | undefined): string[] | undefined {
  if (!values?.length) return undefined;
  const descriptors = values
    .map((value) => textFromWqlValue(value))
    .filter((value): value is string => Boolean(value));
  return descriptors.length > 0 ? descriptors : undefined;
}

export const QUERY = `
  SELECT
    company,
    referenceID1,
    addressPrimary,
    publicAddresses,
    emailAddresses,
    phoneNumbers
  FROM companies
`;

export const handler = withQueryHandler(QUERY)({
  processorFunctionName: `${process.env.AWS_STACK_NAME}-CacheCompaniesProcessor`,
  pageSize: null
});

export const processor = withProcessorHandler(async (context, companies, _event) => {
  if (!companies || companies.length === 0) {
    debug('No company data received - skipping sync');
    return;
  }

  debug(`Processing ${companies.length} companies from Workday query`);

  const items = new Map(
    companies.map((company: any) => [
      company.company.id,
      {
        workdayId: company.company.id,
        companyName: company.company.descriptor,
        companyReferenceId: extractCompanyReferenceId(
          [company.referenceID1],
          { workdayId: company.company.id, companyName: company.company.descriptor }
        ),
        addressPrimary: textFromWqlValue(company.addressPrimary),
        publicAddresses: wqlDescriptors(company.publicAddresses),
        emailAddresses: wqlDescriptors(company.emailAddresses),
        phoneNumbers: wqlDescriptors(company.phoneNumbers),
      }
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
    }),
    isUpdated: (existingMetadata, company) =>
      existingMetadata?.companyReferenceId !== company.companyReferenceId
      || existingMetadata?.companyName !== company.companyName
      || existingMetadata?.addressPrimary !== company.addressPrimary
      || JSON.stringify(existingMetadata?.publicAddresses ?? null) !== JSON.stringify(company.publicAddresses ?? null),
    notifyLabel: 'cache_companies',
    itemLabel: 'companies',
  });
});
