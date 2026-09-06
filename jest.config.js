module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  setupFiles: ['<rootDir>/src/__tests__/support/env.ts'],
  // Suites share one Redis DB and flush it between cases, so they must not interleave.
  maxWorkers: 1,
  testTimeout: 30000,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/__tests__/**',
    // Process bootstrap and a migration CLI: exercised by running them, which
    // the CI workflow does, not by unit tests.
    '!src/index.ts',
    '!src/scripts/migrate.ts',
    // Exported SQL and Lua string constants. Their behaviour is covered through
    // the code that executes them; counting the lines of a template literal
    // measures nothing.
    '!src/database/schema.ts',
  ],
  // Set just under what the suite currently achieves, so a regression trips the
  // build without the threshold needing an edit on every green change.
  coverageThreshold: {
    global: { branches: 68, functions: 78, lines: 78, statements: 78 },
  },
};
