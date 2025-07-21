/**
 * FULL-PIPELINE PERFORMANCE TESTS
 * 
 * Stress-testing av hela kedjan från WebSocket till device updates under high load.
 * Fokuserar på performance bottlenecks och scalability limits som kan orsaka
 * production problem när många båtar är aktiva samtidigt.
 * 
 * Testar performance scenarios:
 * - High vessel count (15+ boats simultaneously)
 * - Rapid WebSocket message bursts
 * - Concurrent device updates under load
 * - Memory usage under extended operation
 * - Recovery time efter stora vessel changes
 * - Flow trigger performance under load
 */

const { createProductionBoat } = require('./helpers/production-test-base');

// Mock setup för performance testing
const Module = require('module');
const originalRequire = Module.prototype.require;

const mockHomey = {
  app: {
    log: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    emit: jest.fn(),
    getSettings: jest.fn(() => ({ 'api_key': 'test-key' }))
  },
  flow: {
    createToken: jest.fn(() => Promise.resolve({ setValue: jest.fn(() => Promise.resolve()) })),
    getDeviceTriggerCard: jest.fn(() => ({ trigger: jest.fn(() => Promise.resolve()) }))
  },
  drivers: {
    getDriver: jest.fn(() => ({ getDevices: jest.fn(() => [mockDevice]) }))
  }
};

const mockDevice = {
  setCapabilityValue: jest.fn(() => Promise.resolve()),
  getCapabilityValue: jest.fn(() => 'Inga båtar'),
  hasCapability: jest.fn(() => true)
};

Module.prototype.require = function mockRequire(...args) {
  if (args[0] === 'homey') {
    return { App: class { constructor() { this.homey = mockHomey; } } };
  }
  return originalRequire.apply(this, args);
};

const AISBridgeApp = require('../app');

