import { emailFromUserIdToken, verifyGmailAddonOidc } from '../lib/gmail_addon_auth.js';

const mockVerifyIdToken = jest.fn();

jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({
    verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args),
  })),
}));

describe('gmail add-on OIDC', () => {
  beforeEach(() => {
    mockVerifyIdToken.mockReset();
  });

  it('verifies the Authorization header against the endpoint URL and add-on service account', async () => {
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({
        email: 'addon@gserviceaccount.com',
        email_verified: true,
      }),
    });

    await verifyGmailAddonOidc('Bearer system-token', {
      endpointUrl: 'https://example.execute-api.us-east-1.amazonaws.com/gmail-addon',
      serviceAccountEmail: 'addon@gserviceaccount.com',
    });

    expect(mockVerifyIdToken).toHaveBeenCalledWith({
      idToken: 'system-token',
      audience: 'https://example.execute-api.us-east-1.amazonaws.com/gmail-addon',
    });
  });

  it('rejects a system token whose audience check or service account does not match', async () => {
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({
        email: 'someone-else@gserviceaccount.com',
        email_verified: true,
      }),
    });

    await expect(verifyGmailAddonOidc('Bearer system-token', {
      endpointUrl: 'https://example.execute-api.us-east-1.amazonaws.com/gmail-addon',
      serviceAccountEmail: 'addon@gserviceaccount.com',
    })).rejects.toThrow('Unauthorized');
  });

  it('reads the user email from the user ID token using the OAuth client id audience', async () => {
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({ email: 'jcarey@pgahq.com' }),
    });

    await expect(emailFromUserIdToken('user-token', 'oauth-client-id.apps.googleusercontent.com'))
      .resolves.toBe('jcarey@pgahq.com');
    expect(mockVerifyIdToken).toHaveBeenCalledWith({
      idToken: 'user-token',
      audience: 'oauth-client-id.apps.googleusercontent.com',
    });
  });
});
