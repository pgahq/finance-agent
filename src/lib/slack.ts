import { debug } from '@pga/logger';

// TypeScript types for Slack blocks
interface SlackTextElement {
  type: 'mrkdwn' | 'plain_text';
  text: string;
}

interface SlackSectionBlock {
  type: 'section';
  text: SlackTextElement;
}

interface SlackContextBlock {
  type: 'context';
  elements: SlackTextElement[];
}

interface SlackDividerBlock {
  type: 'divider';
}

type SlackBlock = SlackSectionBlock | SlackContextBlock | SlackDividerBlock;

const SLACK_SECTION_TEXT_LIMIT = 2900;

function truncateSlackText(text: string, limit = SLACK_SECTION_TEXT_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

function appendErrorBlocks(blocks: SlackBlock[], error: any, details?: any): void {
  const errorMessage = typeof error?.message === 'string' && error.message.trim()
    ? error.message.trim()
    : 'Unknown error';
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: truncateSlackText(`*Error*\n${errorMessage}`) }
  });

  const priorFailures = Array.isArray(error?.priorFailures) ? error.priorFailures : [];
  appendPriorFailureBlocks(blocks, priorFailures);

  const slackDetails = errorDetailsForSlack(details);
  if (slackDetails) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: truncateSlackText(`\`\`\`${JSON.stringify(slackDetails, null, 2)}\`\`\``)
        }
      ]
    });
  }
}

function errorDetailsForSlack(details: unknown): Record<string, unknown> | undefined {
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return undefined;
  }

  const { conversationUrl: _conversationUrl, ...rest } = details as Record<string, unknown>;
  if (Object.keys(rest).length === 0) {
    return undefined;
  }

  return rest;
}

function appendPriorFailureBlocks(
  blocks: SlackBlock[],
  priorFailures: Array<{ attempt?: number; fallback?: string; message?: string }>
): void {
  if (priorFailures.length === 0) return;
  const lines = priorFailures.map((failure) => {
    const fallback = failure.fallback ? ` (${failure.fallback})` : '';
    return `• Attempt ${failure.attempt ?? '?'}${fallback}: ${failure.message ?? ''}`.trim();
  });
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: truncateSlackText(`*Prior submit failures*\n${lines.join('\n')}`) }
  });
}