describe('Full-Pipeline Performance Tests', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = new AISBridgeApp();
    app._devices = new Map();
    app._devices.set('test-device', mockDevice);
    app._vessels = new Map();
    app._lastSeen = new Map();
  });

  describe('High Load Vessel Management', () => {
    test('15+ boats simultaneously - bridge text generation performance', async () => {
      const boatCount = 20;
      const startTime = Date.now();
      
      // Generate realistic boat data
      for (let i = 0; i < boatCount; i++) {
        const mmsi = 1000000 + i;
        const bridges = ['klaffbron', 'stridsbergsbron'];
        const statuses = ['approaching', 'waiting', 'under-bridge'];
        
        app._vessels.set(mmsi, {
          mmsi: mmsi,
          name: `BOAT_${i}`,
          lat: 58.284933 + (i * 0.001),
          lon: 12.285400 + (i * 0.001),
          targetBridge: bridges[i % 2] === 'klaffbron' ? 'Klaffbron' : 'Stridsbergsbron',
          nearBridge: bridges[i % 2],
          status: statuses[i % 3],
          etaMinutes: Math.floor(Math.random() * 10) + 1,
          sog: Math.random() * 5 + 1,
          isApproaching: statuses[i % 3] === 'approaching',
          isWaiting: statuses[i % 3] === 'waiting'
        });
      }
      
      // Performance test: bridge text generation
      const generationStart = Date.now();
      await app._updateActiveBridgesTag();
      const generationTime = Date.now() - generationStart;
      
      // Performance requirement: under 200ms för 20 boats
      expect(generationTime).toBeLessThan(200);
      
      // Verifiera att bridge text innehåller boats
      const bridgeText = mockDevice.setCapabilityValue.mock.calls
        .find(call => call[0] === 'bridge_text')?.[1];
      
      expect(bridgeText).toContain('båtar'); // Plural form
      expect(bridgeText.length).toBeGreaterThan(50); // Reasonable text length
      
      console.log(`Performance: ${boatCount} boats processed in ${generationTime}ms`);
    });

    test('WebSocket message burst performance', async () => {
      const messageCount = 100;
      const burstStart = Date.now();
      
      // Generate realistic AIS messages
      const aisMessages = Array.from({ length: messageCount }, (_, i) => ({
        Message: {
          PositionReport: {
            UserID: 2000000 + (i % 10), // 10 different boats
            Latitude: 58.284933 + (Math.random() * 0.01),
            Longitude: 12.285400 + (Math.random() * 0.01),
            Sog: Math.random() * 10,
            Cog: Math.random() * 360,
            TrueHeading: Math.random() * 360
          }
        },
        MetaData: {
          VesselName: `BURST_BOAT_${i % 10}`
        }
      }));
      
      // Process message burst
      const processPromises = aisMessages.map(msg => 
        app._onWebSocketMessage({ data: JSON.stringify(msg) })
      );
      
      await Promise.all(processPromises);
      const burstTime = Date.now() - burstStart;
      
      // Performance requirement: under 1000ms för 100 messages
      expect(burstTime).toBeLessThan(1000);
      
      // Verifiera att vessels är trackade
      expect(app._vessels.size).toBeGreaterThan(0);
      expect(app._vessels.size).toBeLessThanOrEqual(10); // Max 10 unique boats
      
      console.log(`Burst Performance: ${messageCount} messages processed in ${burstTime}ms`);
    });

    test('concurrent device updates under vessel load', async () => {
      const vesselCount = 15;
      const updateCycles = 5;
      
      // Setup vessels
      for (let i = 0; i < vesselCount; i++) {
        app._vessels.set(3000000 + i, {
          mmsi: 3000000 + i,
          name: `CONCURRENT_${i}`,
          targetBridge: i % 2 === 0 ? 'Klaffbron' : 'Stridsbergsbron',
          status: 'approaching',
          etaMinutes: Math.floor(Math.random() * 10) + 1
        });
      }
      
      // Concurrent update cycles
      const concurrentStart = Date.now();
      const updatePromises = Array.from({ length: updateCycles }, () => 
        app._updateActiveBridgesTag()
      );
      
      await Promise.all(updatePromises);
      const concurrentTime = Date.now() - concurrentStart;
      
      // Performance requirement: under 500ms för 5 concurrent updates
      expect(concurrentTime).toBeLessThan(500);
      
      // Verifiera att device updates är reasonable
      const bridgeTextCalls = mockDevice.setCapabilityValue.mock.calls
        .filter(call => call[0] === 'bridge_text');
      
      expect(bridgeTextCalls.length).toBeGreaterThan(0);
      expect(bridgeTextCalls.length).toBeLessThanOrEqual(updateCycles);
      
      console.log(`Concurrent Performance: ${updateCycles} updates with ${vesselCount} vessels in ${concurrentTime}ms`);
    });
  });

  describe('Memory Management Under Load', () => {
    test('memory stability under extended operation', async () => {
      const operationCycles = 50;
      const vesselsPerCycle = 5;
      
      for (let cycle = 0; cycle < operationCycles; cycle++) {
        // Add vessels
        for (let i = 0; i < vesselsPerCycle; i++) {
          const mmsi = (cycle * vesselsPerCycle) + i + 4000000;
          app._vessels.set(mmsi, {
            mmsi: mmsi,
            name: `CYCLE_${cycle}_BOAT_${i}`,
            targetBridge: 'Klaffbron',
            status: 'approaching',
            etaMinutes: 5
          });
        }
        
        // Update devices
        await app._updateActiveBridgesTag();
        
        // Cleanup old vessels (simulate timeout)
        if (cycle > 10) {
          const oldCycle = cycle - 10;
          for (let i = 0; i < vesselsPerCycle; i++) {
            const oldMMSI = (oldCycle * vesselsPerCycle) + i + 4000000;
            app._vessels.delete(oldMMSI);
            app._lastSeen.delete(oldMMSI);
          }
        }
      }
      
      // Final vessel count ska vara reasonable
      expect(app._vessels.size).toBeLessThan(vesselsPerCycle * 15); // Max 15 cycles worth
      expect(app._lastSeen.size).toBeLessThan(vesselsPerCycle * 15);
      
      // Final update ska fungera normalt
      const finalStart = Date.now();
      await app._updateActiveBridgesTag();
      const finalTime = Date.now() - finalStart;
      
      expect(finalTime).toBeLessThan(100); // Should still be fast
      
      console.log(`Memory test: ${operationCycles} cycles completed, final vessels: ${app._vessels.size}`);
    });

    test('cleanup performance med large vessel count', async () => {
      const vesselCount = 100;
      
      // Setup large number of vessels
      for (let i = 0; i < vesselCount; i++) {
        const mmsi = 5000000 + i;
        app._vessels.set(mmsi, {
          mmsi: mmsi,
          name: `CLEANUP_BOAT_${i}`,
          lastSeen: Date.now() - (Math.random() * 3600000), // Random age up to 1 hour
          firstSeen: Date.now() - (Math.random() * 7200000), // Random first seen up to 2 hours
          targetBridge: 'Klaffbron',
          status: 'approaching'
        });
        
        app._lastSeen.set(mmsi, Date.now() - (Math.random() * 3600000));
      }
      
      expect(app._vessels.size).toBe(vesselCount);
      
      // Performance test cleanup
      const cleanupStart = Date.now();
      app._checkVesselTimeouts();
      const cleanupTime = Date.now() - cleanupStart;
      
      // Cleanup ska vara snabbt även med många vessels
      expect(cleanupTime).toBeLessThan(100);
      
      // Some vessels ska ha schemalagts för cleanup
      expect(mockHomey.app.debug).toHaveBeenCalled();
      
      console.log(`Cleanup Performance: ${vesselCount} vessels checked in ${cleanupTime}ms`);
    });
  });

  describe('Flow Performance Under Load', () => {
    test('multiple flow triggers performance', async () => {
      const triggerCount = 20;
      
      // Mock flow trigger med simulated delay
      const flowTriggerTimes = [];
      mockHomey.flow.getDeviceTriggerCard().trigger.mockImplementation(() => {
        const startTime = Date.now();
        return new Promise(resolve => {
          setTimeout(() => {
            flowTriggerTimes.push(Date.now() - startTime);
            resolve();
          }, Math.random() * 50); // Random delay 0-50ms
        });
      });
      
      // Setup vessels för flow triggers
      const flowPromises = [];
      for (let i = 0; i < triggerCount; i++) {
        const mmsi = 6000000 + i;
        app._vessels.set(mmsi, {
          mmsi: mmsi,
          name: `FLOW_BOAT_${i}`,
          targetBridge: 'Klaffbron',
          nearBridge: 'klaffbron',
          status: 'approaching',
          triggeredFlows: new Set()
        });
        
        flowPromises.push(
          app._handleVesselApproaching(mmsi, 'klaffbron')
        );
      }
      
      const flowStart = Date.now();
      await Promise.all(flowPromises);
      const totalFlowTime = Date.now() - flowStart;
      
      // Flow triggers ska vara reasonable fast
      expect(totalFlowTime).toBeLessThan(1000); // Under 1 second för 20 triggers
      
      // Alla triggers ska ha genomförts
      expect(mockHomey.flow.getDeviceTriggerCard().trigger).toHaveBeenCalledTimes(triggerCount);
      
      const avgTriggerTime = flowTriggerTimes.reduce((a, b) => a + b, 0) / flowTriggerTimes.length;
      console.log(`Flow Performance: ${triggerCount} triggers in ${totalFlowTime}ms (avg: ${avgTriggerTime.toFixed(1)}ms per trigger)`);
    });

    test('condition card performance under load', async () => {
      const conditionChecks = 50;
      
      // Setup vessels för condition checks
      for (let i = 0; i < 10; i++) {
        app._vessels.set(7000000 + i, {
          mmsi: 7000000 + i,
          name: `CONDITION_BOAT_${i}`,
          targetBridge: i % 2 === 0 ? 'Klaffbron' : 'Stridsbergsbron',
          nearBridge: i % 2 === 0 ? 'klaffbron' : 'stridsbergsbron',
          status: 'approaching'
        });
      }
      
      // Mock condition card implementation
      const conditionResults = [];
      const checkCondition = (bridgeName) => {
        const startTime = Date.now();
        
        // Simulate condition logic
        let found = false;
        for (const vessel of app._vessels.values()) {
          if (vessel.nearBridge === bridgeName.toLowerCase()) {
            found = true;
            break;
          }
        }
        
        conditionResults.push(Date.now() - startTime);
        return found;
      };
      
      // Performance test condition checks
      const conditionStart = Date.now();
      const checkPromises = Array.from({ length: conditionChecks }, (_, i) => 
        Promise.resolve(checkCondition(i % 2 === 0 ? 'Klaffbron' : 'Stridsbergsbron'))
      );
      
      const results = await Promise.all(checkPromises);
      const totalConditionTime = Date.now() - conditionStart;
      
      // Condition checks ska vara snabba
      expect(totalConditionTime).toBeLessThan(200);
      
      // Results ska vara reasonable
      const trueResults = results.filter(r => r === true);
      expect(trueResults.length).toBeGreaterThan(0);
      
      const avgConditionTime = conditionResults.reduce((a, b) => a + b, 0) / conditionResults.length;
      console.log(`Condition Performance: ${conditionChecks} checks in ${totalConditionTime}ms (avg: ${avgConditionTime.toFixed(2)}ms per check)`);
    });
  });

  describe('Recovery Performance Tests', () => {
    test('mass vessel recovery efter WebSocket reconnect', async () => {
      const recoveryVesselCount = 25;
      
      // Simulera vessels före disconnect
      for (let i = 0; i < recoveryVesselCount; i++) {
        app._vessels.set(8000000 + i, {
          mmsi: 8000000 + i,
          name: `RECOVERY_BOAT_${i}`,
          targetBridge: i % 2 === 0 ? 'Klaffbron' : 'Stridsbergsbron',
          status: 'approaching',
          etaMinutes: Math.floor(Math.random() * 10) + 1,
          lastSeen: Date.now() - 60000 // 1 minute old
        });
      }
      
      // Simulera WebSocket reconnect recovery
      const recoveryStart = Date.now();
      
      // Update connection status
      await app._updateConnectionStatus(true);
      
      // Full system sync
      await app._updateActiveBridgesTag();
      
      const recoveryTime = Date.now() - recoveryStart;
      
      // Recovery ska vara snabb även med många vessels
      expect(recoveryTime).toBeLessThan(300);
      
      // Alla vessels ska fortfarande vara aktiva
      expect(app._vessels.size).toBe(recoveryVesselCount);
      
      // Device ska uppdateras med current state
      expect(mockDevice.setCapabilityValue).toHaveBeenCalledWith('connection_status', true);
      expect(mockDevice.setCapabilityValue).toHaveBeenCalledWith(
        'bridge_text',
        expect.stringContaining('båtar')
      );
      
      console.log(`Recovery Performance: ${recoveryVesselCount} vessels recovered in ${recoveryTime}ms`);
    });

    test('performance degradation under sustained errors', async () => {
      const errorCycles = 10;
      const vesselsPerCycle = 5;
      
      // Mock intermittent device errors
      let errorCount = 0;
      mockDevice.setCapabilityValue.mockImplementation((capability, value) => {
        errorCount++;
        if (errorCount % 3 === 0) {
          return Promise.reject(new Error(`Intermittent error ${errorCount}`));
        }
        return Promise.resolve();
      });
      
      const performanceTimes = [];
      
      for (let cycle = 0; cycle < errorCycles; cycle++) {
        // Add vessels
        for (let i = 0; i < vesselsPerCycle; i++) {
          app._vessels.set(9000000 + (cycle * vesselsPerCycle) + i, {
            mmsi: 9000000 + (cycle * vesselsPerCycle) + i,
            name: `ERROR_BOAT_${cycle}_${i}`,
            targetBridge: 'Klaffbron',
            status: 'approaching'
          });
        }
        
        // Performance test under errors
        const cycleStart = Date.now();
        await app._updateActiveBridgesTag();
        const cycleTime = Date.now() - cycleStart;
        
        performanceTimes.push(cycleTime);
      }
      
      // Performance ska inte degradera significantly trots errors
      const avgTime = performanceTimes.reduce((a, b) => a + b, 0) / performanceTimes.length;
      const maxTime = Math.max(...performanceTimes);
      
      expect(avgTime).toBeLessThan(150); // Average reasonable
      expect(maxTime).toBeLessThan(300);  // Max reasonable
      
      // Errors ska ha loggats
      expect(mockHomey.app.error).toHaveBeenCalled();
      
      console.log(`Error Performance: ${errorCycles} cycles, avg: ${avgTime.toFixed(1)}ms, max: ${maxTime}ms`);
    });
  });

  describe('Scalability Limit Tests', () => {
    test('theoretical maximum vessel count', async () => {
      const maxVessels = 50; // Theoretical max för Homey hardware
      
      // Add max vessels gradually och measure performance
      const performancePoints = [];
      
      for (let count = 10; count <= maxVessels; count += 10) {
        // Clear previous vessels
        app._vessels.clear();
        
        // Add current count
        for (let i = 0; i < count; i++) {
          app._vessels.set(10000000 + i, {
            mmsi: 10000000 + i,
            name: `MAX_BOAT_${i}`,
            targetBridge: i % 2 === 0 ? 'Klaffbron' : 'Stridsbergsbron',
            status: 'approaching',
            etaMinutes: Math.floor(Math.random() * 10) + 1
          });
        }
        
        // Measure performance
        const testStart = Date.now();
        await app._updateActiveBridgesTag();
        const testTime = Date.now() - testStart;
        
        performancePoints.push({ count, time: testTime });
        
        // Performance ska vara reasonable även vid max
        expect(testTime).toBeLessThan(1000); // 1 second max
      }
      
      // Analyze scalability
      const finalPerformance = performancePoints[performancePoints.length - 1];
      console.log(`Scalability: ${finalPerformance.count} vessels in ${finalPerformance.time}ms`);
      
      performancePoints.forEach(point => {
        console.log(`  ${point.count} vessels: ${point.time}ms`);
      });
      
      // Final count ska vara max
      expect(app._vessels.size).toBe(maxVessels);
      expect(finalPerformance.time).toBeLessThan(500); // Reasonable max performance
    });
  });
});