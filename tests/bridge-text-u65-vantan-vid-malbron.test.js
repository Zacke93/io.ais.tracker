'use strict';

// U65 (ägarens beslut 2026-11-24): en båt med köbeviset vid sin målbro
// (bridgeQueue.waitingBridge(vessel) === vessel.targetBridge) visas som
// "En båt väntar vid <målbro>" i en egen väntgrupp, före gruppen under gång
// mot samma bro. Ersätter U1/U6 (2026-08-08) och beslutet 2026-09-12, där
// samma kö gav målgruppen "beräknad broöppning strax". Köbeviset, statusarna
// och imminent-flaggan är oförändrade; bara texten och de delar som frågar
// texten (vesselSaysStrax, presentedLead) följer.

jest.mock('homey');
const App = require('../app');
const BridgeTextService = require('../lib/services/BridgeTextService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const { BRIDGES, BRIDGE_TEXT_CONSTANTS } = require('../lib/constants');
const { waitingBridge, waitingBridgeForText } = require('../lib/utils/bridgeQueue');

const NOW = Date.parse('2026-11-24T10:00:00Z');
const STRAX = 'beräknad broöppning strax';

// En punkt `meters` från bron längs kanalen (bäring ~40°; positivt = norrut).
function along(bridge, meters) {
  const rad = (40 * Math.PI) / 180;
  return {
    lat: bridge.lat + (meters * Math.cos(rad)) / 111320,
    lon: bridge.lon + (meters * Math.sin(rad)) / (111320 * Math.cos((bridge.lat * Math.PI) / 180)),
  };
}

const makeService = (vesselDataService = null) => new BridgeTextService(
  new BridgeRegistry(BRIDGES), { debug: jest.fn(), error: jest.fn(), log: jest.fn() }, null, vesselDataService, null,
);

// En båt som ligger stilla i kö före `queueAt` på väg mot `target`, i 20 min.
function queued(mmsi, target, queueAt, metersBefore, direction, overrides = {}) {
  const bridge = Object.values(BRIDGES).find((b) => b.name === queueAt);
  const pos = along(bridge, direction === 'south' ? metersBefore : -metersBefore);
  return {
    mmsi,
    name: `B${mmsi}`,
    targetBridge: target,
    status: 'waiting',
    etaMinutes: 4,
    sog: 0,
    cog: direction === 'south' ? 220 : 40,
    navStatus: 0,
    lat: pos.lat,
    lon: pos.lon,
    timestamp: NOW,
    lastPositionUpdate: NOW,
    passedBridges: [],
    _routeDirection: direction,
    _stationarySince: NOW - 20 * 60000,
    _stillnessAnchor: { lat: pos.lat, lon: pos.lon, t: NOW - 20 * 60000 },
    _bridgeQueueApproaches: {
      [queueAt]: {
        confirmedAt: NOW - 21 * 60000,
        direction,
        waitConfirmedAt: NOW - 19 * 60000,
        textWaitConfirmedAt: NOW - 19 * 60000,
      },
    },
    _isImminentAtTargetBridge: true,
    ...overrides,
  };
}

// En båt under gång mot målbron, utan kö.
function moving(mmsi, target, etaMinutes, metersBefore, direction, overrides = {}) {
  const bridge = Object.values(BRIDGES).find((b) => b.name === target);
  const pos = along(bridge, direction === 'south' ? metersBefore : -metersBefore);
  return {
    mmsi,
    name: `M${mmsi}`,
    targetBridge: target,
    status: 'en-route',
    etaMinutes,
    sog: 5,
    cog: direction === 'south' ? 220 : 40,
    lat: pos.lat,
    lon: pos.lon,
    timestamp: NOW,
    lastPositionUpdate: NOW,
    passedBridges: [],
    _routeDirection: direction,
    _isImminentAtTargetBridge: false,
    ...overrides,
  };
}

describe('U65: väntan vid målbron ger vänttext', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockImplementation(() => NOW));
  afterEach(() => jest.restoreAllMocks());

  test('förutsättning: fixturen har köbeviset vid målbron', () => {
    expect(waitingBridge(queued('1', 'Stridsbergsbron', 'Stridsbergsbron', 150, 'south'))).toBe('Stridsbergsbron');
    expect(waitingBridge(queued('2', 'Klaffbron', 'Klaffbron', 150, 'north'))).toBe('Klaffbron');
    expect(waitingBridgeForText(queued('3', 'Stridsbergsbron', 'Järnvägsbron', 150, 'north'))).toBe('Järnvägsbron');
  });

  test('en väntande båt: "En båt väntar vid Stridsbergsbron"', () => {
    const v = queued('1', 'Stridsbergsbron', 'Stridsbergsbron', 150, 'south');
    expect(makeService().generateBridgeText([v])).toBe('En båt väntar vid Stridsbergsbron');
  });

  test('flera väntande: "Två båtar väntar vid Klaffbron"', () => {
    const a = queued('1', 'Klaffbron', 'Klaffbron', 120, 'north');
    const b = queued('2', 'Klaffbron', 'Klaffbron', 220, 'north', { _isImminentAtTargetBridge: false });
    expect(makeService().generateBridgeText([a, b])).toBe('Två båtar väntar vid Klaffbron');
  });

  test('väntgrupp före gruppen under gång mot samma bro, och väntaren ger inte gruppen "strax"', () => {
    const w = queued('1', 'Stridsbergsbron', 'Stridsbergsbron', 150, 'south', { etaMinutes: 1 });
    const m = moving('2', 'Stridsbergsbron', 7, 1500, 'south');
    expect(makeService().generateBridgeText([m, w])).toBe(
      'En båt väntar vid Stridsbergsbron; En båt på väg mot Stridsbergsbron, beräknad broöppning om 7 minuter',
    );
  });

  test('båtar under gång behåller sin egen klausul: "strax" via imminent-flaggan, ETA < 3 och "ETA okänd"', () => {
    const w = queued('1', 'Stridsbergsbron', 'Stridsbergsbron', 150, 'south');
    const svc = makeService();
    expect(svc.generateBridgeText([w, moving('2', 'Stridsbergsbron', 6, 280, 'south', { _isImminentAtTargetBridge: true })]))
      .toBe(`En båt väntar vid Stridsbergsbron; En båt på väg mot Stridsbergsbron, ${STRAX}`);
    expect(svc.generateBridgeText([w, moving('3', 'Stridsbergsbron', 2, 600, 'south')]))
      .toBe(`En båt väntar vid Stridsbergsbron; En båt på väg mot Stridsbergsbron, ${STRAX}`);
    expect(svc.generateBridgeText([w, moving('4', 'Stridsbergsbron', null, 2000, 'south')]))
      .toBe('En båt väntar vid Stridsbergsbron; En båt på väg mot Stridsbergsbron, ETA okänd');
    expect(svc.generateBridgeText([w, moving('5', 'Stridsbergsbron', 12, 2500, 'south'),
      moving('6', 'Stridsbergsbron', 20, 3500, 'south')]))
      .toBe('En båt väntar vid Stridsbergsbron; Två båtar på väg mot Stridsbergsbron, beräknad broöppning om 12 minuter');
  });

  test('båda målbroarna samtidigt: Klaffbrons fraser först', () => {
    const s = queued('1', 'Stridsbergsbron', 'Stridsbergsbron', 150, 'south');
    const k = queued('2', 'Klaffbron', 'Klaffbron', 150, 'north');
    const km = moving('3', 'Klaffbron', 9, 1800, 'north');
    expect(makeService().generateBridgeText([s, km, k])).toBe(
      'En båt väntar vid Klaffbron; En båt på väg mot Klaffbron, beräknad broöppning om 9 minuter; '
      + 'En båt väntar vid Stridsbergsbron',
    );
  });

  test('kö vid mellanbro samtidigt som kö vid målbron: målbrons kö först, oberoende av ordningen in', () => {
    const atTarget = queued('1', 'Stridsbergsbron', 'Stridsbergsbron', 150, 'north');
    const atJvb = queued('2', 'Stridsbergsbron', 'Järnvägsbron', 150, 'north');
    const expected = 'En båt väntar vid Stridsbergsbron; En båt väntar vid Järnvägsbron på väg mot Stridsbergsbron';
    expect(makeService().generateBridgeText([atJvb, atTarget])).toBe(expected);
    expect(makeService().generateBridgeText([atTarget, atJvb])).toBe(expected);
    expect(makeService().generateBridgeText([atJvb, moving('3', 'Stridsbergsbron', 15, 2500, 'north'), atTarget]))
      .toBe(`${expected}; En båt på väg mot Stridsbergsbron, beräknad broöppning om 15 minuter`);
  });

  test('öppning pågår: köbeviset släpper och båten går tillbaka till gruppen under gång med "strax"', () => {
    const v = queued('1', 'Stridsbergsbron', 'Stridsbergsbron', 150, 'south', {
      _bridgeOpeningBridgeName: 'Stridsbergsbron', _bridgeOpeningUntil: NOW + 60000,
    });
    expect(waitingBridge(v)).toBeNull();
    expect(makeService().generateBridgeText([v])).toBe(`En båt på väg mot Stridsbergsbron, ${STRAX}`);
  });

  test('båten sätter fart: köbeviset släpper, imminent-flaggan ger "strax"', () => {
    const v = queued('1', 'Stridsbergsbron', 'Stridsbergsbron', 150, 'south', { sog: 2.5 });
    expect(waitingBridge(v)).toBeNull();
    expect(makeService().generateBridgeText([v])).toBe(`En båt på väg mot Stridsbergsbron, ${STRAX}`);
  });

  test('gammal position (11 min): inget köbevis och ingen "strax", texten blir "ETA okänd"', () => {
    const old = NOW - 11 * 60000;
    const v = queued('1', 'Stridsbergsbron', 'Stridsbergsbron', 150, 'south', {
      timestamp: old, lastPositionUpdate: old, etaMinutes: null,
    });
    expect(waitingBridge(v)).toBeNull();
    expect(makeService().generateBridgeText([v])).toBe('En båt på väg mot Stridsbergsbron, ETA okänd');
  });

  test('zombie (målbron redan i passedBridges): ingen vänttext och ingen "strax"', () => {
    const v = queued('1', 'Stridsbergsbron', 'Stridsbergsbron', 150, 'south', { passedBridges: ['Stridsbergsbron'] });
    expect(waitingBridge(v)).toBeNull();
    expect(makeService().generateBridgeText([v])).toBe('En båt på väg mot Stridsbergsbron, ETA okänd');
  });

  test('GPS-hållen båt: filtreras utan includeGpsHeld; med GPS-hoppsflaggan på själva båten finns inget köbevis', () => {
    const vds = { hasGpsJumpHold: (mmsi) => mmsi === '1' };
    const v = queued('1', 'Stridsbergsbron', 'Stridsbergsbron', 150, 'south');
    expect(makeService(vds).generateBridgeText([v])).toBe(BRIDGE_TEXT_CONSTANTS.DEFAULT_MESSAGE);
    // Appens presentationskopia (förra publicerade underlaget) bär köbeviset.
    expect(makeService(vds).generateBridgeText([v], { includeGpsHeld: true })).toBe('En båt väntar vid Stridsbergsbron');
    const jumped = { ...v, _gpsJumpDetected: true };
    expect(makeService(vds).generateBridgeText([jumped], { includeGpsHeld: true }))
      .toBe(`En båt på väg mot Stridsbergsbron, ${STRAX}`);
  });

  test('räkneordet räknar varje båt en gång (count-validatorns summa är oförändrad)', () => {
    const vs = [
      queued('1', 'Stridsbergsbron', 'Stridsbergsbron', 120, 'south'),
      queued('2', 'Stridsbergsbron', 'Stridsbergsbron', 200, 'south'),
      queued('3', 'Stridsbergsbron', 'Järnvägsbron', 150, 'north'),
      moving('4', 'Stridsbergsbron', 8, 2000, 'south'),
      moving('5', 'Klaffbron', 5, 1500, 'north'),
    ];
    const text = makeService().generateBridgeText(vs);
    expect(text).toBe('En båt på väg mot Klaffbron, beräknad broöppning om 5 minuter; '
      + 'Två båtar väntar vid Stridsbergsbron; En båt väntar vid Järnvägsbron på väg mot Stridsbergsbron; '
      + 'En båt på väg mot Stridsbergsbron, beräknad broöppning om 8 minuter');
    const app = Object.create(App.prototype);
    expect(app._extractVesselCounts(text).totalMentioned).toBe(vs.length);
  });
});

