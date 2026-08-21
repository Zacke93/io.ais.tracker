'use strict';

const AISBridgeApp = require('../app');
const constants = require('../lib/constants');
const geometry = require('../lib/utils/geometry');

const { BRIDGES, PASSAGE_TIMING } = constants;
const KLAFFBRON = BRIDGES.klaffbron;

/**
 * K12 (fältprov 10, 2026-08-19/20 — ANVÄNDARBESLUT A2): HÅLLNINGSHYBRIDEN.
 *
 * FYNDET: PASSED_HOLD_UI-hållningen släppte ENBART på tid (PASSED_HOLD_MS,
 * 150 s). TONGA (211495920) passerade Klaffbron 10:10:34,9 och den
 * FRAMÅTSYFTANDE texten "En båt på väg mot Klaffbron, beräknad broöppning
 * strax" återspelades till 10:13:34,8 — då låg hon 467 m SÖDER om bron och
 * gick därifrån i 4,6 kn. Tre sådana fönster under dygnet (129–178 s).
 *
 * FIXEN: tiden är TAKET, beviset är golvet. Hållningen släpps i förtid när
 * fartyget är >= PASSED_HOLD_RELEASE_BEYOND_M bortom brolinjen på
 * färdriktningens sida, är under gång och har ÖKAT sitt avstånd till bron
 * mellan två på varandra följande fixar. Beviset kan bara KORTA hållningen.
 *
 * TONGAs verkliga fixar (rådata ur fältkorpusen) används rakt av; offset =
 * signerat avstånd från brolinjen längs kanalaxeln, positivt norrut.
 */

const makeLogger = () => ({ debug: jest.fn(), log: jest.fn(), error: jest.fn() });

function makeApp() {
  const app = Object.create(AISBridgeApp.prototype);
  const logger = makeLogger();
  app.debug = logger.debug;
  app.log = logger.log;
  app.error = logger.error;
  app.bridgeRegistry = {
    getBridgeByName: (name) => Object.values(BRIDGES).find((b) => b && b.name === name) || null,
  };
  return app;
}

/** Position `metres` längs kanalaxeln från bron (positivt = norrut). */
function alongCanal(bridge, metres) {
  const perp = ((bridge.axisBearing - 90) * Math.PI) / 180;
  return {
    lat: bridge.lat + (metres * Math.cos(perp)) / 111320,
    lon: bridge.lon + (metres * Math.sin(perp)) / (111320 * Math.cos((bridge.lat * Math.PI) / 180)),
  };
}

/** Fartygsprojektion i _findRelevantBoatsForBridgeText:s form. */
function projection(over = {}) {
  return {
    mmsi: '211495920',
    lastPassedBridge: 'Klaffbron',
    lastPassedBridgeTime: Date.now() - 5 * 1000,
    _routeDirection: 'south',
    sog: 4.6,
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    ...over,
  };
}

// TONGA 211495920, 2026-08-19 — rådata kring Klaffbron-passagen.
const TONGA = {
  passage: {
    t: '10:10:34.921', lat: 58.28314, lon: 12.28375, sog: 5.0,
  }, // 107 m, offset −88 m
  after70s: {
    t: '10:11:45.177', lat: 58.28189, lon: 12.28331, sog: 4.6,
  }, // 248 m, offset −211 m
  after137s: {
    t: '10:12:51.683', lat: 58.28000, lon: 12.28219, sog: 4.6,
  }, // 467 m, offset −415 m
};

describe('K12: _alongCanalOffsetM — signerat avstånd från brolinjen', () => {
  test('TONGAs verkliga fixar får rätt tecken och belopp', () => {
    const app = makeApp();
    const off = (p) => Math.round(app._alongCanalOffsetM(p.lat, p.lon, KLAFFBRON));
    // Före passagen låg hon NORR om linjen, efter den SÖDER om.
    expect(off({ lat: 58.28507, lon: 12.28430 })).toBe(97); // 10:09:29, norr
    expect(off(TONGA.passage)).toBe(-88);
    expect(off(TONGA.after70s)).toBe(-211);
    expect(off(TONGA.after137s)).toBe(-415);
  });

  test('ogiltig geometri ger null (och därmed hållning kvar)', () => {
    const app = makeApp();
    expect(app._alongCanalOffsetM(NaN, 12.28, KLAFFBRON)).toBeNull();
    expect(app._alongCanalOffsetM(58.28, 12.28, null)).toBeNull();
    // Rent öst-västlig broaxel ⇒ norr/söder odefinierat.
    expect(app._alongCanalOffsetM(58.29, 12.29, { lat: 58.28, lon: 12.28, axisBearing: 180 }))
      .toBeNull();
  });
});

