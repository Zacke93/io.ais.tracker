'use strict';

/**
 * Kedjearmens spärr direkt efter en bekräftad vändning (fältprovet 10–13
 * november, familj B, revision 1).
 *
 * k1 11 nov, PILOT 761 (265606970): vände norr om Stridsbergsbron efter 30 min
 * stopp. Vändningen tömde passedBridges (NEW_JOURNEY) och köposterna
 * (_anchorJourneyOrigin), och köposterna skapas först på fixet EFTER första
 * målbrofixet (_noteBridgeQueueApproach körs före måltilldelningen). På
 * första målbrofixet, 166 m norr om Stridsbergsbron i 1,7 kn och 27 s gammalt
 * (AISHub), räknade spärren vid en tidigare bro därför ingen bro emellan för
 * kedjearmen Klaffbron. Den fick 10-knopsdeadlinen 62 s bort, före nästa fix,
 * och varningen gick 50 min före passagen.
 *
 * Rättningen: efter en BEKRÄFTAD vändning (`_reversalConfirmedAt`, satt av
 * VesselDataService._anchorJourneyOrigin) räknas varje opasserad bro mellan
 * båten och kedjearmens bro, även utan historik. En båt utan historik och
 * utan vändning (förstakontakt, båt efter omstart) behåller basens beteende
 * (granskningen av familj B, H1). Testet prövar också vändningsmärkets
 * livslängd, att varningen kommer i tid efter vändningen (M3) och
 * instrumentet [OPENING_HOLD].
 */

jest.mock('homey');

const Service = require('../lib/services/BridgeOpeningService');
const VesselDataService = require('../lib/services/VesselDataService');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const SystemCoordinator = require('../lib/services/SystemCoordinator');
const { BRIDGES, BRIDGE_OPENING } = require('../lib/constants');
const { calculateDistance } = require('../lib/utils/geometry');

const START = Date.parse('2026-11-11T12:33:55.766Z');
const MMSI = '265606970';
const KLAFF = BRIDGES.klaffbron;
const JVB = BRIDGES.jarnvagsbron;
const STRID = BRIDGES.stridsbergsbron;
const OLIDE = BRIDGES.olidebron;
const KN = 0.514444;
const STALE_MS = 300000; // STALE_ETA_SOFT_MS: spärrens längsta gräns från ankaret
const LEAD_MS = BRIDGE_OPENING.WARNING_LEAD_MS;
const TEN_KN = BRIDGE_OPENING.DEADLINE_MAX_SPEED_KN * KN;

// d meter bortom bron `b` räknat från bron `a` (linjen a → b förlängd).
const beyond = (a, b, d) => {
  const span = calculateDistance(a.lat, a.lon, b.lat, b.lon);
  return { lat: b.lat + (b.lat - a.lat) * (d / span), lon: b.lon + (b.lon - a.lon) * (d / span) };
};
// d meter före bron `b` på väg från `a` (punkt på linjen a → b).
const before = (a, b, d) => {
  const span = calculateDistance(a.lat, a.lon, b.lat, b.lon);
  return { lat: b.lat + (a.lat - b.lat) * (d / span), lon: b.lon + (a.lon - b.lon) * (d / span) };
};

