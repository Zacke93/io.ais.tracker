// Jest configuration for AIS Tracker tests
// Ensures all tests can run with proper Homey SDK mocking

module.exports = {
  // Test environment
  testEnvironment: 'node',

  // Root directories for tests (fix: already in tests directory)
  roots: ['<rootDir>'],

  // Test file patterns
  testMatch: [
    '**/*.test.js',
  ],

  // Setup files to run before tests
  setupFiles: [
    '<rootDir>/__mocks__/homey.js',
  ],

  // Coverage configuration. Fas 7-fix (2026-07-03): lib/ ingår — tidigare
  // mättes bara app.js + drivers, så alla services rapporterade 0 % och
  // trösklarna var missvisande.
  collectCoverageFrom: [
    '../app.js',
    '../lib/**/*.js',
    '../drivers/**/*.js',
    '!**/node_modules/**',
    '!**/__mocks__/**',
  ],

  // Coverage thresholds — ett GOLV som ALDRIG sänks, bara höjs.
  // Ratchet 2026-07-10 (helkodsgranskningen): uppmätt 78,8/75,3/83,7/79,5
  // (dödkod raderad + 26 nya tester) → golv strax under (marginal ~1–2 pp
  // för legitim variation). Föregående golv (2026-07-06): 75/70/80/76.
  coverageThreshold: {
    global: {
      branches: 73,
      functions: 82,
      lines: 78,
      statements: 77,
    },
  },

  // Coverage reporting
  collectCoverage: false, // Enable only when explicitly requested
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],

  // Module path mapping (fix: correct property name is moduleNameMapper)
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/../$1',
  },

  // Test timeout (important for async operations)
  testTimeout: 10000,

  // Silent mode to reduce noise during testing
  silent: false,

  // Verbose output for better debugging
  verbose: true,

  // Clear mocks between tests
  clearMocks: true,

  // Reset modules between tests
  resetModules: true,
};
