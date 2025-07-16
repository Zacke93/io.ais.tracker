/**
 * WebSocket Mock Helper for AIS Bridge Tests
 * 
 * Provides a simple and reliable WebSocket mock that captures
 * event handlers and allows easy simulation of AIS messages.
 */

class MockWebSocket {
  constructor() {
    this.readyState = 1; // OPEN
    this.OPEN = 1;
    this.CLOSED = 3;
    this.CONNECTING = 0;
    this.CLOSING = 2;
    
    // Store event handlers
    this.eventHandlers = {
      open: [],
      message: [],
      close: [],
      error: []
    };
    
    // Mock functions
    this.send = jest.fn();
    this.close = jest.fn(() => {
      this.readyState = this.CLOSED;
    });
  }
  
  on(event, handler) {
    if (this.eventHandlers[event]) {
      this.eventHandlers[event].push(handler);
    }
    return this;
  }
  
  // Simulate events
  simulateOpen() {
    this.eventHandlers.open.forEach(handler => handler());
  }
  
  simulateMessage(data) {
    const messageData = typeof data === 'string' ? data : JSON.stringify(data);
    this.eventHandlers.message.forEach(handler => handler(messageData));
  }
  
  simulateClose(code = 1000, reason = 'Normal closure') {
    this.readyState = this.CLOSED;
    this.eventHandlers.close.forEach(handler => handler({ code, reason }));
  }
  
  simulateError(error) {
    this.eventHandlers.error.forEach(handler => handler(error));
  }
  
  // Helper to send AIS position report
  sendAISPosition(vessel) {
    const aisMessage = {
      MessageID: 'PositionReport',
      MetaData: { 
        time_utc: new Date().toISOString(),
        source: 'test'
      },
      Message: {
        PositionReport: {
          Cog: vessel.heading || vessel.cog || 0,
          CommunicationState: '0',
          Latitude: vessel.lat || vessel.latitude,
          Longitude: vessel.lon || vessel.longitude,
          MessageID: 'PositionReport',
          NavigationalStatus: vessel.navStatus || 'UnderWayUsingEngine',
          PositionAccuracy: true,
          RateOfTurn: vessel.rateOfTurn || 0,
          RepeatIndicator: 'DoNotRepeat',
          Sog: vessel.speed || vessel.sog || 0,
          Spare: false,
          SpecialManoeuvreIndicator: 'NotEngaged',
          Timestamp: 0,
          TrueHeading: vessel.heading || vessel.cog || 0,
          UserID: vessel.mmsi,
          Valid: true
        }
      }
    };
    
    // Also send static data if name is provided
    if (vessel.name) {
      this.sendAISStaticData(vessel);
    }
    
    this.simulateMessage(aisMessage);
  }
  
  // Helper to send AIS static data
  sendAISStaticData(vessel) {
    const staticMessage = {
      MessageID: 'ShipStaticData',
      MetaData: {
        time_utc: new Date().toISOString(),
        source: 'test'
      },
      Message: {
        ShipStaticData: {
          AisVersion: 0,
          CallSign: vessel.callSign || 'TEST',
          Destination: vessel.destination || '',
          Dimension: {
            A: 10,
            B: 10,
            C: 5,
            D: 5
          },
          Dte: false,
          Eta: {
            Day: 0,
            Hour: 24,
            Minute: 60,
            Month: 0
          },
          FixType: 1,
          ImoNumber: vessel.imo || 0,
          MaximumPresentStaticDraught: vessel.draught || 5.0,
          MessageID: 'ShipStaticData',
          Name: vessel.name,
          RepeatIndicator: 'DoNotRepeat',
          Type: vessel.shipType || 70,
          UserID: vessel.mmsi,
          Valid: true
        }
      }
    };
    
    this.simulateMessage(staticMessage);
  }
}

// Create a factory function that returns a new mock instance
function createMockWebSocket() {
  return new MockWebSocket();
}

// Export both the class and factory
module.exports = {
  MockWebSocket,
  createMockWebSocket
};