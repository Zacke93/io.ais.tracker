module.exports = {
  testEnvironment: 'node',
  rootDir: '../',
  roots: ['<rootDir>/tests'],
  testMatch: [
    '**/integration/simple-bug-finder-tests.js',
    '**/integration/comprehensive-bug-detection-tests.js',
    '**/integration/real-log-scenario-tests.js',
    '**/integration/chaos-edge-case-tests.js',
  ],
  collectCoverageFrom: [
    'app.js',
    'drivers/**/*.js',
    '!node_modules/**',
    '!coverage/**',
    '!tests/**',
  ],
  coverageReporters: ['text', 'lcov', 'html'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
  testTimeout: 30000, // Increased for integration tests
  moduleNameMapper: {
    '^homey$': '<rootDir>/tests/__mocks__/homey.js',
  },
  // Disable old mock-based tests
  testPathIgnorePatterns: [
    '/node_modules/',
    'ultimate.test.js',
    'ultimate-v2.2.test.js',
    'ultimate-v2.3-comprehensive.test.js',
  ],
};
