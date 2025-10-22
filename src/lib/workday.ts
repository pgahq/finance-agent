import { debug } from '@pga/logger';

export interface WorkdayConfig {
  domain: string;
  tenant: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export const getWorkdayConfig = (env: NodeJS.ProcessEnv): WorkdayConfig => ({
  domain: env.WORKDAY_DOMAIN!,
  tenant: env.WORKDAY_TENANT!,
  clientId: env.WORKDAY_CLIENT_ID!,
  clientSecret: env.WORKDAY_CLIENT_SECRET!,
  refreshToken: env.WORKDAY_REFRESH_TOKEN!,
});

const generateAuthToken = ({ clientId, clientSecret }: { clientId: string; clientSecret: string }): string => {
  return Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
};

const getAccessToken = async (config: WorkdayConfig): Promise<string> => {
  const authToken = generateAuthToken({ clientId: config.clientId, clientSecret: config.clientSecret });
  const headers = { Authorization: `Basic ${authToken}` };

  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('refresh_token', config.refreshToken);

  const tokenUrl = `https://${config.domain}/ccx/oauth2/${config.tenant}/token`;
  
  debug('Requesting access token using refresh token grant');
  
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers,
    body: params
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to get access token: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const tokenResponse = await response.json() as { access_token?: string };
  const accessToken = tokenResponse.access_token;
  
  if (!accessToken) {
    throw new Error('Unable to generate bearer token!');
  }

  debug('Successfully obtained access token');
  return accessToken;
};

async function fetchWorkdayPage(
  config: WorkdayConfig,
  accessToken: string,
  wqlQuery: string,
  limit: number,
  offset: number
): Promise<{ total?: number; data?: unknown[] }> {
  const wqlUrl = `https://${config.domain}/api/wql/v1/${config.tenant}/data`;
  const url = new URL(wqlUrl);
  url.searchParams.set('query', wqlQuery);
  url.searchParams.set('limit', limit.toString());
  url.searchParams.set('offset', offset.toString());

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Workday API error: ${response.status} ${response.statusText} - ${errorText}`);
  }

  return response.json() as { total?: number; data?: unknown[] };
}

async function fetchRemainingPages(
  config: WorkdayConfig,
  accessToken: string,
  wqlQuery: string,
  totalCount: number,
  initialData: unknown[]
): Promise<unknown[]> {
  const maxLimit = 10000;
  const remainingCount = totalCount - initialData.length;
  
  if (remainingCount <= 0) {
    return [];
  }

  const additionalPages = Math.ceil(remainingCount / maxLimit);
  debug(`Fetching ${additionalPages} additional pages to get remaining ${remainingCount} records`);

  const pageRequests = [];
  for (let page = 0; page < additionalPages; page++) {
    const offset = maxLimit + (page * maxLimit);
    const limit = Math.min(maxLimit, totalCount - offset);
    
    const pageRequest = fetchWorkdayPage(config, accessToken, wqlQuery, limit, offset);
    pageRequests.push(pageRequest);
  }

  const pageResults = await Promise.all(pageRequests);
  
  // Combine all data from additional pages
  const additionalData: unknown[] = [];
  for (const pageResult of pageResults) {
    if (pageResult.data && Array.isArray(pageResult.data)) {
      additionalData.push(...pageResult.data);
    }
  }

  return additionalData;
}

export async function executeWorkdayQuery(
  config: WorkdayConfig,
  wqlQuery: string
): Promise<{ total?: number; data?: unknown[] }> {
  debug(`Executing WQL query on tenant: ${config.tenant}`);
  debug(`Query: ${wqlQuery}`);

  const accessToken = await getAccessToken(config);

  // Start with max limit to get as much as possible in one request
  const initialResult = await fetchWorkdayPage(config, accessToken, wqlQuery, 10000, 0);
  const totalCount = initialResult.total || 0;
  const initialData = initialResult.data || [];
  
  debug(`Total records available: ${totalCount}, got ${initialData.length} in initial request`);

  // If we got all records in the initial request, return it
  if (totalCount <= 10000) {
    return initialResult;
  }

  // Fetch remaining pages in parallel
  const additionalData = await fetchRemainingPages(config, accessToken, wqlQuery, totalCount, initialData);
  
  // Combine all data
  const allData = [...initialData, ...additionalData];
  
  debug(`Successfully fetched ${allData.length} records total`);

  return {
    total: totalCount,
    data: allData
  };
}

export async function getAttachmentContent(_config: WorkdayConfig, attachments: any[]): Promise<any[]> {
  if (!attachments || attachments.length === 0) {
    return [];
  }

  // For now, return attachment metadata
  // TODO: Implement actual base64 content retrieval via RaaS or SOAP API
  // This would require using the Bearer token for authentication
  return attachments.map(attachment => ({
    id: attachment.id,
    fileName: attachment.fileName,
    contentType: attachment.contentType,
    // Note: Base64 content would need to be retrieved via separate API call
    // This requires either RaaS report or SOAP API integration
  }));
}


