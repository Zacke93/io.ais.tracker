'use strict';

jest.mock('homey');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const AISBridgeApp = require('../app');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const BridgeTextService = require('../lib/services/BridgeTextService');
const ProximityService = require('../lib/services/ProximityService');
const { BRIDGES } = require('../lib/constants');

/**
 * F07 (buggjägarens kort F03 i standardkörningen 2026-11-14; ETA-etappen under
 * ägarbeslutet U28): RC4-klampen släpper en Fix G-baslinje som texten inte
 * visar, men bara när släppet är osynligt — den färska beräkningen ligger
 * över det värde gruppens klausul visar, så texten är oförändrad i samma
 * ögonblick. Se app.js _reconcilePublishedETA och _presentedGroupLead, och
 * granskningen av den första versionen (P1–P3, kögrenen, gps700/accstop).
 */
const ROOT = path.resolve(__dirname, '..');
const logger = {
  log() {}, debug() {}, error() {}, warn() {},
};

describe('F07: klampen och en osedd Fix G-baslinje (enhet)', () => {
  let app;
  let now;
  let others;
  let held;

  beforeEach(() => {
    now = Date.parse('2026-07-08T07:07:02.344Z');
    jest.spyOn(Date, 'now').mockReturnValue(now);
    app = new AISBridgeApp();
    app.debug = jest.fn();
    app.bridgeRegistry = new BridgeRegistry();
    app.proximityService = new ProximityService(app.bridgeRegistry, logger);
    others = [];
    held = new Set();
    app.vesselDataService = {
      getVesselsForBridgeText: () => others,
      hasGpsJumpHold: (mmsi) => held.has(String(mmsi)),
    };
    app.bridgeTextService = new BridgeTextService(app.bridgeRegistry, logger, null, app.vesselDataService);
    app._lastBridgeTextVessels = new Map();
  });

  afterEach(() => jest.restoreAllMocks());

  // Den bakre båten: Fix G har just registrerat sin extrapolering (25,3) som
  // publicerad baslinje, 1,2 km söder om Klaffbron.
  const rear = (o = {}) => ({
    mmsi: '219009353',
    targetBridge: 'Klaffbron',
    lat: BRIDGES.klaffbron.lat - 0.011,
    lon: BRIDGES.klaffbron.lon,
    timestamp: now,
    lastPositionUpdate: now,
    etaMinutes: 25.26,
    status: 'en-route',
    passedBridges: [],
    _routeDirection: 'north',
    fixTs: now,
    sog: 3.7,
    _rawPositionSog: 3.7,
    // Förra fixet 302 s tidigare, 480 m söderut i 1,7 kn: kvot ≈ 0,84 (rimligt).
    _prevFixSample: {
      lat: BRIDGES.klaffbron.lat - 0.011 - 480 / 111320, lon: BRIDGES.klaffbron.lon, sog: 1.7, t: now - 302000,
    },
    _etaIsExtrapolated: true,
    _etaPublishedFromExtrapolation: true,
    _etaPublishTarget: 'Klaffbron',
    _etaPublishedValue: 25.26,
    _etaPublishedAtMs: now - 2300,
    ...o,
  });
  const other = (o = {}) => ({
    mmsi: '257919970',
    targetBridge: 'Klaffbron',
    lat: BRIDGES.klaffbron.lat - 0.008,
    lon: BRIDGES.klaffbron.lon,
    timestamp: now - 30000,
    lastPositionUpdate: now - 30000,
    etaMinutes: 10,
    status: 'en-route',
    passedBridges: [],
    _routeDirection: 'north',
    ...o,
  });
  // RC4 mot 25,26: maxDelta = max(3, glapp + 0,25 · 25,26) ≈ 6,35 ⇒ 18,9.
  const CLAMPED = [18.5, 19.5];
  const expectClamped = (out) => {
    expect(out).toBeGreaterThan(CLAMPED[0]);
    expect(out).toBeLessThan(CLAMPED[1]);
  };

  test('osynligt släpp: en annan båt leder (10) och färska 13,39 ligger över ledaren', () => {
    const v = rear();
    others = [v, other()];
    expect(app._reconcilePublishedETA(v, 13.39)).toBe(13.39);
    expect(v._etaPublishedFromExtrapolation).toBe(false);
  });

  test('P2 (granskningen): andra passet på samma fix klampas mot första passets MÄTNING', () => {
    const v = rear();
    others = [v, other()];
    expect(app._reconcilePublishedETA(v, 13.39)).toBe(13.39);
    // Baslinjen 13,39 är nu en mätning: RC4 ger 13,39 − max(3, 0,25 · 13,39) = 10,04.
    // (I appen nollas _etaIsExtrapolated först efter snapshot-anropet.)
    expect(v._etaIsExtrapolated).toBe(true);
    expect(app._reconcilePublishedETA(v, 5)).toBeCloseTo(10.04, 1);
  });

  test('den färska går UNDER det visade värdet och fixet är rimligt: dämpas mot det VISADE (17), inte mot den osedda 25,3', () => {
    const v = rear();
    others = [v, other({ etaMinutes: 17 })];
    // 17 − max(3, 4,25) = 12,75 ⇒ den färska 13,39 går igenom
    expect(app._reconcilePublishedETA(v, 13.39)).toBe(13.39);
    // Andra passet på samma fix dämpas mot samma referens (burstens bas = 17):
    // texten sjunker högst en maxDelta på ett fix.
    expect(app._reconcilePublishedETA(v, 5)).toBeCloseTo(12.75, 2);
  });

  test('gps700-klassen: fixet går inte ihop med rörelsen (700 m för långt fram) — klampen gäller som förut', () => {
    const v = rear({
      _prevFixSample: {
        lat: BRIDGES.klaffbron.lat - 0.011 - 1300 / 111320, lon: BRIDGES.klaffbron.lon, sog: 3.0, t: now - 390000,
      },
      sog: 3.0,
      _rawPositionSog: 3.0,
    });
    others = [v, other({ etaMinutes: 17 })];
    expectClamped(app._reconcilePublishedETA(v, 13.39));
  });

  test.each([
    ['GPS-misstänkt fix', { _positionUncertain: true }],
    ['GPS-hopp', { _gpsJumpDetected: true }],
    ['inget föregående fix', { _prevFixSample: null }],
    ['föregående fix med samma fixtid', {
      _prevFixSample: {
        lat: 58.27, lon: 12.28, sog: 3, t: Date.parse('2026-07-08T07:07:02.344Z'),
      },
    }],
  ])('%s: sänkningen tillåts inte, klampen gäller som förut', (_label, extra) => {
    const v = rear(extra);
    others = [v, other({ etaMinutes: 17 })];
    expectClamped(app._reconcilePublishedETA(v, 13.39));
  });

  test('lika med det visade värdet: dämpningsgrenen (inte släppet) — resultatet blir det visade värdet', () => {
    const v = rear();
    others = [v, other({ etaMinutes: 17 })];
    expect(app._reconcilePublishedETA(v, 17)).toBe(17);
  });

  test('P1 (granskningen): en GPS-hållen ledare utan tidigare underlag som texten tagit bort leder inte', () => {
    const v = rear();
    const b = other();
    others = [v, b];
    held.add(b.mmsi);
    const text = app.bridgeTextService.generateBridgeText(
      app._bridgeTextPresentationVessels(app._findRelevantBoatsForBridgeText()), { includeGpsHeld: true },
    );
    expect(text).toMatch(/om cirka 25 minuter/);
    expectClamped(app._reconcilePublishedETA(v, 13.39));
  });

  test('_processingRemoval: en ledare som håller på att tas bort leder inte', () => {
    const v = rear();
    const b = other();
    others = [v, b];
    app._processingRemoval = new Set([b.mmsi]);
    expectClamped(app._reconcilePublishedETA(v, 13.39));
  });

  test('P3 (granskningen): en baslinje som visades (19) faller inte till 6 när en annan båt dök upp med 18', () => {
    const v = rear({ etaMinutes: 19, _etaPublishedValue: 19 });
    others = [v, other({ etaMinutes: 18 })];
    // Basen gav 19 − 4,75 = 14,25. Här visar texten den andra båtens 18, och
    // texten får sjunka högst en maxDelta från det: 18 − 4,5 = 13,5 (dirigentens
    // villkor (iii)); utan rimligt fix gäller basens 14,25.
    expect(app._reconcilePublishedETA(v, 6)).toBeCloseTo(13.5, 2);
    const w = rear({ etaMinutes: 19, _etaPublishedValue: 19, _prevFixSample: null });
    expect(app._reconcilePublishedETA(w, 6)).toBeCloseTo(14.25, 1);
  });

  test('H3: en båt med bekräftad kö vid Olidebron (vänttext utan minuter) leder inte', () => {
    const v = rear();
    const q = other({
      lat: BRIDGES.olidebron.lat - 0.0006,
      lon: BRIDGES.olidebron.lon,
      timestamp: now - 10000,
      lastPositionUpdate: now - 10000,
      sog: 0,
      etaMinutes: 10,
      _bridgeQueueApproaches: { Olidebron: { confirmedAt: now - 300000, waitConfirmedAt: now - 240000, direction: 'north' } },
    });
    others = [v, q];
    const text = app.bridgeTextService.generateBridgeText(
      app._bridgeTextPresentationVessels(app._findRelevantBoatsForBridgeText()), { includeGpsHeld: true },
    );
    expect(text).toMatch(/väntar vid Olidebron/);
    expectClamped(app._reconcilePublishedETA(v, 13.39));
  });

  test('H1: båten själv i listan (med lägre etaMinutes än baslinjen) räknas inte som "annan ledare"', () => {
    const v = rear({ etaMinutes: 10 });
    others = [v];
    expectClamped(app._reconcilePublishedETA(v, 13.39));
  });

  test.each([
    ['ensam båt (hennes extrapolering är gruppens klausul)', () => []],
    ['hon själv leder (den andra har högre ETA)', () => [other({ etaMinutes: 30 })]],
    ['den andra är en zombie (målbron redan passerad)', () => [other({ passedBridges: ['Klaffbron'] })]],
    ['den andra har en annan målbro', () => [other({ targetBridge: 'Stridsbergsbron' })]],
    ['den andra saknar giltig ETA', () => [other({ etaMinutes: null })]],
  ])('%s: baslinjen försvaras som förut', (_label, make) => {
    const v = rear();
    others = [v, ...make()];
    expectClamped(app._reconcilePublishedETA(v, 13.39));
  });

  test('bara nedåt: en högre färsk beräkning dämpas som förut', () => {
    const v = rear();
    others = [v, other()];
    const out = app._reconcilePublishedETA(v, 40);
    expect(out).toBeGreaterThan(31);
    expect(out).toBeLessThan(32.5);
  });

  test('en uppmätt baslinje (inte Fix G:s) försvaras som förut, även om _etaIsExtrapolated står', () => {
    const v = rear({ _etaPublishedFromExtrapolation: false });
    others = [v, other()];
    expectClamped(app._reconcilePublishedETA(v, 13.39));
  });
});

