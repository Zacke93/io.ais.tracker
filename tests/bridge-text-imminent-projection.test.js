'use strict';

jest.mock('homey');

const BridgeTextService = require('../lib/services/BridgeTextService');
const AISBridgeApp = require('../app');

/**
 * F4 (HÖG): _findRelevantBoatsForBridgeText byggde nya plain-objekt men kopierade
 * inte _etaIsExtrapolated/_isImminentAtTargetBridge. BridgeTextService läser dem
 * som === true → alltid false → "strax"/"cirka N min" aktiverades aldrig via
 * publiceringsvägen. Två testblock: (1) kontraktet i BridgeTextService, (2) att
 * projektionen faktiskt bär med flaggorna.
 */
describe('F4: imminent/extrapolated-flaggor styr ETA-frasen (BridgeTextService-kontrakt)', () => {
  const logger = { debug: jest.fn(), error: jest.fn(), log: jest.fn() };

  test('imminent-flaggan tvingar "strax" även när ETA >= 3 min', () => {
    const svc = new BridgeTextService(null, logger);
    const base = { mmsi: '1', targetBridge: 'Klaffbron', etaMinutes: 5 };
    expect(svc.generateBridgeText([base])).toContain('om 5 minuter');

    const imminent = { ...base, _isImminentAtTargetBridge: true };
    const text = svc.generateBridgeText([imminent]);
    expect(text).toContain('strax');
    expect(text).not.toContain('5 minuter');
  });

  test('extrapolated-flaggan ger "cirka N minuter"', () => {
    const svc = new BridgeTextService(null, logger);
    const v = {
      mmsi: '1', targetBridge: 'Stridsbergsbron', etaMinutes: 6, _etaIsExtrapolated: true,
    };
    expect(svc.generateBridgeText([v])).toContain('cirka 6 minuter');
  });
});

describe('F4: _findRelevantBoatsForBridgeText bär med flaggorna i projektionen', () => {
  test('projektionen inkluderar _isImminentAtTargetBridge och _etaIsExtrapolated', () => {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();

    const vessel = {
      mmsi: '99',
      name: 'V',
      targetBridge: 'Klaffbron',
      etaMinutes: 5,
      passedBridges: [],
      _isImminentAtTargetBridge: true,
      _etaIsExtrapolated: true,
    };

    app._processingRemoval = new Set();
    app.vesselDataService = { getVesselsForBridgeText: () => [vessel] };
    app.proximityService = {
      analyzeVesselProximity: () => ({ nearestBridge: null, nearestDistance: 9999, bridgeDistances: {} }),
    };
    app.bridgeRegistry = { findBridgeIdByName: () => null };

    const projected = app._findRelevantBoatsForBridgeText();
    expect(projected).toHaveLength(1);
    expect(projected[0]._isImminentAtTargetBridge).toBe(true);
    expect(projected[0]._etaIsExtrapolated).toBe(true);
  });
});
