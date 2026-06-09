import { extractBearerToken, isAuthorizedBearer } from '../lib/api_auth.js';

describe('api_auth', () => {
  describe('extractBearerToken', () => {
    it('returns null when header is undefined', () => {
      expect(extractBearerToken(undefined)).toBeNull();
    });

    it('returns null when header is malformed', () => {
      expect(extractBearerToken('Basic abc123')).toBeNull();
      expect(extractBearerToken('Bearer')).toBeNull();
      expect(extractBearerToken('Bearer   ')).toBeNull();
    });

    it('extracts token from Bearer header', () => {
      expect(extractBearerToken('Bearer secret-token')).toBe('secret-token');
      expect(extractBearerToken('bearer secret-token')).toBe('secret-token');
    });
  });

  describe('isAuthorizedBearer', () => {
    it('returns false when tokens are missing', () => {
      expect(isAuthorizedBearer('', 'expected')).toBe(false);
      expect(isAuthorizedBearer('provided', '')).toBe(false);
    });

    it('returns false when tokens differ in length', () => {
      expect(isAuthorizedBearer('short', 'longer-token')).toBe(false);
    });

    it('returns false when tokens differ', () => {
      expect(isAuthorizedBearer('token-a', 'token-b')).toBe(false);
    });

    it('returns true when tokens match', () => {
      expect(isAuthorizedBearer('secret-token', 'secret-token')).toBe(true);
    });
  });
});
