'use strict';

/**
 * End-to-end-scenario för spökbåtsbuggen som drabbade WINDA (MMSI 265500870)
 * 2026-04-17 07:17:55 → 2026-04-17 16:45 (8 timmar).
 *
 * Reproducerar den exakta sekvensen:
 * 1. Vessel passerar Stridsbergsbron söderut (confidence ≥ 0.90)
 * 2. Vessel stannar 150m söder om Stridsbergsbron (SOG 0.1 kn)
 * 3. AIS-signalen tystnar (inga fler positions-uppdateringar)
 * 4. 20 minuter senare triggas cleanup → PROTECTION_ZONE (inom 300m av Järnvägsbron)
 * 5. Verifierar att vessel tas bort inom rimlig tid (via STALE_AIS fallback)
 *
 * Före fix: vessel kvar för alltid, bridge text fastnar på "15 minuter" varje minut.
 * Efter fix: vessel bort efter ~30 min (10 min PROTECTION_ZONE reschedule + 30 min STALE_AIS)
 */

const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const VesselDataService = require('../lib/services/VesselDataService');

describe('Ghost vessel scenario (WINDA replay)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-17T07:17:55.676Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const makeLogger = () => ({
    log: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  });

  test('WINDA-like ghost vessel is removed within 40 min after AIS silence', () => {
    const logger = makeLogger();
    const registry = new BridgeRegistry();
    const coordinator = new SystemCoordinator(logger);
    const service = new VesselDataService(logger, registry, coordinator);
    service.vesselLifecycleManager.shouldEliminateVessel = () => false;

    // WINDA at her last known position (58.292805, 12.293613)
    // ~150m south of Stridsbergsbron (58.294, 12.2936)
    const stridsbergsbron = registry.getBridgeByName('Stridsbergsbron');
    const mmsi = '265500870';
    const lastPositionTime = Date.now();

    service.vessels.set(mmsi, {
      mmsi,
      lat: 58.292805,
      lon: 12.293613,
      sog: 0.1,
      cog: 34.3,
      targetBridge: 'Klaffbron', // became target after passing Stridsbergsbron
      lastPassedBridge: 'Stridsbergsbron',
      passedBridges: ['Stridsbergsbron'],
      lastPositionUpdate: lastPositionTime,
      timestamp: lastPositionTime,
      status: 'en-route',
    });

    // Simulate 20 min of silence — first timeout triggers PROTECTION_ZONE reschedule
    jest.advanceTimersByTime(20 * 60 * 1000);
    // Manually trigger cleanup (in production a timer would do it)
    service.removeVessel(mmsi, 'timeout');

    // Bug #1: lock must be cleared despite early return
    expect(service._removalInProgress.has(mmsi)).toBe(false);
    // Vessel must still be present (protected)
    expect(service.vessels.has(mmsi)).toBe(true);

    // 10 minutes later, the rescheduled cleanup fires → STALE_AIS (30 min since AIS)
    jest.advanceTimersByTime(10 * 60 * 1000 + 1000);

    // Vessel must now be removed via STALE_AIS bypass
    expect(service.vessels.has(mmsi)).toBe(false);

    // No dangling state
    expect(service._removalInProgress.has(mmsi)).toBe(false);
    expect(service._eliminationPending.has(mmsi)).toBe(false);
    expect(service.cleanupTimers.has(mmsi)).toBe(false);
  });

  test('BEFORE Bug #1 fix: lock would have been retained (negative test)', () => {
    // Sanity-check: our fix actually removed the leak. If we simulate the
    // OLD code path (don't delete lock before scheduleCleanup), the guard
    // would block the reschedule and vessel would be trapped.
    const logger = makeLogger();
    const registry = new BridgeRegistry();
    const coordinator = new SystemCoordinator(logger);
    const service = new VesselDataService(logger, registry, coordinator);
    service.vesselLifecycleManager.shouldEliminateVessel = () => false;

    const klaffbron = registry.getBridgeByName('Klaffbron');
    const mmsi = 'TEST_OLD';
    service.vessels.set(mmsi, {
      mmsi,
      lat: klaffbron.lat + 0.001,
      lon: klaffbron.lon,
      sog: 0.1,
      targetBridge: 'Klaffbron',
      lastPositionUpdate: Date.now() - 20 * 60 * 1000,
      timestamp: Date.now() - 20 * 60 * 1000,
      passedBridges: [],
    });

    // Simulate the OLD buggy behavior: manually add to lock first
    service._removalInProgress.add(mmsi);
    // Now scheduleCleanup would return early at the RACE_PROTECTION guard
    const beforeExpiry = service._cleanupExpiryTimes.get(mmsi);
    service.scheduleCleanup(mmsi, 10 * 60 * 1000);
    const afterExpiry = service._cleanupExpiryTimes.get(mmsi);

    // Without fix: scheduleCleanup skipped, no new timer created
    expect(afterExpiry).toBe(beforeExpiry); // unchanged = guard blocked

    // Clean up for other tests
    service._removalInProgress.delete(mmsi);
  });
});
