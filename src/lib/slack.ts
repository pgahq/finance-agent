import { debug } from '@pga/logger';

/**
 * Send a message to Slack using webhook
 */
async function sendSlackMessage(message: string, blocks: any[] = []): Promise<void> {
  try {
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    
    if (!webhookUrl) {
      debug('SLACK_WEBHOOK_URL environment variable not set - skipping Slack notification');
      return;
    }
    
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: message,
        blocks
      })
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
  let message = `${statusEmoji} *${lambdaName}* function ran *${statusText}* in ${timeText}`;
  
  if (context) {
    message += ` for ${context}`;
  }
  
  message += '\n';

  let blocks: any[] = [];
  if (details || error) {
    const detailsData = error ? { error, details } : details;
    const jsonString = JSON.stringify(detailsData, null, 2);
    blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `\`\`\`json\n${jsonString}\n\`\`\``
        }
      }
    ];
  }

  await sendSlackMessage(message, blocks);
}
