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

export async function executeWorkdayQuery(
  config: WorkdayConfig,
  wqlQuery: string
): Promise<unknown[]> {
  const wqlUrl = `https://${config.domain}/api/wql/v1/${config.tenant}/data`;
  const url = new URL(wqlUrl);
  url.searchParams.set('query', wqlQuery);

  debug(`Executing WQL query on tenant: ${config.tenant}`);
  debug(`Query: ${wqlQuery.substring(0, 100)}...`);

  const accessToken = await getAccessToken(config);

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

  const result = await response.json() as { data?: unknown[] };
  return result.data || [];
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


