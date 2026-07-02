'use strict';

/**
 * Regressionstester för 19h-auditens rotorsaker (docs/bug-audit-2026-06-10.md).
 * RC1: STALE_AIS mäter senast MOTTAGNA meddelande, inte frusen positionsklocka
 * RC2: INFERRED Järnvägsbron-passage ENDAST vid TARGET_END
 * RC3: failsafe-stale-skattning: ankrad tid exakt / maxRecentSpeed-skattning
 * RC4: publicerings-clamp mot ETA-sågtand
 * RC7: stale-exklusion (>10 min) ur bridge_text-underlaget
 * RC8: 30-min minimum removal-timeout vid aktiv resa
 * RC9: bakåt-inferens av missad målbro-passage
 */

jest.mock('homey');

const AISBridgeApp = require('../app');
const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const ProximityService = require('../lib/services/ProximityService');

const logger = {
  debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
};

const liveServices = [];

function makeVDS() {
  const bridgeRegistry = new BridgeRegistry();
  const systemCoordinator = new SystemCoordinator(logger);
  const svc = new VesselDataService(logger, bridgeRegistry, systemCoordinator);
  svc.app = {
    gpsJumpGateService: null, passageLatchService: null, routeOrderValidator: null, debug: jest.fn(), log: jest.fn(), error: jest.fn(),
  };
  liveServices.push(svc);
  return svc;
}

beforeAll(() => {
  global.__TEST_MODE__ = true;
});

afterAll(() => {
  delete global.__TEST_MODE__;
});

afterEach(() => {
  // Rensa äkta timers (scheduleCleanup/_markPassageProcessed) — annars
  // hänger Jest-processen på öppna handles efter att testerna passerat.
  while (liveServices.length > 0) {
    const svc = liveServices.pop();
    try {
      svc.clearAllTimers();
    } catch (_) { /* tomt */ }
  }
  jest.clearAllMocks();
});

describe('RC1: STALE_AIS mäter senast mottagna meddelande', () => {
  test('frusen positionsklocka men färskt meddelande → skyddszonen håller kvar fartyget', () => {
    const svc = makeVDS();
    const mmsi = '220276000';
    svc.vessels.set(mmsi, {
      mmsi,
      lat: 58.28604, // ~240m från Klaffbron (inom skyddszonen)
      lon: 12.28571,
      targetBridge: null,
      passedBridges: [],
      lastPositionUpdate: Date.now() - 9 * 60 * 60 * 1000, // "9h" frusen klocka
      timestamp: Date.now() - 5 * 60 * 1000, // meddelande för 5 min sedan
    });

    svc.removeVessel(mmsi, 'timeout');

    expect(svc.vessels.has(mmsi)).toBe(true); // INTE stale-raderad
  });

  test('äkta total tystnad ≥30 min → stale-raderas trots skyddszon', () => {
    const svc = makeVDS();
    const mmsi = '265000999';
    svc.vessels.set(mmsi, {
      mmsi,
      lat: 58.28604,
      lon: 12.28571,
      targetBridge: null,
      passedBridges: [],
      lastPositionUpdate: Date.now() - 35 * 60 * 1000,
      timestamp: Date.now() - 35 * 60 * 1000, // även meddelanden tysta
    });

    svc.removeVessel(mmsi, 'timeout');

    expect(svc.vessels.has(mmsi)).toBe(false); // korrekt raderad
  });
});

