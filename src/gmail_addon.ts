import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import loadEnv from '@pga/lambda-env';
import { debug } from '@pga/logger';
import { z } from 'zod';
import { emailFromUserIdToken, GmailAddonUnauthorizedError, verifyGmailAddonOidc } from './lib/gmail_addon_auth.js';
import { supplierInvoiceAddonCopy } from './lib/gmail_addon_copy.js';
import {
  getAddonEnvironment,
  getGmailConfig,
  getSupplierInvoiceLabelState,
  type AddonEnvironment,
  type SupplierInvoiceLabelState,
} from './lib/gmail.js';
import { formatError, jsonResponse, readRequestBody } from './lib/http_api.js';
import { runCreateInvoiceFromGmail } from './trigger_create_invoice_gmail.js';

const addonEventSchema = z.object({
  authorizationEventObject: z.object({
    userIdToken: z.string().optional(),
    userOAuthToken: z.string().optional(),
  }).optional(),
  commonEventObject: z.object({
    parameters: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
  gmail: z.object({
    messageId: z.string().optional(),
  }).optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

type AddonAction = 'create' | 'confirm' | 'createAgain' | 'cancel';

interface ActionParameter {
  key: string;
  value: string;
}

interface AddonButton {
  text: string;
  onClick: {
    action: {
      function: string;
      parameters: ActionParameter[];
      loadIndicator?: 'SPINNER';
    };
  };
}

type AddonWidget =
  | { textParagraph: { text: string } }
  | { buttonList: { buttons: AddonButton[] } };

interface AddonCard {
  header: {
    title: string;
    subtitle?: string;
  };
  sections: Array<{ widgets: AddonWidget[] }>;
}

interface AddonRenderResponse {
  action: {
    notification?: { text: string };
    navigations: Array<{ pushCard: AddonCard } | { updateCard: AddonCard }>;
  };
}

function addonUrlFromEvent(event: APIGatewayProxyEventV2): string {
  if (process.env.GMAIL_ADDON_URL) {
    return process.env.GMAIL_ADDON_URL.replace(/\/+$/, '');
  }
  const domain = event.requestContext?.domainName;
  if (!domain) {
    return '';
  }
  const path = (event.rawPath || '/gmail-addon').replace(/\/+$/, '') || '/gmail-addon';
  return `https://${domain}${path.startsWith('/') ? path : `/${path}`}`;
}

function authorizationHeader(event: APIGatewayProxyEventV2): string | undefined {
  return event.headers?.authorization ?? event.headers?.Authorization;
}

function addonJsonResponse(body: AddonRenderResponse): APIGatewayProxyResultV2 {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function parseAddonAction(value: string | undefined): AddonAction | undefined {
  if (value === 'create' || value === 'confirm' || value === 'createAgain' || value === 'cancel') {
    return value;
  }
  return undefined;
}

function parameterString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].trim()) {
    return value[0].trim();
  }
  return undefined;
}

function addonActionFromEvent(parsed: z.infer<typeof addonEventSchema>): AddonAction | undefined {
  const raw = parsed.commonEventObject?.parameters?.addonAction ?? parsed.parameters?.addonAction;
  return parseAddonAction(parameterString(raw));
}

function gmailMessageIdFromEvent(parsed: z.infer<typeof addonEventSchema>): string {
  return parsed.gmail?.messageId?.trim()
    || parameterString(parsed.commonEventObject?.parameters?.gmailMessageId)
    || parameterString(parsed.parameters?.gmailMessageId)
    || '';
}

function triggerStatusCode(result: APIGatewayProxyResultV2): number {
  if (typeof result === 'object' && result && 'statusCode' in result && typeof result.statusCode === 'number') {
    return result.statusCode;
  }
  return 200;
}

function triggerMessage(result: APIGatewayProxyResultV2): string | undefined {
  if (typeof result !== 'object' || !result || !('body' in result) || typeof result.body !== 'string') {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(result.body);
    if (typeof parsed === 'object' && parsed && 'message' in parsed && typeof parsed.message === 'string') {
      return parsed.message;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function cardHeader(copy: ReturnType<typeof supplierInvoiceAddonCopy>): AddonCard['header'] {
  return copy.cardSubtitle
    ? { title: copy.cardTitle, subtitle: copy.cardSubtitle }
    : { title: copy.cardTitle };
}

function actionButton(
  addonUrl: string,
  text: string,
  action: AddonAction,
  options: { spinner?: boolean; gmailMessageId?: string } = {},
): AddonButton {
  const parameters: ActionParameter[] = [{ key: 'addonAction', value: action }];
  if (options.gmailMessageId) {
    parameters.push({ key: 'gmailMessageId', value: options.gmailMessageId });
  }
  return {
    text,
    onClick: {
      action: {
        function: addonUrl,
        parameters,
        ...(options.spinner ? { loadIndicator: 'SPINNER' as const } : {}),
      },
    },
  };
}

function homepageCard(environment: AddonEnvironment): AddonCard {
  const copy = supplierInvoiceAddonCopy(environment);
  return {
    header: cardHeader(copy),
    sections: [{
      widgets: [{ textParagraph: { text: copy.openAMessage } }],
    }],
  };
}

function confirmationCard(
  environment: AddonEnvironment,
  addonUrl: string,
  gmailMessageId: string,
): AddonCard {
  const copy = supplierInvoiceAddonCopy(environment);
  return {
    header: cardHeader(copy),
    sections: [{
      widgets: [
        { textParagraph: { text: copy.confirmTitle } },
        { textParagraph: { text: copy.confirmBody } },
        {
          buttonList: {
            buttons: [
              actionButton(addonUrl, copy.confirmButton, 'createAgain', {
                spinner: true,
                gmailMessageId,
              }),
              actionButton(addonUrl, copy.cancelButton, 'cancel', { gmailMessageId }),
            ],
          },
        },
      ],
    }],
  };
}

function statusCard(
  environment: AddonEnvironment,
  addonUrl: string,
  labelState: SupplierInvoiceLabelState | null,
  extraText?: string,
  gmailMessageId?: string,
): AddonCard {
  const copy = supplierInvoiceAddonCopy(environment);
  const widgets: AddonWidget[] = [
    { textParagraph: { text: copy.status[labelState ?? 'idle'] } },
  ];
  if (extraText) {
    widgets.push({ textParagraph: { text: extraText } });
  }
  if (addonUrl) {
    const buttons: AddonButton[] = labelState
      ? [actionButton(addonUrl, copy.createAgainButton, 'confirm', { gmailMessageId })]
      : [actionButton(addonUrl, copy.createButton, 'create', { spinner: true, gmailMessageId })];
    widgets.push({ buttonList: { buttons } });
  }
  return {
    header: cardHeader(copy),
    sections: [{ widgets }],
  };
}

function renderCard(
  card: AddonCard,
  options: { update: boolean; notification?: string },
): AddonRenderResponse {
  return {
    action: {
      ...(options.notification ? { notification: { text: options.notification } } : {}),
      navigations: [
        options.update ? { updateCard: card } : { pushCard: card },
      ],
    },
  };
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  debug('Gmail add-on request received');
  process.env = await loadEnv();

  const clientId = process.env.GMAIL_ADDON_OAUTH_CLIENT_ID ?? '';
  const serviceAccountEmail = process.env.GMAIL_ADDON_SERVICE_ACCOUNT_EMAIL ?? '';
  const addonUrl = addonUrlFromEvent(event);
  try {
    await verifyGmailAddonOidc(authorizationHeader(event), {
      endpointUrl: addonUrl,
      serviceAccountEmail,
    });
  } catch (error) {
    if (error instanceof GmailAddonUnauthorizedError) {
      debug('Unauthorized Gmail add-on OIDC token', {
        hasAuthorizationHeader: Boolean(authorizationHeader(event)),
        hasClientId: Boolean(clientId),
        hasServiceAccountEmail: Boolean(serviceAccountEmail),
        hasEndpointUrl: Boolean(addonUrl),
      });
      return jsonResponse(401, { status: 'error', message: 'Unauthorized' });
    }
    debug('Unexpected Gmail add-on auth error', { error: formatError(error) });
    return jsonResponse(500, { status: 'error', message: 'Internal server error' });
  }

  const environment = getAddonEnvironment(process.env);
  const copy = supplierInvoiceAddonCopy(environment);

  let parsedBody: z.infer<typeof addonEventSchema>;
  try {
    const rawBody = readRequestBody(event);
    parsedBody = addonEventSchema.parse(rawBody ? JSON.parse(rawBody) as unknown : {});
  } catch (error) {
    debug('Invalid Gmail add-on event', { error: formatError(error) });
    return addonJsonResponse(renderCard(homepageCard(environment), { update: false }));
  }

  const addonAction = addonActionFromEvent(parsedBody);
  const gmailMessageId = gmailMessageIdFromEvent(parsedBody);
  if (!gmailMessageId) {
    debug('Gmail add-on request has no message id', { addonAction: addonAction ?? 'open' });
    return addonJsonResponse(renderCard(homepageCard(environment), { update: Boolean(addonAction) }));
  }

  let userEmail: string;
  try {
    userEmail = await emailFromUserIdToken(
      parsedBody.authorizationEventObject?.userIdToken,
      clientId,
    );
  } catch (error) {
    if (error instanceof GmailAddonUnauthorizedError) {
      return jsonResponse(401, { status: 'error', message: 'Unauthorized' });
    }
    debug('Unexpected Gmail add-on user token error', { error: formatError(error) });
    return jsonResponse(500, { status: 'error', message: 'Internal server error' });
  }

  const gmailAccessToken = parsedBody.authorizationEventObject?.userOAuthToken?.trim() ?? '';
  debug('Gmail add-on request', {
    addonAction: addonAction ?? 'open',
    hasMessageId: true,
    hasUserOAuthToken: Boolean(gmailAccessToken),
  });
  if (!gmailAccessToken) {
    debug('Gmail add-on event is missing userOAuthToken');
    return addonJsonResponse(renderCard(
      statusCard(environment, addonUrl, null, copy.gmailAccessDenied, gmailMessageId),
      { update: Boolean(addonAction) },
    ));
  }

  if (addonAction === 'confirm') {
    return addonJsonResponse(renderCard(confirmationCard(environment, addonUrl, gmailMessageId), { update: true }));
  }

  if (addonAction === 'create' || addonAction === 'createAgain') {
    const force = addonAction === 'createAgain';
    const result = await runCreateInvoiceFromGmail({
      gmailMessageId,
      userEmail,
      force,
      gmailAccessToken,
    });
    const statusCode = triggerStatusCode(result);
    debug('Gmail add-on create result', { gmailMessageId, statusCode, force });
    if (statusCode === 202) {
      return addonJsonResponse(renderCard(
        statusCard(environment, addonUrl, 'processing', undefined, gmailMessageId),
        { update: true, notification: copy.startedToast },
      ));
    }
    let labelState: SupplierInvoiceLabelState | null = null;
    try {
      const gmailConfig = await getGmailConfig(process.env, userEmail, gmailAccessToken);
      labelState = await getSupplierInvoiceLabelState(gmailConfig, gmailMessageId);
    } catch (error) {
      debug('Failed to read Gmail labels after trigger', {
        gmailMessageId,
        error: formatError(error),
      });
    }
    return addonJsonResponse(renderCard(
      statusCard(environment, addonUrl, labelState, triggerMessage(result), gmailMessageId),
      { update: true },
    ));
  }

  let labelState: SupplierInvoiceLabelState | null = null;
  try {
    const gmailConfig = await getGmailConfig(process.env, userEmail, gmailAccessToken);
    labelState = await getSupplierInvoiceLabelState(gmailConfig, gmailMessageId);
  } catch (error) {
    debug('Failed to read Gmail labels for add-on card', {
      gmailMessageId,
      error: formatError(error),
    });
    return addonJsonResponse(renderCard(
      statusCard(environment, addonUrl, null, 'Unable to read this message in Gmail.', gmailMessageId),
      { update: false },
    ));
  }

  return addonJsonResponse(renderCard(
    statusCard(environment, addonUrl, labelState, undefined, gmailMessageId),
    { update: addonAction === 'cancel' },
  ));
}
