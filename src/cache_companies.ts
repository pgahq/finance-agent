import { debug } from '@pga/logger';
import { withProcessorHandler, withQueryHandler } from './lib/handlers.js';
import { createCompanyContent } from './lib/rag.js';
import { syncDataSource } from './lib/sync.js';

const QUERY = `
  SELECT
    company,
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
        addressPrimary: company.addressPrimary,
        publicAddresses: company.publicAddresses?.length > 0 ? company.publicAddresses.map((pa: any) => pa.descriptor) : undefined,
        emailAddresses: company.emailAddresses?.length > 0 ? company.emailAddresses.map((ea: any) => ea.descriptor) : undefined,
        phoneNumbers: company.phoneNumbers?.length > 0 ? company.phoneNumbers.map((pn: any) => pn.descriptor) : undefined,
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
    }),
    notifyLabel: 'cache_companies',
    itemLabel: 'companies',
  });
});