describe('RC2: INFERRED Järnvägsbron-passage endast vid TARGET_END', () => {
  test('Klaffbron→Stridsbergsbron-transition infererar INTE Järnvägsbron (ligger framför)', () => {
    const svc = makeVDS();
    const vessel = {
      mmsi: '265576710', lat: 58.2845, lon: 12.2842, sog: 4, cog: 25, targetBridge: 'Klaffbron', passedBridges: [], _routeDirection: 'north',
    };
    const oldVessel = { ...vessel, targetBridge: 'Klaffbron' };

    svc._applyTargetTransition(vessel, oldVessel, 'Stridsbergsbron');

    expect(vessel.targetBridge).toBe('Stridsbergsbron');
    expect(vessel.passedBridges).not.toContain('Järnvägsbron'); // RC2!
  });

  test('TARGET_END vid Stridsbergsbron infererar Järnvägsbron (ligger bakom)', () => {
    const svc = makeVDS();
    const vessel = {
      mmsi: '265000001',
      lat: 58.2940,
      lon: 12.2950,
      sog: 4,
      cog: 25,
      targetBridge: 'Stridsbergsbron',
      passedBridges: ['Klaffbron'],
      _routeDirection: 'north',
      // S-F6 (2026-07-01): inferensen kräver att resan BÖRJADE bortom
      // Järnvägsbron i färdriktningen (norrgående: söder om 58.2916).
      _firstSeenLat: 58.2700,
    };
    const oldVessel = { ...vessel };

    svc._applyTargetTransition(vessel, oldVessel, null); // TARGET_END

    expect(vessel.passedBridges).toContain('Järnvägsbron'); // geometriskt nödvändig
  });

  test('S-F6: kajstart MELLAN broarna → ingen inferred Järnvägsbron', () => {
    const svc = makeVDS();
    // Södergående båt som lade ut från Kajen norr om Klaffbron (58.2857-64,
    // MELLAN Klaffbron 58.284 och Järnvägsbron 58.2916) — hon har ALDRIG
    // korsat Järnvägsbron; gamla inferensen gav falsk passedBridges-post och
    // falsk boat_near-notis via backfillen.
    const vessel = {
      mmsi: '265000002',
      lat: 58.2820,
      lon: 12.2850,
      sog: 4,
      cog: 190,
      targetBridge: 'Klaffbron',
      passedBridges: [],
      _routeDirection: 'south',
      _firstSeenLat: 58.2860, // kajen — söder om Järnvägsbron
    };
    const oldVessel = { ...vessel };

    svc._applyTargetTransition(vessel, oldVessel, null); // TARGET_END Klaffbron

    expect(vessel.passedBridges).not.toContain('Järnvägsbron');
    expect(vessel._passageBackfills || []).not.toContain('Järnvägsbron');
  });
});

describe('RC9: bakåt-inferens av missad målbro-passage', () => {
  test('detekterad Järnvägsbron-passage med target=Klaffbron (norrgående) → målbro-transition', () => {
    const svc = makeVDS();
    const vessel = {
      mmsi: '265576700', lat: 58.2920, lon: 12.2925, sog: 5, cog: 25, targetBridge: 'Klaffbron', passedBridges: [], _routeDirection: 'north', passedAt: {},
    };
    const oldVessel = {
      ...vessel, lat: 58.2905, lon: 12.2910,
    };
    // Simulera att detekteringen ser Järnvägsbron-passage (AIS-glapp hoppade över Klaffbron)
    svc._hasPassedBridge = jest.fn((v, o, bridge) => bridge.name === 'Järnvägsbron');

    svc._handleIntermediateBridgePassage(vessel, oldVessel);

    // Järnvägsbron ligger BORTOM Klaffbron norrut ⇒ Klaffbron-passagen var missad
    expect(vessel.targetBridge).toBe('Stridsbergsbron'); // transition applicerad
    expect(vessel.passedBridges).toContain('Järnvägsbron');
  });

  test('detekterad Olidebron-passage med target=Klaffbron (norrgående) → INGEN transition (ligger före)', () => {
    const svc = makeVDS();
    const vessel = {
      mmsi: '265000002', lat: 58.2735, lon: 12.2720, sog: 5, cog: 25, targetBridge: 'Klaffbron', passedBridges: [], _routeDirection: 'north', passedAt: {},
    };
    const oldVessel = { ...vessel, lat: 58.2715, lon: 12.2710 };
    svc._hasPassedBridge = jest.fn((v, o, bridge) => bridge.name === 'Olidebron');

    svc._handleIntermediateBridgePassage(vessel, oldVessel);

    expect(vessel.targetBridge).toBe('Klaffbron'); // oförändrad
  });
});