function appendCreateInvoiceSuccessBlocks(blocks: SlackBlock[], details: Record<string, unknown>): void {
  const changeLines: string[] = [];
  const fallbackLines: string[] = [];

  if (typeof details.invoiceNumber === 'string' && details.invoiceNumber) {
    changeLines.push(`*Workday Invoice* → \`${details.invoiceNumber}\``);
  }
  const supplier = details.supplier as { status?: string; resolvedName?: string; isDefault?: boolean } | undefined;
  if (supplier?.isDefault) {
    fallbackLines.push('Default supplier — no match found in Workday');
  } else if (supplier?.resolvedName) {
    const how = supplier.status === 'found' ? 'identified' : (supplier.status ?? 'set');
    changeLines.push(`*Supplier* → ${supplier.resolvedName} (${how})`);
  }

  const company = details.company as {
    appliedFrom?: string;
    appliedName?: string;
  } | undefined;
  if (company?.appliedName) {
    const from = company.appliedFrom === 'recommended' ? 'recommended'
      : company.appliedFrom === 'po' ? 'from PO'
      : company.appliedFrom === 'email' ? 'from email coding'
      : company.appliedFrom === 'default' ? 'default'
      : (company.appliedFrom ?? 'set');
    changeLines.push(`*Company* → ${company.appliedName} (${from})`);
  }

  const extracted = details.extracted as {
    invoiceDate?: string;
    amountDue?: string;
    suppliersInvoiceNumber?: string;
    freightAmount?: string;
    purchaseOrderNumber?: string;
    paymentTerms?: string;
  } | undefined;
  if (extracted?.invoiceDate) changeLines.push(`*Invoice Date* → ${extracted.invoiceDate}`);
  if (extracted?.amountDue) changeLines.push(`*Amount Due* → ${extracted.amountDue}`);
  if (extracted?.suppliersInvoiceNumber) changeLines.push(`*Supplier Invoice #* → ${extracted.suppliersInvoiceNumber}`);
  if (extracted?.freightAmount) changeLines.push(`*Freight* → ${extracted.freightAmount}`);
  if (extracted?.purchaseOrderNumber) changeLines.push(`*PO #* → ${extracted.purchaseOrderNumber}`);
  if (extracted?.paymentTerms) changeLines.push(`*Payment Terms* → ${extracted.paymentTerms}`);

  const appliedFallbacks = Array.isArray(details.appliedFallbacks)
    ? details.appliedFallbacks.filter((label): label is string => typeof label === 'string')
    : [];
  fallbackLines.push(...appliedFallbacks);

  if (changeLines.length) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: truncateSlackText(`*Changes*\n${changeLines.map((line) => `• ${line}`).join('\n')}`) }
    });
  }
  if (fallbackLines.length) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: truncateSlackText(`*Fallbacks Applied*\n${fallbackLines.map((line) => `• ${line}`).join('\n')}`) }
    });
  }

  const priorFailures = Array.isArray(details.priorFailures) ? details.priorFailures : [];
  appendPriorFailureBlocks(
    blocks,
    priorFailures as Array<{ attempt?: number; fallback?: string; message?: string }>
  );

  const attachment = details.attachment as { fileName?: string } | undefined;
  const slackDetails: Record<string, unknown> = {
    ...(typeof details.invoiceNumber === 'string' ? { invoiceNumber: details.invoiceNumber } : {}),
    ...(typeof details.invoiceWID === 'string' ? { invoiceWID: details.invoiceWID } : {}),
    ...(attachment?.fileName ? { fileName: attachment.fileName } : {}),
    ...(typeof details.conversationId === 'string' ? { conversationId: details.conversationId } : {}),
    ...(typeof details.lineCount === 'number' ? { lineCount: details.lineCount } : {}),
  };
  if (Object.keys(slackDetails).length > 0) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: truncateSlackText(`\`\`\`${JSON.stringify(slackDetails, null, 2)}\`\`\``)
        }
      ]
    });
  }
}

function appendNotificationLinks(blocks: SlackBlock[], conversationUrl?: string): void {
  const links: string[] = [];
  if (conversationUrl) {
    links.push(`<${conversationUrl}|View Intercom conversation>`);
  }
  const logUrl = buildCloudWatchLogUrl();
  if (logUrl) {
    links.push(`<${logUrl}|View CloudWatch logs>`);
  }
  if (links.length === 0) return;

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: links.join(' · ') }]
  });
}

function buildCloudWatchLogUrl(): string | undefined {
  const region = process.env.AWS_REGION;
  const logGroup = process.env.AWS_LAMBDA_LOG_GROUP_NAME;
  const logStream = process.env.AWS_LAMBDA_LOG_STREAM_NAME;
  if (!region || !logGroup || !logStream) return undefined;

  // CloudWatch console deep-links use double-percent-encoding with $ instead of %
  const encode = (s: string) => encodeURIComponent(encodeURIComponent(s)).replace(/%/g, '$');

  return `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#logsV2:log-groups/log-group/${encode(logGroup)}/log-events/${encode(logStream)}`;
}

/**
 * Send a message to Slack using blocks
 */
