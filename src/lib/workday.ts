import { debug } from '@pga/logger';
import path from 'path';
import type { 
  WorkdaySoapConfig, 
  SupplierInvoiceSoapResponse,
  PresignedAttachment,
  DownloadedAttachment
} from './types.js';

// Import strong-soap for SOAP client using dynamic import
let strong: any;
const getStrongSoap = async () => {
  if (!strong) {
    const strongSoapModule = await import('strong-soap');
    strong = strongSoapModule.soap;
  }
  return strong;
};

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

export const getWorkdaySoapConfig = (env: NodeJS.ProcessEnv): WorkdaySoapConfig => ({
  domain: env.WORKDAY_DOMAIN!,
  tenant: env.WORKDAY_TENANT!,
  username: env.WORKDAY_USER!,
  password: env.WORKDAY_PASSWORD!,
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

// SOAP API Functions
export async function getSupplierInvoiceWithAttachments(
  context: { workdaySoapConfig: WorkdaySoapConfig; s3Config: { bucketName: string } },
  workdayID: string
): Promise<{
  invoice: any;
  presignedAttachments: PresignedAttachment[];
}> {
  const username = `${context.workdaySoapConfig.username}@${context.workdaySoapConfig.tenant}`;
  const wsdlPath = path.join(process.cwd(), 'dist', 'soap', 'Resource_Management.wsdl');

  debug('Creating Workday SOAP client for invoice retrieval');
  debug(`WSDL path: ${wsdlPath}`);
  debug(`WorkdayID: ${workdayID}`);
  debug(`Username: ${username}`);
  debug(`Password length: ${context.workdaySoapConfig.password?.length || 0}`);
  debug(`Domain: ${context.workdaySoapConfig.domain}`);
  debug(`Tenant: ${context.workdaySoapConfig.tenant}`);

  // Validate required SOAP configuration
  if (!context.workdaySoapConfig.password) {
    throw new Error('Workday SOAP password is not configured. Please check WORKDAY_PASSWORD environment variable.');
  }

  // Get the strong-soap module
  const strongSoap = await getStrongSoap();
  
  // First, get the SOAP response
  const soapResponse = await new Promise<SupplierInvoiceSoapResponse>((resolve, reject) => {
    strongSoap.createClient(wsdlPath, {}, (err: any, client: any) => {
      if (err) {
        debug('Failed to create SOAP client:', err);
        return reject(err);
      }

      client.setSecurity(new strongSoap.WSSecurity(username, context.workdaySoapConfig.password, { 
        passwordType: 'PasswordText', 
        mustUnderstand: true 
      }));

      const endpoint = `https://${context.workdaySoapConfig.domain}/ccx/service/${context.workdaySoapConfig.tenant}/Resource_Management/v44.1`;
      client.setEndpoint(endpoint);

      const request = {
        Get_Supplier_Invoices_Request: {
          Request_References: {
            Supplier_Invoice_Reference: {
              ID: [{ $attributes: { type: 'WID' }, $value: workdayID }]
            }
          },
          Response_Group: {
            Include_Reference: true,
            Include_Attachment_Data: true
          }
        }
      };

      debug('Requesting Supplier Invoice with attachments from Workday:', request);
      client.Get_Supplier_Invoices(request, (err: any, result: any) => {
        if (err) {
          debug('Error from Workday SOAP (Get_Supplier_Invoices):', err);
          return reject(err);
        }
        debug('Workday SOAP response received');
        debug('Full SOAP response structure:', JSON.stringify(result, null, 2));
        resolve(result);
      });
    });
  });

  // Extract invoice data
  debug('Parsing SOAP response for invoice data');
  debug('soapResponse keys:', Object.keys(soapResponse || {}));
  debug('Response_Data:', soapResponse?.Response_Data);
  
  const supplierInvoice = soapResponse?.Response_Data?.Supplier_Invoice;
  debug('Found supplier invoice:', !!supplierInvoice);
  debug('Supplier invoice structure:', JSON.stringify(supplierInvoice, null, 2));
  
  if (!supplierInvoice) {
    throw new Error(`No invoice found for workdayID: ${workdayID}`);
  }
  
  const invoice = supplierInvoice?.Supplier_Invoice_Data || {};
  
  debug('Invoice data from SOAP', invoice);

  // Process attachments: upload to S3 and generate presigned URLs
  const presignedAttachments: PresignedAttachment[] = [];
  const attachmentData = invoice.Attachment_Data;
  
  if (attachmentData) {
    // Handle both single attachment object and array of attachments
    const attachments = Array.isArray(attachmentData) ? attachmentData : [attachmentData];
    debug(`Processing ${attachments.length} attachments for invoice`);
    
    for (let i = 0; i < attachments.length; i++) {
      const attachment = attachments[i];
      try {
        // Convert base64 content to buffer
        const buffer = Buffer.from(attachment.File_Content || '', 'base64');
        
        const downloadedAttachment: DownloadedAttachment = {
          id: `${workdayID}-${i}`,
          fileName: attachment.$attributes?.Filename || `attachment-${i}`,
          contentType: attachment.$attributes?.Content_Type || 'application/octet-stream',
          buffer,
          size: buffer.length
        };

        // Upload to S3 and get presigned URL
        const { uploadAttachmentToS3 } = await import('./s3.js');
        const presignedAttachment = await uploadAttachmentToS3(context.s3Config, downloadedAttachment, workdayID);
        presignedAttachments.push(presignedAttachment);
        debug(`Successfully processed attachment: ${downloadedAttachment.fileName}`);
        
      } catch (attachmentError) {
        debug(`Error processing attachment ${attachment.$attributes?.Filename}:`, attachmentError);
        // Continue with other attachments even if one fails
      }
    }
    
    debug(`Successfully processed ${presignedAttachments.length} attachments`);
  } else {
    debug('No attachments found for this invoice');
  }

  return {
    invoice,
    presignedAttachments
  };
}


