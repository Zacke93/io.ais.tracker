'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');

/**
 * F14 (HÖG): _analyzeVesselPosition läste positionAnalysis.movementDistance, men
 * fältet bor i positionAnalysis.analysis.movementDistance. Följd: passage-latch
 * och GPS-gate fick alltid 0, och clearVesselHistory (>1km) kördes aldrig
 * (undefined > 1000 === false) → stale latches kunde blockera korrekt status i
 * upp till 10 min efter ett stort GPS-hopp.
 */
describe('F14: GPS-jump propagerar korrekt movementDistance (analysis.movementDistance)', () => {
  let app;

  beforeEach(() => {
    app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();

    app.proximityService = {
      analyzeVesselProximity: () => ({ nearestBridge: null, nearestDistance: 1234, bridgeDistances: {} }),
      calculateProximityTimeout: () => 60000,
    };
    app.statusService = {
      analyzeVesselStatus: () => ({ status: 'en-route' }),
      calculateETA: () => null,
    };
    app.vesselDataService = {
      setGpsJumpHold: jest.fn(),
      scheduleCleanup: jest.fn(),
      _handleTargetBridgeTransition: jest.fn(),
    };
    app.passageLatchService = { handleGPSJump: jest.fn() };
    app.gpsJumpGateService = {
      activateGate: jest.fn(),
      confirmStableCandidates: jest.fn(() => []),
    };
    app.routeOrderValidator = { clearVesselHistory: jest.fn() };
  });

  test('movementDistance=1500 propageras och route-historik rensas (>1km)', async () => {
    const vessel = {
      mmsi: '246810',
      lat: 58.30,
      lon: 12.30,
      targetBridge: 'Klaffbron',
      _gpsJumpDetected: true,
      _positionUncertain: false,
      _positionAnalysis: { movementDistance: 1500, isGPSJump: true },
    };

    await app._analyzeVesselPosition(vessel);

    expect(app.passageLatchService.handleGPSJump).toHaveBeenCalled();
    expect(app.passageLatchService.handleGPSJump.mock.calls[0][1]).toBe(1500);

    expect(app.gpsJumpGateService.activateGate).toHaveBeenCalled();
    expect(app.gpsJumpGateService.activateGate.mock.calls[0][1]).toBe(1500);

    // Tidigare: undefined > 1000 === false → kördes aldrig. Nu: 1500 > 1000.
    expect(app.routeOrderValidator.clearVesselHistory).toHaveBeenCalled();
  });
});
