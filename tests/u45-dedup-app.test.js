'use strict';

jest.mock('homey');

/**
 * U45 I APPEN: EN SLÄPPT MEDLEMS NYA KORT TYSTAS INTE AV DEN GAMLA ANKOMSTEN
 * =============================================================================
 * Den beständiga dedupspärren (bro|mmsi|riktning, arrivalActive) tystar ett
 * nytt kort för en båt som redan varnats för samma ankomst. När en annan båt
 * har använt den öppning hon varnades för (U45) släpper öppningstjänsten
 * henne och lägger hennes mmsi i payloadens reopenedMmsis. Appen släpper då
 * hennes gamla spärr, som vid hennes egen passage (J15), och kortet går ut.
 * Utan fältet tystas kortet som förut (motfallet).
 */

// 'homey' före '../app' (se bridge-opening-app-integration.test.js).
const { __mockHomey: mockHomey } = require('homey');
const AISBridgeApp = require('../app');

const bootApp = async () => {
  const app = new AISBridgeApp();
  app.homey = mockHomey;
  mockHomey.app.settings = { debug_level: 'off', ais_api_key: null };
  mockHomey.settings = {
    get: (key) => mockHomey.app.settings[key] || null,
    set: (key, value) => {
      mockHomey.app.settings[key] = value;
    },
    on: () => {},
    off: () => {},
  };
  global.__TEST_MODE__ = true;
  await app.onInit();
  return app;
};

const withRealFlowGate = async (fn) => {
  const savedEnv = process.env.NODE_ENV;
  const savedMode = global.__TEST_MODE__;
  process.env.NODE_ENV = 'production';
  global.__TEST_MODE__ = undefined;
  try {
    return await fn();
  } finally {
    process.env.NODE_ENV = savedEnv;
    global.__TEST_MODE__ = savedMode;
  }
};

const payloadFor = (overrides = {}) => ({
  t: Date.now(),
  eventId: 'Klaffbron#15',
  bridge: 'Klaffbron',
  direction: 'southbound',
  eventDirection: 'southbound',
  memberDirections: { 265689820: 'southbound' },
  etaMinutes: null,
  vesselCount: 1,
  leadVessel: 'BEAUTYFIELD',
  leadMmsi: '265689820',
  firedBy: 'deadline',
  mmsis: ['265689820'],
  distanceM: 1320,
  ...overrides,
});

describe('U45: reopenedMmsis släpper den gamla ankomstens dedupspärr', () => {
  let app = null;

  afterEach(async () => {
    if (app) await app.onUninit();
    app = null;
    delete global.__TEST_MODE__;
  });

  test('[FÄLLER] det nya kortet för den släppta medlemmen går ut', async () => {
    app = await bootApp();
    const card = app._bridgeOpeningTrigger;
    card.clearTriggerCalls();
    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payloadFor());
      await Promise.resolve();
    });
    expect(card.getTriggerCalls()).toHaveLength(1);
    let result;
    await withRealFlowGate(async () => {
      result = app._onBridgeOpeningWarning(payloadFor({
        eventId: 'Klaffbron#20', distanceM: 1417, reopenedMmsis: ['265689820'],
      }));
      await Promise.resolve();
    });
    expect(result?.suppressed).toBeUndefined();
    expect(card.getTriggerCalls()).toHaveLength(2);
    // Den nya ankomsten har en egen spärr.
    expect(app._persistentOpeningWarnings.get('Klaffbron|265689820|southbound')?.arrivalActive).toBe(true);
  });

  test('motfall: utan reopenedMmsis tystas kortet som förut (samma ankomst)', async () => {
    app = await bootApp();
    const card = app._bridgeOpeningTrigger;
    card.clearTriggerCalls();
    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payloadFor());
      await Promise.resolve();
    });
    let result;
    await withRealFlowGate(async () => {
      result = app._onBridgeOpeningWarning(payloadFor({ eventId: 'Klaffbron#20', distanceM: 1417 }));
      await Promise.resolve();
    });
    expect(result?.suppressed).toBe('same-arrival');
    expect(card.getTriggerCalls()).toHaveLength(1);
  });

  test('motfall: reopenedMmsis släpper bara spärren för en båt som är med i kortet', async () => {
    app = await bootApp();
    const card = app._bridgeOpeningTrigger;
    card.clearTriggerCalls();
    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payloadFor());
      await Promise.resolve();
    });
    await withRealFlowGate(async () => {
      app._onBridgeOpeningWarning(payloadFor({
        eventId: 'Klaffbron#21',
        leadMmsi: '111',
        leadVessel: 'ANNAN',
        mmsis: ['111'],
        memberDirections: { 111: 'southbound' },
        reopenedMmsis: ['265689820'],
      }));
      await Promise.resolve();
    });
    expect(card.getTriggerCalls()).toHaveLength(2);
    expect(app._persistentOpeningWarnings.has('Klaffbron|265689820|southbound')).toBe(true);
  });
});

/**
 * VARV 3 (granskningens anmärkning 1): ANTARES-förloppet genom appens dedup.
 * M1 och M2 varnas tillsammans; H passerar; efter fönstret släpps båda av U45,
 * M1 seedar en ny händelse som varnas och M2 absorberas i den. M2 är tyst över
 * bron. När hennes täckning löper ut ger U17 en säkerhetsvarning för henne.
 * Förut bar hon kvar foreignReleasedFrom, kortet bad appen öppna hennes gamla
 * spärr och gick ut efter passagen (ANTARES 11:44:44 i 20260710-13h). Nu är
 * säkerhetsvarningen samma ankomst för appen och tystas.
 */
