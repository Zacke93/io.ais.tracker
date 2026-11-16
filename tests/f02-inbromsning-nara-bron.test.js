'use strict';

jest.mock('homey');

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const ProgressiveETACalculator = require('../lib/services/ProgressiveETACalculator');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const geometry = require('../lib/utils/geometry');
const { BRIDGES } = require('../lib/constants');

/**
 * F02 (buggjägarens standardkörning; triagens F06): inbromsning nära bron.
 * XENIA (värld 192) bromsar från 4,5 till 1,1 kn cirka 340 m före Klaffbron.
 * Fartbufferten bär anloppsfarten, rå-ETA:n på medelfarten lovar strax och
 * texten sa "strax" 9,9 min före korsningen, sedan "om 4", sedan "strax".
 * Inbromsningsregeln i ProgressiveETACalculator._processETAWithProtection
 * håller ETA:n på strax-tröskeln när medelfarten ENSAM lovar strax (se
 * DECEL_HOLD_* i filen). Sviten prövar varje delvillkor åt båda håll och hela
 * kedjan på syntetiska scenarier (egna positioner, granskarnas generator).
 */

global.__TEST_MODE__ = true;
const ROOT = path.resolve(__dirname, '..');
const MMSI = '265000101';

describe('F02: inbromsningsregeln (enhet, _processETAWithProtection)', () => {
  let logger;
  const holdLines = () => logger.debug.mock.calls.filter(([m]) => String(m).includes('[ETA_DECEL_HOLD]'));

  // Förra värdet i kalkylatorns historik `prev` (30 s gammalt om inte annat
  // sägs), fartbufferten `buf`, momentanfarten `sog` och samplets rå-ETA
  // `raw`. Utan `distM` är targetBridge null, vilket isolerar beräknings-
  // stegen (ingen väntan, inget avstånd); med `distM` ligger båten så långt
  // söder om Klaffbron. `calc` behålls för att läsa historiken.
  let calc;
  const run = ({
    prev, raw, sog, buf, imminent = false, ageMs = 30000, gps = false, distM = null,
  }) => {
    logger = {
      debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
    };
    calc = new ProgressiveETACalculator(logger, new BridgeRegistry());
    calc._recordETAHistory(MMSI, {
      rawETA: prev,
      protectedETA: prev,
      processedETA: prev,
      timestamp: Date.now() - ageMs,
      targetBridge: null,
      nearestBridge: null,
      vesselSpeed: 4.5,
      distance: null,
      distanceToTarget: null,
      vesselStatus: 'en-route',
    });
    calc._speedBuffers.set(MMSI, buf);
    const vessel = {
      mmsi: MMSI,
      sog,
      status: 'en-route',
      targetBridge: distM === null ? null : 'Klaffbron',
      lat: distM === null ? undefined : BRIDGES.klaffbron.lat - distM / 111320,
      lon: distM === null ? undefined : BRIDGES.klaffbron.lon,
      _isImminentAtTargetBridge: imminent,
      lastCoordinationLevel: gps ? 'enhanced' : undefined,
    };
    return calc._processETAWithProtection(vessel, raw, null);
  };

  // XENIA-formen: bufferten [4,5; 2,5; 1,1] ger snittet 2,7 kn mot 1,1 nu
  // (kvot 2,45). Rå-ETA 2,0 på snittet ⇒ EMA 2,84; momentant 4,9 min.
  const XENIA = {
    prev: 3.4, raw: 2.0, sog: 1.1, buf: [4.5, 2.5, 1.1],
  };

  test('alla villkor: hålls på 3 (inte 2,84, som hade gett "strax")', () => {
    expect(run(XENIA)).toBe(3);
    expect(holdLines()).toHaveLength(1);
  });

  test('villkor 1, nytt inträde: en redan given strax (förra 2,9) lyfts inte till 3', () => {
    expect(run({ ...XENIA, prev: 2.9 })).toBeCloseTo(2.54, 5);
    expect(holdLines()).toHaveLength(0);
  });

  test('villkor 2, mätningen: lovar samplets egen mätning inte strax (rå 5 under GPS-fallback) hålls inget', () => {
    // GPS-grenen ersätter rå-ETA:n med en blandning under förra värdet, så
    // det publicerade hamnar under 3 fast mätningen säger 5 min.
    const out = run({
      ...XENIA, prev: 3.05, raw: 5, ageMs: 90000, gps: true,
    });
    expect(out).toBeLessThan(3);
    expect(out).toBeCloseTo(2.864, 2);
    expect(holdLines()).toHaveLength(0);
  });

  test('villkor 3, kvoten: 1,20 håller, 1,18 inte (momentan-ETA:n över 3,5 i båda)', () => {
    expect(run({
      prev: 3.0, raw: 2.98, sog: 2.0, buf: [2.4],
    })).toBe(3);
    expect(run({
      prev: 3.0, raw: 2.98, sog: 2.0, buf: [2.36],
    })).toBeCloseTo(2.992, 5);
    expect(holdLines()).toHaveLength(0);
  });

  test('villkor 3, lätt inbromsning (kvot 1,15): ingen hållning', () => {
    expect(run({
      prev: 3.4, raw: 2.0, sog: 2.0, buf: [2.3],
    })).toBeCloseTo(2.84, 5);
    expect(holdLines()).toHaveLength(0);
  });

  test('villkor 4, momentanfartens ETA: 3,50 håller, 3,48 inte', () => {
    expect(run({
      prev: 3.4, raw: 1.75, sog: 1.0, buf: [2.0],
    })).toBe(3);
    expect(run({
      prev: 3.4, raw: 1.74, sog: 1.0, buf: [2.0],
    })).toBeCloseTo(2.736, 5);
    expect(holdLines()).toHaveLength(0);
  });

  test('villkor 5, imminent-flaggan på: ingen hållning', () => {
    expect(run({ ...XENIA, imminent: true })).toBeCloseTo(2.84, 5);
    expect(holdLines()).toHaveLength(0);
  });

  // Granskningen av C-decel, H1: Fix H skriver flaggan senare i svepet än
  // ETA:n räknas, så på första fixet innanför 300 m är den falsk. Regeln
  // prövar därför avståndet själv (APPROACH_RADIUS).
  test('villkor 5, avståndet: 225 m och 299 m (flaggan ännu falsk) ger ingen hållning, 305 m håller', () => {
    expect(run({ ...XENIA, distM: 225 })).toBeCloseTo(2.84, 5);
    expect(run({ ...XENIA, distM: 299 })).toBeCloseTo(2.84, 5);
    expect(holdLines()).toHaveLength(0);
    expect(run({ ...XENIA, distM: 305 })).toBe(3);
    expect(holdLines()).toHaveLength(1);
  });

  test('villkor 5, gränsen: exakt 300,0 m räknas som innanför (ingen hållning), 300,1 m håller', () => {
    const at = (meters) => {
      logger = {
        debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
      };
      calc = new ProgressiveETACalculator(logger, new BridgeRegistry());
      calc._getDistanceToTarget = () => meters;
      calc._recordETAHistory(MMSI, {
        rawETA: 3.4, protectedETA: 3.4, processedETA: 3.4, timestamp: Date.now() - 30000,
      });
      calc._speedBuffers.set(MMSI, [4.5, 2.5, 1.1]);
      return calc._processETAWithProtection({
        mmsi: MMSI, sog: 1.1, status: 'en-route', targetBridge: null,
      }, 2.0, null);
    };
    expect(at(300)).toBeCloseTo(2.84, 5);
    expect(at(300.1)).toBe(3);
  });

  // Granskningen av C-decel, M1: hållningen gäller bara det som publiceras.
  test('historiken bär det OHÅLLNA värdet; det hållna 3 bär bara publiceringen', () => {
    expect(run(XENIA)).toBe(3);
    const last = calc._etaHistory.get(MMSI).slice(-1)[0];
    expect(last.processedETA).toBeCloseTo(2.84, 5);
    expect(last.decelHeldETA).toBe(3);
  });

  test('andra passet på samma fix (K6) ser det publicerade 3 och håller igen', () => {
    expect(run(XENIA)).toBe(3);
    const vessel = {
      mmsi: MMSI, sog: 1.1, status: 'en-route', targetBridge: null,
    };
    // Pass 2: samma bufferts kvot; EMA från det ohållna 2,84 ⇒ 2,50 < 3.
    expect(calc._processETAWithProtection(vessel, 2.0, null)).toBe(3);
    expect(holdLines()).toHaveLength(2);
  });

  test('nästa sampel räknar från det ohållna värdet (som om regeln inte hade hållit)', () => {
    run(XENIA);
    const vessel = {
      mmsi: MMSI, sog: 4.0, status: 'en-route', targetBridge: null,
    };
    // Båten gasar igen (snittet under momentanfarten ⇒ ingen hållning):
    // EMA 0,4 · 1,5 + 0,6 · 2,84 = 2,30. Med det hållna 3 som bas hade det
    // blivit 2,40 — och vid avrundningen i en notis "om 3" i stället för "om 2".
    calc._speedBuffers.set(MMSI, [2.5, 1.1, 4.0]);
    expect(calc._processETAWithProtection(vessel, 1.5, null)).toBeCloseTo(0.4 * 1.5 + 0.6 * 2.84, 5);
  });

  test('värdet är redan minst 3 (EMA 3,4): regeln rör det inte', () => {
    expect(run({ ...XENIA, prev: 4.0, raw: 2.5 })).toBeCloseTo(3.4, 5);
    expect(holdLines()).toHaveLength(0);
  });

  test('saknad fart eller tom buffert: ingen kvot, ingen hållning', () => {
    expect(run({ ...XENIA, sog: undefined })).toBeCloseTo(2.84, 5);
    expect(run({ ...XENIA, buf: [] })).toBeCloseTo(2.84, 5);
    expect(holdLines()).toHaveLength(0);
  });

  test('momentanfarten har golvet 0,5 kn: sog 0,1 mot snitt 1,0 ger kvoten 2,0, inte 10', () => {
    expect(run({
      prev: 3.4, raw: 2.0, sog: 0.1, buf: [1.0],
    })).toBe(3);
    expect(holdLines()[0][0]).toMatch(/kvot 2\.00/);
  });

  test('accelerationen (snittet under momentanfarten) håller aldrig', () => {
    expect(run({
      prev: 3.4, raw: 2.0, sog: 4.5, buf: [1.1, 2.5, 4.5],
    })).toBeCloseTo(2.84, 5);
    expect(holdLines()).toHaveLength(0);
  });
});