describe('K12: hållningen släpper på BEVIS, inte bara på tid', () => {
  test('FÄLTFALLET TONGA: hållning vid passagen, släpp 70 s senare (mot 150 s)', () => {
    const app = makeApp();
    const t0 = Date.now();
    const at = (fix, offsetMs) => [projection({
      lat: fix.lat,
      lon: fix.lon,
      sog: fix.sog,
      lastPassedBridgeTime: t0,
      timestamp: t0 + offsetMs,
      lastPositionUpdate: t0 + offsetMs,
    })];

    // 10:10:34,9 — passagen bokförs. 88 m bortom linjen, dvs. under golvet.
    expect(app._hasRecentTargetPassage(at(TONGA.passage, 0))).toBe(true);
    // 10:11:45,2 — 211 m bortom, 4,6 kn, avståndet 107 → 248 m.
    expect(app._hasRecentTargetPassage(at(TONGA.after70s, 70256))).toBe(false);
    expect(app.debug.mock.calls.some((c) => String(c[0]).includes('PASSED_HOLD_RELEASE'))).toBe(true);
  });

  test('MUTATIONSPROV: utan bevisgrenen håller TONGA hela vägen till tidstaket', () => {
    // Grenen bortmuterad = kodens läge FÖRE K12 (hållningen släpper bara på
    // tid). Fältfallet ovan är alltså RÖTT utan fixen.
    const app = makeApp();
    app._passedHoldDepartureProven = () => false;
    const t0 = Date.now();
    const at = (fix, offsetMs) => [projection({
      lat: fix.lat,
      lon: fix.lon,
      sog: fix.sog,
      lastPassedBridgeTime: t0,
      timestamp: t0 + offsetMs,
      lastPositionUpdate: t0 + offsetMs,
    })];
    expect(app._hasRecentTargetPassage(at(TONGA.passage, 0))).toBe(true);
    expect(app._hasRecentTargetPassage(at(TONGA.after70s, 70256))).toBe(true);
    expect(app._hasRecentTargetPassage(at(TONGA.after137s, 136762))).toBe(true);
  });

  test('BÅT STILLA BORTOM BRON hålls kvar tills tidstaket (broöppningen kan pågå)', () => {
    const app = makeApp();
    const t0 = Date.now();
    const pos = alongCanal(KLAFFBRON, -250); // 250 m söder om linjen
    const still = (offsetMs) => [projection({
      ...pos, sog: 0.1, lastPassedBridgeTime: t0, timestamp: t0 + offsetMs, lastPositionUpdate: t0 + offsetMs,
    })];
    expect(app._hasRecentTargetPassage(still(0))).toBe(true);
    expect(app._hasRecentTargetPassage(still(60000))).toBe(true);
    expect(app._hasRecentTargetPassage(still(120000))).toBe(true);
    expect(app.debug.mock.calls.some((c) => String(c[0]).includes('PASSED_HOLD_RELEASE'))).toBe(false);
  });

  test('STILLA + GPS-JITTER kan inte fabricera "avståndet ökade"', () => {
    // Utan fartkravet hade en förtöjd båts 20–80 m Class B-multipath räckt.
    const app = makeApp();
    const t0 = Date.now();
    const a = alongCanal(KLAFFBRON, -260);
    const b = alongCanal(KLAFFBRON, -290); // 30 m "hopp" utåt
    const frame = (p, offsetMs) => [projection({
      ...p, sog: 0.2, lastPassedBridgeTime: t0, timestamp: t0 + offsetMs, lastPositionUpdate: t0 + offsetMs,
    })];
    expect(app._hasRecentTargetPassage(frame(a, 0))).toBe(true);
    expect(app._hasRecentTargetPassage(frame(b, 30000))).toBe(true);
  });

  test('BÅT PÅ INGÅNGSSIDAN hålls kvar även om hon är långt bort och ökar', () => {
    // Sydgående båt som (felaktigt eller efter U-sväng) ligger NORR om
    // Klaffbron: sidan stämmer inte med färdriktningen ⇒ inget bevis.
    const app = makeApp();
    const t0 = Date.now();
    const frame = (metres, offsetMs) => [projection({
      ...alongCanal(KLAFFBRON, metres),
      sog: 4.6,
      lastPassedBridgeTime: t0,
      timestamp: t0 + offsetMs,
      lastPositionUpdate: t0 + offsetMs,
    })];
    expect(app._hasRecentTargetPassage(frame(180, 0))).toBe(true);
    expect(app._hasRecentTargetPassage(frame(320, 60000))).toBe(true);
    expect(app.debug.mock.calls.some((c) => String(c[0]).includes('PASSED_HOLD_RELEASE'))).toBe(false);
  });

  test('BÅT SOM VÄNDER TILLBAKA (avståndet krymper) hålls kvar', () => {
    const app = makeApp();
    const t0 = Date.now();
    const frame = (metres, offsetMs) => [projection({
      ...alongCanal(KLAFFBRON, metres),
      sog: 3.0,
      lastPassedBridgeTime: t0,
      timestamp: t0 + offsetMs,
      lastPositionUpdate: t0 + offsetMs,
    })];
    expect(app._hasRecentTargetPassage(frame(-300, 0))).toBe(true);
    expect(app._hasRecentTargetPassage(frame(-180, 60000))).toBe(true); // närmar sig igen
  });

  test('120 m bortom OCH ökande ⇒ hållningen släpps tidigt', () => {
    const app = makeApp();
    const t0 = Date.now();
    const frame = (metres, offsetMs) => [projection({
      ...alongCanal(KLAFFBRON, metres),
      _routeDirection: 'north',
      sog: 3.0,
      lastPassedBridgeTime: t0,
      timestamp: t0 + offsetMs,
      lastPositionUpdate: t0 + offsetMs,
    })];
    expect(app._hasRecentTargetPassage(frame(105, 0))).toBe(true);
    expect(app._hasRecentTargetPassage(frame(120, 40000))).toBe(false);
  });

  test('GOLVET: 99 m bortom räcker inte, 101 m gör det', () => {
    const clearM = PASSAGE_TIMING.PASSED_HOLD_RELEASE_BEYOND_M;
    const run = (metres) => {
      const app = makeApp();
      const t0 = Date.now();
      const frame = (m, offsetMs) => [projection({
        ...alongCanal(KLAFFBRON, m),
        sog: 3.0,
        lastPassedBridgeTime: t0,
        timestamp: t0 + offsetMs,
        lastPositionUpdate: t0 + offsetMs,
      })];
      app._hasRecentTargetPassage(frame(-(metres - 20), 0));
      return app._hasRecentTargetPassage(frame(-metres, 40000));
    };
    expect(run(clearM - 1)).toBe(true); // hålls kvar
    expect(run(clearM + 1)).toBe(false); // släpps
  });
});

