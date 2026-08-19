import { OAuth2Client } from 'google-auth-library';
import { extractBearerToken } from './api_auth.js';

export class GmailAddonUnauthorizedError extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'GmailAddonUnauthorizedError';
  }
}

export async function verifyGmailAddonOidc(
  authorizationHeader: string | undefined,
  clientId: string,
): Promise<void> {
  const token = extractBearerToken(authorizationHeader);
  if (!token || !clientId) {
    throw new GmailAddonUnauthorizedError();
  }

  const client = new OAuth2Client(clientId);
  try {
    await client.verifyIdToken({
      idToken: token,
      audience: clientId,
    });
  } catch {
    throw new GmailAddonUnauthorizedError();
  }
}

export async function emailFromUserIdToken(
  userIdToken: string | undefined,
  clientId: string,
): Promise<string> {
  if (!userIdToken || !clientId) {
    throw new GmailAddonUnauthorizedError('user email is required');
  }
  const client = new OAuth2Client(clientId);
  try {
    const ticket = await client.verifyIdToken({
      idToken: userIdToken,
      audience: clientId,
    });
    const email = ticket.getPayload()?.email?.trim();
    if (!email) {
      throw new GmailAddonUnauthorizedError('user email is required');
    }
    return email;
  } catch (error) {
    if (error instanceof GmailAddonUnauthorizedError) throw error;
    throw new GmailAddonUnauthorizedError('user email is required');
  }
}
