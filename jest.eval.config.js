import baseConfig from './jest.config.js';

export default {
  ...baseConfig,
  testMatch: ['**/evals/run-evals.test.ts'],
  testPathIgnorePatterns: [],
  verbose: true,
};
