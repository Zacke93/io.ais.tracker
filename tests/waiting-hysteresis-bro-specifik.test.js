'use strict';

/**
 * Helgranskningen 2026-11-03: målbrogrenens väntehysteres i _isWaiting
 * gäller väntan VID MÅLBRON.
 *
 * Grenen valde släppgränsen 350 m så snart status var 'waiting', oavsett
 * vilken bro väntan avsåg. Järnvägsbron ligger 257 m från Stridsbergsbron.
 * En nordgående båt som väntade vid Järnvägsbron fick därför sin väntan
 * flyttad till målbron redan ~93 m SÖDER om Järnvägsbron. ETA-kalkylatorn
 * läste det som väntan vid målbron, och väntbaslinjen släpptes inte när
 * båten gick igenom Järnvägsbron. Fältfallet är ARESTEL i both-21h: notisen
 * sa "om 3 minuter" 12:50:21.699 och rådatans passage kom 12:51:34.
 */
const StatusService = require('../lib/services/StatusService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const ProximityService = require('../lib/services/ProximityService');
const geometry = require('../lib/utils/geometry');
const { BRIDGES, STATUS_HYSTERESIS } = require('../lib/constants');

const REAL_DATE_NOW = Date.now;
const southOf = (bridge, meters) => ({ lat: bridge.lat - meters / 111320, lon: bridge.lon });
const distanceTo = (pos, bridge) => geometry.calculateDistance(pos.lat, pos.lon, bridge.lat, bridge.lon);

describe('Väntehysteresen vid målbron är bro-specifik', () => {
  let now;
  let statusService;
  let proximityService;

  beforeEach(() => {
    now = Date.parse('2026-11-03T12:00:00Z');
    Date.now = () => now;
    global.__TEST_MODE__ = true;
    const logger = {
      debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
    };
    const bridgeRegistry = new BridgeRegistry();
    statusService = new StatusService(
      bridgeRegistry, logger, new SystemCoordinator(logger),
      { anchorPassageTimestamp: jest.fn() },
      { shouldBlockStatus: jest.fn().mockReturnValue(false) },
    );
    proximityService = new ProximityService(bridgeRegistry, logger);
  });

  afterEach(() => {
    Date.now = REAL_DATE_NOW;
  });

  const vesselAt = (pos, overrides) => ({
    mmsi: 265700360,
    name: 'VÄNTAREN',
    sog: 0.3,
    cog: 20,
    lat: pos.lat,
    lon: pos.lon,
    timestamp: now,
    lastPositionUpdate: now,
    _lastStatusChangeTime: now - 60_000, // förbi FIX G-debouncen
    ...overrides,
  });

  test('väntan vid Järnvägsbron flyttas inte till Stridsbergsbron inom målbrons släppgräns', () => {
    const pos = southOf(BRIDGES.jarnvagsbron, 60);
    // Förutsättning: inom målbrons släppgräns men utanför dess sättgräns,
    // och fortfarande söder om Järnvägsbron.
    const toTarget = distanceTo(pos, BRIDGES.stridsbergsbron);
    expect(toTarget).toBeGreaterThan(STATUS_HYSTERESIS.WAITING_SET_DISTANCE);
    expect(toTarget).toBeLessThanOrEqual(STATUS_HYSTERESIS.WAITING_CLEAR_DISTANCE);
    expect(pos.lat).toBeLessThan(BRIDGES.jarnvagsbron.lat);

    const vessel = vesselAt(pos, {
      status: 'waiting',
      waitingAtBridge: 'Järnvägsbron',
      targetBridge: 'Stridsbergsbron',
      currentBridge: 'Järnvägsbron',
      _routeDirection: 'north',
      passedBridges: ['Olidebron', 'Klaffbron'],
    });
    const result = statusService.analyzeVesselStatus(vessel, proximityService.analyzeVesselProximity(vessel));

    expect(result.status).toBe('waiting');
    expect(result.waitingAtBridge).toBe('Järnvägsbron');
  });

  test('väntan vid målbron behåller släppgränsen 350 m (hysteresen består)', () => {
    const pos = southOf(BRIDGES.klaffbron, 320);
    const vessel = vesselAt(pos, {
      status: 'waiting',
      waitingAtBridge: 'Klaffbron',
      targetBridge: 'Klaffbron',
      _routeDirection: 'north',
      passedBridges: ['Olidebron'],
    });
    const result = statusService.analyzeVesselStatus(vessel, proximityService.analyzeVesselProximity(vessel));

    expect(result.status).toBe('waiting');
    expect(result.waitingAtBridge).toBe('Klaffbron');
  });

  test('väntan utan bokförd bro räknas som väntan vid målbron (tidigare beteende)', () => {
    const pos = southOf(BRIDGES.klaffbron, 320);
    const vessel = vesselAt(pos, {
      status: 'waiting',
      waitingAtBridge: null,
      targetBridge: 'Klaffbron',
      _routeDirection: 'north',
      passedBridges: ['Olidebron'],
    });
    const prox = proximityService.analyzeVesselProximity(vessel);

    expect(statusService._isWaiting(vessel, prox)).toBe(true);
    expect(statusService._lastWaitingBridgeName).toBe('Klaffbron');
  });
});
