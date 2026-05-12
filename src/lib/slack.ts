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

  // Build the main message
  let mainMessage = `${statusEmoji} *${lambdaName}* function ran *${statusText}* in ${timeText}`;

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

  if (details || error) {
    let detailsData;
    if (error) {
      // Safely serialize error object to avoid circular references
      const safeError = {
        name: error.name,
        message: error.message,
        stack: error.stack,
        code: error.code,
        statusCode: error.statusCode,
        $metadata: error.$metadata
      };
      detailsData = { error: safeError, details };
    } else {
      detailsData = details;
    }

    const jsonString = JSON.stringify(detailsData, null, 2);
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `\`\`\`${jsonString}\`\`\``
        }
      ]
    });
  }

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
  fallbacks: {
    defaultSupplier: boolean;
    fallbackFund?: string;
    fallbackCostCenter?: string;
  };
}

export async function notifyEnrichmentResult(notification: EnrichmentNotification): Promise<void> {
  const { processingTime, invoiceNumber, canModify, supplier, company, extracted, poLineCount, suggestedCostCenters, fallbacks } = notification;

  const timeText = `${(processingTime / 1000).toFixed(2)}s`;
  const blocks: SlackBlock[] = [];

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `✅ *enrich_invoice* processed \`${invoiceNumber}\` in ${timeText}` }
  });

  const changeLines: string[] = [];
  const verifiedLines: string[] = [];
  const fallbackLines: string[] = [];

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

  await sendSlackMessage(blocks);
}