/**
 * Hela kedjan: granskningens syntetiska motfall (egna positioner, byggda med
 * granskarens generator). En klass B-båt bakom en ledare får efter ett glapp
 * på 6,5 min en färsk siffra under ledarens visade värde. Texten ska vara
 * exakt som på 7eb350d: klampen gäller, och ingen för optimistisk siffra tar
 * över gruppens klausul.
 */
describe('F07: motfallen gps700 och accstop genom appen', () => {
  let dir;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f07-mot-'));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const replay = (jsonl) => new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(ROOT, 'tests/replay-validation/replayRunner.js'), jsonl], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      env: {
        ...process.env, NODE_OPTIONS: '', REPLAY_VERBOSE: '', REPLAY_MONITORING: '',
      },
    }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(JSON.parse(stdout.match(/__REPLAY_JSON__(.*?)__END__/s)[1]));
    });
  });

  const texts = (result) => result.bridgeTextTransitions
    .map((t) => `${new Date(t.t).toISOString().slice(11, 19)} ${t.text}`);

  test.each([
    ['gps700'], ['gps400'], ['spik1'], ['accstop'],
  ])('%s: brotext och notiser som i den låsta förväntan', async (name) => {
    const expected = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `f07-${name}.expected.json`), 'utf8'));
    const result = await replay(path.join(__dirname, 'fixtures', `f07-${name}.jsonl`));
    expect(texts(result)).toEqual(expected.texts);
    expect(result.notifications.map((n) => `${n.mmsi}|${n.bridge}|${n.eta}`)).toEqual(expected.notifications);
  }, 120000);

  // accstop är det enda scenariot där sänkningen binder (fixet är rimligt: båten
  // accelererade under glappet). Texten får sjunka högst klampens maxDelta på
  // ett fix räknat från det visade värdet, samma gräns som en ensam båt har.
  test('accstop: texten sjunker högst en maxDelta på det fix som sänker den', async () => {
    const result = await replay(path.join(__dirname, 'fixtures', 'f07-accstop.jsonl'));
    const val = (t) => {
      const m = t.text.match(/Klaffbron, beräknad broöppning om (?:cirka )?(\d+) minuter/);
      return m ? Number(m[1]) : null;
    };
    const seq = result.bridgeTextTransitions.map(val).filter((v) => v !== null);
    // Ledaren nedräknas en minut i taget (21, 20 … 15). Den första sänkning
    // som är större än en minut är den bakre båtens fix 10:07: "om 15" (det
    // visade 14,62) → "om 11" (14,62 − 3,65 = 10,97). Avrundningen kan lägga
    // till högst en minut i det visade steget.
    const i = seq.findIndex((v, k) => k + 1 < seq.length && v - seq[k + 1] > 1);
    expect(i).toBeGreaterThanOrEqual(0);
    const before = seq[i];
    expect(before - seq[i + 1]).toBeLessThanOrEqual(Math.max(3, 0.25 * before) + 1);
  }, 120000);
});

