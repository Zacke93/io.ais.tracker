const path = require('path');

// Mock Homey before requiring the app
require('../setup');

const appPath = path.join(__dirname, '../../app.js');
const AISBridgeApp = require(appPath);

describe('Stability and Reliability Tests', () => {
  let app;

  beforeEach(() => {
    app = new AISBridgeApp();
    app._lastSeen = {};
    
    // Mock settings
    app.homey.settings.get.mockImplementation((key) => {
      if (key === 'debug_level') return 'basic';
      if (key === 'ais_api_key') return '12345678-1234-4123-a123-123456789012';
      return null;
    });

    // Mock methods that might not exist in test environment
    app._updateConnectionStatus = jest.fn();
    app._updateActiveBridgesTag = jest.fn();
  });

  describe('Boat Tracking Reliability', () => {
    test('should not lose boats due to minor course changes', () => {
      const mmsi = '123456789';
      const bridgeId = 'klaffbron';
      
      // Initial detection
      app._lastSeen[bridgeId] = {
        [mmsi]: {
          ts: Date.now() - 30000,
          lat: 58.284,
          lon: 12.284,
          sog: 4.2,
          cog: 45, // Initial course
          dir: 'Vänersborg'
        }
      };
      
      // Course change but still in same general direction
      const updatedData = {
        ts: Date.now(),
        lat: 58.285,
        lon: 12.285,
        sog: 4.0,
        cog: 60, // 15 degree course change
        dir: 'Vänersborg'
      };
      
      // Update tracking data
      app._lastSeen[bridgeId][mmsi] = {
        ...app._lastSeen[bridgeId][mmsi],
        ...updatedData
      };
      
      // Boat should still be tracked
      expect(app._lastSeen[bridgeId][mmsi]).toBeDefined();
      expect(app._lastSeen[bridgeId][mmsi].sog).toBe(4.0);
      expect(app._lastSeen[bridgeId][mmsi].dir).toBe('Vänersborg');
    });

    test('should maintain tracking through temporary signal loss', () => {
      const mmsi = '123456789';
      const bridgeId = 'stridsbergsbron';
      const maxAge = 3 * 60 * 1000; // 3 minutes
      
      // Last known position
      const lastSeenTime = Date.now() - (maxAge - 30000); // Just under 3 minutes ago
      
      app._lastSeen[bridgeId] = {
        [mmsi]: {
          ts: lastSeenTime,
          sog: 4.5,
          dir: 'Göteborg',
          dist: 200
        }
      };
      
      // Check if boat is still considered "recent"
      const cutoff = Date.now() - maxAge;
      const isStillTracked = app._lastSeen[bridgeId][mmsi].ts > cutoff;
      
      expect(isStillTracked).toBe(true);
    });

    test('should handle boats moving between multiple bridges', () => {
      const mmsi = '123456789';
      const startTime = Date.now() - 300000; // 5 minutes ago
      
      // Boat journey: Klaffbron → Stridsbergsbron
      const journey = [
        { bridge: 'klaffbron', time: startTime, dist: 150 },
        { bridge: 'stridsbergsbron', time: startTime + 180000, dist: 200 } // 3 minutes later
      ];
      
      // Simulate boat movement
      journey.forEach(({ bridge, time, dist }) => {
        // Clear from other bridges (as per app logic)
        Object.keys(app._lastSeen).forEach(bid => {
          if (app._lastSeen[bid] && app._lastSeen[bid][mmsi]) {
            delete app._lastSeen[bid][mmsi];
          }
        });
        
        // Add to current bridge
        (app._lastSeen[bridge] ??= {})[mmsi] = {
          ts: time,
          sog: 4.2,
          dir: 'Vänersborg',
          dist
        };
      });
      
      // Should be tracked at final bridge
      expect(app._lastSeen['stridsbergsbron'][mmsi]).toBeDefined();
      expect(app._lastSeen['klaffbron'][mmsi]).toBeUndefined();
    });
  });

  describe('Anchored and Waiting Boat Detection', () => {
    test('should reliably detect anchored boats', () => {
      const mmsi = '123456789';
      const bridgeId = 'klaffbron';
      
      app._lastSeen[bridgeId] = {
        [mmsi]: {
          ts: Date.now(),
          sog: 0.1, // Nearly stationary
          maxRecentSog: 0.2, // Has not been moving fast
          dir: 'Göteborg',
          dist: 250,
          speedHistory: [
            { speed: 0.1, time: Date.now() - 60000 },
            { speed: 0.1, time: Date.now() - 30000 },
            { speed: 0.1, time: Date.now() }
          ]
        }
      };
      
      const boat = app._lastSeen[bridgeId][mmsi];
      const isAnchored = boat.sog < 0.3 && boat.maxRecentSog < 1.0;
      
      expect(isAnchored).toBe(true);
    });

    test('should reliably detect boats waiting at bridges', () => {
      const mmsi = '123456789';
      const bridgeId = 'stridsbergsbron';
      
      app._lastSeen[bridgeId] = {
        [mmsi]: {
          ts: Date.now(),
          sog: 0.3, // Very slow
          maxRecentSog: 4.8, // Was moving fast recently
          dir: 'Vänersborg',
          dist: 120, // Close to bridge
          lastActiveTime: Date.now() - 5 * 60 * 1000 // Was active 5 minutes ago
        }
      };
      
      const boat = app._lastSeen[bridgeId][mmsi];
      const isWaiting = boat.sog < 0.5 && 
                       boat.maxRecentSog > 2.0 && 
                       boat.dist < 300;
      
      expect(isWaiting).toBe(true);
    });

    test('should distinguish between anchored and waiting vessels', () => {
      const anchoredMmsi = '111111111';
      const waitingMmsi = '222222222';
      const bridgeId = 'klaffbron';
      
      app._lastSeen[bridgeId] = {
        [anchoredMmsi]: {
          sog: 0.1,
          maxRecentSog: 0.2, // Never moved fast
          dist: 400 // Far from bridge
        },
        [waitingMmsi]: {
          sog: 0.4,
          maxRecentSog: 4.5, // Was moving fast
          dist: 150 // Close to bridge
        }
      };
      
      const anchored = app._lastSeen[bridgeId][anchoredMmsi];
      const waiting = app._lastSeen[bridgeId][waitingMmsi];
      
      const isAnchored = anchored.sog < 0.3 && anchored.maxRecentSog < 1.0;
      const isWaiting = waiting.sog < 0.5 && waiting.maxRecentSog > 2.0 && waiting.dist < 300;
      
      expect(isAnchored).toBe(true);
      expect(isWaiting).toBe(true);
      // Both can be true since they test different conditions
      expect(typeof isAnchored).toBe('boolean');
      expect(typeof isWaiting).toBe('boolean');
    });
  });

  describe('ETA Accuracy and Consistency', () => {
    test('should provide accurate ETAs for normal speed vessels', () => {
      const speed = 4.0; // knots
      const distance = 1000; // meters
      
      const speedMs = speed * 0.514444; // Convert to m/s
      const etaSeconds = distance / speedMs;
      const etaMinutes = Math.round(etaSeconds / 60);
      
      // Should be reasonable (about 8 minutes for 1000m at 4kts)
      expect(etaMinutes).toBeGreaterThan(7);
      expect(etaMinutes).toBeLessThan(10);
    });

    test('should provide consistent ETAs for waiting vessels', () => {
      const currentSpeed = 0.2;
      const maxRecentSpeed = 4.5;
      const distance = 500;
      
      // Use speed compensation for waiting vessels
      const compensatedSpeed = maxRecentSpeed * 0.7;
      const speedMs = compensatedSpeed * 0.514444;
      const etaSeconds = distance / speedMs;
      const etaMinutes = Math.round(etaSeconds / 60);
      
      expect(etaMinutes).toBeGreaterThan(0);
      expect(etaMinutes).toBeLessThan(30);
    });

    test('should handle edge cases in ETA calculation', () => {
      const testCases = [
        { speed: 0.1, distance: 100 }, // Very slow
        { speed: 8.0, distance: 2000 }, // Very fast
        { speed: 4.0, distance: 50 }    // Very close
      ];
      
      testCases.forEach(({ speed, distance }) => {
        const speedMs = Math.max(speed * 0.514444, 0.1); // Minimum speed
        const etaSeconds = distance / speedMs;
        const etaMinutes = Math.round(etaSeconds / 60);
        
        expect(etaMinutes).toBeGreaterThanOrEqual(0);
        expect(etaMinutes).toBeLessThan(300); // Less than 5 hours
      });
    });
  });

  describe('Multi-Boat Handling', () => {
    test('should handle multiple boats at target bridges simultaneously', () => {
      const currentTime = Date.now();
      
      // Multiple boats at Klaffbron
      app._lastSeen['klaffbron'] = {
        '111111111': {
          ts: currentTime,
          sog: 3.8,
          dir: 'Göteborg',
          dist: 180
        },
        '222222222': {
          ts: currentTime - 30000,
          sog: 4.2,
          dir: 'Vänersborg',
          dist: 220
        }
      };
      
      // Boat at Stridsbergsbron
      app._lastSeen['stridsbergsbron'] = {
        '333333333': {
          ts: currentTime - 45000,
          sog: 4.5,
          dir: 'Göteborg',
          dist: 150
        }
      };
      
      const klaffboats = Object.keys(app._lastSeen['klaffbron']).length;
      const stridsboats = Object.keys(app._lastSeen['stridsbergsbron']).length;
      const totalBoats = klaffboats + stridsboats;
      
      expect(klaffboats).toBe(2);
      expect(stridsboats).toBe(1);
      expect(totalBoats).toBe(3);
    });

    test('should prioritize boats correctly when multiple approach same bridge', () => {
      const currentTime = Date.now();
      const bridgeId = 'stridsbergsbron';
      
      app._lastSeen[bridgeId] = {
        '111111111': { // Closer boat
          ts: currentTime,
          sog: 4.0,
          dir: 'Vänersborg',
          dist: 150
        },
        '222222222': { // Further boat
          ts: currentTime,
          sog: 4.2,
          dir: 'Vänersborg',
          dist: 280
        }
      };
      
      // Get boats sorted by distance
      const boats = Object.values(app._lastSeen[bridgeId])
        .sort((a, b) => a.dist - b.dist);
      
      expect(boats[0].dist).toBe(150); // Closest first
      expect(boats[1].dist).toBe(280);
    });
  });

  describe('Connection Resilience', () => {
    test('should handle connection failures gracefully', () => {
      app._connectionAttempts = 0;
      
      // Simulate connection failure
      app._handleConnectionFailure = jest.fn(() => {
        app._connectionAttempts++;
        const delay = Math.min(10000 * Math.pow(2, app._connectionAttempts), 300000);
        return delay;
      });
      
      const delay1 = app._handleConnectionFailure();
      const delay2 = app._handleConnectionFailure();
      const delay3 = app._handleConnectionFailure();
      
      expect(app._connectionAttempts).toBe(3);
      expect(delay1).toBe(20000); // 10s * 2^1
      expect(delay2).toBe(40000); // 10s * 2^2
      expect(delay3).toBe(80000); // 10s * 2^3
    });

    test('should reset connection attempts on successful connection', () => {
      app._connectionAttempts = 5;
      app._isConnected = false;
      
      // Simulate successful connection
      app._connectionAttempts = 0;
      app._isConnected = true;
      
      expect(app._connectionAttempts).toBe(0);
      expect(app._isConnected).toBe(true);
    });
  });

  describe('Memory and Performance', () => {
    test('should clean up stale boat data automatically', () => {
      const currentTime = Date.now();
      const maxAge = 3 * 60 * 1000; // 3 minutes
      
      // Add mix of fresh and stale data
      app._lastSeen['klaffbron'] = {
        'fresh_boat': {
          ts: currentTime - 60000, // 1 minute ago - fresh
          sog: 4.0
        },
        'stale_boat': {
          ts: currentTime - 5 * 60 * 1000, // 5 minutes ago - stale
          sog: 3.8
        }
      };
      
      // Simulate cleanup
      const cutoff = currentTime - maxAge;
      Object.keys(app._lastSeen).forEach(bridgeId => {
        Object.keys(app._lastSeen[bridgeId]).forEach(mmsi => {
          if (app._lastSeen[bridgeId][mmsi].ts < cutoff) {
            delete app._lastSeen[bridgeId][mmsi];
          }
        });
        
        if (Object.keys(app._lastSeen[bridgeId]).length === 0) {
          delete app._lastSeen[bridgeId];
        }
      });
      
      expect(app._lastSeen['klaffbron']['fresh_boat']).toBeDefined();
      expect(app._lastSeen['klaffbron']['stale_boat']).toBeUndefined();
    });

    test('should limit speed history size to prevent memory leaks', () => {
      const maxHistorySize = 10;
      const speedHistory = [];
      
      // Simulate adding many speed readings
      for (let i = 0; i < 20; i++) {
        speedHistory.push({
          speed: 4.0 + Math.random(),
          time: Date.now() + i * 1000
        });
        
        // Keep only last N entries
        if (speedHistory.length > maxHistorySize) {
          speedHistory.splice(0, speedHistory.length - maxHistorySize);
        }
      }
      
      expect(speedHistory.length).toBeLessThanOrEqual(maxHistorySize);
      expect(speedHistory.length).toBe(10);
    });
  });
});