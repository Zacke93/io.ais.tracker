'use strict';

/**
 * Bug 12 regression tests: targetBridge försvinner för nordgående fartyg.
 *
 * Rotorsak: isTerminalTarget kontrollerade inte riktning, så Klaffbron
 * felaktigt ansågs terminal för nordgående fartyg (Stridsbergsbron är
 * deras terminala bro). Fix B: removal-timer avbryts vid targetBridge-ändring.
 */

jest.mock('homey');

const AISBridgeApp = require('../app');
const { COG_DIRECTIONS } = require('../lib/constants');

describe('Bug 12: terminal target direction check', () => {
  let app;

  beforeEach(() => {
    app = new AISBridgeApp();
    app.debug = jest.fn();
    app.log = jest.fn();
    app.error = jest.fn();
    app.statusService = { clearVesselETAHistory: jest.fn() };
    app.vesselDataService = { removeVessel: jest.fn() };
    app._updateUI = jest.fn();
    app._hasPassedFinalTargetBridge = jest.fn().mockReturnValue(false);
    app._triggerBoatNearFlow = jest.fn();
    app._clearBoatNearTriggers = jest.fn();
    app._vesselRemovalTimers = new Map();
    app._processingRemoval = new Set();
    app._analyzeVesselPosition = jest.fn();
  });

  afterEach(() => {
    // Clean up any timers
    if (app._vesselRemovalTimers) {
      for (const timerId of app._vesselRemovalTimers.values()) {
        clearTimeout(timerId);
      }
      app._vesselRemovalTimers.clear();
    }
  });

  test('northbound vessel passing Klaffbron is NOT scheduled for removal', async () => {
    const vessel = {
      mmsi: '304027000',
      targetBridge: 'Klaffbron',
      passedBridges: ['Klaffbron'],
      cog: 20, // northbound
      _finalTargetBridge: null,
    };

    await app._onVesselStatusChanged({
      vessel,
      oldStatus: 'under-bridge',
      newStatus: 'passed',
      reason: 'test',
    });

    expect(app._vesselRemovalTimers.has('304027000')).toBe(false);
  });

  test('southbound vessel passing Klaffbron IS scheduled for removal', async () => {
    const vessel = {
      mmsi: '304027001',
      targetBridge: 'Klaffbron',
      passedBridges: ['Klaffbron'],
      cog: 200, // southbound
      _finalTargetBridge: null,
    };

    await app._onVesselStatusChanged({
      vessel,
      oldStatus: 'under-bridge',
      newStatus: 'passed',
      reason: 'test',
    });

    expect(app._vesselRemovalTimers.has('304027001')).toBe(true);
  });

  test('northbound vessel passing Stridsbergsbron IS scheduled for removal', async () => {
    const vessel = {
      mmsi: '304027002',
      targetBridge: 'Stridsbergsbron',
      passedBridges: ['Klaffbron', 'Stridsbergsbron'],
      cog: 20, // northbound
      _finalTargetBridge: null,
    };

    await app._onVesselStatusChanged({
      vessel,
      oldStatus: 'under-bridge',
      newStatus: 'passed',
      reason: 'test',
    });

    expect(app._vesselRemovalTimers.has('304027002')).toBe(true);
  });

  test('removal timer is cancelled when targetBridge changes', async () => {
    const mmsi = '304027003';

    // Set up an active removal timer
    const timerId = setTimeout(() => {}, 60000);
    app._vesselRemovalTimers.set(mmsi, timerId);

    const oldVessel = { targetBridge: 'Klaffbron' };
    const vessel = {
      mmsi,
      targetBridge: 'Stridsbergsbron',
      _finalTargetBridge: 'Klaffbron',
    };

    await app._onVesselUpdated({ mmsi, vessel, oldVessel });

    expect(app._vesselRemovalTimers.has(mmsi)).toBe(false);
    expect(vessel._finalTargetBridge).toBeNull();
  });
});