/**
 * F03:s fasvariant av 20260708-21h (δ −11,52 s, bitlik med kortets
 * variant.jsonl). Texten ska aldrig visa AVALON:s klampade gissning ("om 18"
 * eller "om 19"), och ingen INV-3-sågtand vid Klaffbron.
 */
describe('F07: 20260708-21h i fasvarianten δ −11,52 s', () => {
  const corpora = require('./replay-validation/corpora');
  const { validateInvariants } = require('./replay-validation/invariants');
  const corpus = corpora.find((c) => c.id === '20260708-21h');
  let dir;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f07-21h-'));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('AVALON:s osedda gissning tar aldrig över texten', async () => {
    const d = -11520;
    const rows = fs.readFileSync(corpus.jsonl, 'utf8').trim().split('\n').map((l) => {
      const r = JSON.parse(l);
      if (Number.isFinite(r.aisTimestamp)) r.aisTimestamp += d;
      if (Number.isFinite(r.fixTs)) r.fixTs += d;
      if (typeof r.receivedAt === 'string' && Number.isFinite(Date.parse(r.receivedAt))) {
        r.receivedAt = new Date(Date.parse(r.receivedAt) + d).toISOString();
      }
      return JSON.stringify(r);
    });
    const jsonl = path.join(dir, 'fas-11.52.jsonl');
    fs.writeFileSync(jsonl, `${rows.join('\n')}\n`);
    const result = await new Promise((resolve, reject) => {
      execFile(process.execPath, [path.join(ROOT, 'tests/replay-validation/replayRunner.js'), jsonl], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        env: {
          ...process.env, NODE_OPTIONS: '', REPLAY_VERBOSE: '', REPLAY_MONITORING: '',
        },
      }, (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout.match(/__REPLAY_JSON__(.*?)__END__/s)[1]))));
    });
    const from = Date.parse('2026-07-08T07:06:00Z');
    const to = Date.parse('2026-07-08T07:13:00Z');
    const klaff = result.bridgeTextTransitions
      .filter((t) => t.t >= from && t.t <= to)
      .map((t) => (t.text.match(/på väg mot Klaffbron, beräknad broöppning (om (?:cirka )?\d+ minuter|strax)/) || [])[1])
      .filter(Boolean);
    expect(klaff.length).toBeGreaterThan(0);
    // 7eb350d: "om 19 minuter" 07:11:30. Nu "om 13" från 07:07:02.
    expect(klaff).not.toContain('om 19 minuter');
    expect(klaff).not.toContain('om 18 minuter');
    expect(klaff).toContain('om 13 minuter');
    const sawtooth = validateInvariants(result).filter((v) => /ETA-SÅGTAND UPP: 2026-07-08T07:1\d:\S+ Klaffbron/.test(v));
    expect(sawtooth).toEqual([]);
  }, 120000);
});

