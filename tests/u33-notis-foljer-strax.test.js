'use strict';

jest.mock('homey');

const path = require('path');
const { execFile } = require('child_process');
const AISBridgeApp = require('../app');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const BridgeTextService = require('../lib/services/BridgeTextService');
const geometry = require('../lib/utils/geometry');
const { BRIDGES, UI_CONSTANTS } = require('../lib/constants');

// U33 (F20): målbronotisen säger inte "om 3–4 minuter" när brotexten säger
// "strax" för samma båt och bro. Notisen byggs på fixets första beräkning och
// texten på den andra 25 ms senare; texten säger dessutom "strax" inom 300 m.
// Fältkörning 3: NINA BRES, LIDAN och SYLVIA fick "om 3–4 minuter" i samma
// sekund som texten bytte till "strax" och korsade 1,6–2,9 min senare.
// Regeln: notisen säger högst "om 2 minuter", men bara när båten i sin fart
// når bron inom 3 minuter. Positionerna ligger på linjen Olidebron–Klaffbron.

const KLAFF = BRIDGES.klaffbron;
const OLIDE = BRIDGES.olidebron;
const STRIDS = BRIDGES.stridsbergsbron;
const JVG = BRIDGES.jarnvagsbron;

// Punkt d meter före bron b på linjen från bron a (söderifrån, norrut).
function pointBefore(b, a, d) {
  const span = geometry.calculateDistance(a.lat, a.lon, b.lat, b.lon);
  const f = d / span;
  return { lat: b.lat - f * (b.lat - a.lat), lon: b.lon - f * (b.lon - a.lon) };
}

