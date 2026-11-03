'use strict';

jest.mock('homey');

const AISBridgeApp = require('../app');
const { TRIGGER_POINTS } = require('../lib/constants');

/**
 * Helgranskningen 2026-11-03: boat_near-kortets trigger() awaitades utan
 * tidsgräns. Exit-notisen awaitas inne i _onVesselRemoved, så ett Homey-anrop
 * som aldrig svarade hindrade finally från att släppa _processingRemoval.
 * En återfödd båt med samma MMSI filtrerades därefter bort ur brotexten tills
 * appen startades om — samma felklass som A2R2-2 stängde för den globala
 * tokenens setValue.
 */
const KANAL = TRIGGER_POINTS.kanalinfarten;
const TIMEOUT_MS = 60 * 1000;

function makeApp() {
  const app = new AISBridgeApp();
  app.log = jest.fn();
  app.debug = jest.fn();
  app.error = jest.fn();
  return app;
}

const vessel = { mmsi: '265777001' };

describe('boat_near-kortets trigger() har en tidsgräns', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: Date.parse('2026-11-03T12:00:00Z') });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('ett anrop som aldrig svarar släpps efter tidsgränsen och loggas', async () => {
    const app = makeApp();
    app._boatNearTrigger = { trigger: jest.fn(() => new Promise(() => {})) };
    let settled = false;
    const call = app._triggerBoatNearFlowBest({}, {}, vessel).then(() => {
      settled = true;
    });
    await jest.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await call;
    expect(settled).toBe(true);
    expect(app.error.mock.calls.some(([msg]) => String(msg).includes('FLOW_TRIGGER_TIMEOUT'))).toBe(true);
  });

  test('ett svarande anrop ger kortets resultat och ingen timeoutrad', async () => {
    const app = makeApp();
    app._boatNearTrigger = { trigger: jest.fn().mockResolvedValue('ok') };
    await expect(app._triggerBoatNearFlowBest({}, {}, vessel)).resolves.toBe('ok');
    await jest.advanceTimersByTimeAsync(TIMEOUT_MS * 2);
    expect(app.error).not.toHaveBeenCalled();
  });

  test('ett fel från kortet kastas vidare som förut (anroparens rollback lever)', async () => {
    const app = makeApp();
    app._boatNearTrigger = { trigger: jest.fn().mockRejectedValue(new Error('sdk fel')) };
    await expect(app._triggerBoatNearFlowBest({}, {}, vessel)).rejects.toThrow('sdk fel');
  });

  test('exit-notis med hängande kort låser inte MMSI:t i _processingRemoval', async () => {
    const app = makeApp();
    app._boatNearTrigger = { trigger: jest.fn(() => new Promise(() => {})) };
    app._triggeredBoatNearKeys = new Set();
    app._persistentRecentTriggers = new Map();
    // Exit-vägen awaitar kortet via _triggerBoatNearFlowBest, precis som
    // _triggerExitPointFallback → _triggerBoatNearFlowFallback gör i drift.
    app._triggerExitPointFallback = jest.fn(function exitPath(snapshot) {
      return this._triggerBoatNearFlowBest({}, { bridge: 'kanalinfarten' }, snapshot);
    });
    app._clearBoatNearTriggers = jest.fn();
    app._updateUI = jest.fn();
    app.statusService = {
      statusStabilizer: { removeVessel: jest.fn() },
      clearVesselETAHistory: jest.fn(),
    };
    app.bridgeTextService = { clearVesselPhaseTracking: jest.fn() };
    app.vesselDataService = { getVesselCount: () => 1, getAllVessels: () => [] };
    app._processingRemoval = new Set();
    app._vesselRemovalTimers = new Map();
    app._skippedBridgesSweepSeen = new Map();
    app._isConnected = true;
    app.aisClient = { getConnectionStats: () => ({ timeSinceLastMessage: 1000 }) };

    const snapshot = {
      mmsi: vessel.mmsi,
      name: 'UTFARTEN',
      lat: KANAL.lat + 150 / 111320,
      lon: KANAL.lon,
      sog: 5,
      cog: 200,
      maxRecentSpeed: 5,
      timestamp: Date.now() - 60000,
      lastPositionUpdate: Date.now() - 60000,
      _hasMovementProof: true,
      _finalTargetDirection: 'south',
      _routeDirection: 'south',
      _finalTargetBridge: 'Klaffbron',
      passedBridges: ['Stridsbergsbron', 'Järnvägsbron', 'Klaffbron', 'Olidebron'],
      targetBridge: null,
      status: 'en-route',
    };
    const removal = app._onVesselRemoved({ mmsi: vessel.mmsi, vessel: snapshot, reason: 'timeout' });
    await jest.advanceTimersByTimeAsync(0);
    expect(app._triggerExitPointFallback).toHaveBeenCalled();
    expect(app._processingRemoval.has(vessel.mmsi)).toBe(true);

    await jest.advanceTimersByTimeAsync(TIMEOUT_MS);
    await removal;
    expect(app._processingRemoval.has(vessel.mmsi)).toBe(false);
  });
});
