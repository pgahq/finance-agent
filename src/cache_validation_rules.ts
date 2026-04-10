import { debug } from '@pga/logger';
import { withHandler } from './lib/handlers.js';
import { putJsonToS3 } from './lib/s3.js';
import { getCustomValidationRules } from './lib/workday.js';
import { notifyResult } from './lib/slack.js';

export const VALIDATION_RULES_S3_KEY = 'validation-rules/supplier-invoice.json';

export const handler = withHandler(async (context) => {
  const startTime = Date.now();

  debug('Fetching custom validation rules from Workday Financial Management');
  const rules = await getCustomValidationRules(context);
  debug(`Parsed ${rules.length} Supplier Invoice validation rules`);

  await putJsonToS3(context.s3Config, VALIDATION_RULES_S3_KEY, rules);
  debug(`Stored ${rules.length} rules to S3 at ${VALIDATION_RULES_S3_KEY}`);

  await notifyResult(
    'cache_validation_rules',
    'success',
    Date.now() - startTime,
    { ruleCount: rules.length },
    undefined,
    `${rules.length} supplier invoice validation rules`
  );
});
