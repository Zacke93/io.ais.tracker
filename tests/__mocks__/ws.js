/* eslint-disable max-classes-per-file */
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

class MockWebSocketServer extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.clients = new Set();
  }

  close(callback) {
    if (callback) callback();
  }

  handleUpgrade() {
    // Mock implementation
  }

  on(event, handler) {
    super.on(event, handler);
    // Simulate connection
    if (event === 'connection') {
      setTimeout(() => {
        const ws = new MockWebSocket('ws://mock');
        this.clients.add(ws);
        this.emit('connection', ws);
      }, 10);
    }
    return this;
  }
}

const WebSocketMock = jest.fn(() => new MockWebSocket());
WebSocketMock.Server = MockWebSocketServer;
WebSocketMock.MockWebSocket = MockWebSocket;
WebSocketMock.CONNECTING = 0;
WebSocketMock.OPEN = 1;
WebSocketMock.CLOSING = 2;
WebSocketMock.CLOSED = 3;

module.exports = WebSocketMock;