async function sendSlackMessage(blocks: SlackBlock[]): Promise<void> {
  try {
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;

    if (!webhookUrl) {
      debug('SLACK_WEBHOOK_URL environment variable not set - skipping Slack notification');
      return;
    }

    // Create fallback text from the first section block for notifications
    const fallbackText = blocks.length > 0 && blocks[0].type === 'section'
      ? blocks[0].text.text.replace(/\*([^*]+)\*/g, '$1') // Remove markdown formatting
      : 'Slack notification';

    const payload = {
      text: fallbackText, // Fallback for notifications
      blocks
    };

    debug('Slack webhook payload:', JSON.stringify(payload, null, 2));

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Slack webhook request failed: ${response.status} ${response.statusText}`);
    }

    debug('Slack notification sent successfully');
  } catch (error) {
    debug('Error sending Slack notification:', error);
    // Don't throw - we don't want Slack failures to break the main process
  }
}

/**
 * Send notification for any Lambda operation result
 */
export async function notifyResult(
  lambdaName: string,
  status: 'success' | 'error',
  processingTime?: number,
  details?: any,
  error?: any,
  context?: string
): Promise<void> {
  const statusEmoji = status === 'success' ? '✅' : '🚨';
  const statusText = status === 'success' ? 'successfully' : 'with error';

  // Format processing time
  const timeText = processingTime ? `${(processingTime / 1000).toFixed(2)}s` : 'unknown time';

  const createdInvoiceNumber = lambdaName === 'create_invoice' && status === 'success'
    && typeof details?.invoiceNumber === 'string'
    && details.invoiceNumber
    ? details.invoiceNumber
    : undefined;

  // Build the main message
  let mainMessage = createdInvoiceNumber
    ? `${statusEmoji} *${lambdaName}* created \`${createdInvoiceNumber}\` in ${timeText}`
    : `${statusEmoji} *${lambdaName}* function ran *${statusText}* in ${timeText}`;

  if (context) {
    mainMessage += ` for ${context}`;
  }

  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: mainMessage
      }
    }
  ];

  if (error) {
    appendErrorBlocks(blocks, error, details);
  } else if (lambdaName === 'create_invoice' && details && typeof details === 'object') {
    appendCreateInvoiceSuccessBlocks(blocks, details as Record<string, unknown>);
  } else if (details) {
    const jsonString = JSON.stringify(details, null, 2);
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: truncateSlackText(`\`\`\`${jsonString}\`\`\``)
        }
      ]
    });
  }

  appendNotificationLinks(
    blocks,
    typeof details?.conversationUrl === 'string' ? details.conversationUrl : undefined
  );

  await sendSlackMessage(blocks);
}

export interface EnrichmentNotification {
  processingTime: number;
  invoiceNumber: string;
  canModify: boolean;
  supplier: {
    status: string;
    resolvedName?: string;
    existingName?: string;
    isDefault: boolean;
  };
  company?: {
    status: string;
    existingName?: string;
    recommendedName?: string;
    appliedFromEmail?: boolean;
    appliedName?: string;
    appliedReferenceId?: string;
  };
  extracted: {
    invoiceDate?: string;
    amountDue?: string;
    suppliersInvoiceNumber?: string;
    freightAmount?: string;
    purchaseOrderNumber?: string;
    paymentTerms?: string;
  };
  poLineCount?: number;
  suggestedCostCenters?: Array<{ code?: string | null; name: string }>;
  priorFailures?: Array<{ attempt: number; fallback?: string; message: string }>;
  fallbacks: {
    defaultSupplier: boolean;
    fallbackFund?: string;
    fallbackCostCenter?: string;
    fallbackLineOfBusiness?: string;
    fallbackPaymentTerms?: boolean;
  };
}

