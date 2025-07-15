const EventEmitter = require('events');

class MockWebSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 1; // OPEN
    this.CONNECTING = 0;
    this.OPEN = 1;
    this.CLOSING = 2;
    this.CLOSED = 3;
    
    // Simulate connection
    setTimeout(() => {
      this.emit('open');
    }, 10);
  }

  send(data) {
    this.lastSentData = data;
  }

  close() {
    this.readyState = 3;
    this.emit('close');
  }

  terminate() {
    this.close();
  }
}

module.exports = jest.fn(() => new MockWebSocket());
module.exports.MockWebSocket = MockWebSocket;