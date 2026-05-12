import { debug } from '@pga/logger';
import { withHandler } from './lib/handlers.js';
import { createPaymentTermsContent } from './lib/rag.js';
import { syncDataSource } from './lib/sync.js';
import { getAllPaymentTerms } from './lib/workday.js';

export const handler = withHandler(async (context) => {
  const paymentTerms = await getAllPaymentTerms(context);

  if (paymentTerms.length === 0) {
    debug('No payment terms returned from Workday - skipping sync');
    return;
  }

  debug(`Processing ${paymentTerms.length} payment terms from Workday`);

  const items = new Map(
    paymentTerms.map((pt) => [
      pt.paymentTermsId,
      { paymentTermsId: pt.paymentTermsId, name: pt.name }
    ])
  );

  await syncDataSource({
    dbConnection: context.dbConnection,
    type: 'payment_terms',
    items,
    totalCount: paymentTerms.length,
    createContent: createPaymentTermsContent,
    createMetadata: (pt) => ({
      paymentTermsId: pt.paymentTermsId,
      name: pt.name,
    }),
    notifyLabel: 'cache_payment_terms',
    itemLabel: 'payment terms',
  });
});