describe('K12: hållningen kan bara KORTAS, aldrig förlängas', () => {
  test('TIDSTAKET gäller alltid — bevis eller ej', () => {
    const app = makeApp();
    const t0 = Date.now() - (PASSAGE_TIMING.PASSED_HOLD_MS + 1000);
    const parked = [projection({
      ...alongCanal(KLAFFBRON, -250),
      sog: 0, // inget bevis alls: hon ligger still bortom bron
      lastPassedBridgeTime: t0,
    })];
    expect(app._hasRecentTargetPassage(parked)).toBe(false);
  });

  test('en båt UTAN målbropassage har aldrig kunnat hålla, och gör det inte nu', () => {
    const app = makeApp();
    expect(app._hasRecentTargetPassage([projection({ lastPassedBridge: 'Olidebron' })])).toBe(false);
    expect(app._hasRecentTargetPassage([projection({ lastPassedBridgeTime: null })])).toBe(false);
    expect(app._hasRecentTargetPassage([])).toBe(false);
    expect(app._hasRecentTargetPassage(null)).toBe(false);
  });

  test('OKÄND färdriktning ⇒ inget bevis ⇒ hållningen står kvar som förut', () => {
    const app = makeApp();
    const t0 = Date.now();
    const frame = (offsetMs) => [projection({
      ...alongCanal(KLAFFBRON, -300),
      _routeDirection: null,
      _finalTargetDirection: null,
      sog: 4.6,
      lastPassedBridgeTime: t0,
      timestamp: t0 + offsetMs,
      lastPositionUpdate: t0 + offsetMs,
    })];
    expect(app._hasRecentTargetPassage(frame(0))).toBe(true);
    expect(app._hasRecentTargetPassage(frame(60000))).toBe(true);
  });

  test('saknad position ⇒ inget bevis (predikatet är rent släppande)', () => {
    const app = makeApp();
    const t0 = Date.now();
    const frame = (offsetMs) => [projection({
      lat: null, lon: null, lastPassedBridgeTime: t0, timestamp: t0 + offsetMs, lastPositionUpdate: t0 + offsetMs,
    })];
    expect(app._hasRecentTargetPassage(frame(0))).toBe(true);
    expect(app._hasRecentTargetPassage(frame(60000))).toBe(true);
  });
});