/**
 * Hela kedjan genom appen (replayRunner), syntetiska positioner söderifrån
 * mot Klaffbron. Före regeln (bfaeec4) gav XENIA-formen "strax" 10:08:30
 * (10,0 min före korsningen), "om 4" 10:09:00 och "strax" 10:10:00
 * (imminent, inom 300 m). Motfallen ska ge exakt samma text och notiser som
 * före regeln (låsta i f02-*.expected.json). De tre första är byggda så att
 * vart och ett blir rött när just SITT villkor tas bort (granskningen av
 * C-decel, M2; prövat med en mutant per villkor). De tre sista är
 * regressionslås: där spärrar flera villkor samtidigt (jämn fart: ingen
 * kvot; lätt inbromsning: kvoten 1,15 OCH momentan-ETA:n 2,9) eller inget
 * av regelns villkor (gammal position: U16/F40). Kvoten ensam och
 * mätningsvillkoret har inget motfall genom appen — fönstret där bara
 * kvoten spärrar (kvot 1,167–1,2, mätningen 2,92–3,0 och förra värdet
 * 3,00–3,03) träffades inte i en sökning över 108 scenarier — och prövas i
 * enhetsfallen ovan.
 */
describe('F02: inbromsningsregeln genom appen', () => {
  const run = (name) => new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(ROOT, 'tests/replay-validation/replayRunner.js'),
      path.join(__dirname, 'fixtures', `f02-${name}.jsonl`)], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env, NODE_OPTIONS: '', REPLAY_VERBOSE: '', REPLAY_MONITORING: '',
      },
    }, (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout.match(/__REPLAY_JSON__(.*?)__END__/s)[1]))));
  });
  const klaffStrax = (t) => /på väg mot Klaffbron, beräknad broöppning strax/.test(t);

  test('XENIA-formen: en enda "strax" före passagen, och först inom strax-löftet eller 300 m', async () => {
    const result = await run('xenia');
    const passage = result.targetPassages.find((p) => p.bridge === 'Klaffbron');
    expect(passage).toBeDefined();
    const before = result.bridgeTextTransitions.filter((r) => r.t < passage.t);
    // Antal övergångar TILL strax för Klaffbron: en fördröjd eller
    // återkommande strax syns här (före regeln: två).
    const entries = before.filter((r, i) => klaffStrax(r.text) && !(i > 0 && klaffStrax(before[i - 1].text)));
    expect(entries).toHaveLength(1);
    const first = entries[0];
    const rows = fs.readFileSync(path.join(__dirname, 'fixtures', 'f02-xenia.jsonl'), 'utf8')
      .trim().split('\n').map(JSON.parse);
    const fix = rows.filter((r) => r.aisTimestamp <= first.t).pop();
    const meters = geometry.calculateDistance(fix.lat, fix.lon, BRIDGES.klaffbron.lat, BRIDGES.klaffbron.lon);
    const minutesLeft = (passage.t - first.t) / 60000;
    expect(meters <= 300 || minutesLeft <= 3).toBe(true);
    // Ingen uppgång från strax till minuttal före passagen.
    for (let i = 1; i < before.length; i += 1) {
      if (klaffStrax(before[i - 1].text)) expect(klaffStrax(before[i].text)).toBe(true);
    }
  }, 120000);

  test.each([
    ['inom300', 'villkor 5, avståndet: 7 kn, fix var 90 s, bromsar till 1,8 kn på första fixet innanför 300 m — notis och text som förut'],
    ['redanstrax', 'villkor 1, nytt inträde: 8 kn, strax redan given, bromsar till 1,2 kn 500 m före — som förut'],
    ['momentan', 'villkor 4, momentanfartens ETA: 5 → 3,5 kn 380 m före (kvot över 1,2, momentan-ETA under 3,5) — som förut'],
    ['jamn', 'regressionslås: håller farten 4,5 kn, strax i samma sampel som förut'],
    ['latt', 'regressionslås: bromsar lite (4,5 → 3,68 kn), som förut'],
    ['gammal', 'regressionslås: positionen blir gammal före bron (glapp 6,5 min), som förut'],
  ])('%s — %s', async (name) => {
    const result = await run(name);
    const expected = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `f02-${name}.expected.json`), 'utf8'));
    expect(result.bridgeTextTransitions.map((r) => [r.t, r.text])).toEqual(expected.bridgeTextTransitions);
    expect((result.notifications || []).map((n) => [n.t, n.mmsi, n.bridge, n.eta])).toEqual(expected.notifications);
  }, 120000);
});
