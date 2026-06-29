import baseConfig from './jest.config.js';

export default {
  ...baseConfig,
  testMatch: ['**/evals/run-*.test.ts'],
  testPathIgnorePatterns: [],
};