describe('U33: notisen följer brotextens strax', () => {
  let app;
  let now;

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-15T06:15:58.000Z'));
    now = Date.now();
    app = new AISBridgeApp();
    app.log = jest.fn();
    app.debug = jest.fn();
    app.error = jest.fn();
    app.bridgeRegistry = new BridgeRegistry();
    app.bridgeTextService = new BridgeTextService(app.bridgeRegistry, { debug() {}, log() {}, error() {} });
    app._triggeredBoatNearKeys = new Set();
    app._persistentRecentTriggers = new Map();
    app._triggerBoatNearFlowBest = jest.fn().mockResolvedValue(undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  // En båt d meter söder om Klaffbron på väg norrut mot målbron.
  const vessel = (d, overrides = {}) => ({
    mmsi: '265000001',
    name: 'LIDAN',
    ...pointBefore(KLAFF, OLIDE, d),
    sog: 4,
    cog: 33,
    targetBridge: 'Klaffbron',
    currentBridge: null,
    status: 'approaching',
    _routeDirection: 'north',
    _hasMovementProof: true,
    _positionUncertain: false,
    _gpsJumpDetected: false,
    passedBridges: ['Olidebron'],
    lastPassedBridge: 'Olidebron',
    lastPassedBridgeTime: now - 6 * 60 * 1000,
    etaMinutes: 3.6,
    timestamp: now,
    lastPositionUpdate: now,
    ...overrides,
  });

  const candidate = (v, overrides = {}) => ({
    name: 'Klaffbron',
    id: 'klaffbron',
    source: 'target',
    distance: geometry.calculateDistance(v.lat, v.lon, KLAFF.lat, KLAFF.lon),
    ...overrides,
  });

  const send = async (v, c = candidate(v)) => {
    await app._triggerBoatNearFlowForBridge(v, c);
    expect(app._triggerBoatNearFlowBest).toHaveBeenCalledTimes(1);
    return app._triggerBoatNearFlowBest.mock.calls[0][0];
  };

  describe('fall som fälldes före rättningen', () => {
    test('LIDAN-fallet: 280 m i 4 kn med första beräkningen 3,6 min ger "om 2 minuter"', async () => {
      const v = vessel(280);
      const tokens = await send(v);
      expect(tokens.eta_minutes).toBe(2);
      expect(tokens.eta_available).toBe(true);
      expect(tokens.message).toBe('LIDAN närmar sig Klaffbron, beräknad ankomst om 2 minuter');
      // Notisen rör varken båtens ETA eller imminent-flaggan: omvärderingen äger dem.
      expect(v.etaMinutes).toBe(3.6);
      expect(v._isImminentAtTargetBridge).toBeUndefined();
    });

    test('första beräkningen 2,7 min utanför 300 m: texten säger strax på siffran, notisen "om 2"', async () => {
      const tokens = await send(vessel(380, { sog: 5.5, etaMinutes: 2.7 }));
      expect(tokens.eta_minutes).toBe(2);
      expect(tokens.message).toBe('LIDAN närmar sig Klaffbron, beräknad ankomst om 2 minuter');
    });

    test('hysteresen: 330 m med flaggan redan satt (≤350 m) ger "om 2"', async () => {
      const tokens = await send(vessel(330, {
        sog: 5, etaMinutes: 3.4, _isImminentAtTargetBridge: true, _imminentFromExhausted: false,
      }));
      expect(tokens.eta_minutes).toBe(2);
    });
  });

  describe('motfall: dagens siffra står kvar', () => {
    test('båten når inte bron inom 3 min i sin fart (250 m i 1,2 kn) behåller "om 4"', async () => {
      expect((await send(vessel(250, { sog: 1.2 }))).eta_minutes).toBe(4);
    });

    test('båten bromsar in (U31:s mått): notisen behåller sin siffra', async () => {
      app.statusService = { isBraking: () => true };
      expect((await send(vessel(280))).eta_minutes).toBe(4);
    });

    test('inbromsningens mått är kalkylatorns: medelfart minst 1,2 gånger momentanfarten', () => {
      const ProgressiveETACalculator = require('../lib/services/ProgressiveETACalculator');
      const calc = new ProgressiveETACalculator({ debug() {}, log() {}, error() {} }, app.bridgeRegistry);
      calc._speedBuffers.set('1', [6.3, 6.3, 4]);
      expect(calc.isBraking({ mmsi: '1', sog: 4 })).toBe(true); // AIR: 5,53 / 4 = 1,38
      calc._speedBuffers.set('1', [3.9, 3.9, 3.9]);
      expect(calc.isBraking({ mmsi: '1', sog: 3.9 })).toBe(false); // WILSON ALSTER: jämn fart
      calc._speedBuffers.set('1', [4.4, 4.2, 4]);
      expect(calc.isBraking({ mmsi: '1', sog: 3.6 })).toBe(false); // 4,2 / 3,6 = 1,17
      calc.destroy?.();
    });

    test('gränsen: strax över 3 min i sin fart behåller siffran, strax under följer texten', async () => {
      // 3 min i 3,0 kn = 3 * 60 * 3,0 * 0,5144 m ≈ 278 m, alltså inom 300 m.
      const d = 3 * 60 * 3.0 * 0.5144;
      expect((await send(vessel(d + 1, { sog: 3.0, etaMinutes: 3.6 }))).eta_minutes).toBe(4);
      app._triggerBoatNearFlowBest.mockClear();
      app._triggeredBoatNearKeys.clear();
      app._persistentRecentTriggers.clear();
      expect((await send(vessel(d - 2, { sog: 3.0, etaMinutes: 3.6 }))).eta_minutes).toBe(2);
    });

    test('utanför 300 m med siffran 3,4: texten säger "om 3", notisen också', async () => {
      expect((await send(vessel(380, { sog: 5, etaMinutes: 3.4 }))).eta_minutes).toBe(3);
    });

    test('330 m utan satt flagga: texten säger "om 3", notisen också', async () => {
      expect((await send(vessel(330, { sog: 5, etaMinutes: 3.4 }))).eta_minutes).toBe(3);
    });

    test('extrapolerad 2,7: texten säger "om cirka 2", inte strax, och U33 rör inte notisen', async () => {
      const tokens = await send(vessel(380, { sog: 5.5, etaMinutes: 2.7, _etaIsExtrapolated: true }));
      expect(tokens.eta_minutes).toBe(3);
    });

    test('position äldre än 10 min: varken flaggan eller texten säger strax', async () => {
      const old = now - UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS - 1000;
      expect((await send(vessel(250, { timestamp: old, lastPositionUpdate: old }))).eta_minutes).toBe(4);
    });

    test('uttömd extrapolering räknas inte i notisens fråga (omvärderingen nollar den först)', async () => {
      const tokens = await send(vessel(420, {
        sog: 6, etaMinutes: 3.4, _etaExtrapolationExhausted: true, _etaExhaustedAtMs: now - 10000,
      }));
      expect(tokens.eta_minutes).toBe(3);
    });

    test('redan "om 2" eller lägre ändras inte', async () => {
      expect((await send(vessel(200, { sog: 5, etaMinutes: 2.2 }))).eta_minutes).toBe(2);
    });

    test('ETA okänd (U30): ingen siffra fylls i, notisen saknar ETA', async () => {
      app.statusService = { isStillUnknownETA: () => true, hasStationaryETAHold: () => false };
      const tokens = await send(vessel(250, { etaMinutes: null }));
      expect(tokens.eta_minutes).toBe(-1);
      expect(tokens.eta_available).toBe(false);
    });

    test('mellanbron: notisen för Järnvägsbron behåller sin avstånds-ETA', async () => {
      // 250 m före Järnvägsbron i 1,5 kn, målbro Stridsbergsbron 440 m bort.
      const pos = pointBefore(JVG, KLAFF, 250);
      const v = vessel(0, {
        ...pos,
        sog: 1.5,
        targetBridge: 'Stridsbergsbron',
        passedBridges: ['Olidebron', 'Klaffbron'],
        lastPassedBridge: 'Klaffbron',
        etaMinutes: 3.6,
      });
      const c = {
        name: 'Järnvägsbron',
        id: 'jarnvagsbron',
        source: 'current',
        distance: geometry.calculateDistance(v.lat, v.lon, JVG.lat, JVG.lon),
      };
      const expected = Math.round((c.distance / (1.5 * 0.5144)) / 60);
      expect((await send(v, c)).eta_minutes).toBe(expected);
      expect(expected).toBeGreaterThan(2);
    });

    test('en annan båts strax i gruppen räknas inte: frågan gäller den här båten', async () => {
      const other = vessel(100, { mmsi: '265000002', name: 'ANNAN', _isImminentAtTargetBridge: true });
      app.vesselDataService = {
        getAllVessels: () => [other],
        getVessel: (m) => (m === other.mmsi ? other : null),
        hasGpsJumpHold: () => false,
      };
      expect((await send(vessel(380, { sog: 5, etaMinutes: 3.4 }))).eta_minutes).toBe(3);
    });
  });

  describe('regeln finns på ett ställe', () => {
    test('_imminentVerdict är imminent-beslutet som omvärderingen verkställer', () => {
      const v = vessel(280);
      expect(app._imminentVerdict(v).imminent).toBe(true);
      expect(app._imminentVerdict(vessel(320)).imminent).toBe(false);
      expect(app._imminentVerdict(vessel(320, { _isImminentAtTargetBridge: true })).imminent).toBe(true);
      // Echo-hållningen: osäker position behåller flaggan orörd.
      const held = app._imminentVerdict(vessel(600, { _positionUncertain: true, _isImminentAtTargetBridge: true }));
      expect(held.imminent).toBe(true);
      expect(app._imminentVerdict(vessel(600, { _positionUncertain: true })).imminent).toBe(false);
      // Uttömd extrapolering: omvärderingen sätter flaggan, notisens fråga räknar den inte.
      const exhausted = vessel(420, { _etaExtrapolationExhausted: true, _etaExhaustedAtMs: now - 10000 });
      expect(app._imminentVerdict(exhausted)).toMatchObject({ imminent: true, fromExhausted: true });
      expect(app._imminentVerdict(exhausted, { forNotice: true }).imminent).toBe(false);
      // Beslutet är fritt från sidoeffekter.
      expect(v._isImminentAtTargetBridge).toBeUndefined();
    });

    test('vesselSaysStrax svarar som brotexten för en ensam båt (rutnät över villkoren)', () => {
      const svc = app.bridgeTextService;
      const base = {
        mmsi: '1', name: 'A', targetBridge: 'Klaffbron', sog: 4, cog: 33, ...pointBefore(KLAFF, OLIDE, 250),
      };
      // Kartesisk produkt utan nästlade loopar.
      const grid = [
        [null, 1.2, 2.49, 2.5, 2.99, 3, 3.6, 12], // etaMinutes
        [false, true], // extrapolerad
        [false, true], // imminent-flaggan
        ['approaching', 'under-bridge'],
        ['Klaffbron', 'Olidebron'], // currentBridge
        [false, true], // gammal position
        [false, true], // zombie (målbron redan passerad)
      ].reduce((acc, values) => acc.flatMap((c) => values.map((x) => [...c, x])), [[]]);
      let checked = 0;
      grid.forEach(([eta, extrapolated, imminent, status, currentBridge, stale, zombie]) => {
        const t = stale ? now - UI_CONSTANTS.STALE_ETA_HARD_THRESHOLD_MS - 1000 : now;
        const v = {
          ...base,
          etaMinutes: eta,
          _etaIsExtrapolated: extrapolated,
          _isImminentAtTargetBridge: imminent,
          status,
          currentBridge,
          timestamp: t,
          lastPositionUpdate: t,
          passedBridges: zombie ? ['Klaffbron'] : [],
        };
        const text = svc.generateBridgeText([v]);
        const textSaysStrax = /på väg mot Klaffbron, beräknad broöppning strax/.test(text);
        const label = [eta, extrapolated, imminent, status, currentBridge, stale, zombie];
        expect([...label, svc.vesselSaysStrax(v, 'Klaffbron')]).toEqual([...label, textSaysStrax]);
        checked += 1;
      });
      expect(checked).toBe(8 * 2 * 2 * 2 * 2 * 2 * 2);
    });

    test('vesselSaysStrax gäller bara båtens egen målbro', () => {
      const svc = app.bridgeTextService;
      const v = vessel(100, { _isImminentAtTargetBridge: true });
      expect(svc.vesselSaysStrax(v, 'Klaffbron')).toBe(true);
      expect(svc.vesselSaysStrax(v, 'Stridsbergsbron')).toBe(false);
      expect(svc.vesselSaysStrax({ ...v, targetBridge: 'Järnvägsbron' }, 'Järnvägsbron')).toBe(false);
      expect(STRIDS.name).toBe('Stridsbergsbron');
    });
  });

  // Granskningen av U33 (anmärkning 1), genom hela appen: OSAKER-4 går norrut
  // i 3,3 kn med fix var 30:e s. Ett AIS-glapp tar henne från 800 m till 295 m
  // före Klaffbron med kursen 62° fel, så fixet blir uncertain_movement:
  // echo-hållningen låter imminent-flaggan vara falsk och texten säger
  // "om 8 minuter" i 30 s. FLOW_TRIGGER_ETA_CAP sänker notisens lagrade 8,2
  // till rå restid 2,77. Frågade regeln med notisens siffra blev notisen
  // "om 2" mot textens "om 8"; med båtens egen siffra (den texten visar) blir
  // den "om 3" som på basen. Nästa rena fix ger strax.
  describe('genom hela appen', () => {
    const replay = (file) => new Promise((resolve, reject) => {
      execFile(process.execPath, [path.join(__dirname, 'replay-validation/replayRunner.js'), file], {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env, NODE_OPTIONS: '', REPLAY_VERBOSE: '', REPLAY_MONITORING: '',
        },
      }, (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout.match(/__REPLAY_JSON__(.*?)__END__/s)[1]))));
    });

    test('osäker position efter glapp: notisen följer siffran texten visar, inte taket', async () => {
      const result = await replay(path.join(__dirname, 'fixtures', 'u33-osaker-glapp.jsonl'));
      const textAt = (t) => result.bridgeTextTransitions.filter((x) => x.t <= t + 1000).pop().text;
      const notice = result.notifications.find((n) => n.bridge === 'Klaffbron' && !n.alreadyPassed);
      expect(notice).toBeDefined();
      expect(textAt(notice.t)).toBe('En båt på väg mot Klaffbron, beräknad broöppning om 8 minuter');
      expect(notice.eta).toBe(3);
      // Och allmänt: en målbronotis säger aldrig under 3 när texten i samma
      // ögonblick visar en siffra för bron.
      for (const n of result.notifications.filter((x) => ['Klaffbron', 'Stridsbergsbron'].includes(x.bridge))) {
        if (n.eta >= 0 && n.eta < 3) {
          expect(textAt(n.t)).not.toMatch(new RegExp(`mot ${n.bridge}, beräknad broöppning om (cirka )?([3-9]|\\d\\d)`));
        }
      }
    }, 120000);
  });
});
