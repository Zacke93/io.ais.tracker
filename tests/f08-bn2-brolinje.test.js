'use strict';

jest.mock('homey');

const { __mockHomey: mockHomey } = require('homey');
const AISBridgeApp = require('../app');
const { BRIDGES } = require('../lib/constants');
const geometry = require('../lib/utils/geometry');

/**
 * F08 (buggjägarens nattprofil 2026-11-16, värld 16517): BN2
 * (_hasGapCrossedNotifiedBridge) jämförde brons LATITUD. Brolinjerna går snett
 * (axel 130°, vid Stallbackabron 142°), så latitudlinjen genom brons punkt
 * avviker från brolinjen med 0,84 m (130°) respektive 1,28 m (142°) längs
 * kanalaxeln per meter i sidled. BRISEN låg 13 m FÖRE Stallbackabrons linje
 * (18 m åt nordväst i sidled) men norr om brons latitud, fick "passerade
 * Stallbackabron under AIS-tystnad", och den riktiga korsningen 104 s senare
 * gav en returnotis: två notiser för en passage. Åt andra hållet fick en båt
 * förbi linjen förvarningsform.
 *
 * Nu avgör brolinjen (geometry.decisiveBridgeSide, ±10 m) när positionen ligger
 * entydigt på en sida; inom ±10 m från linjen gäller latitudsvaret som förut.
 */
const MMSI = '265498596';

/** Position d m från brolinjen längs kanalaxeln och L m i sidled längs linjen. */
const at = (bridge, d, L = 0) => {
  const pe = ((bridge.axisBearing - 90) * Math.PI) / 180;
  const ax = (bridge.axisBearing * Math.PI) / 180;
  const n = d * Math.cos(pe) + L * Math.cos(ax);
  const e = d * Math.sin(pe) + L * Math.sin(ax);
  return { lat: bridge.lat + n / 111320, lon: bridge.lon + e / (111320 * Math.cos((bridge.lat * Math.PI) / 180)) };
};

/** Dagens regel före rättningen: brons latitud strikt mellan positionerna. */
const latitudeRule = (bridge, from, pos, travel) => bridge.lat > Math.min(from.lat, pos.lat)
  && bridge.lat < Math.max(from.lat, pos.lat)
  && ((pos.lat > from.lat && travel === 'north') || (pos.lat < from.lat && travel === 'south'));

