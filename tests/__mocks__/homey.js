module.exports = {
  App: class MockApp {
    constructor() {
      this.homey = {
        settings: {
          get: jest.fn(),
          set: jest.fn(),
          on: jest.fn(),
        },
        flow: {
          getTriggerCard: jest.fn(() => ({
            registerRunListener: jest.fn(),
            trigger: jest.fn().mockResolvedValue(true),
          })),
          getConditionCard: jest.fn(() => ({
            registerRunListener: jest.fn(),
          })),
          createToken: jest.fn(() => ({
            setValue: jest.fn().mockResolvedValue(true),
          })),
          getToken: jest.fn(() => ({
            setValue: jest.fn().mockResolvedValue(true),
          })),
        },
        setInterval: jest.fn(setInterval),
        setTimeout: jest.fn(setTimeout),
        clearTimeout: jest.fn(clearTimeout),
      };
    }

    log(...args) {
      // Optionally log during tests
      // console.log(...args);
    }

    error(...args) {
      console.error(...args);
    }
  },
};
