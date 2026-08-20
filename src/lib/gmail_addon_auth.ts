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
  options: {
    endpointUrl: string;
    serviceAccountEmail: string;
  },
): Promise<void> {
  const token = extractBearerToken(authorizationHeader);
  const endpointUrl = options.endpointUrl.trim();
  const serviceAccountEmail = options.serviceAccountEmail.trim();
  if (!token || !endpointUrl || !serviceAccountEmail) {
    throw new GmailAddonUnauthorizedError();
  }

  const client = new OAuth2Client();
  try {
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: endpointUrl,
    });
    const payload = ticket.getPayload();
    const email = payload?.email?.trim();
    if (!payload?.email_verified || email !== serviceAccountEmail) {
      throw new GmailAddonUnauthorizedError();
    }
  } catch (error) {
    if (error instanceof GmailAddonUnauthorizedError) throw error;
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