export async function notifyEnrichmentResult(notification: EnrichmentNotification): Promise<void> {
  const { processingTime, invoiceNumber, canModify, supplier, company, extracted, poLineCount, suggestedCostCenters, priorFailures, fallbacks } = notification;

  const timeText = `${(processingTime / 1000).toFixed(2)}s`;
  const blocks: SlackBlock[] = [];

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `✅ *enrich_invoice* processed \`${invoiceNumber}\` in ${timeText}` }
  });

  const changeLines: string[] = [];
  const verifiedLines: string[] = [];
  const fallbackLines: string[] = [];

  if (invoiceNumber && invoiceNumber !== 'Unknown') {
    changeLines.push(`*Workday Invoice* → \`${invoiceNumber}\``);
  }

  // Supplier
  switch (supplier.status) {
    case 'found':
      changeLines.push(`*Supplier* → ${supplier.resolvedName ?? 'Unknown'} (identified)`);
      break;
    case 'different':
      changeLines.push(`*Supplier* → ${supplier.resolvedName ?? 'Unknown'} (was: ${supplier.existingName ?? 'previous supplier'})`);
      break;
    case 'matching':
      verifiedLines.push(`*Supplier* · ${supplier.resolvedName ?? supplier.existingName ?? 'Unknown'} (matching)`);
      break;
    default:
      if (!fallbacks.defaultSupplier) changeLines.push(`*Supplier* · ${supplier.status}`);
  }

  if (company?.appliedFromEmail) {
    const label = company.appliedName ?? company.appliedReferenceId ?? 'Unknown';
    const code = company.appliedReferenceId ? ` (\`${company.appliedReferenceId}\`)` : '';
    changeLines.push(`*Company* → ${label}${code} from email coding`);
  } else {
    switch (company?.status) {
      case 'different':
        changeLines.push(`*Company* → ${company.recommendedName ?? 'Unknown'} (was: ${company.existingName ?? 'previous company'})`);
        break;
      case 'matching':
        verifiedLines.push(`*Company* · ${company.existingName ?? 'Unknown'} (matching)`);
        break;
      case 'uncertain':
        verifiedLines.push(`*Company* · uncertain`);
        break;
    }
  }

  if (extracted.invoiceDate) changeLines.push(`*Invoice Date* → ${extracted.invoiceDate}`);
  if (extracted.amountDue) changeLines.push(`*Amount Due* → ${extracted.amountDue}`);
  if (extracted.suppliersInvoiceNumber) changeLines.push(`*Supplier Invoice #* → ${extracted.suppliersInvoiceNumber}`);
  if (extracted.freightAmount) changeLines.push(`*Freight* → ${extracted.freightAmount}`);
  if (extracted.purchaseOrderNumber) {
    const lineSuffix = poLineCount !== undefined ? ` · ${poLineCount} line${poLineCount !== 1 ? 's' : ''} from PO` : '';
    changeLines.push(`*PO #* → ${extracted.purchaseOrderNumber}${lineSuffix}`);
  }
  if (extracted.paymentTerms) changeLines.push(`*Payment Terms* → ${extracted.paymentTerms}`);
  if (suggestedCostCenters?.length) {
    const formatted = suggestedCostCenters.map(cc => cc.code ? `${cc.name} (${cc.code})` : cc.name).join(', ');
    changeLines.push(`*Cost Center* → ${formatted}`);
  }

  if (canModify && fallbacks.defaultSupplier) {
    fallbackLines.push(`Default supplier — no match found in Workday`);
  }
  if (canModify && fallbacks.fallbackFund) {
    fallbackLines.push(`Fallback fund applied to lines: \`${fallbacks.fallbackFund}\``);
  }
  if (canModify && fallbacks.fallbackCostCenter) {
    fallbackLines.push(`Fallback cost center applied to lines: \`${fallbacks.fallbackCostCenter}\``);
  }
  if (canModify && fallbacks.fallbackLineOfBusiness) {
    fallbackLines.push(`Fallback line of business applied to lines: \`${fallbacks.fallbackLineOfBusiness}\``);
  }
  if (canModify && fallbacks.fallbackPaymentTerms) {
    fallbackLines.push(`Fallback payment terms applied`);
  }

  if (!canModify) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `_Invoice modification disabled — notes only_` }
    });
    const analysisLines = [...changeLines, ...verifiedLines];
    if (analysisLines.length) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*Analysis*\n${analysisLines.map(l => `• ${l}`).join('\n')}` }
      });
    }
  } else {
    if (changeLines.length) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*Changes*\n${changeLines.map(l => `• ${l}`).join('\n')}` }
      });
    }
    if (verifiedLines.length) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*Verified*\n${verifiedLines.map(l => `• ${l}`).join('\n')}` }
      });
    }
  }

  if (fallbackLines.length) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Fallbacks Applied*\n${fallbackLines.map(l => `• ${l}`).join('\n')}` }
    });
  }

  if (priorFailures?.length) {
    const lines = priorFailures.map((failure) => {
      const fallback = failure.fallback ? ` (${failure.fallback})` : '';
      return `• Attempt ${failure.attempt}${fallback}: ${failure.message}`;
    });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: truncateSlackText(`*Prior submit failures*\n${lines.join('\n')}`) }
    });
  }

  appendNotificationLinks(blocks);

  await sendSlackMessage(blocks);
}
