import { debug } from '@pga/logger';
import { bulkInsertDocuments, getDocumentsByType } from './lib/database.js';
import { withProcessorHandler, withQueryHandler } from './lib/handlers.js';
import { createCompanyContent, createEmbedding } from './lib/rag.js';
import { notifyResult } from './lib/slack.js';

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
  const startTime = Date.now();

  debug('Starting incremental company sync');

  try {
    if (!companies || companies.length === 0) {
      debug('No company data received - skipping sync');
      return;
    }

    debug(`Processing ${companies.length} companies from Workday query`);

    debug('Fetching existing companies from database...');
    const existingCompanies = await getDocumentsByType(context.dbConnection, 'company');
    const existingCompanyMap = new Map(
      existingCompanies.map(c => [c.workday_id, c])
    );

    const workdayCompanyMap = new Map(
      companies.map((company: any) => [
        company.company.id,
        {
          workdayId: company.company.id,
          addressPrimary: company.addressPrimary,
          publicAddresses: company.publicAddresses?.length > 0 ? company.publicAddresses.map((pa: any) => pa.descriptor) : undefined,
          emailAddresses: company.emailAddresses?.length > 0 ? company.emailAddresses.map((ea: any) => ea.descriptor) : undefined,
          phoneNumbers: company.phoneNumbers?.length > 0 ? company.phoneNumbers.map((pn: any) => pn.descriptor) : undefined,
          companyId: company.company.id,
          companyName: company.company.descriptor,
        }
      ])
    );

    const newCompanies: string[] = [];
    const unchangedCompanies: string[] = [];

    for (const [companyId] of workdayCompanyMap) {
      const existingCompany = existingCompanyMap.get(companyId);

      if (!existingCompany) {
        newCompanies.push(companyId);
      } else {
        unchangedCompanies.push(companyId);
      }
    }

    debug(`Sync analysis: ${newCompanies.length} new, ${unchangedCompanies.length} unchanged`);

    // Process changes using bulk operations
    let successCount = 0;
    let errorCount = 0;

    if (newCompanies.length > 0) {
      debug(`Preparing ${newCompanies.length} new companies for bulk insert in batches of 50...`);

      const batchSize = 50;
      const totalBatches = Math.ceil(newCompanies.length / batchSize);

      for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
        const startIndex = batchIndex * batchSize;
        const endIndex = Math.min(startIndex + batchSize, newCompanies.length);
        const batchCompanies = newCompanies.slice(startIndex, endIndex);

        const newCompanyDocuments = [];

        for (const companyId of batchCompanies) {
          try {
            const company = workdayCompanyMap.get(companyId)!;
            const content = createCompanyContent(company);
            const metadata = {
              workdayId: company.workdayId,
              companyId: company.companyId,
              companyName: company.companyName,
            };

            const embedding = await createEmbedding(content);
            newCompanyDocuments.push({
              workdayId: company.workdayId,
              type: 'company' as const,
              content,
              metadata,
              embedding
            });
          } catch (error) {
            debug(`Error preparing company ${companyId} for insert:`, error);
            errorCount++;
          }
        }

        if (newCompanyDocuments.length > 0) {
          await bulkInsertDocuments(context.dbConnection, newCompanyDocuments);
          successCount += newCompanyDocuments.length;
        }

        debug(`Batch ${batchIndex + 1}/${totalBatches} complete: ${newCompanyDocuments.length} companies inserted (${Math.round(((batchIndex + 1) / totalBatches) * 100)}% complete)`);
      }
    }

    const processingTime = Date.now() - startTime;
    debug(`Bulk sync complete: ${successCount} operations successful, ${errorCount} errors`);
    debug(`Skipped ${unchangedCompanies.length} unchanged companies`);

    const status = errorCount > 0 ? 'error' : 'success';
    const details = {
      syncStats: {
        total: companies.length,
        new: newCompanies.length,
        unchanged: unchangedCompanies.length,
        errors: errorCount,
        processingTime
      }
    };

    await notifyResult(
      'cache_companies',
      status,
      processingTime,
      details,
      undefined,
      `${companies.length} companies`
    );

  } catch (error) {
    const processingTime = Date.now() - startTime;
    debug('Error during bulk sync operations:', error);

    await notifyResult(
      'cache_companies',
      'error',
      processingTime,
      {
        processingTime: `${processingTime}ms`
      },
      error
    );

    throw error;
  }
});
