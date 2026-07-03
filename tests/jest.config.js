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

  // Coverage thresholds (omkalibrerade 2026-07-03 mot faktisk mätning
  // inkl. lib/ — höjs i takt med fas 7-testerna, aldrig sänks)
  coverageThreshold: {
    global: {
      branches: 60,
      functions: 70,
      lines: 70,
      statements: 70,
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
