/**
 * Names the replay removes from its own environment, so a developer shell that happens to hold Workday, Slack, or Intercom
 * credentials cannot leak them into a run. The replay needs none of them.
 */
export const REPLAY_SCRUBBED_ENV = [
  'WORKDAY_CLIENT_ID',
  'WORKDAY_CLIENT_SECRET',
  'WORKDAY_REFRESH_TOKEN',
  'SLACK_WEBHOOK_URL',
  'AUDIT_SLACK_BOT_TOKEN',
  'AUDIT_SLACK_CHANNEL_ID',
  'INTERCOM_ACCESS_TOKEN',
  'ENRICH_INVOICE_API_TOKEN',
  'INVOICE_ATTACHMENT_CLUSTERING_ENABLED',
] as const;

export const REPLAY_REQUIRED_ENV = ['AI_GATEWAY_API_KEY', 'DATABASE_SECRET_ARN', 'DATABASE_CLUSTER_ENDPOINT'] as const;

/**
 * Prepares `env` for a replay and returns what is missing. Must run before the pipeline modules are imported, because
 * they read some of these values once at load.
 */
export function prepareReplayEnv(env: NodeJS.ProcessEnv): { missing: string[] } {
  for (const name of REPLAY_SCRUBBED_ENV) delete env[name];
  env.INVOICE_MOD_ENABLED = 'true';
  env.WORKDAY_DOMAIN = 'replay.invalid';
  env.WORKDAY_TENANT = 'replay';
  env.LOG_LEVEL ??= 'INFO';
  return { missing: REPLAY_REQUIRED_ENV.filter((name) => !env[name]) };
}
