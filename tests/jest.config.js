module.exports = {
  testEnvironment: 'node',
  rootDir: '../',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/__tests__/**/*.js', '**/?(*.)+(spec|test).js'],
  collectCoverageFrom: [
    'app.js',
    'drivers/**/*.js',
    '!node_modules/**',
    '!coverage/**',
    '!tests/**',
  ],
  coverageReporters: ['text', 'lcov', 'html'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
  testTimeout: 10000,
  moduleNameMapper: {
    '^homey$': '<rootDir>/tests/__mocks__/homey.js',
  },
};
