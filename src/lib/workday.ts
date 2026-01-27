import { debug } from '@pga/logger';
import path from 'path';
import { notifyResult } from './slack.js';
import type {
  DownloadedAttachment,
  PresignedAttachment,
  SupplierInvoiceSoapResponse
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

async function buildClient(
  context: { workdayConfig: WorkdayConfig }
): Promise<any> {
  const wsdlPath = path.join(process.cwd(), 'dist', 'soap', 'Resource_Management.wsdl');

  // Get OAuth access token
  const accessToken = await getAccessToken(context.workdayConfig);

  const strongSoap = await getStrongSoap();

  return new Promise((resolve, reject) => {
    strongSoap.createClient(wsdlPath, {}, (err: any, client: any) => {
      if (err) {
        debug('Failed to create SOAP client:', err);
        return reject(err);
      }

      // Use OAuth bearer token authentication
      client.setSecurity(new strongSoap.BearerSecurity(accessToken));

      const endpoint = `https://${context.workdayConfig.domain}/ccx/service/${context.workdayConfig.tenant}/Resource_Management/v44.1`;
      client.setEndpoint(endpoint);

      resolve(client);
    });
  });
}

interface WorkQueueTag {
  ID: Array<{ $attributes: { type: string }; $value: string }>;
}

interface buildSubmitInvoiceDataOptions {
  currentInvoice: any;
  supplierID?: string;
  workQueueTags?: WorkQueueTag[];
  notes?: string;
  memo?: string;
}

function buildSubmitInvoiceData(options: buildSubmitInvoiceDataOptions): any {
  const { currentInvoice, supplierID, workQueueTags, notes, memo } = options;

  const supplierRef = supplierID
    ? { ID: [{ $attributes: { type: 'Supplier_ID' }, $value: supplierID }] }
    : currentInvoice.Supplier_Reference;

  return {
    Company_Reference: currentInvoice.Company_Reference,
    Currency_Reference: currentInvoice.Currency_Reference,
    Invoice_Date: currentInvoice.Invoice_Date,

    ...(supplierRef && { Supplier_Reference: supplierRef }),

    Invoice_Number: currentInvoice.Invoice_Number,
    Control_Amount_Total: currentInvoice.Control_Amount_Total,

    ...((currentInvoice.Memo || memo) && { Memo: currentInvoice.Memo || memo }),

    ...(currentInvoice.Payment_Terms_Reference && { Payment_Terms_Reference: currentInvoice.Payment_Terms_Reference }),
    ...(currentInvoice.Due_Date_Override && { Due_Date_Override: currentInvoice.Due_Date_Override }),
    ...(currentInvoice.Default_Tax_Option_Reference && { Default_Tax_Option_Reference: currentInvoice.Default_Tax_Option_Reference }),

    ...((workQueueTags || notes) && {
      Work_Queue_Information_Data: {
        ...(workQueueTags && { Work_Queue_Tags_Reference: workQueueTags }),
        ...(notes && { Work_Queue_Notes: notes })
      }
    })
  };
}

function createWorkQueueTag(tagId: string): WorkQueueTag {
  return {
    ID: [{ $attributes: { type: 'Work_Queue_Tag_ID' }, $value: tagId }]
  };
}

export async function getSupplierInvoiceWithAttachments(
  context: { workdayConfig: WorkdayConfig; s3Config: { bucketName: string } },
  workdayID: string
): Promise<{
  invoice: any;
  presignedAttachments: PresignedAttachment[];
}> {
  debug('Creating Workday SOAP client for invoice retrieval');
  debug(`WorkdayID: ${workdayID}`);
  debug(`Domain: ${context.workdayConfig.domain}`);
  debug(`Tenant: ${context.workdayConfig.tenant}`);

  const client = await buildClient(context);

  const soapResponse = await new Promise<SupplierInvoiceSoapResponse>((resolve, reject) => {
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

    debug('Requesting Supplier Invoice with attachments from Workday');
    client.Get_Supplier_Invoices(request, (err: any, result: any) => {
      if (err) {
        debug('Error from Workday SOAP (Get_Supplier_Invoices):', err);
        return reject(err);
      }
      debug('Workday SOAP response received');
      debug('Full SOAP response:', JSON.stringify(result, null, 2));
      resolve(result);
    });
  });

  // Extract invoice data
  const supplierInvoiceArray = soapResponse?.Response_Data?.Supplier_Invoice;

  if (!supplierInvoiceArray || !Array.isArray(supplierInvoiceArray) || supplierInvoiceArray.length === 0) {
    throw new Error(`No invoice found for workdayID: ${workdayID}`);
  }

  const supplierInvoice = supplierInvoiceArray[0];

  const invoiceDataArray = supplierInvoice?.Supplier_Invoice_Data;
  const invoice = (Array.isArray(invoiceDataArray) && invoiceDataArray.length > 0)
    ? invoiceDataArray[0]
    : {};

  debug('Invoice data from SOAP', invoice);

  // Process attachments: convert PDFs to images and upload to S3
  const processedAttachments: PresignedAttachment[] = [];
  const attachmentData = invoice.Attachment_Data;

  if (attachmentData) {
    // Handle both single attachment object and array of attachments
    const attachments = Array.isArray(attachmentData) ? attachmentData : [attachmentData];

    for (let i = 0; i < attachments.length; i++) {
      const attachment = attachments[i];
      try {
        // Convert base64 content to buffer
        const buffer = Buffer.from(attachment.File_Content || '', 'base64');
        const contentType = attachment.$attributes?.Content_Type || 'application/octet-stream';
        const fileName = attachment.$attributes?.Filename || `attachment-${i}`;

        // Check if it's a PDF and convert to images
        if (contentType === 'application/pdf') {
          const { processPdfAttachment } = await import('./pdf.js');
          const processedPdf = await processPdfAttachment(buffer, fileName, workdayID, i, context.s3Config);

          // Add all converted images to processed attachments
          processedAttachments.push(...processedPdf.images);
        } else {
          // Handle non-PDF attachments (images, etc.)
          const downloadedAttachment: DownloadedAttachment = {
            id: `${workdayID}-${i}`,
            fileName: fileName,
            contentType: contentType,
            buffer: buffer,
            size: buffer.length
          };

          const { uploadAttachmentToS3 } = await import('./s3.js');
          const presignedAttachment = await uploadAttachmentToS3(context.s3Config, downloadedAttachment, workdayID);

          processedAttachments.push({
            id: presignedAttachment.id,
            fileName: fileName,
            contentType: contentType,
            presignedUrl: presignedAttachment.presignedUrl,
            expiresAt: presignedAttachment.expiresAt,
            s3Key: presignedAttachment.s3Key,
            buffer: buffer
          });
        }

      } catch (attachmentError) {
        debug(`Error processing attachment ${attachment.$attributes?.Filename}:`, attachmentError);
        // Continue with other attachments even if one fails
      }
    }

    // Consolidated attachment processing log with presigned URLs
    const attachmentSummary = processedAttachments.map(att => ({
      fileName: att.fileName,
      contentType: att.contentType,
      presignedUrl: att.presignedUrl
    }));

    debug(`Processed ${processedAttachments.length} attachments:`, attachmentSummary);
  } else {
    debug('No attachments found for this invoice');
  }

  return {
    invoice,
    presignedAttachments: processedAttachments
  };
}

// Get an invoice without attachments (just for testing/simple queries)
export async function getSupplierInvoice(
  context: { workdayConfig: WorkdayConfig },
  workdayID: string
): Promise<any> {
  debug('Fetching Supplier Invoice via SOAP (without attachments)');
  debug(`WorkdayID: ${workdayID}`);

  const client = await buildClient(context);

  const soapResponse = await new Promise<SupplierInvoiceSoapResponse>((resolve, reject) => {
    const request = {
      Get_Supplier_Invoices_Request: {
        Request_References: {
          Supplier_Invoice_Reference: {
            ID: [{ $attributes: { type: 'WID' }, $value: workdayID }]
          }
        },
        Response_Group: {
          Include_Reference: true,
          Include_Attachment_Data: false
        }
      }
    };

    debug('Requesting Supplier Invoice from Workday');
    client.Get_Supplier_Invoices(request, (err: any, result: any) => {
      if (err) {
        debug('Error from Workday SOAP (Get_Supplier_Invoices):', err);
        return reject(err);
      }
      debug('Workday SOAP response received');
      resolve(result);
    });
  });

  const supplierInvoiceRaw = soapResponse?.Response_Data?.Supplier_Invoice;

  if (!supplierInvoiceRaw) {
    throw new Error(`No invoice found for workdayID: ${workdayID}`);
  }

  const supplierInvoice = Array.isArray(supplierInvoiceRaw)
    ? supplierInvoiceRaw[0]
    : supplierInvoiceRaw;

  const invoiceDataRaw = supplierInvoice?.Supplier_Invoice_Data;

  const invoice = Array.isArray(invoiceDataRaw)
    ? (invoiceDataRaw.length > 0 ? invoiceDataRaw[0] : {})
    : (invoiceDataRaw || {});

  debug('Invoice data from SOAP', invoice);

  return invoice;
}

export async function updateSupplierInvoiceSupplier(
  context: { workdayConfig: WorkdayConfig },
  invoiceWorkdayID: string,
  supplierID: string,
  notes?: string,
  memo?: string | undefined
): Promise<{ success: boolean; message?: string }> {
  const startTime = Date.now();

  debug('Updating Supplier Invoice supplier via SOAP');
  debug(`Invoice WorkdayID: ${invoiceWorkdayID}`);
  debug(`Supplier ID: ${supplierID}`);

  try {
    debug('Fetching current invoice data');
    const currentInvoice = await getSupplierInvoice(context, invoiceWorkdayID);

    if (!currentInvoice) {
      throw new Error(`No invoice found for workdayID: ${invoiceWorkdayID}`);
    }

    debug('Current invoice data retrieved - has required fields:', {
      hasCompanyReference: !!currentInvoice.Company_Reference,
      hasCurrencyReference: !!currentInvoice.Currency_Reference,
      hasInvoiceDate: !!currentInvoice.Invoice_Date,
      hasInvoiceNumber: !!currentInvoice.Invoice_Number,
      hasControlAmount: !!currentInvoice.Control_Amount_Total
    });

    const client = await buildClient(context);

    const agentModifiedTagID = process.env.WORKDAY_AGENT_MODIFIED_TAG_WID;
    const workQueueTags = agentModifiedTagID ? [createWorkQueueTag(agentModifiedTagID)] : undefined;

    if (agentModifiedTagID) {
      debug(`Adding agent-modified work queue tag: ${agentModifiedTagID}`);
    }

    const invoiceData = buildSubmitInvoiceData({
      currentInvoice,
      supplierID,
      workQueueTags,
      notes,
      memo
    });

    const updateResponse = await new Promise<any>((resolve, reject) => {
      const request = {
        Submit_Supplier_Invoice_Request: {
          Supplier_Invoice_Reference: {
            ID: [{ $attributes: { type: 'WID' }, $value: invoiceWorkdayID }]
          },
          Supplier_Invoice_Data: invoiceData
        }
      };

      debug('Submitting updated Supplier Invoice to Workday');
      client.Submit_Supplier_Invoice(request, (err: any, result: any) => {
        if (err) {
          debug('Error from Workday SOAP (Submit_Supplier_Invoice):', err);
          return reject(err);
        }
        debug('Workday SOAP update response received');
        resolve(result);
      });
    });

    debug('Supplier invoice updated successfully', updateResponse);

    const processingTime = Date.now() - startTime;

    await notifyResult(
      'update_supplier_invoice',
      'success',
      processingTime,
      {
        invoiceWorkdayID,
        supplierID,
        invoiceNumber: currentInvoice.Invoice_Number
      },
      undefined,
      `invoice: \`${currentInvoice.Invoice_Number || invoiceWorkdayID}\``
    );

    return {
      success: true,
      message: `Successfully updated invoice ${invoiceWorkdayID} with supplier ${supplierID}`
    };
  } catch (error) {
    const processingTime = Date.now() - startTime;

    await notifyResult(
      'update_supplier_invoice',
      'error',
      processingTime,
      {
        invoiceWorkdayID,
        supplierID
      },
      error,
      `invoice: \`${invoiceWorkdayID}\``
    );

    throw error;
  }
}

export async function addNoSupplierTagToInvoice(
  context: { workdayConfig: WorkdayConfig },
  invoiceWorkdayID: string,
  notes?: string,
  memo?: string | undefined
): Promise<{ success: boolean; message?: string }> {
  const startTime = Date.now();

  debug('Adding no-supplier work queue tag to invoice via SOAP');
  debug(`Invoice WorkdayID: ${invoiceWorkdayID}`);

  try {
    const noSupplierTagID = process.env.WORKDAY_AGENT_NO_SUPPLIER_TAG_WID;
    const defaultSupplierID = process.env.WORKDAY_DEFAULT_SUPPLIER_ID;

    if (!noSupplierTagID) {
      throw new Error('WORKDAY_AGENT_NO_SUPPLIER_TAG_WID environment variable is not set');
    }

    if (!defaultSupplierID) {
      throw new Error('WORKDAY_DEFAULT_SUPPLIER_ID environment variable is not set');
    }

    debug('Fetching current invoice data');
    const currentInvoice = await getSupplierInvoice(context, invoiceWorkdayID);

    if (!currentInvoice) {
      throw new Error(`No invoice found for workdayID: ${invoiceWorkdayID}`);
    }

    debug('Current invoice data retrieved for no-supplier tag:', JSON.stringify(currentInvoice, null, 2));

    const client = await buildClient(context);

    const workQueueTags = [createWorkQueueTag(noSupplierTagID)];

    debug(`Adding no-supplier work queue tag: ${noSupplierTagID}`);
    debug(`Using default supplier ID: ${defaultSupplierID}`);

    const invoiceData = buildSubmitInvoiceData({
      currentInvoice,
      supplierID: defaultSupplierID,
      workQueueTags,
      notes,
      memo
    });

    const updateResponse = await new Promise<any>((resolve, reject) => {
      const request = {
        Submit_Supplier_Invoice_Request: {
          Supplier_Invoice_Reference: {
            ID: [{ $attributes: { type: 'WID' }, $value: invoiceWorkdayID }]
          },
          Supplier_Invoice_Data: invoiceData
        }
      };

      debug('SOAP Request object for no-supplier tag:', JSON.stringify(request, null, 2));
      debug('Submitting updated Supplier Invoice to Workday with no-supplier tag');
      client.Submit_Supplier_Invoice(request, (err: any, result: any) => {
        if (err) {
          debug('Error from Workday SOAP (Submit_Supplier_Invoice):', err);
          if (client.lastRequest) {
            debug('Last SOAP Request XML:', client.lastRequest);
          }
          return reject(err);
        }
        debug('Workday SOAP update response received');
        resolve(result);
      });
    });

    debug('No-supplier tag added successfully', updateResponse);

    const processingTime = Date.now() - startTime;

    await notifyResult(
      'add_no_supplier_tag',
      'success',
      processingTime,
      {
        invoiceWorkdayID,
        invoiceNumber: currentInvoice.Invoice_Number,
        tagAdded: 'no-supplier'
      },
      undefined,
      `invoice: \`${currentInvoice.Invoice_Number || invoiceWorkdayID}\``
    );

    return {
      success: true,
      message: `Successfully added no-supplier tag to invoice ${invoiceWorkdayID}`
    };
  } catch (error) {
    const processingTime = Date.now() - startTime;

    await notifyResult(
      'add_no_supplier_tag',
      'error',
      processingTime,
      {
        invoiceWorkdayID
      },
      error,
      `invoice: \`${invoiceWorkdayID}\``
    );

    throw error;
  }
}

export async function updateVerifySupplierInvoiceData(
  context: { workdayConfig: WorkdayConfig },
  invoiceWorkdayID: string,
  notes?: string,
  memo?: string | undefined
): Promise<{ success: boolean; message?: string }> {
  const startTime = Date.now();

  debug('Updating Supplier Invoice data (notes/memo) via SOAP');
  debug(`Invoice WorkdayID: ${invoiceWorkdayID}`);

  try {
    debug('Fetching current invoice data');
    const currentInvoice = await getSupplierInvoice(context, invoiceWorkdayID);

    if (!currentInvoice) {
      throw new Error(`No invoice found for workdayID: ${invoiceWorkdayID}`);
    }

    debug('Current invoice data retrieved for update');

    const client = await buildClient(context);

    const agentModifiedTagID = process.env.WORKDAY_AGENT_MODIFIED_TAG_WID;
    const workQueueTags = agentModifiedTagID ? [createWorkQueueTag(agentModifiedTagID)] : undefined;

    if (agentModifiedTagID) {
      debug(`Adding agent-modified work queue tag: ${agentModifiedTagID}`);
    }

    const invoiceData = buildSubmitInvoiceData({
      currentInvoice,
      workQueueTags,
      notes,
      memo
    });

    const updateResponse = await new Promise<any>((resolve, reject) => {
      const request = {
        Submit_Supplier_Invoice_Request: {
          Supplier_Invoice_Reference: {
            ID: [{ $attributes: { type: 'WID' }, $value: invoiceWorkdayID }]
          },
          Supplier_Invoice_Data: invoiceData
        }
      };

      debug('Submitting updated Supplier Invoice to Workday');
      client.Submit_Supplier_Invoice(request, (err: any, result: any) => {
        if (err) {
          debug('Error from Workday SOAP (Submit_Supplier_Invoice):', err);
          return reject(err);
        }
        debug('Workday SOAP update response received');
        resolve(result);
      });
    });

    debug('Supplier invoice data updated successfully', updateResponse);

    const processingTime = Date.now() - startTime;

    await notifyResult(
      'update_supplier_invoice_data',
      'success',
      processingTime,
      {
        invoiceWorkdayID,
        invoiceNumber: currentInvoice.Invoice_Number,
        hasNotes: !!notes,
        hasMemo: !!memo
      },
      undefined,
      `invoice: \`${currentInvoice.Invoice_Number || invoiceWorkdayID}\``
    );

    return {
      success: true,
      message: `Successfully updated invoice ${invoiceWorkdayID} with notes/memo`
    };
  } catch (error) {
    const processingTime = Date.now() - startTime;

    await notifyResult(
      'update_supplier_invoice_data',
      'error',
      processingTime,
      {
        invoiceWorkdayID
      },
      error,
      `invoice: \`${invoiceWorkdayID}\``
    );

    throw error;
  }
}