describe('RC3: failsafe-stale-skattning', () => {
  function makeApp() {
    const app = new AISBridgeApp();
    app.log = jest.fn();
    app.error = jest.fn();
    app.debug = jest.fn();
    app._boatNearTrigger = {}; // truthy
    app.bridgeRegistry = new BridgeRegistry();
    app.vesselDataService = { hasGpsJumpHold: () => false };
    app._persistentRecentTriggers = new Map();
    app._PERSISTENT_DEDUP_WINDOW_MS = 2 * 60 * 60 * 1000;
    app._triggerBoatNearFlowForBridge = jest.fn().mockResolvedValue(undefined);
    return app;
  }
  // ~641 m norr om Klaffbron (SILJA-scenariot)
  const SILJA_POS = { lat: 58.28986, lon: 12.28393 };

  test('SILJA-fallet: inbromsad (2.7kn) men transitfart 5.8kn → failsafen FYRAR', async () => {
    const app = makeApp();
    const vessel = {
      mmsi: '265627390', name: 'SILJA', ...SILJA_POS, sog: 2.7, maxRecentSpeed: 5.8, passedAt: {}, _routeDirection: 'north',
    };
    await app._triggerBoatNearFlowFallback(vessel, 'Klaffbron');
    expect(app._triggerBoatNearFlowForBridge).toHaveBeenCalled(); // 641m/5.8kn ≈ 215s < 300
  });

  test('utan transitfartshistorik (max=momentan 2.7kn) → korrekt undertryckt', async () => {
    const app = makeApp();
    const vessel = {
      mmsi: '265000003', ...SILJA_POS, sog: 2.7, maxRecentSpeed: 2.7, passedAt: {}, _routeDirection: 'north',
    };
    await app._triggerBoatNearFlowFallback(vessel, 'Klaffbron');
    expect(app._triggerBoatNearFlowForBridge).not.toHaveBeenCalled(); // 461s > 300
  });

  test('ankrad passage-tidsstämpel används EXAKT: 2 min sedan → fyrar', async () => {
    const app = makeApp();
    const vessel = {
      mmsi: '265000004', ...SILJA_POS, sog: 0.5, maxRecentSpeed: 0.5, _routeDirection: 'north', passedAt: { Klaffbron: Date.now() - 2 * 60 * 1000 },
    };
    await app._triggerBoatNearFlowFallback(vessel, 'Klaffbron');
    expect(app._triggerBoatNearFlowForBridge).toHaveBeenCalled();
  });

  test('ankrad passage-tidsstämpel: 8 min sedan → undertryckt', async () => {
    const app = makeApp();
    const vessel = {
      mmsi: '265000005', ...SILJA_POS, sog: 5.0, maxRecentSpeed: 5.0, _routeDirection: 'north', passedAt: { Klaffbron: Date.now() - 8 * 60 * 1000 },
    };
    await app._triggerBoatNearFlowFallback(vessel, 'Klaffbron');
    expect(app._triggerBoatNearFlowForBridge).not.toHaveBeenCalled();
  });
});

describe('RC4: publicerings-clamp mot ETA-sågtand', () => {
  function makeApp() {
    const app = new AISBridgeApp();
    app.debug = jest.fn();
    return app;
  }

  test('sågtand klipps: publicerat 4, färskt 9 (inget glapp) → max +3', () => {
    const app = makeApp();
    const vessel = {
      mmsi: '1', targetBridge: 'Klaffbron', _etaPublishTarget: 'Klaffbron', _etaPublishedValue: 4, _etaPublishedAtMs: Date.now(),
    };
    expect(app._reconcilePublishedETA(vessel, 9)).toBe(7); // 4 + maxDelta 3
  });

  test('liten ändring passerar orörd', () => {
    const app = makeApp();
    const vessel = {
      mmsi: '1', targetBridge: 'Klaffbron', _etaPublishTarget: 'Klaffbron', _etaPublishedValue: 8, _etaPublishedAtMs: Date.now(),
    };
    expect(app._reconcilePublishedETA(vessel, 9.5)).toBe(9.5);
  });

  test('långt glapp sedan publicering tillåter större delta (glapp-skalning)', () => {
    const app = makeApp();
    const vessel = {
      mmsi: '1', targetBridge: 'Klaffbron', _etaPublishTarget: 'Klaffbron', _etaPublishedValue: 12, _etaPublishedAtMs: Date.now() - 6 * 60 * 1000,
    };
    // maxDelta = max(3, 6 + 0.25*12) = 9 → 12→21 tillåts precis
    expect(app._reconcilePublishedETA(vessel, 21)).toBe(21);
    const vessel2 = {
      mmsi: '1', targetBridge: 'Klaffbron', _etaPublishTarget: 'Klaffbron', _etaPublishedValue: 12, _etaPublishedAtMs: Date.now() - 6 * 60 * 1000,
    };
    expect(app._reconcilePublishedETA(vessel2, 25)).toBe(21); // klipps vid 12+9
  });

  test('målbrobyte släpper clampen', () => {
    const app = makeApp();
    const vessel = {
      mmsi: '1', targetBridge: 'Stridsbergsbron', _etaPublishTarget: 'Klaffbron', _etaPublishedValue: 2, _etaPublishedAtMs: Date.now(),
    };
    expect(app._reconcilePublishedETA(vessel, 14)).toBe(14); // nytt mål = ny skala
  });

  test('null-publicerat eller null-färskt → ingen clamp', () => {
    const app = makeApp();
    expect(app._reconcilePublishedETA({ mmsi: '1', targetBridge: 'Klaffbron' }, 9)).toBe(9);
    expect(app._reconcilePublishedETA({
      mmsi: '1', targetBridge: 'Klaffbron', _etaPublishTarget: 'Klaffbron', _etaPublishedValue: 5, _etaPublishedAtMs: Date.now(),
    }, null)).toBeNull();
  });
});