describe('U45 varv 3: U17-varningen för en släppt och absorberad båt tystas som samma ankomst', () => {
  const BridgeOpeningService = require('../lib/services/BridgeOpeningService');
  const { BRIDGES, BRIDGE_OPENING } = require('../lib/constants');
  const KLAFF = BRIDGES.klaffbron;
  const T0 = 1_700_000_000_000; const S = 1000; const KN = 0.514444;
  const pos = (d, bearing) => {
    const r = (bearing * Math.PI) / 180;
    return {
      lat: KLAFF.lat + (d * Math.cos(r)) / 111320,
      lon: KLAFF.lon + (d * Math.sin(r)) / (111320 * Math.cos((KLAFF.lat * Math.PI) / 180)),
    };
  };
  const boat = (mmsi, dir, d, sog, beyond = false) => {
    const approach = dir === 'north' ? 220 : 40;
    const p = pos(d, beyond ? (approach + 180) % 360 : approach);
    const now = Date.now();
    return {
      mmsi,
      name: mmsi,
      lat: p.lat,
      lon: p.lon,
      sog,
      cog: dir === 'north' ? 40 : 220,
      timestamp: now,
      fixTs: now,
      lastPositionUpdate: now,
      targetBridge: 'Klaffbron',
      _routeDirection: dir,
      _finalTargetDirection: null,
      _hasMovementProof: true,
      _moored: false,
      _stationarySince: null,
      navStatus: null,
      etaMinutes: null,
      passedAt: {},
      passedBridges: [],
    };
  };

  test('[FÄLLER] inget kort efter passagen för den absorberade båten', async () => {
    const savedEnv = process.env.NODE_ENV;
    const savedMode = global.__TEST_MODE__;
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    const app = new AISBridgeApp();
    app.log = jest.fn(); app.debug = jest.fn(); app.error = jest.fn();
    app._firedOpeningEvents = new Map();
    app._OPENING_DEDUP_TTL_MS = 60 * 60 * 1000;
    app._persistentOpeningWarnings = new Map();
    app._knownVesselNames = new Map();
    app.homey = { settings: { get: () => null, set: () => {} } };
    const trigger = jest.fn(() => Promise.resolve());
    app._bridgeOpeningTrigger = { trigger };
    const results = [];
    const svc = new BridgeOpeningService({
      logger: {
        debug() {}, log() {}, error() {}, warn() {},
      },
      onWarning: (p) => {
        const r = app._onBridgeOpeningWarning(p); results.push({ p, r }); return r;
      },
      targetBridges: ['Klaffbron'],
    });
    const timer = setInterval(() => svc.tick(), BRIDGE_OPENING.TICK_INTERVAL_MS);
    const at = (s, fn) => {
      const t = T0 + s * S; if (t > Date.now()) jest.advanceTimersByTime(t - Date.now()); fn();
    };
    process.env.NODE_ENV = 'production';
    global.__TEST_MODE__ = undefined;
    try {
      const v5 = 5 * KN;
      // M1 och M2 varnas tillsammans långt ute (samma ankomst, krypfart).
      at(0, () => {
        svc.observeVessel(boat('111', 'north', 1100, 1.2)); svc.observeVessel(boat('222', 'north', 1120, 1.2));
      });
      at(60, () => {
        svc.observeVessel(boat('111', 'north', 1063, 1.2)); svc.observeVessel(boat('222', 'north', 1083, 1.2));
      });
      // H (söderut, egen händelse) korsar ≈ 550 s.
      at(200, () => svc.observeVessel(boat('333', 'south', 900, 5)));
      at(380, () => svc.observeVessel(boat('333', 'south', 900 - 180 * v5, 5)));
      at(610, () => svc.observeVessel(boat('333', 'south', 60 * v5, 5, true)));
      // Efter fönstret (≈ 1150 s): M1 och M2 i 5 kn, släpps på egna fix.
      at(1200, () => svc.observeVessel(boat('111', 'north', 900, 5)));
      at(1210, () => svc.observeVessel(boat('222', 'north', 960, 5)));
      // M1 går in och bokförs; M2 tystnar och korsar osedd ≈ 1583 s.
      at(1560, () => svc.observeVessel(boat('111', 'north', 900 - 360 * v5 - 0, 5)));
      at(1600, () => svc.observeVessel(boat('111', 'north', 40 * v5, 5, true)));
      // Hennes täckning löper ut; U17:s säkerhetsvarning avfyras i servicen.
      at(2700, () => {});
      await Promise.resolve();
    } finally {
      process.env.NODE_ENV = savedEnv;
      global.__TEST_MODE__ = savedMode;
      clearInterval(timer);
      svc.destroy();
      jest.useRealTimers();
    }
    const forM2 = results.filter(({ p }) => (p.mmsis || []).map(String).includes('222'));
    // M2:s första kort (med M1) och den sena säkerhetsvarningen.
    expect(forM2.length).toBeGreaterThanOrEqual(2);
    const late = forM2[forM2.length - 1];
    expect(late.p.mmsis.map(String)).toEqual(['222']);
    expect(late.p.reopenedMmsis).toBeUndefined();
    expect(late.r?.suppressed).toBe('same-arrival');
    // Inget kort nådde kortet för henne efter hennes passage (≈ 1583 s).
    const sent = trigger.mock.calls.map(([, state]) => state).filter((st) => (st.mmsis || []).map(String).includes('222'));
    expect(sent.every((st) => st.eventId !== late.p.eventId)).toBe(true);
  });
});
