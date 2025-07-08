// Homey is mocked via moduleNameMapping in jest.config.js

// Mock WebSocket
jest.mock('ws', () => {
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    send: jest.fn(),
    close: jest.fn(),
    readyState: 1, // OPEN
  }));
});

// Reset mocks before each test
beforeEach(() => {
  jest.clearAllMocks();
});
