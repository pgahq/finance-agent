import { debug } from '@pga/logger';

export interface WorkdayConfig {
  apiUrl: string;
  tenant: string;
  user: string;
  password: string;
}

export const getWorkdayConfig = (env: NodeJS.ProcessEnv): WorkdayConfig => ({
  apiUrl: env.WORKDAY_API_URL!,
  tenant: env.WORKDAY_TENANT!,
  user: env.WORKDAY_USER!,
  password: env.WORKDAY_PASSWORD!,
});

export async function executeWorkdayQuery(
  config: WorkdayConfig,
  wqlQuery: string
): Promise<unknown[]> {
  const url = new URL(`/api/wql/v1/${config.tenant}/data`, config.apiUrl);
  url.searchParams.set('query', wqlQuery);

  debug(`Executing WQL query on tenant: ${config.tenant}`);
  debug(`Query: ${wqlQuery.substring(0, 100)}...`);

  const authString = Buffer.from(`${config.user}@${config.tenant}:${config.password}`).toString('base64');

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'Authorization': `Basic ${authString}`,
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Workday API error: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const result = await response.json() as { data?: unknown[] };
  return result.data || [];
}

