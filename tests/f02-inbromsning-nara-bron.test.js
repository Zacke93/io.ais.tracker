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

  test('villkor 1 läser föregående FIX: en stillastående båt (samma sampel) visar inget nytt inträde', () => {
    logger = {
      debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
    };
    calc = new ProgressiveETACalculator(logger, new BridgeRegistry());
    const vessel = {
      mmsi: MMSI, lat: 58.28, lon: 12.28, sog: 0, cog: 20, status: 'en-route', targetBridge: null,
    };
    // Två poster från SAMMA sampel som nuvarande (båten står still): 2,6 och
    // sedan 3,0 när EMA:n klättrat. Det finns inget föregående fix att visa
    // ett inträde från, så regeln håller inte trots förra passets 3,0.
    const key = `${vessel.lat}:${vessel.lon}:${vessel.sog}:${vessel.cog}`;
    for (const v of [2.6, 3.0]) {
      calc._recordETAHistory(MMSI, {
        rawETA: v, protectedETA: v, processedETA: v, timestamp: Date.now() - 30000, decelSampleKey: key,
      });
    }
    calc._speedBuffers.set(MMSI, [6.5, 4.5, 0]);
    expect(calc._processETAWithProtection(vessel, 2.93, null)).toBeLessThan(3);
    expect(holdLines()).toHaveLength(0);
  });

  // Identiska ramar (samma position, fart och kurs): villkor 1 letar sig
  // förbi dem till den sista fixen med ett annat sampel, så beslutet blir
  // detsamma på varje identisk ram som på den första.
  test.each([
    ['den första ramen håller (förra rörliga fixet "om 3")', 3.4, 1.1, true],
    ['den första ramen håller inte (förra rörliga fixet strax)', 2.1, 1.1, false],
  ])('identiska ramar: %s — samma beslut på varje identisk ram', (_l, movingPublished, sog, expectHold) => {
    logger = {
      debug: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(),
    };
    calc = new ProgressiveETACalculator(logger, new BridgeRegistry());
    calc._recordETAHistory(MMSI, {
      rawETA: movingPublished,
      protectedETA: movingPublished,
      processedETA: movingPublished,
      timestamp: Date.now() - 30000,
      decelSampleKey: '58.27:12.27:4.5:20',
    });
    calc._speedBuffers.set(MMSI, [4.5, 2.5, 1.1]);
    const frame = () => ({
      mmsi: MMSI, lat: 58.28, lon: 12.28, sog, cog: 20, status: 'en-route', targetBridge: null,
    });
    const outs = [1, 2, 3, 4].map(() => calc._processETAWithProtection(frame(), 2.0, null));
    const held = holdLines().length;
    if (expectHold) {
      for (const o of outs) expect(o).toBe(3);
      expect(held).toBe(4);
    } else {
      for (const o of outs) expect(o).toBeLessThan(3);
      expect(held).toBe(0);
    }
  });

  // Granskningen av C-decel, M1: hållningen gäller bara det som publiceras.
  test('historiken bär det OHÅLLNA värdet; det hållna 3 bär bara publiceringen', () => {
    expect(run(XENIA)).toBe(3);
    const last = calc._etaHistory.get(MMSI).slice(-1)[0];
    expect(last.processedETA).toBeCloseTo(2.84, 5);
    expect(last.decelHeldETA).toBe(3);
  });

  test('andra passet på samma fix (K6) jämför med föregående fix och håller igen', () => {
    expect(run(XENIA)).toBe(3);
    const vessel = {
      mmsi: MMSI, sog: 1.1, status: 'en-route', targetBridge: null,
    };
    // Pass 2: samma bufferts kvot; EMA från det ohållna 2,84 ⇒ 2,50 < 3.
    expect(calc._processETAWithProtection(vessel, 2.0, null)).toBe(3);
    expect(holdLines()).toHaveLength(2);
  });

  test('nästa fix efter en hållning: förra fixets PUBLICERADE 3 räknas, inte dess ohållna 2,84', () => {
    expect(run(XENIA)).toBe(3);
    // Nytt fix (annan position): fortfarande inbromsning och strax på snittet.
    const vessel = {
      mmsi: MMSI, lat: 58.27, lon: 12.27, sog: 1.1, cog: 20, status: 'en-route', targetBridge: null,
    };
    calc._speedBuffers.set(MMSI, [4.5, 2.5, 1.1]);
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
 * mot Klaffbron. Före regeln (187f31e) gav XENIA-formen "strax" 10:08:30
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
 *
 * U33 (2026-11-16): målbronotisens eta i fixturerna latt, stilla332 och
 * stannar är omräknad till restiden i båtens fart (notisen följer textens
 * strax; fältet "u33" i fixturen). Texterna och övriga notisfält är de låsta.
 * U65 (2026-11-24): i stilla332 ligger båten i kö vid målbron och texten visar
 * "En båt väntar vid Klaffbron" medan köbeviset står (fältet "u65").
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
    ['stilla332', 'villkor 1 på föregående FIX: stannar 332 m före; EMA:n nuddar 3,0 i första passet medan texten säger strax — inget strax → om 3 → strax'],
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

/**
 * Låsta utfall med regeln (inte basen): samma text som regeln ger, och
 * notiserna som i basen. Granskningarna av C-decel: notisfallet ur
 * granskarens rutnät (M1) och samspelet med U30 ("ETA okänd" för en
 * bevisat stilla båt mer än 350 m från bron).
 */
describe('F02: inbromsningsregeln genom appen, låsta utfall med regeln', () => {
  const runFixture = (name) => new Promise((resolve, reject) => {
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
  const load = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `f02-${name}.expected.json`), 'utf8'));
  const klaff = (text) => {
    const m = text.match(/på väg mot Klaffbron, (?:beräknad broöppning (strax|om (?:cirka )?(\d+) minuter)|(ETA okänd))/);
    if (!m) return null;
    if (m[3]) return 'okänd';
    return m[1] === 'strax' ? 'strax' : Number(m[2]);
  };

  // Granskarens rutnät V6_I60_go_b1.8, båten D375: 6 kn, fix var 60 s,
  // bromsar till 1,8 kn 375 m före bron och gasar sedan igen. På 3c7a4ec
  // (hållet 3 i historiken) gick målbronotisen 2 → 3 mot sanningen 1,38.
  test('gasar igen efter hållningen: texten som regeln ger, målbronotisen som basen ("om 2")', async () => {
    const result = await runFixture('gasar');
    const expected = load('gasar');
    expect(result.bridgeTextTransitions.map((r) => [r.t, r.text])).toEqual(expected.bridgeTextTransitions);
    const notis = (result.notifications || []).map((n) => [n.t, n.mmsi, n.bridge, n.eta]);
    expect(notis).toEqual(expected.basNotiser);
    expect(notis.filter((n) => n[2] === 'Klaffbron').map((n) => n[3])).toEqual([2]);
  }, 120000);

  // 6,5 kn, bromsar till 2 kn 454 m före bron och står still 7,5 min 418 m
  // före (utanför 350 m): först håller regeln "om 3" (basen: strax), sedan
  // stiger värdet och U30 tar över med "ETA okänd" — utan blink.
  test('bromsar och står still utanför 350 m: "om 3" (regeln), sedan stigande och "ETA okänd" (U30), inga blink', async () => {
    const result = await runFixture('stannar');
    const expected = load('stannar');
    expect(result.bridgeTextTransitions.map((r) => [r.t, r.text])).toEqual(expected.bridgeTextTransitions);
    expect((result.notifications || []).map((n) => [n.t, n.mmsi, n.bridge, n.eta])).toEqual(expected.basNotiser);
    const seq = result.bridgeTextTransitions.map((r) => klaff(r.text)).filter((v) => v !== null);
    const iOkand = seq.indexOf('okänd');
    expect(iOkand).toBeGreaterThan(0);
    // Före "ETA okänd": ingen strax alls, och efter hållningens "om 3" bara uppåt.
    const before = seq.slice(0, iOkand);
    expect(before).not.toContain('strax');
    const i3 = before.lastIndexOf(3);
    for (let i = i3 + 1; i < before.length; i += 1) expect(before[i]).toBeGreaterThanOrEqual(before[i - 1]);
  }, 120000);

  test('XENIA-formen med U30 inne: fortfarande en enda strax, ingen "ETA okänd"', async () => {
    const result = await runFixture('xenia');
    const seq = result.bridgeTextTransitions.map((r) => klaff(r.text)).filter((v) => v !== null);
    expect(seq).not.toContain('okänd');
    const entries = seq.filter((v, i) => v === 'strax' && seq[i - 1] !== 'strax');
    expect(entries).toHaveLength(1);
  }, 120000);
});