describe('U65: delarna som frågar texten', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockImplementation(() => NOW));
  afterEach(() => jest.restoreAllMocks());

  test('vesselSaysStrax: aldrig för en båt i kö vid målbron, också med imminent-flaggan', () => {
    const svc = makeService();
    const v = queued('1', 'Stridsbergsbron', 'Stridsbergsbron', 60, 'south', { etaMinutes: 0.5 });
    expect(svc.vesselSaysStrax(v, 'Stridsbergsbron')).toBe(false);
    // När köbeviset släpper (fart) säger texten "strax" genom flaggan igen.
    expect(svc.vesselSaysStrax({ ...v, sog: 2.5 }, 'Stridsbergsbron')).toBe(true);
    // En båt under gång påverkas inte.
    expect(svc.vesselSaysStrax(moving('2', 'Stridsbergsbron', 2, 200, 'south'), 'Stridsbergsbron')).toBe(true);
  });

  test('presentedLead: en väntande båt leder aldrig; bara båtar under gång', () => {
    const svc = makeService();
    const w = queued('1', 'Stridsbergsbron', 'Stridsbergsbron', 150, 'south', { etaMinutes: 1 });
    const m = moving('2', 'Stridsbergsbron', 7, 1500, 'south');
    expect(svc.presentedLead([w, m], 'Stridsbergsbron').mmsi).toBe('2');
    expect(svc.presentedLead([w], 'Stridsbergsbron')).toBeNull();
  });

  test('appen: notisens restid följer inte "strax" för en båt i kö vid målbron', () => {
    const app = new App();
    app.log = jest.fn(); app.debug = jest.fn(); app.error = jest.fn();
    app.bridgeRegistry = new BridgeRegistry();
    app.vesselDataService = { hasGpsJumpHold: () => false };
    app.bridgeTextService = makeService(app.vesselDataService);
    app.statusService = { isBraking: () => false };
    // 60 m före bron i 0,8 kn: köbeviset (waitConfirmedAt, under 1 kn) står,
    // restiden är 1,5 min, och imminent-flaggan skulle sättas (≤ 300 m).
    const v = queued('1', 'Stridsbergsbron', 'Stridsbergsbron', 60, 'south', { sog: 0.8, etaMinutes: 1.5 });
    expect(waitingBridge(v)).toBe('Stridsbergsbron');
    expect(app._noticeStraxTravelMinutes(v, 'Stridsbergsbron', 60)).toBeNull();
    // Samma båt utan köbevis (under gång) får restiden som förut (U33).
    const m = { ...v, _bridgeQueueApproaches: {}, _stationarySince: null };
    expect(waitingBridge(m)).toBeNull();
    expect(app._noticeStraxTravelMinutes(m, 'Stridsbergsbron', 60)).toBeCloseTo(60 / (0.8 * 0.5144) / 60, 5);
  });
});