describe('F08: BN2 prövar brolinjen, inte brons latitud', () => {
  let apps;
  let savedTestMode;

  const boot = async () => {
    const store = {};
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app.homey = {
      ...mockHomey,
      settings: {
        get: (key) => (store[key] === undefined ? undefined : JSON.parse(JSON.stringify(store[key]))),
        set: jest.fn((key, value) => {
          store[key] = JSON.parse(JSON.stringify(value));
        }),
        on: jest.fn(),
        off: jest.fn(),
      },
    };
    await app.onInit();
    apps.push(app);
    jest.spyOn(app._boatNearTrigger, 'trigger');
    return app;
  };

  const vessel = (pos, from, travel, extra = {}) => ({
    mmsi: MMSI,
    name: 'BRISEN',
    ...pos,
    lastPosition: { ...from },
    sog: 7.4,
    cog: travel === 'north' ? 30 : 210,
    _routeDirection: travel,
    targetBridge: null,
    status: 'en-route',
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    ...extra,
  });

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-03T10:01:22.619Z'));
    savedTestMode = global.__TEST_MODE__;
    global.__TEST_MODE__ = true;
    apps = [];
  });

  afterEach(async () => {
    for (const app of apps) {
      // eslint-disable-next-line no-await-in-loop
      if (!app._shuttingDown) await app.onUninit();
    }
    await jest.advanceTimersByTimeAsync(0);
    global.__TEST_MODE__ = savedTestMode;
    jest.useRealTimers();
  });

  test('BRISEN-fallet med fältets positioner: förvarningsform, en notis', async () => {
    const app = await boot();
    const from = { lat: 58.30459911623467, lon: 12.30847597546097 };
    const pos = { lat: 58.30985528617945, lon: 12.316380504666265 };
    const stall = BRIDGES.stallbackabron;
    expect(geometry.bridgeLineOffsetM(pos, stall)).toBeCloseTo(-13.3, 1);
    expect(pos.lat).toBeGreaterThan(stall.lat);
    const v = vessel(pos, from, 'north');
    const candidate = {
      name: 'Stallbackabron', id: 'stallbackabron', distance: 22, source: 'current',
    };
    expect(app._hasGapCrossedNotifiedBridge(v, candidate, 'current')).toBe(false);
    await app._triggerBoatNearFlowForBridge(v, candidate);
    const [[tokens]] = app._boatNearTrigger.trigger.mock.calls;
    expect(tokens.already_passed).toBe(false);
    expect(tokens.message).toMatch(/^BRISEN närmar sig Stallbackabron/);
  });

  // [bro, färd, d (m från linjen, + = nordöstra sidan), sidled L (m), före, efter]
  // Hoppet börjar 1 000 m före linjen (över 0,005° i latitud). Sidledet ±20 m (130°) och
  // ±18 m (Stallbackabron, fältfallet) ligger inom bankens spridning vid
  // linjen (Klaffbron −30…+30 m, p1–p99; Stallbackabron −25…+19 m, p1–p90).
  const CASES = [];
  for (const key of ['olidebron', 'klaffbron', 'jarnvagsbron', 'stridsbergsbron', 'stallbackabron']) {
    const b = BRIDGES[key];
    const L = b.axisBearing === 142 ? 18 : 20;
    CASES.push(
      // Kilen FÖRE linjen (latituden säger passerad): F08-dubbletten.
      [b.name, 'north', -13, -L, true, false],
      [b.name, 'south', 13, L, true, false],
      // Kilen FÖRBI linjen (latituden säger inte passerad): förvarning efter passagen.
      [b.name, 'north', 13, L, false, true],
      [b.name, 'south', -13, -L, false, true],
      // Inom ±10 m: latitudsvaret står kvar.
      [b.name, 'north', -8, -L, true, true],
      [b.name, 'south', 8, L, true, true],
      // Utanför kilen: ingen skillnad.
      [b.name, 'north', 160, 0, true, true],
      [b.name, 'south', -160, 0, true, true],
      [b.name, 'north', -160, 0, false, false],
    );
  }

  test.each(CASES)('%s %s d=%s m sidled=%s m: före %s, efter %s', async (name, travel, d, L, before, after) => {
    const app = await boot();
    const b = Object.values(BRIDGES).find((x) => x.name === name);
    const from = at(b, travel === 'north' ? -1000 : 1000);
    const pos = at(b, d, L);
    expect(latitudeRule(b, from, pos, travel)).toBe(before);
    expect(app._hasGapCrossedNotifiedBridge(vessel(pos, from, travel), { name }, 'current')).toBe(after);
  });

  test('återresa: båten på tillfartssidan för sin färdriktning behåller förvarningen', async () => {
    const app = await boot();
    const b = BRIDGES.stridsbergsbron;
    // Söderut från 700 m norr om linjen till 160 m norr om den: bron ligger framför.
    const v = vessel(at(b, 160), at(b, 700), 'south');
    expect(app._hasGapCrossedNotifiedBridge(v, { name: b.name }, 'current')).toBe(false);
  });

  test('återfödd båt vars sist kända position redan låg bortom linjen: latitudsvaret som förut', async () => {
    const app = await boot();
    const b = BRIDGES.stridsbergsbron;
    // Sist känd 15 m förbi linjen men söder om latituden (sidled +20 m), nu 130 m förbi.
    const lastKnown = at(b, 15, 20);
    const pos = at(b, 130);
    app._lastKnownPositions.set(MMSI, { ...lastKnown, t: Date.now() - 10 * 60 * 1000 });
    const v = vessel(pos, lastKnown, 'north', { lastPosition: null });
    expect(latitudeRule(b, lastKnown, pos, 'north')).toBe(true);
    expect(app._hasGapCrossedNotifiedBridge(v, { name: b.name }, 'current')).toBe(true);
  });
});