describe('K12: de två anropsställena får samma svar, och minnet är begränsat', () => {
  test('C1c-kontraktet: samma fix frågad två gånger ger samma svar', () => {
    // _actuallyUpdateUI (hållningen) och nödfallbacken frågar samma predikat i
    // samma UI-cykel. Utan fixstämpeln hade den andra frågan jämfört samplet
    // med sig självt och svarat "ökade inte".
    const app = makeApp();
    const t0 = Date.now();
    const frame = (metres, offsetMs) => [projection({
      ...alongCanal(KLAFFBRON, metres),
      sog: 4.6,
      lastPassedBridgeTime: t0,
      timestamp: t0 + offsetMs,
      lastPositionUpdate: t0 + offsetMs,
    })];
    app._hasRecentTargetPassage(frame(-150, 0));
    const first = app._hasRecentTargetPassage(frame(-320, 60000));
    const second = app._hasRecentTargetPassage(frame(-320, 60000));
    expect(first).toBe(false);
    expect(second).toBe(false);
  });

  test('BOUNDED MINNE: posten släpps när båten lämnar passed-fönstret', () => {
    const app = makeApp();
    const t0 = Date.now();
    const inWindow = [projection({
      ...alongCanal(KLAFFBRON, -150), lastPassedBridgeTime: t0,
    })];
    app._hasRecentTargetPassage(inWindow);
    expect(app._passedHoldDistances.size).toBe(1);

    const expired = [projection({
      ...alongCanal(KLAFFBRON, -150),
      lastPassedBridgeTime: t0 - (PASSAGE_TIMING.PASSED_HOLD_MS + 1000),
    })];
    app._hasRecentTargetPassage(expired);
    expect(app._passedHoldDistances.size).toBe(0);
  });

  test('EN båt utan bevis håller texten även när en annan har bevisat sin utfärd', () => {
    const app = makeApp();
    const t0 = Date.now();
    const gone = projection({
      mmsi: '211495920', ...alongCanal(KLAFFBRON, -300), sog: 4.6, lastPassedBridgeTime: t0,
    });
    const atBridge = projection({
      mmsi: '265573130', ...alongCanal(KLAFFBRON, -30), sog: 0.2, lastPassedBridgeTime: t0,
    });
    // Första cykeln bokför båda.
    app._hasRecentTargetPassage([gone, atBridge]);
    const next = [
      {
        ...gone, ...alongCanal(KLAFFBRON, -420), timestamp: t0 + 60000, lastPositionUpdate: t0 + 60000,
      },
      { ...atBridge, timestamp: t0 + 60000, lastPositionUpdate: t0 + 60000 },
    ];
    expect(app._hasRecentTargetPassage(next)).toBe(true);
  });
});

describe('K12: geometrin mot verkligt facit', () => {
  test('avståndet till bron är det som växer i TONGAs bevis', () => {
    const d = (p) => Math.round(geometry.calculateDistance(p.lat, p.lon, KLAFFBRON.lat, KLAFFBRON.lon));
    expect(d(TONGA.passage)).toBe(107);
    expect(d(TONGA.after70s)).toBe(248);
    expect(d(TONGA.after137s)).toBe(467);
  });
});
