'use strict';

/**
 * Familj E (rättningskampanjen 2026-11-04): AVGÅNGS-ETA (buggjägarens F04).
 *
 * En båt som väntat stilla och sätter igång fick sin ETA räknad på
 * igångsättningsfarten. Fartbufferten medlade dessutom in väntans 0-sampel,
 * och gap-reseten gjorde meddelandevägens uppblåsta värde till ny baslinje,
 * så snapshot-vägens bättre värde dömdes som outlier. Minsta repro (värld 884,
 * ALVA vid Järnvägsbron mot Stridsbergsbron): "om 27 minuter" när båten i
 * själva verket korsade Stridsbergsbron 3,1 min senare (L0 11:34:52).
 *
 * Rättningen (ProgressiveETACalculator): väntans sampel lämnar fartbufferten
 * när avgången syns, och farten räknas på ett golv som följer den uppmätta
 * accelerationen ett sampel framåt. Villkoren efter granskningarna:
 *   • stillheten är belagd (alla buffrade sampel under 0,5 kn, minst två);
 *   • avgångssampelt ligger högst 200 m från senaste stillasampel ("på
 *     plats", samma radie som gravens återfödelse) — MARIANNE 20260525;
 *   • båten är närmare målbron än där den låg still (riktningskravet);
 *   • golvet är dubbla igångsättningsfarten i avgångssampelt och därefter
 *     senaste farten plus senaste ökningen, medan farten stiger, högst rask
 *     kanalfart 4 kn — ett fast golv på 4 kn gav för låg ETA och uppsteg för
 *     båtar som planar ut under 4 kn (andra granskningen: "om 3" mot sanning
 *     6 vid Klaffbron, "om 11 → 14 → 16" mot sanning 23 från Olidebron);
 *   • när farten slutar stiga dras antagandet tillbaka mjukt: golvet ligger
 *     kvar högst fartbruset 0,3 kn över toppfarten och sjunker i avståndets
 *     takt, aldrig under aktuell fart; inbromsning mer än bruset eller fart
 *     under 1 kn avslutar kontexten, och den varar högst 5 min;
 *   • golvet får aldrig ensamt lova "strax" (M9-principen): bestämde golvet
 *     farten och hade den uppmätta farten inte gett strax hålls ETA:n på
 *     3 min, om inte imminent-flaggan äger klausulen (värld 595). Nästa
 *     sampels EMA räknar från det ohållna värdet när det samplets egen mätning
 *     lovar strax (V4-principen, SKONNERTEN JYLLAND 20260601-41h).
 *
 * Fixturen är minsta reprots ALVA-rader 10:58–11:36 (77 rader). De syntetiska
 * avgångarna byggs här ur scenarioGeneratorns kanalgeometri (deterministiskt).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const BridgeRegistry = require('../lib/models/BridgeRegistry');
const ProgressiveETACalculator = require('../lib/services/ProgressiveETACalculator');
const { BRIDGES } = require('../lib/constants');
const {
  buildPath, pathMetrics, pointAt, BASE_TIME_MS,
} = require('./replay-validation/scenarioGenerator');

const ROOT = path.resolve(__dirname, '..');
const RUNNER = path.join(ROOT, 'tests/replay-validation/replayRunner.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'e-f04-alva-avgang-jarnvagsbron.jsonl');
const STRIDS = BRIDGES.stridsbergsbron;
const M_PER_DEG_LAT = 111320;
const KN_M_PER_MIN = 1852 / 60;

const logger = {
  log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn(),
};

function southOfStrids(metres) {
  return { lat: STRIDS.lat - metres / M_PER_DEG_LAT, lon: STRIDS.lon };
}

function vesselAt(metres, sog, extra = {}) {
  return {
    mmsi: '265000884',
    targetBridge: 'Stridsbergsbron',
    status: 'waiting',
    ...southOfStrids(metres),
    sog,
    cog: 33.4,
    timestamp: Date.now(),
    lastPositionUpdate: Date.now(),
    ...extra,
  };
}

function runReplay(jsonlPath) {
  const env = { ...process.env, NODE_OPTIONS: '', REPLAY_VERBOSE: '' };
  delete env.REPLAY_MONITORING;
  const out = execFileSync(process.execPath, [RUNNER, jsonlPath], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env,
  });
  return JSON.parse(out.match(/__REPLAY_JSON__(.*?)__END__/s)[1]);
}

describe('avgångskontexten i ProgressiveETACalculator', () => {
  let calc;

  beforeEach(() => {
    jest.useFakeTimers({ now: Date.parse('2026-06-22T11:30:00Z') });
    calc = new ProgressiveETACalculator(logger, new BridgeRegistry());
  });

  afterEach(() => {
    calc.destroy();
    jest.useRealTimers();
  });

  // Ett sampel = ett nytt fartyg-objekt; samma objekt räknas två gånger för att
  // spegla K6-dubbelkörningen (meddelandevägen + snapshot-vägen).
  function sample(metres, sog, { dtS = 30 } = {}) {
    jest.advanceTimersByTime(dtS * 1000);
    const v = vesselAt(metres, sog);
    const first = calc._getEffectiveSpeed(v);
    const second = calc._getEffectiveSpeed(v);
    return { first, second, v };
  }

  // Hel beräkning (rå-ETA + skydden) för ett sampel, två pass som i appen.
  function eta(metres, sog, { dtS = 30, imminent = false } = {}) {
    jest.advanceTimersByTime(dtS * 1000);
    const v = vesselAt(metres, sog, { _isImminentAtTargetBridge: imminent });
    const pass1 = calc.calculateProgressiveETA(v, null);
    const pass2 = calc.calculateProgressiveETA(v, null);
    return { pass1, pass2 };
  }

  function stillAt(metres) {
    sample(metres, 0.0);
    sample(metres - 1, 0.1);
    sample(metres - 2, 0.0);
  }

  test('första rörliga sampel efter belagd stillhet räknas på dubbla igångsättningsfarten, inte på igångsättningsfarten', () => {
    stillAt(485);
    const { first, second } = sample(476, 1.6);
    expect(first).toBeCloseTo(3.2, 5); // 2 × 1,6 kn: lika mycket fart till som från stillheten
    expect(second).toBeCloseTo(3.2, 5); // dubbelkörningen ger samma svar
    // Väntans sampel har lämnat bufferten: bara avgångssampelt finns kvar.
    expect(calc._speedBuffers.get('265000884')).toEqual([1.6]);
    expect(calc._departures.get('265000884').samples).toBe(1);
  });

  test('golvet är högst rask kanalfart, 4 kn', () => {
    stillAt(485);
    expect(sample(476, 2.6).first).toBe(4); // 2 × 2,6 = 5,2 kn kapas till 4
  });

  test('hel ETA-beräkning: värld 884-läget ger restiden i dubbla igångsättningsfarten, inte 27 minuter', () => {
    stillAt(485);
    const { pass1, pass2 } = eta(476, 1.6);
    const expected = 476 / (3.2 * KN_M_PER_MIN); // 4,8 min
    expect(pass1).toBeCloseTo(expected, 1);
    expect(pass2).toBeCloseTo(expected, 1);
  });

  test('golvet följer accelerationen ett sampel framåt så länge farten stiger', () => {
    stillAt(485);
    expect(sample(476, 1.0).first).toBeCloseTo(2.0, 5); // 2 × 1,0
    expect(sample(466, 1.3).first).toBeCloseTo(2.0, 5); // 1,3 + 0,3 = 1,6: golvet sjunker inte
    expect(sample(452, 1.6).first).toBeCloseTo(2.0, 5); // 1,6 + 0,3 = 1,9
    expect(sample(435, 1.9).first).toBeCloseTo(2.2, 5); // 1,9 + 0,3
    expect(sample(395, 3.0).first).toBeCloseTo(4.0, 5); // 3,0 + 1,1 kapas till rask kanalfart
    expect(calc._departures.get('265000884').released).toBe(false);
  });

  test('när farten slutar stiga räknas aktuell fart i stället för det eftersläpande snittet, tills snittet hunnit ikapp', () => {
    stillAt(485);
    sample(476, 1.6);
    sample(460, 3.0);
    sample(430, 3.9);
    sample(395, 4.4);
    // Farten står still på 4,4: antagandet om fortsatt acceleration (4 kn,
    // under toppfarten) dras tillbaka, men bufferten [3,9, 4,4, 4,4] har
    // snittet 4,23 — båten går 4,4.
    expect(sample(360, 4.4).first).toBeCloseTo(4.4, 5);
    expect(calc._departures.get('265000884').released).toBe(true);
    // Nästa jämna sampel: snittet 4,4 har hunnit ikapp, kontexten är slut.
    expect(sample(325, 4.4).first).toBeCloseTo(4.4, 5);
    expect(calc._departures.has('265000884')).toBe(false);
  });

  test('jämn låg fart efter avgången skär ned antagandet direkt till bruset över toppfarten (standardvärldarna 664, 906, 920, 1113)', () => {
    stillAt(485);
    expect(sample(476, 2.2).first).toBe(4);
    // Farten steg inte: golvet 4 kn skärs ned till 2,2 + 0,3 kn och sjunker
    // sedan i avståndets takt mot den uppmätta farten.
    const steady = sample(460, 2.2).first;
    expect(steady).toBeCloseTo(2.5, 5);
    const later = sample(444, 2.2).first;
    expect(later).toBeLessThan(2.5);
    expect(later).toBeGreaterThanOrEqual(2.2);
  });

  test('fartbrus inom 0,3 kn under toppfarten släpper inte golvet till snittet', () => {
    stillAt(485);
    sample(476, 1.5);
    sample(461, 2.5); // golvet 2,5 + 1,0 = 3,5
    const dip = sample(447, 2.4).first; // brus: golvet högst 2,5 + 0,3
    expect(dip).toBeCloseTo(2.8, 5);
    const resumed = sample(432, 3.0).first; // över toppfarten: accelerationen fortsätter
    expect(resumed).toBeCloseTo(3.6, 5);
    expect(calc._departures.get('265000884').released).toBe(false);
  });

  test('en båt som saktar in mer än bruset efter avgången får sitt vanliga snitt (gästhamnsbåten MARIANNE)', () => {
    stillAt(700);
    expect(sample(690, 3.8).first).toBe(4);
    const slower = sample(680, 3.2).first; // 0,6 kn under toppfarten: inbromsning
    expect(slower).toBeCloseTo((3.8 + 3.2) / 2, 5);
    expect(calc._departures.has('265000884')).toBe(false);
  });

  test('en båt som stannar igen lämnar kontexten direkt', () => {
    stillAt(485);
    expect(sample(476, 1.6).first).toBeCloseTo(3.2, 5);
    sample(475, 0.3);
    expect(calc._departures.has('265000884')).toBe(false);
  });

  test('kontexten har en tidsgräns på fem minuter', () => {
    stillAt(485);
    expect(sample(476, 1.6).first).toBeCloseTo(3.2, 5);
    const within = sample(470, 2.0, { dtS: 4 * 60 }).first; // stigande inom 5 min
    expect(within).toBeCloseTo(3.2, 5);
    const late = sample(466, 2.4, { dtS: 2 * 60 }).first; // 6 min efter avgången
    expect(late).toBeCloseTo((1.6 + 2.0 + 2.4) / 3, 5);
    expect(calc._departures.has('265000884')).toBe(false);
  });

  test('långsam gång (0,5–0,99 kn, kajdrift) är ingen avgång', () => {
    sample(485, 0.6);
    sample(484, 0.8);
    sample(483, 0.9);
    const eff = sample(480, 1.5).first;
    expect(calc._departures.has('265000884')).toBe(false);
    expect(eff).toBeCloseTo((0.8 + 0.9 + 1.5) / 3, 5);
  });

  test('ett ensamt stillasampel är ingen belagd stillhet', () => {
    sample(485, 0.0);
    const eff = sample(480, 2.0).first;
    expect(calc._departures.has('265000884')).toBe(false);
    expect(eff).toBeCloseTo(1.0, 5); // snitt av [0, 2]
  });

  test('avgången måste synas på plats: 250 m från stillheten är båten redan på väg (MARIANNE 20260525)', () => {
    stillAt(700);
    // AIS-tystnad, och båten hörs igen 250 m längre fram i 3,8 kn.
    const eff = sample(448, 3.8, { dtS: 11 * 60 }).first;
    expect(calc._departures.has('265000884')).toBe(false);
    expect(eff).toBeLessThan(4);
  });

  test('en båt som kör bort från målbron efter väntan får ingen avgångskontext', () => {
    stillAt(485);
    const eff = sample(495, 1.6).first; // söderut, bort från Stridsbergsbron
    expect(calc._departures.has('265000884')).toBe(false);
    expect(eff).toBeLessThan(1);
  });

  test('golvet släpps om båten vänder och hamnar längre från målbron än stillheten', () => {
    stillAt(485);
    expect(sample(476, 1.6).first).toBeCloseTo(3.2, 5);
    const turned = sample(490, 2.4).first; // stigande fart, men nu söder om stillheten
    expect(turned).toBeCloseTo((1.6 + 2.4) / 2, 5);
  });

  test('golvet får inte ensamt lova "strax": jämn låg fart 340 m före bron ger 3 min, inte strax', () => {
    stillAt(345);
    const { pass1, pass2 } = eta(340, 2.2);
    // På 4 kn vore det 340 / 123,5 ≈ 2,8 min (strax); på uppmätta 2,2 kn ≈ 5 min.
    expect(pass1).toBe(3);
    expect(pass2).toBe(3);
  });

  test('imminent-flaggan äger strax: då får golvets ETA gå under 3 min', () => {
    stillAt(345);
    const { pass1 } = eta(340, 2.2, { imminent: true });
    expect(pass1).toBeLessThan(3);
  });

  test('ger även den uppmätta farten strax är det inte golvet som lovar (SKONNERTEN JYLLAND)', () => {
    stillAt(165);
    const { pass1 } = eta(160, 3.8);
    // 160 m: 1,3 min på 4 kn och 1,4 min på uppmätta 3,8 kn — båda under 3.
    expect(pass1).toBeLessThan(2);
  });

  // V4-principen (andra granskningen): M9-hållet 3,0 är en spärr för
  // presentationen. Historikposten bär det ohållna värdet; nästa sampels EMA
  // räknar från det när det samplets egen mätning lovar strax, annars från det
  // hållna värdet. Fartyget är här utan avgångskontext, så rå-ETA:n är mätningen.
  function heldHistory(unheld) {
    const t = Date.now();
    calc._etaHistory.set('265000884', [{
      rawETA: 2.4,
      protectedETA: 2.4,
      processedETA: 3,
      m9UnheldETA: unheld,
      timestamp: t - 30000,
      targetBridge: 'Stridsbergsbron',
      nearestBridge: null,
      vesselSpeed: 3.4,
      distance: null,
      distanceToTarget: null,
      vesselStatus: 'en-route',
      waitingAtBridge: null,
      position: null,
    }]);
  }

  test('efter ett M9-hållet värde räknar EMA:n från det ohållna värdet när mätningen själv lovar strax (SKONNERTEN JYLLAND)', () => {
    heldHistory(2.6);
    const v = vesselAt(160, 3.8, { status: 'en-route' });
    const out = calc._processETAWithProtection(v, 1.93, null);
    expect(out).toBeCloseTo(0.4 * 1.93 + 0.6 * 2.6, 5); // 2,33 — inte 2,56 från det hållna 3,0
  });

  test('lovar mätningen inte strax räknar EMA:n från det hållna värdet, så antagandet inte kan lova strax via utjämningen', () => {
    heldHistory(2.6);
    const v = vesselAt(300, 3.0, { status: 'en-route' });
    const out = calc._processETAWithProtection(v, 3.4, null);
    expect(out).toBeCloseTo(0.4 * 3.4 + 0.6 * 3, 5); // 3,16 ("om 3"); från 2,6 hade det blivit 2,92 (strax)
    expect(out).toBeGreaterThanOrEqual(3);
  });

  test('historiken lagrar det publicerade, hållna värdet och det ohållna bredvid (E-F6)', () => {
    stillAt(345);
    eta(340, 2.2);
    const last = calc._etaHistory.get('265000884').slice(-1)[0];
    expect(last.processedETA).toBe(3);
    expect(last.m9UnheldETA).toBeLessThan(3);
  });

  test('städningen följer fartbufferten (clear, svep och destroy)', () => {
    stillAt(485);
    sample(476, 1.6);
    expect(calc._departures.has('265000884')).toBe(true);
    calc.clearVesselETAHistory('265000884', 'vessel_removed');
    expect(calc._departures.has('265000884')).toBe(false);
    expect(calc._lastStillSample.has('265000884')).toBe(false);

    stillAt(485);
    sample(476, 1.6);
    calc._etaHistory.delete('265000884');
    calc._cleanupOldETAHistory();
    expect(calc._departures.has('265000884')).toBe(false);

    stillAt(485);
    expect(calc._lastStillSample.has('265000884')).toBe(true);
    sample(476, 1.6);
    calc.destroy();
    expect(calc._departures.size).toBe(0);
    expect(calc._lastStillSample.size).toBe(0);
  });
});

describe('avgångs-ETA i hela kedjan (replay av minsta reprots ALVA-rader)', () => {
  let result;

  beforeAll(() => {
    result = runReplay(FIXTURE);
  });

  // L0-sanningen ur minsta reprots tidslinje: ALVA korsar Stridsbergsbron 11:34:52.
  const TRUE_CROSSING_MS = Date.parse('2026-06-22T11:34:52Z');
  const DEPARTURE_MS = Date.parse('2026-06-22T11:31:40Z');
  const minutesOf = (text) => {
    const m = text.match(/på väg mot Stridsbergsbron, beräknad broöppning om (\d+) minuter/);
    return m ? Number(m[1]) : null;
  };

  test('första prognosen efter avgången ligger nära rådatans korsning, inte på 27 minuter', () => {
    const after = result.bridgeTextTransitions.filter((t) => t.t >= DEPARTURE_MS && minutesOf(t.text) !== null);
    expect(after.length).toBeGreaterThan(0);
    const first = after[0];
    const truthMin = (TRUE_CROSSING_MS - first.t) / 60000;
    // Golvet antar dubbla igångsättningsfarten (3,2 kn): "om 5" mot sanning
    // 3,1 i stället för "om 27" — försiktigt, och nedräkningen går därefter
    // bara nedåt (4, 3, strax).
    expect(Math.abs(minutesOf(first.text) - truthMin)).toBeLessThanOrEqual(2);
  });

  test('ingen prognos efter avgången överstiger 6 minuter (förr 27 → 22 → 18 → 14)', () => {
    const after = result.bridgeTextTransitions
      .filter((t) => t.t >= DEPARTURE_MS)
      .map((t) => minutesOf(t.text))
      .filter((n) => n !== null);
    expect(Math.max(...after)).toBeLessThanOrEqual(6);
  });

  test('passagen och väntetexten före avgången är oförändrade', () => {
    expect(result.targetPassages.map((p) => p.bridge)).toEqual(['Stridsbergsbron']);
    expect(result.bridgeTextTransitions.some((t) => t.text === 'En båt väntar vid Järnvägsbron på väg mot Stridsbergsbron'))
      .toBe(true);
  });
});

describe('buggjägarens standardvärldar efter granskningen (INV-3 med projektets egen validator)', () => {
  // Utdrag (20 min före utslaget till 8 min efter) ur motorns världar, bas-seed 1.
  //   664: ALVA väntar vid Järnvägsbron och kör iväg i jämn låg fart 2,3 kn.
  //        Prototypen räknade jämn fart som acceleration: "strax → om 4 → strax".
  //   595: TROLLA avgår 2,0 → 3,1 → 3,1 kn. Utan M9-kravet gav golvet ensamt
  //        "strax" som släpptes till "om 3" (4 → strax → 3).
  const { validateInvariants } = require('./replay-validation/invariants');
  const etaViolations = (result) => validateInvariants(result)
    .filter((v) => /ETA-OSCILLATION|ETA-SÅGTAND/.test(v));

  test('värld 664: jämn låg fart från kön ger ingen strax-studs', () => {
    const result = runReplay(path.join(__dirname, 'fixtures', 'e-w664-alva-jamn-avgang.jsonl'));
    expect(etaViolations(result)).toEqual([]);
    expect(result.targetPassages.map((p) => p.bridge)).toContain('Stridsbergsbron');
  });

  test('värld 595: golvet lovar inte ensamt strax (M9)', () => {
    const result = runReplay(path.join(__dirname, 'fixtures', 'e-w595-trolla-avgang-m9.jsonl'));
    expect(etaViolations(result)).toEqual([]);
  });
});

describe('syntetiska avgångar efter väntan söder om Klaffbron (placeringsberoende)', () => {
  // Granskningens prov: en båt kör norrut i 4 kn, väntar 6 min stilla 450 m
  // söder om Klaffbron (litet positionsbrus, nya sampelnycklar) och sätter
  // sedan igång. Sampel var 30:e sekund.
  const P = buildPath();
  const M = pathMetrics(P);
  const S_KLAFF = M.cum[2];
  const NORTH = pointAt(P, M, S_KLAFF - 500).bearing;
  const KLAFF_RX = /på väg mot Klaffbron, beräknad broöppning (?:om (\d+) minuter?|(strax))/;

  function row(t, s, sog, cog, mmsi, jitter = 0) {
    const p = pointAt(P, M, s);
    return {
      mmsi,
      msgType: 'StandardClassBPositionReport',
      lat: p.lat + jitter * 1e-6,
      lon: p.lon - jitter * 1e-6,
      sog,
      cog,
      navStatus: null,
      shipName: `SYNT-E-${mmsi.slice(-2)}`,
      aisTimestamp: t,
      fixTs: t,
      feed: 'aisstream',
      receivedAt: new Date(t).toISOString(),
    };
  }

  function departure({
    mmsi, waitBeforeM, speeds, south = false,
  }) {
    const rows = [];
    let s = S_KLAFF - 1400;
    let t = BASE_TIME_MS;
    while (s < S_KLAFF - waitBeforeM - 110) {
      rows.push(row(t, s, 4.0, NORTH, mmsi));
      s += 4 * 0.5144 * 30;
      t += 30000;
    }
    rows.push(row(t, S_KLAFF - waitBeforeM - 50, 2.0, NORTH, mmsi)); t += 30000;
    rows.push(row(t, S_KLAFF - waitBeforeM - 15, 1.0, NORTH, mmsi)); t += 30000;
    for (let i = 0; i < 12; i++) {
      rows.push(row(t, S_KLAFF - waitBeforeM, i % 3 === 0 ? 0.1 : 0.0, NORTH, mmsi, i % 4));
      t += 30000;
    }
    const departAtMs = t;
    let ss = S_KLAFF - waitBeforeM;
    const cog = south ? (NORTH + 180) % 360 : NORTH;
    for (const v of speeds) {
      ss += (south ? -1 : 1) * v * 0.5144 * 30;
      rows.push(row(t, ss, v, cog, mmsi));
      t += 30000;
    }
    return { rows, departAtMs };
  }

  function replayRows(name, rows) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e-avgang-'));
    const file = path.join(dir, `${name}.jsonl`);
    fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
    try {
      return runReplay(file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // Klaffbron-klausulens minutvärden efter avgången (strax = 0), i tidsordning.
  function klaffMinutesAfter(result, fromMs) {
    return result.bridgeTextTransitions
      .filter((t) => t.t >= fromMs)
      .map((t) => t.text.match(KLAFF_RX))
      .filter(Boolean)
      .map((m) => (m[2] ? 0 : Number(m[1])));
  }

  const ACCEL = [1.4, 2.0, 2.6, 3.2, 3.8, 4.0, 4.0, 4.0, 4.0, 4.0, 4.0, 4.0, 4.0, 4.0, 4.0, 4.0];

  test('stigande fart mot bron: nedräkningen går aldrig upp igen (förr "om 4 → om 3 → om 4")', () => {
    const { rows, departAtMs } = departure({ mmsi: '901009902', waitBeforeM: 450, speeds: ACCEL });
    const minutes = klaffMinutesAfter(replayRows('accel', rows), departAtMs);
    expect(minutes.length).toBeGreaterThan(1);
    for (let i = 1; i < minutes.length; i++) expect(minutes[i]).toBeLessThanOrEqual(minutes[i - 1]);
    expect(minutes[minutes.length - 1]).toBe(0);
  });

  test('en båt som vänder bort från bron efter väntan får ingen nedräkning mot den', () => {
    const { rows, departAtMs } = departure({
      mmsi: '901009901', waitBeforeM: 450, speeds: ACCEL, south: true,
    });
    const result = replayRows('vand', rows);
    const before = result.bridgeTextTransitions.filter((t) => t.t < departAtMs && KLAFF_RX.test(t.text));
    const lastBefore = before[before.length - 1].text.match(KLAFF_RX);
    const floor = lastBefore[2] ? 0 : Number(lastBefore[1]);
    const after = klaffMinutesAfter(result, departAtMs);
    expect(after.every((m) => m >= floor)).toBe(true);
  });
});

describe('platåklassen: avgångar som planar ut under 4 kn (andra granskningen)', () => {
  // Granskarens fall (omgranskning 1) från tre platser. Båten kör i 4 kn mot
  // väntplatsen, ligger still 6 min (litet positionsbrus) och sätter igång i
  // en fart som planar ut under rask kanalfart. Sanningen är linjekorsningen
  // av målbron i den genererade geometrin (sampel k ligger fart_k · 30 s
  // längre fram). Med ett fast golv på 4 kn medan farten steg blev texten
  // "5 → 4 → 3 → 5" mot sanning 6 vid Klaffbron, "om 3" mot sanning 6,5 från
  // Järnvägsbron och "13 → 12 → 11 → 14 → 15 → 16" mot sanning 24 från
  // Olidebron.
  const P = buildPath();
  const M = pathMetrics(P);
  const S = {
    olide: M.cum[1], klaff: M.cum[2], jarnv: M.cum[3], strids: M.cum[4],
  };
  const KN = 0.5144;
  const PLACES = {
    klaff: { anchorS: S.klaff, target: 'Klaffbron', targetS: S.klaff },
    olide: { anchorS: S.olide, target: 'Klaffbron', targetS: S.klaff },
    jarnv: { anchorS: S.jarnv, target: 'Stridsbergsbron', targetS: S.strids },
  };

  function row(t, s, sog, mmsi, jitter = 0) {
    const p = pointAt(P, M, s);
    return {
      mmsi,
      msgType: 'StandardClassBPositionReport',
      lat: p.lat + jitter * 1e-6,
      lon: p.lon - jitter * 1e-6,
      sog,
      cog: p.bearing,
      navStatus: null,
      shipName: `SYNT-PLATA-${mmsi.slice(-2)}`,
      aisTimestamp: t,
      fixTs: t,
      feed: 'aisstream',
      receivedAt: new Date(t).toISOString(),
    };
  }

  function plateauDeparture({
    mmsi, place, waitBeforeM, speeds, dtS = 30,
  }) {
    const pl = PLACES[place];
    const rows = [];
    let s = pl.anchorS - waitBeforeM - 1300;
    let t = BASE_TIME_MS;
    while (s < pl.anchorS - waitBeforeM - 110) {
      rows.push(row(t, s, 4.0, mmsi));
      s += 4 * KN * 30;
      t += 30000;
    }
    rows.push(row(t, pl.anchorS - waitBeforeM - 50, 2.0, mmsi)); t += 30000;
    rows.push(row(t, pl.anchorS - waitBeforeM - 15, 1.0, mmsi)); t += 30000;
    for (let i = 0; i < 12; i++) {
      rows.push(row(t, pl.anchorS - waitBeforeM, i % 3 === 0 ? 0.1 : 0.0, mmsi, i % 4));
      t += 30000;
    }
    const departAtMs = t;
    let ss = pl.anchorS - waitBeforeM;
    let crossingMs = null;
    t -= dtS * 1000;
    const advance = (v) => {
      const before = ss;
      ss += v * KN * dtS;
      if (crossingMs === null && before < pl.targetS && ss >= pl.targetS) {
        crossingMs = t + ((pl.targetS - before) / (ss - before)) * dtS * 1000;
      }
      t += dtS * 1000;
      rows.push(row(t, ss, v, mmsi));
    };
    speeds.forEach(advance);
    while (ss < pl.targetS + 400) advance(speeds[speeds.length - 1]);
    return {
      rows, departAtMs, crossingMs, target: pl.target,
    };
  }

  function replayRows(name, rows) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e-plata-'));
    const file = path.join(dir, `${name}.jsonl`);
    fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
    try {
      return runReplay(file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // Målbroklausulens minuttal (strax = 0) från avgången till korsningen, med
  // sanningen i minuter vid publiceringen.
  function claims(result, { target, departAtMs, crossingMs }) {
    const rx = new RegExp(`på väg mot ${target}, beräknad broöppning (?:(strax)|om (\\d+) minuter?)`);
    return result.bridgeTextTransitions
      .filter((tr) => tr.t >= departAtMs - 500 && tr.t < crossingMs)
      .map((tr) => ({ tr, m: tr.text.match(rx) }))
      .filter(({ m }) => m)
      .map(({ tr, m }) => ({
        t: tr.t, v: m[1] ? 0 : Number(m[2]), truth: (crossingMs - tr.t) / 60000,
      }));
  }

  function expectCountdown(list) {
    for (let i = 1; i < list.length; i++) expect(list[i].v).toBeLessThanOrEqual(list[i - 1].v);
  }

  test('Klaffbron, 480 m söder, 1,1 → 2,0 kn (granskarens platå2): ingen prognos mer än 2 min för låg och inget uppsteg', () => {
    const dep = plateauDeparture({
      mmsi: '901009911', place: 'klaff', waitBeforeM: 480, speeds: [1.1, 1.5, 1.9, 2.0],
    });
    const list = claims(replayRows('klaff', dep.rows), dep);
    expect(list.length).toBeGreaterThan(0);
    for (const c of list.filter((x) => x.v > 0)) expect(c.v).toBeGreaterThanOrEqual(c.truth - 2);
    expectCountdown(list);
  });

  test('Järnvägsbron mot Stridsbergsbron, 1,0 → 2,0 kn: inget "om 3" mot sanning 6', () => {
    const dep = plateauDeparture({
      mmsi: '901009912', place: 'jarnv', waitBeforeM: 150, speeds: [1.0, 1.3, 1.6, 1.9, 2.0],
    });
    const list = claims(replayRows('jarnv', dep.rows), dep);
    expect(list.length).toBeGreaterThan(0);
    for (const c of list.filter((x) => x.v > 0)) expect(c.v).toBeGreaterThanOrEqual(c.truth - 2);
    expectCountdown(list);
  });

  test('Olidebron mot Klaffbron, 1,0 → 2,0 kn: första prognosen nära sanningen och sedan bara nedåt', () => {
    const dep = plateauDeparture({
      mmsi: '901009913', place: 'olide', waitBeforeM: 120, speeds: [1.0, 1.2, 1.4, 1.6, 1.8, 2.0],
    });
    // De första 10 minuterna efter avgången (avgångskontexten varar högst 5).
    // Senare går texten 6 → 7 när passagegolvet 2,5 kn efter Olidebron löper
    // ut efter 15 min (E-F5) — samma på 7699cbe och utanför den här rättningen.
    const list = claims(replayRows('olide', dep.rows), dep)
      .filter((c) => c.t - dep.departAtMs <= 10 * 60000);
    expect(list.length).toBeGreaterThan(5);
    // Väntans prognos före avgången räknar redan på rask kanalfart (E-F7:s
    // decaygolv), så en långsam båt rättas uppåt en gång vid avgången. Efter
    // det får nedräkningen inte gå upp (förr 11 → 14 → 15 → 16).
    expect(Math.abs(list[0].v - list[0].truth)).toBeLessThanOrEqual(2);
    expectCountdown(list);
  });

  test('fartbrus 2,5 → 2,4 mitt i accelerationen ger inget uppsteg (förr "4 → 5 → 4")', () => {
    const dep = plateauDeparture({
      mmsi: '901009914', place: 'klaff', waitBeforeM: 480, speeds: [1.5, 2.5, 2.4, 3.0, 3.5, 3.4, 4.0, 4.2],
    });
    const list = claims(replayRows('brus', dep.rows), dep);
    expect(list.length).toBeGreaterThan(0);
    expectCountdown(list);
  });
});