describe('Kedjearmens spärr efter en bekräftad vändning (PILOT 761, k1 11 nov)', () => {
  const services = [];
  const make = () => {
    const warnings = [];
    const debug = [];
    const logger = { log: () => {}, error: () => {}, debug: (line) => debug.push(String(line)) };
    const service = new Service({ onWarning: (w) => warnings.push(w), logger });
    services.push(service);
    return { service, warnings, holdLines: () => debug.filter((l) => l.includes('[OPENING_HOLD]')) };
  };
  // Södergående efter vändningen: målbro Stridsbergsbron, ingen historik.
  const southbound = (pos, sog, extra = {}) => ({
    mmsi: MMSI,
    name: 'PILOT 761',
    ...pos,
    sog,
    cog: 220,
    targetBridge: 'Stridsbergsbron',
    _routeDirection: 'south',
    _hasMovementProof: true,
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    fixTs: Date.now() - 27000,
    fixFeed: 'aishub',
    etaMinutes: 3,
    status: 'waiting',
    passedBridges: [],
    _bridgeQueueApproaches: {},
    _reversalConfirmedAt: START - 73000,
    ...extra,
  });
  const arm = (service, bridge) => service._arms.get(`${MMSI}::${bridge}`);

  beforeEach(() => {
    jest.useFakeTimers({ now: START });
  });
  afterEach(() => {
    while (services.length) services.pop().destroy();
    jest.useRealTimers();
  });

  test('första målbrofixet efter vändningen: kedjearmen hålls av Järnvägsbron, den egna armen varnar', () => {
    const { service, warnings } = make();
    const fix = southbound(beyond(JVB, STRID, 166), 1.7);
    service.observeVessel(fix);

    const own = arm(service, 'Stridsbergsbron');
    const chain = arm(service, 'Klaffbron');
    expect(own.earlierBridge).toBeNull();
    expect(chain.earlierBridge).toBe('Järnvägsbron');
    const anchor = fix.fixTs;
    expect(chain.earlierBridgeUntilMs).toBe(anchor + STALE_MS);
    expect(chain.fireDueMs).toBe(anchor + STALE_MS);
    // Stridsbergsbrons returvarning (U15) går direkt, som förut.
    expect(warnings.map((w) => w.bridge)).toEqual(['Stridsbergsbron']);

    // Den gamla 10-knopsdeadlinen (fixtid + d / 10 kn − 180 s) passerar utan varning.
    const tenKnotsMs = anchor + (chain.distanceM / TEN_KN) * 1000 - LEAD_MS;
    expect(tenKnotsMs).toBeLessThan(START + 70000); // före nästa AISHub-poll, som i fältet
    jest.setSystemTime(Math.ceil(tenKnotsMs) + 1000);
    service.tick();
    expect(warnings.map((w) => w.bridge)).toEqual(['Stridsbergsbron']);
  });

  test('tystnar hon efter fixet går Klaffbronvarningen när spärren löper ut (reservvarningen finns kvar, U15)', () => {
    const { service, warnings } = make();
    const fix = southbound(beyond(JVB, STRID, 166), 1.7);
    service.observeVessel(fix);
    jest.setSystemTime(fix.fixTs + STALE_MS - 1000);
    service.tick();
    expect(warnings.map((w) => w.bridge)).toEqual(['Stridsbergsbron']);
    jest.setSystemTime(fix.fixTs + STALE_MS);
    service.tick();
    expect(warnings.map((w) => w.bridge)).toEqual(['Stridsbergsbron', 'Klaffbron']);
    expect(warnings[1].firedBy).toBe('deadline');
  });

  test('samma bro och gräns som för en båt med historik (passerad Stallbackabron)', () => {
    const a = make();
    const b = make();
    a.service.observeVessel(southbound(beyond(JVB, STRID, 166), 1.7));
    b.service.observeVessel(southbound(beyond(JVB, STRID, 166), 1.7, {
      passedBridges: ['Stallbackabron'], _reversalConfirmedAt: null,
    }));
    const ca = arm(a.service, 'Klaffbron');
    const cb = arm(b.service, 'Klaffbron');
    expect(ca.earlierBridge).toBe(cb.earlierBridge);
    expect(ca.earlierBridgeUntilMs).toBe(cb.earlierBridgeUntilMs);
    expect(ca.fireDueMs).toBe(cb.fireDueMs);
  });

  test('spegeln norrut: vändning söder om Klaffbron, kedjearmen Stridsbergsbron hålls av Järnvägsbron', () => {
    const { service } = make();
    service.observeVessel(southbound(before(OLIDE, KLAFF, 400), 4.5, {
      cog: 30, targetBridge: 'Klaffbron', _routeDirection: 'north', status: 'en-route',
    }));
    expect(arm(service, 'Klaffbron').earlierBridge).toBeNull();
    expect(arm(service, 'Stridsbergsbron').earlierBridge).toBe('Järnvägsbron');
  });

  // Granskningen av familj B (H1): utan vändning håller spärren inte en arm som
  // saknar kadens. En förstakontakt får basens 10-knopsdeadline på första fixet.
  test.each([
    ['förstakontakt söderut', () => southbound(beyond(JVB, STRID, 250), 2.5, { _reversalConfirmedAt: null }), 'Klaffbron'],
    ['förstakontakt norrut', () => southbound(before(OLIDE, KLAFF, 250), 2.5, {
      cog: 30, targetBridge: 'Klaffbron', _routeDirection: 'north', status: 'en-route', _reversalConfirmedAt: null,
    }), 'Stridsbergsbron'],
  ])('%s utan historik och utan vändning: kedjearmen hålls inte (basens deadline)', (_label, build, chainBridge) => {
    const { service } = make();
    const fix = build();
    service.observeVessel(fix);
    const chain = arm(service, chainBridge);
    expect(chain.earlierBridge).toBeNull();
    expect(chain.fireDueMs).toBeLessThanOrEqual(fix.fixTs + (chain.distanceM / TEN_KN) * 1000 - LEAD_MS + 1);
  });

  // M3: varningen ska komma I TID efter vändningen, inte bara inte för tidigt.
  // I jämn fart och tystnad går reservvarningen minst WARNING_LEAD_MS före
  // ankomsten till kedjebron.
  test.each([4, 6, 8])('i jämn fart %s kn efter vändningen går kedjevarningen minst 180 s före ankomsten', (kn) => {
    const { service, warnings } = make();
    const fix = southbound(beyond(JVB, STRID, 220), kn, { fixTs: Date.now(), fixFeed: 'aisstream', status: 'en-route' });
    service.observeVessel(fix);
    const chain = arm(service, 'Klaffbron');
    expect(chain.earlierBridge).toBe('Järnvägsbron');
    const arrivalMs = fix.fixTs + (chain.distanceM / (kn * KN)) * 1000;
    for (let t = START; t <= arrivalMs; t += 1000) {
      jest.setSystemTime(t);
      service.tick();
      if (warnings.some((w) => w.bridge === 'Klaffbron')) break;
    }
    const klaff = warnings.find((w) => w.bridge === 'Klaffbron');
    expect(klaff).toBeDefined();
    // Testet tickar varje sekund; i drift bokar deadline-timern exakt tid.
    expect(arrivalMs - klaff.t).toBeGreaterThanOrEqual(LEAD_MS - 1000);
  });

  test('[OPENING_HOLD]: start, ingen rad vid förnyelse framåt, slut när spärren löper ut', () => {
    const { service, holdLines } = make();
    service.observeVessel(southbound(beyond(JVB, STRID, 166), 1.7));
    expect(holdLines()).toHaveLength(1);
    expect(holdLines()[0]).toMatch(/Klaffbron hålls av Järnvägsbron — egen målbro efter vändning, gren kö eller under 2 kn, 300 s/);

    // Nästa fix har köposter (märket har släckts i VesselDataService) och
    // förnyar bara spärren framåt: ingen ny rad.
    jest.setSystemTime(START + 67000);
    const queued = { Järnvägsbron: { direction: 'south', confirmedAt: null } };
    service.observeVessel(southbound(beyond(JVB, STRID, 119), 1.1, {
      _bridgeQueueApproaches: queued, _reversalConfirmedAt: null,
    }));
    service.tick();
    expect(holdLines()).toHaveLength(1);

    // Tystnad: spärren löper ut, och första utvärderingen efter slutet loggar det
    // med det FAKTISKA slutet och antalet förnyelser.
    const until = arm(service, 'Klaffbron').earlierBridgeUntilMs;
    jest.setSystemTime(until);
    service.tick();
    expect(holdLines()).toHaveLength(2);
    expect(holdLines()[1]).toContain(`spärren löpte ut ${new Date(until).toISOString()}`);
    expect(holdLines()[1]).toContain('förnyad 1 gånger');
    service.tick();
    expect(holdLines()).toHaveLength(2);
  });

  test('[OPENING_HOLD]: släpp när ett fix inte längre visar någon tidigare bro', () => {
    const { service, holdLines } = make();
    service.observeVessel(southbound(beyond(JVB, STRID, 166), 1.7));
    jest.setSystemTime(START + 67000);
    // Förbi Järnvägsbron: Stridsbergsbron och Järnvägsbron passerade, målbro Klaffbron.
    service.observeVessel(southbound(before(JVB, KLAFF, 800), 5.3, {
      targetBridge: 'Klaffbron',
      passedBridges: ['Stridsbergsbron', 'Järnvägsbron'],
      status: 'en-route',
      _reversalConfirmedAt: null,
    }));
    const lines = holdLines();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/Klaffbron släpps — fixet visar ingen tidigare bro framför \(spärren vid Järnvägsbron/);
  });

  test('[OPENING_HOLD]: slutrad när en hållen arm avväpnas, och en rad när spärren kortas', () => {
    const { service, holdLines } = make();
    service.observeVessel(southbound(beyond(JVB, STRID, 166), 1.7));
    // Nästa fix i 8 kn: restiden i nuvarande fart − 180 s är kortare än det
    // loggade slutet, så spärren kortas.
    jest.setSystemTime(START + 30000);
    const queued = { Järnvägsbron: { direction: 'south', confirmedAt: null } };
    service.observeVessel(southbound(beyond(JVB, STRID, 100), 8, {
      fixTs: Date.now(), fixFeed: 'aisstream', status: 'en-route', _bridgeQueueApproaches: queued, _reversalConfirmedAt: null,
    }));
    expect(holdLines()).toHaveLength(2);
    expect(holdLines()[1]).toMatch(/Klaffbron — spärren vid Järnvägsbron kortas till/);
    service.removeVessel(MMSI, 'test', true);
    const last = holdLines()[holdLines().length - 1];
    expect(last).toMatch(/Klaffbron släpps — armen avväpnad \(test\)/);
  });
});

