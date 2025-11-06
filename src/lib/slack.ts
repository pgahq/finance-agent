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

  // Build blocks array
  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: mainMessage
      }
    }
  ];

  // Add details/error as context block if present
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
