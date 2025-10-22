/**
 * Simple utility for resolving action names to Lambda function ARNs
 */

/**
 * Get the action map from environment variable
 */
function getActionMap(): Record<string, string> {
  try {
    return JSON.parse(process.env.ACTION_FUNCTION_MAP || '{}');
  } catch (error) {
    throw new Error(`Failed to parse ACTION_FUNCTION_MAP: ${error}`);
  }
}

/**
 * Get the Lambda function ARN for an action
 */
export function getFunctionArn(action: string): string {
  const actionMap = getActionMap();
  const functionArn = actionMap[action];
  
  if (!functionArn) {
    const validActions = Object.keys(actionMap);
    throw new Error(`Invalid action: ${action}. Valid actions: ${validActions.join(', ')}`);
  }
  
  return functionArn;
}

/**
 * Check if an action is valid
 */
export function isValidAction(action: string): boolean {
  const actionMap = getActionMap();
  return action in actionMap;
}

/**
 * Get all valid action names
 */
export function getValidActions(): string[] {
  const actionMap = getActionMap();
  return Object.keys(actionMap);
}