describe('Vändningsmärket _reversalConfirmedAt (VesselDataService)', () => {
  const logger = {
    debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
  };
  const live = [];
  const makeVDS = () => {
    const svc = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
    svc.app = {
      gpsJumpGateService: null,
      passageLatchService: null,
      routeOrderValidator: null,
      debug: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
    };
    live.push(svc);
    return svc;
  };
  beforeAll(() => {
    global.__TEST_MODE__ = true;
  });
  afterAll(() => {
    delete global.__TEST_MODE__;
  });
  afterEach(() => {
    while (live.length) live.pop().clearAllTimers();
    jest.clearAllMocks();
  });

  test('sätts bara av en bekräftad vändning', () => {
    const svc = makeVDS();
    const vessel = { mmsi: '1', ...beyond(JVB, STRID, 220) };
    svc._anchorJourneyOrigin(vessel, 'target-assign-accelerated');
    expect(vessel._reversalConfirmedAt).toBeUndefined();
    svc.anchorJourneyOrigin(vessel, 'new-journey', { reversal: true });
    expect(Number.isFinite(vessel._reversalConfirmedAt)).toBe(true);
  });

  // Omgranskningen av familj B (O3): Fix D-vägen. _confirmDirectionReversal
  // behåller bara passerade broar BAKOM båten i den nya riktningen. Har
  // målbron Stridsbergsbron ännu inte släppts när vändningen bekräftas norr
  // om bron (passagen inte bokförd), ligger alla passerade broar framför: de
  // släpps, köposterna töms, och märket är kedjearmens enda underlag.
  test('Fix D-vägen sätter märket, och med alla passerade broar framför är det kedjearmens enda underlag', () => {
    const svc = makeVDS();
    const mmsi = '903611113';
    const vessel = {
      mmsi,
      ...beyond(JVB, STRID, 300),
      sog: 3,
      cog: 215,
      targetBridge: 'Stridsbergsbron',
      _routeDirection: 'north',
      passedBridges: ['Olidebron', 'Klaffbron', 'Järnvägsbron'],
      _bridgeQueueApproaches: { Stridsbergsbron: { direction: 'north', confirmedAt: null } },
    };
    svc._confirmDirectionReversal(vessel, 'south', 'test');
    expect(Number.isFinite(vessel._reversalConfirmedAt)).toBe(true);
    expect(vessel.passedBridges).toEqual([]);
    expect(vessel._bridgeQueueApproaches).toEqual({});

    const service = new Service({ onWarning: () => {} });
    try {
      service.observeVessel({
        ...vessel,
        name: 'FIX-D',
        targetBridge: 'Stridsbergsbron',
        _hasMovementProof: true,
        timestamp: Date.now(),
        lastPositionUpdate: Date.now(),
        fixTs: Date.now(),
        fixFeed: 'aisstream',
        etaMinutes: 3,
        status: 'en-route',
      });
      expect(service._arms.get(`${mmsi}::Klaffbron`).earlierBridge).toBe('Järnvägsbron');
    } finally {
      service.destroy();
    }
  });

  test('överlever objektombyggnaden tills köposterna finns, och släcks då', () => {
    const svc = makeVDS();
    const mmsi = '903611111';
    const t0 = Date.now() - 120000;
    svc.updateVessel(mmsi, {
      ...beyond(JVB, STRID, 230), sog: 0.2, cog: 200, name: 'MÄRKE', fixTs: t0, fixFeed: 'aisstream',
    });
    const v = svc.getVessel(mmsi);
    v._routeDirection = 'south';
    svc.anchorJourneyOrigin(v, 'new-journey', { reversal: true });
    // Nästa fix utan målbro och utan passerade broar: inga köposter, märket står kvar.
    svc.updateVessel(mmsi, {
      ...beyond(JVB, STRID, 225), sog: 0.2, cog: 200, name: 'MÄRKE', fixTs: t0 + 60000, fixFeed: 'aisstream',
    });
    expect(Number.isFinite(svc.getVessel(mmsi)._reversalConfirmedAt)).toBe(true);
    // Med målbro bokförs köposter på nästa fix, och märket släcks.
    svc.getVessel(mmsi).targetBridge = 'Stridsbergsbron';
    svc.getVessel(mmsi)._routeDirection = 'south';
    svc.updateVessel(mmsi, {
      ...beyond(JVB, STRID, 170), sog: 2.5, cog: 210, name: 'MÄRKE', fixTs: t0 + 120000, fixFeed: 'aisstream',
    });
    const after = svc.getVessel(mmsi);
    expect(Object.keys(after._bridgeQueueApproaches || {}).length).toBeGreaterThan(0);
    expect(after._reversalConfirmedAt).toBeNull();
  });

  test('släcks när båten klassas förtöjd', () => {
    const svc = makeVDS();
    const mmsi = '903611112';
    const t0 = Date.now() - 120000;
    svc.updateVessel(mmsi, {
      ...beyond(JVB, STRID, 230), sog: 0.2, cog: 200, name: 'KAJ', fixTs: t0, fixFeed: 'aisstream',
    });
    svc.anchorJourneyOrigin(svc.getVessel(mmsi), 'new-journey', { reversal: true });
    jest.spyOn(svc, '_updateMooringEvidence').mockImplementation((vessel) => {
      vessel._moored = true;
    });
    svc.updateVessel(mmsi, {
      ...beyond(JVB, STRID, 230), sog: 0, cog: 200, name: 'KAJ', fixTs: t0 + 60000, fixFeed: 'aisstream',
    });
    expect(svc.getVessel(mmsi)._reversalConfirmedAt).toBeNull();
  });
});