describe('RC7: stale-exklusion ur bridge_text-underlaget', () => {
  test('fartyg med 11 min gammalt meddelande exkluderas; 5 min inkluderas', () => {
    const svc = makeVDS();
    // SABETH-klassen: I RÖRELSE (sog ≥ 3) och LÅNGT från broarna (>600 m
    // nearest, >300 m från target) — 10-min-regeln gäller. Position flyttad
    // 2026-07-02: de nya nivåerna (kö ≤600 m / mitt-i-passage ≤300 m från
    // target) håller båtar NÄRA broar synliga längre — testets gamla
    // position (~210 m från Klaffbron) täcks numera av 15-min-nivån.
    svc.vessels.set('1', {
      mmsi: '1', targetBridge: 'Klaffbron', status: 'en-route', sog: 4.0, cog: 25, lat: 58.2785, lon: 12.2805, timestamp: Date.now() - 11 * 60 * 1000, lastPositionUpdate: Date.now() - 11 * 60 * 1000,
    });
    svc.vessels.set('2', {
      mmsi: '2', targetBridge: 'Klaffbron', status: 'en-route', sog: 4.0, cog: 25, lat: 58.287, lon: 12.287, timestamp: Date.now() - 5 * 60 * 1000, lastPositionUpdate: Date.now() - 5 * 60 * 1000,
    });

    const result = svc.getVesselsForBridgeText();
    const mmsis = result.map((v) => v.mmsi);
    expect(mmsis).not.toContain('1');
    expect(mmsis).toContain('2');
  });

  test('mitt-i-passage-nivån (2026-07-02, PAX): ≤300 m från målbron ⇒ synlig vid 11 min', () => {
    const svc = makeVDS();
    // PAX-fallet: 182 m från Stridsbergsbron, väntande på öppning, tystnade
    // 19 min → gamla 10-min-regeln gav "Inga båtar" medan bron öppnades.
    svc.vessels.set('3', {
      mmsi: '3',
      targetBridge: 'Stridsbergsbron',
      status: 'waiting',
      sog: 5.4,
      cog: 222,
      lat: 58.29479,
      lon: 12.29653,
      timestamp: Date.now() - 11 * 60 * 1000,
      lastPositionUpdate: Date.now() - 11 * 60 * 1000,
    });
    expect(svc.getVesselsForBridgeText().map((v) => v.mmsi)).toContain('3');
  });

  test('kö-nivån (2026-07-02, HAJH-LAIF): sog < 3 och ≤600 m från bro ⇒ synlig vid 18 min', () => {
    const svc = makeVDS();
    // HAJH-LAIF-fallet: bromsade in i kö vid Järnvägsbron (sista sog 2,4 kn,
    // ~150 m från bron), tystnade 30 min — doldes efter 10 min trots kö.
    svc.vessels.set('4', {
      mmsi: '4',
      targetBridge: 'Stridsbergsbron',
      status: 'en-route',
      sog: 2.4,
      cog: 242,
      lat: 58.290353,
      lon: 12.29028,
      timestamp: Date.now() - 18 * 60 * 1000,
      lastPositionUpdate: Date.now() - 18 * 60 * 1000,
    });
    expect(svc.getVesselsForBridgeText().map((v) => v.mmsi)).toContain('4');
  });
});

describe('RC8: 30-min minimum removal-timeout vid aktiv resa', () => {
  test('fartyg med target på 400m (10-min-zonen) får ≥30 min', () => {
    const registry = new BridgeRegistry();
    const prox = new ProximityService(registry, logger);
    const vessel = {
      mmsi: '219013101', sog: 3, status: 'en-route', targetBridge: 'Klaffbron',
    };
    const timeout = prox.calculateProximityTimeout(vessel, { nearestDistance: 400 });
    expect(timeout).toBeGreaterThanOrEqual(30 * 60 * 1000);
  });

  test('fartyg UTAN target på 400m behåller 10-min-zonen', () => {
    const registry = new BridgeRegistry();
    const prox = new ProximityService(registry, logger);
    const vessel = {
      mmsi: '2', sog: 3, status: 'en-route', targetBridge: null,
    };
    const timeout = prox.calculateProximityTimeout(vessel, { nearestDistance: 400 });
    expect(timeout).toBe(10 * 60 * 1000);
  });
});
