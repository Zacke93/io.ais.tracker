'use strict';

const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const VesselDataService = require('../lib/services/VesselDataService');

/**
 * F26: en bekräftad 100ms-elimination (shouldEliminateVessel=true) tystades av
 * BUG 6 anti-shortening-guarden om båten redan hade en lång proximity-timer →
 * avslutad/spök-båt stannade kvar i bridge_text upp till 10 min. Eliminationen
 * forcerar nu igenom den korta timern.
 */
describe('F26: 100ms-elimination kringgår anti-shortening-guarden', () => {
  let logger;
  let service;
  const mmsi = '244660000';

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    logger = { log: jest.fn(), debug: jest.fn(), error: jest.fn() };
    service = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const addVessel = () => {
    const now = Date.now();
    service.vessels.set(mmsi, {
      mmsi,
      lat: 0,
      lon: 0,
      sog: 0,
      cog: 180,
      status: 'passed',
      lastPositionUpdate: now,
      timestamp: now,
    });
  };

  test('eliminering forcerar bort båt trots befintlig lång timer', () => {
    service.vesselLifecycleManager.shouldEliminateVessel = () => false;
    addVessel();

    // Steg 1: schemalägg en lång timer (10 min) — ingen elimination ännu
    service.scheduleCleanup(mmsi, 10 * 60 * 1000);
    jest.advanceTimersByTime(60 * 1000);
    expect(service.vessels.has(mmsi)).toBe(true); // lever fortfarande

    // Steg 2: nu ska båten elimineras → 100ms-timer MÅSTE kunna korta den långa
    service.vesselLifecycleManager.shouldEliminateVessel = () => true;
    service.scheduleCleanup(mmsi, 10 * 60 * 1000); // även med lång begärd timeout

    jest.advanceTimersByTime(200); // > 100ms
    expect(service.vessels.has(mmsi)).toBe(false); // borta nu, inte om 10 min
  });

  test('ingen elimination → BUG6-guarden skyddar fortfarande lång timer', () => {
    service.vesselLifecycleManager.shouldEliminateVessel = () => false;
    // PassageWindow ska inte heller förlänga i detta test
    service.passageWindowManager.shouldShowRecentlyPassed = () => false;
    service.passageWindowManager.isWithinInternalGracePeriod = () => false;
    addVessel();

    service.scheduleCleanup(mmsi, 10 * 60 * 1000);
    jest.advanceTimersByTime(60 * 1000);

    // Försök korta till 100ms utan elimination → ska IGNORERAS (BUG6-guard)
    service.scheduleCleanup(mmsi, 100);
    jest.advanceTimersByTime(200);
    expect(service.vessels.has(mmsi)).toBe(true); // fortfarande kvar (skyddad)
  });
});
