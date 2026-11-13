const esmOnlyPackages = ['ai', '@ai-sdk', '@vercel/oidc', '@workflow/serde', 'eventsource-parser', 'zod'];

export default {
  preset: 'ts-jest/presets/default-esm',
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      useESM: true,
    }],
    // ai@7 and its dependencies ship ESM only; Jest runs in CommonJS mode, so compile them.
    [`^.+/node_modules/(${esmOnlyPackages.join('|')})/.+\\.js$`]: ['ts-jest', {
      useESM: true,
      diagnostics: false,
      tsconfig: {
        allowJs: true,
        module: 'commonjs',
        target: 'ES2022',
        esModuleInterop: true,
        skipLibCheck: true,
      },
    }],
  },
  transformIgnorePatterns: [`/node_modules/(?!(${esmOnlyPackages.join('|')})/)`],
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/jest.setup.ts'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/globals.d.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