/**
 * Rimlighetsprovets föregångare: VesselDataService för förra FIXET vidare och
 * byter det bara när ett fix med senare fixtid kommer. Ett meddelande med
 * samma fixtid (dubblettleverans) får inte göra fixet till sin egen föregångare
 * eller nolla det.
 */
describe('F07: _prevFixSample i VesselDataService', () => {
  const VesselDataService = require('../lib/services/VesselDataService');
  const SystemCoordinator = require('../lib/services/SystemCoordinator');
  let service;
  let now;
  beforeEach(() => {
    global.__TEST_MODE__ = true;
    now = Date.parse('2026-07-08T07:00:00Z');
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    service = new VesselDataService(logger, new BridgeRegistry(), new SystemCoordinator(logger));
  });
  afterEach(() => {
    service.clearAllTimers();
    jest.restoreAllMocks();
    delete global.__TEST_MODE__;
  });

  test('förra fixet följer med och byts bara av ett senare fix', () => {
    const base = {
      lon: BRIDGES.klaffbron.lon, cog: 20, fixFeed: 'aisstream', name: 'PROV',
    };
    const lat0 = BRIDGES.klaffbron.lat - 0.02;
    const t0 = now;
    service.updateVessel('265000099', {
      ...base, lat: lat0, sog: 1.7, fixTs: t0,
    });
    now += 300000;
    const v1 = service.updateVessel('265000099', {
      ...base, lat: lat0 + 0.004, sog: 3.7, fixTs: t0 + 300000,
    });
    expect(v1._prevFixSample).toMatchObject({ lat: lat0, sog: 1.7, t: t0 });
    // Samma fix levereras igen (samma fixtid): föregångaren står kvar.
    now += 2000;
    const v2 = service.updateVessel('265000099', {
      ...base, lat: lat0 + 0.004, sog: 3.7, fixTs: t0 + 300000,
    });
    expect(v2._prevFixSample).toMatchObject({ lat: lat0, sog: 1.7, t: t0 });
  });
});