describe('U65 i appens publiceringsväg: GPS-hållen båt i kö vid målbron', () => {
  let app;
  let held;

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockImplementation(() => NOW);
    held = new Set();
    app = new App();
    app.log = jest.fn(); app.debug = jest.fn(); app.error = jest.fn();
    app._isConnected = true; app._lastConnectionLost = null;
    app._updateDeviceCapability = jest.fn(); app._globalBridgeTextToken = null;
    app._lastBridgeTextVessels = new Map();
    app.vesselDataService = { hasGpsJumpHold: (mmsi) => held.has(mmsi) };
    app.bridgeRegistry = new BridgeRegistry();
    app.bridgeTextService = new BridgeTextService(app.bridgeRegistry, app, null, app.vesselDataService);
  });

  afterEach(() => jest.restoreAllMocks());

  async function publish(vessels) {
    await app._processUIUpdate({
      relevantVessels: vessels,
      vesselCount: vessels.length,
      vesselsBeingRemoved: new Set(),
      timestamp: Date.now(),
    });
    return app._lastBridgeText;
  }

  test('vänttexten står kvar genom hållningen (förra underlaget), och ett hopp på båten ändrar inte den', async () => {
    const v = queued('1', 'Stridsbergsbron', 'Stridsbergsbron', 150, 'south');
    expect(await publish([v])).toBe('En båt väntar vid Stridsbergsbron');
    held.add('1');
    const jumped = {
      ...v, lat: v.lat + 0.01, _gpsJumpDetected: true, _isImminentAtTargetBridge: false,
    };
    expect(await publish([jumped])).toBe('En båt väntar vid Stridsbergsbron');
  });
});
